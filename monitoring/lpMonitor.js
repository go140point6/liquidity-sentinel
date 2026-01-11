// monitoring/lpMonitor.js
//
// DB-driven LP monitor (NEW SCHEMA):
// - Reads LP positions via (user_wallets + contracts(kind=LP_NFT) + nft_tokens current owner)
// - Uses lp_token_meta.pair_label when available
// - Persists previous range status in alert_state.state_json (via alertEngine) - no extra tables
// - Provider endpoints come from .env (FLR_MAINNET, XDC_MAINNET, etc.)
// - Keeps existing range-tier logic + alertEngine integration intact

const { ethers } = require("ethers");

const positionManagerAbi = require("../abi/positionManager.json");
const uniswapV3FactoryAbi = require("../abi/uniswapV3Factory.json");
const uniswapV3PoolAbi = require("../abi/uniswapV3Pool.json");
const erc20MetadataAbi = require("../abi/erc20Metadata.json");

const { getDb } = require("../db");
const { getProviderForChain } = require("../utils/ethers/providers");
const { handleLpRangeAlert } = require("./alertEngine");
const logger = require("../utils/logger");

// -----------------------------
// Chains config for getProviderForChain()
// -----------------------------
const CHAINS_CONFIG = {
  FLR: { rpcEnvKey: "FLR_MAINNET" },
  XDC: { rpcEnvKey: "XDC_MAINNET" },
};

// -----------------------------
// Env parsing (assume validateEnv already enforced presence)
// -----------------------------
const LP_TIER_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"];

const LP_ALERT_MIN_TIER = String(process.env.LP_ALERT_MIN_TIER || "UNKNOWN").toUpperCase();
if (!LP_TIER_ORDER.includes(LP_ALERT_MIN_TIER)) {
  logger.error(
    `[Config] LP_ALERT_MIN_TIER must be one of ${LP_TIER_ORDER.join(
      ", "
    )}, got "${process.env.LP_ALERT_MIN_TIER}"`
  );
  throw new Error(
    `[Config] LP_ALERT_MIN_TIER must be one of ${LP_TIER_ORDER.join(
      ", "
    )}, got "${process.env.LP_ALERT_MIN_TIER}"`
  );
}

const LP_EDGE_WARN_FRAC = Number(process.env.LP_EDGE_WARN_FRAC);
const LP_EDGE_HIGH_FRAC = Number(process.env.LP_EDGE_HIGH_FRAC);
const LP_OUT_WARN_FRAC = Number(process.env.LP_OUT_WARN_FRAC);
const LP_OUT_HIGH_FRAC = Number(process.env.LP_OUT_HIGH_FRAC);

// -----------------------------
// Tier compare
// -----------------------------
function isLpTierAtLeast(tier, minTier) {
  const idx = LP_TIER_ORDER.indexOf((tier || "UNKNOWN").toUpperCase());
  const minIdx = LP_TIER_ORDER.indexOf((minTier || "UNKNOWN").toUpperCase());
  if (idx === -1 || minIdx === -1) return false;
  return idx >= minIdx;
}

// -----------------------------
// Token symbol cache (best-effort)
// -----------------------------
const tokenSymbolCache = new Map();

async function getTokenSymbol(provider, address) {
  const key = (address || "").toLowerCase();
  if (tokenSymbolCache.has(key)) return tokenSymbolCache.get(key);

  const token = new ethers.Contract(address, erc20MetadataAbi, provider);
  const symbol = await token.symbol();
  tokenSymbolCache.set(key, symbol);
  return symbol;
}

// -----------------------------
// LP range tier classification
// -----------------------------
function classifyLpRangeTier(rangeStatus, tickLower, tickUpper, currentTick) {
  const normStatus = (rangeStatus || "")
    .toString()
    .toUpperCase()
    .replace(/\s+/g, "_");

  const width = tickUpper - tickLower;
  const hasTicks =
    Number.isFinite(width) &&
    width > 0 &&
    Number.isFinite(tickLower) &&
    Number.isFinite(tickUpper) &&
    Number.isFinite(currentTick);

  const edgeWarn = LP_EDGE_WARN_FRAC;
  const edgeHigh = LP_EDGE_HIGH_FRAC;
  const outWarn = LP_OUT_WARN_FRAC;
  const outHigh = LP_OUT_HIGH_FRAC;

  if (normStatus === "IN_RANGE" && hasTicks) {
    const positionFrac = (currentTick - tickLower) / width; // 0..1
    const centerDist = Math.min(positionFrac, 1 - positionFrac);

    if (!Number.isFinite(centerDist) || centerDist < 0) {
      return {
        tier: "UNKNOWN",
        positionFrac: null,
        distanceFrac: null,
        label: "invalid in-range tick geometry",
      };
    }

    let tier = "LOW";
    if (Number.isFinite(edgeHigh) && centerDist <= edgeHigh) tier = "HIGH";
    else if (Number.isFinite(edgeWarn) && centerDist <= edgeWarn) tier = "MEDIUM";

    const label =
      tier === "LOW"
        ? "comfortably in range"
        : tier === "MEDIUM"
        ? "in range but near edge"
        : "in range and very close to edge";

    return { tier, positionFrac, distanceFrac: centerDist, label };
  }

  if (normStatus === "OUT_OF_RANGE" && hasTicks) {
    let distanceFrac = null;

    if (currentTick < tickLower) distanceFrac = (tickLower - currentTick) / width;
    else if (currentTick >= tickUpper) distanceFrac = (currentTick - tickUpper) / width;

    if (!Number.isFinite(distanceFrac) || distanceFrac < 0) {
      return {
        tier: "HIGH",
        positionFrac: null,
        distanceFrac: null,
        label: "out of range (distance unknown)",
      };
    }

    let tier;
    if (Number.isFinite(outWarn) && distanceFrac <= outWarn) tier = "MEDIUM";
    else if (Number.isFinite(outHigh) && distanceFrac <= outHigh) tier = "HIGH";
    else tier = "CRITICAL";

    const label =
      tier === "MEDIUM"
        ? "slightly out of range"
        : tier === "HIGH"
        ? "far out of range"
        : "deeply out of range";

    return { tier, positionFrac: null, distanceFrac, label };
  }

  return {
    tier: normStatus === "IN_RANGE" ? "LOW" : "UNKNOWN",
    positionFrac: null,
    distanceFrac: null,
    label: normStatus === "IN_RANGE" ? "in range (no detailed geometry)" : "range not computed",
  };
}

// -----------------------------
// DB: fetch monitored LP rows (NEW SCHEMA)
// -----------------------------
function getMonitoredLpRows() {
  const db = getDb();

  const sql = `
    SELECT
      u.id                 AS userId,
      uw.id                AS walletId,
      c.id                 AS contractId,

      c.chain_id           AS chainId,
      c.protocol           AS protocol,

      uw.address_eip55     AS owner,
      c.address_eip55      AS contract,

      nt.token_id          AS tokenId,
      lpm.pair_label       AS pairLabel,

      ast.state_json       AS prevStateJson
    FROM user_wallets uw
    JOIN users u
      ON u.id = uw.user_id
    JOIN contracts c
      ON c.chain_id = uw.chain_id
     AND c.kind = 'LP_NFT'
    JOIN nft_tokens nt
      ON nt.contract_id = c.id
     AND nt.owner_lower = uw.address_lower
     AND nt.is_burned = 0
    LEFT JOIN lp_token_meta lpm
      ON lpm.contract_id = nt.contract_id
     AND lpm.token_id    = nt.token_id
    LEFT JOIN alert_state ast
      ON ast.user_id     = u.id
     AND ast.wallet_id   = uw.id
     AND ast.contract_id = c.id
     AND ast.token_id    = nt.token_id
    LEFT JOIN position_ignores pi
      ON pi.user_id        = u.id
     AND pi.position_kind  = 'LP'
     AND pi.wallet_id      = uw.id
     AND pi.contract_id    = c.id
     AND (pi.token_id IS NULL OR pi.token_id = nt.token_id)
    WHERE
      uw.is_enabled = 1
      AND c.is_enabled = 1
      AND pi.id IS NULL
    ORDER BY c.chain_id, c.protocol, uw.address_eip55, nt.token_id
  `;

  return db.prepare(sql).all();
}

function extractPrevRangeStatus(prevStateJson) {
  if (!prevStateJson) return "UNKNOWN";
  try {
    const obj = JSON.parse(prevStateJson);
    if (!obj || obj.kind !== "LP") return "UNKNOWN";
    const s = obj.rangeStatus ?? obj.status ?? obj.range ?? null;
    const out = (s || "UNKNOWN").toString().toUpperCase();
    // normalize a few cases we might have stored historically
    if (out === "INACTIVE") return "INACTIVE";
    if (out === "OUT_OF_RANGE" || out === "IN_RANGE" || out === "UNKNOWN") return out;
    return out; // keep whatever else, but uppercased
  } catch {
    return "UNKNOWN";
  }
}

// -----------------------------
// LP summary builder (no logging)
// -----------------------------
async function summarizeLpPosition(provider, chainId, protocol, row) {
  const { userId, walletId, contractId, contract, owner, tokenId, pairLabel: dbPairLabel } = row;
  const tokenIdBN = BigInt(tokenId);

  const pm = new ethers.Contract(contract, positionManagerAbi, provider);
  const pos = await pm.positions(tokenIdBN);

  const liquidity = BigInt(pos.liquidity.toString());
  if (liquidity === 0n) return null;

  const token0 = pos.token0;
  const token1 = pos.token1;
  const fee = Number(pos.fee);
  const tickLower = Number(pos.tickLower);
  const tickUpper = Number(pos.tickUpper);

  let token0Symbol = token0;
  let token1Symbol = token1;
  try {
    token0Symbol = await getTokenSymbol(provider, token0);
  } catch (_) {}
  try {
    token1Symbol = await getTokenSymbol(provider, token1);
  } catch (_) {}

  const pairLabel = dbPairLabel || `${token0Symbol}-${token1Symbol}`;

  let poolAddr = null;
  let currentTick = null;
  let rangeStatus = "UNKNOWN";

  try {
    const factoryAddr = await pm.factory();
    if (factoryAddr && factoryAddr !== ethers.ZeroAddress) {
      const factory = new ethers.Contract(factoryAddr, uniswapV3FactoryAbi, provider);
      poolAddr = await factory.getPool(token0, token1, fee);

      if (poolAddr && poolAddr !== ethers.ZeroAddress) {
        const pool = new ethers.Contract(poolAddr, uniswapV3PoolAbi, provider);
        const slot0 = await pool.slot0();
        const tick = slot0.tick !== undefined ? slot0.tick : slot0[1];
        currentTick = Number(tick);

        if (Number.isFinite(currentTick)) {
          rangeStatus =
            currentTick >= tickLower && currentTick < tickUpper ? "IN_RANGE" : "OUT_OF_RANGE";
        }
      }
    }
  } catch (_) {}

  const lpClass = classifyLpRangeTier(rangeStatus, tickLower, tickUpper, currentTick);

  return {
    userId,
    walletId,
    contractId,

    protocol,
    chainId,
    owner,
    tokenId,
    nftContract: contract,

    token0,
    token1,
    token0Symbol,
    token1Symbol,
    pairLabel,

    fee,
    tickLower,
    tickUpper,
    currentTick,
    liquidity: liquidity.toString(),
    status: "ACTIVE",
    rangeStatus,
    poolAddr,

    lpRangeTier: lpClass.tier,
    lpRangeLabel: lpClass.label,
    lpPositionFrac: lpClass.positionFrac,
    lpDistanceFrac: lpClass.distanceFrac,
  };
}

// -----------------------------
// Public API: getLpSummaries
// -----------------------------
async function getLpSummaries() {
  const summaries = [];

  const rows = getMonitoredLpRows();
  if (!rows || rows.length === 0) return summaries;

  const byChain = new Map();
  for (const r of rows) {
    const chainId = (r.chainId || "").toUpperCase();
    if (!byChain.has(chainId)) byChain.set(chainId, []);
    byChain.get(chainId).push(r);
  }

  for (const [chainId, chainRows] of byChain.entries()) {
    let provider;
    try {
      provider = getProviderForChain(chainId, CHAINS_CONFIG);
    } catch (err) {
      logger.warn(`[LP] Skipping chain ${chainId} in getLpSummaries: ${err?.message || err}`);
      continue;
    }

    for (const row of chainRows) {
      try {
        const summary = await summarizeLpPosition(
          provider,
          chainId,
          row.protocol || "UNKNOWN_PROTOCOL",
          row
        );
        if (summary) summaries.push(summary);
      } catch (err) {
        logger.error(
          `[LP] Failed to build LP summary tokenId=${row.tokenId} on ${chainId}:`,
          err?.message || err
        );
      }
    }
  }

  return summaries;
}

// -----------------------------
// Core LP description (logging + alerts)
// -----------------------------
async function describeLpPosition(provider, chainId, protocol, row, options = {}) {
  const { verbose = false } = options;

  const {
    userId,
    walletId,
    contractId,
    contract,
    owner,
    tokenId,
    pairLabel: dbPairLabel,
    prevStateJson,
  } = row;
  const prevStatus = extractPrevRangeStatus(prevStateJson);

  const tokenIdBN = BigInt(tokenId);
  const pm = new ethers.Contract(contract, positionManagerAbi, provider);
  const pos = await pm.positions(tokenIdBN);

  const liquidity = BigInt(pos.liquidity.toString());
  if (liquidity === 0n) {
    if (verbose) {
      logger.debug(
        `${protocol} tokenId=${tokenId} on ${chainId} has zero liquidity; treating as INACTIVE.`
      );
    }

    await handleLpRangeAlert({
      userId,
      walletId,
      contractId,
      positionId: tokenId,
      prevStatus,
      currentStatus: "INACTIVE",
      isActive: false,
      lpRangeTier: "UNKNOWN",
      tickLower: null,
      tickUpper: null,
      currentTick: null,
      protocol,
      wallet: owner,
    });
    return;
  }

  const token0 = pos.token0;
  const token1 = pos.token1;
  const fee = Number(pos.fee);
  const tickLower = Number(pos.tickLower);
  const tickUpper = Number(pos.tickUpper);

  let pairLabel = dbPairLabel || "";
  if (!pairLabel) {
    try {
      const [sym0, sym1] = await Promise.all([
        getTokenSymbol(provider, token0).catch(() => token0),
        getTokenSymbol(provider, token1).catch(() => token1),
      ]);
      pairLabel = `${sym0}-${sym1}`;
    } catch (_) {
      pairLabel = `${token0}-${token1}`;
    }
  }

  if (verbose) {
    logger.debug("========================================");
    logger.debug(`LP POSITION (${protocol})`);
    logger.debug("----------------------------------------");
    logger.debug(`UserId:    ${userId}`);
    logger.debug(`WalletId:  ${walletId}`);
    logger.debug(`ContractId:${contractId}`);
    logger.debug(`Owner:     ${owner}`);
    logger.debug(`Chain:     ${chainId}`);
    logger.debug(`NFT:       ${contract}`);
    logger.debug(`tokenId:   ${tokenId}`);
    logger.debug("");
    logger.debug("  --- Basic Position Data ---");
    logger.debug(`  token0:        ${token0}`);
    logger.debug(`  token1:        ${token1}`);
    logger.debug(`  fee:           ${fee}`);
    logger.debug(`  tickLower:     ${tickLower}`);
    logger.debug(`  tickUpper:     ${tickUpper}`);
    logger.debug(`  liquidity:     ${liquidity.toString()}`);
    logger.debug(`  status:        ACTIVE`);
    if (pairLabel) logger.debug(`  pairLabel:     ${pairLabel}`);
  }

  let currentStatus = "UNKNOWN";
  let poolAddr = null;
  let currentTick = null;

  try {
    const factoryAddr = await pm.factory();
    if (factoryAddr && factoryAddr !== ethers.ZeroAddress) {
      const factory = new ethers.Contract(factoryAddr, uniswapV3FactoryAbi, provider);
      poolAddr = await factory.getPool(token0, token1, fee);

      if (poolAddr && poolAddr !== ethers.ZeroAddress) {
        const pool = new ethers.Contract(poolAddr, uniswapV3PoolAbi, provider);
        const slot0 = await pool.slot0();
        const tick = slot0.tick !== undefined ? slot0.tick : slot0[1];
        currentTick = Number(tick);

        if (Number.isFinite(currentTick)) {
          currentStatus = currentTick >= tickLower && currentTick < tickUpper ? "IN_RANGE" : "OUT_OF_RANGE";
        }
      }
    }
  } catch (err) {
    logger.warn(
      `  Could not compute range for LP token ${tokenId} (${protocol}):`,
      err?.message || err
    );
  }

  const lpClass = classifyLpRangeTier(currentStatus, tickLower, tickUpper, currentTick);
  const isActive =
    currentStatus === "OUT_OF_RANGE" && isLpTierAtLeast(lpClass.tier, LP_ALERT_MIN_TIER);

  await handleLpRangeAlert({
    userId,
    walletId,
    contractId,
    positionId: tokenId,
    prevStatus,
    currentStatus,
    isActive,
    lpRangeTier: lpClass.tier,
    tickLower,
    tickUpper,
    currentTick,
    protocol,
    wallet: owner,
  });

  if (verbose) {
    logger.debug("");
    logger.debug("  --- Range Status ---");
    if (poolAddr && currentTick != null) {
      logger.debug(`  pool:          ${poolAddr}`);
      logger.debug(`  currentTick:   ${currentTick}`);
    }
    logger.debug(`  range:         ${currentStatus}`);
    logger.debug(`  range tier:    ${lpClass.tier} (${lpClass.label})`);

    if (lpClass.positionFrac != null) {
      logger.debug(
        `  position:      ${(lpClass.positionFrac * 100).toFixed(2)}% from lower bound`
      );
    }
    if (lpClass.distanceFrac != null) {
      logger.debug(`  edge/dist:     ${(lpClass.distanceFrac * 100).toFixed(2)}% of width`);
    }

    logger.debug("========================================");
    logger.debug("");
  }

  const humanRange =
    currentStatus === "UNKNOWN" ? "with unknown range" : `and ${currentStatus.replace(/_/g, " ")}`;

  const tierPart = lpClass.tier && lpClass.tier !== "UNKNOWN" ? ` (tier ${lpClass.tier})` : "";

  logger.info(`${protocol} ${pairLabel || "UNKNOWN_PAIR"} is ACTIVE ${humanRange}${tierPart}.`);
}

// -----------------------------
// Public API: monitorLPs
// -----------------------------
async function monitorLPs(options = {}) {
  const verbose = Boolean(options.verbose);

  logger.debug("");

  const rows = getMonitoredLpRows();
  if (!rows || rows.length === 0) {
    logger.info("[LP] No enabled LP positions found in DB.");
    return;
  }

  const byChain = new Map();
  for (const r of rows) {
    const chainId = (r.chainId || "").toUpperCase();
    if (!byChain.has(chainId)) byChain.set(chainId, []);
    byChain.get(chainId).push(r);
  }

  for (const [chainId, chainRows] of byChain.entries()) {
    let provider;
    try {
      provider = getProviderForChain(chainId, CHAINS_CONFIG);
    } catch (err) {
      logger.warn(`[LP] Skipping chain ${chainId}: ${err?.message || err}`);
      continue;
    }

    for (const row of chainRows) {
      try {
        await describeLpPosition(provider, chainId, row.protocol || "UNKNOWN_PROTOCOL", row, {
          verbose,
        });
      } catch (err) {
        logger.error(
          `  [ERROR] Failed to describe LP tokenId=${row.tokenId} on ${chainId}:`,
          err?.message || err
        );
      }
    }
  }
}

module.exports = {
  monitorLPs,
  getLpSummaries,
};
