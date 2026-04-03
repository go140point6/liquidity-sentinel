// monitoring/dailyHeartbeat.js
const { EmbedBuilder } = require("discord.js");
const { getLoanSummaries, refreshLoanSnapshots } = require("./loanMonitor");
const { getLpSummaries, refreshLpSnapshots } = require("./lpMonitor");
const { createDecimalFormatter } = require("../utils/intlNumberFormats");
const { getDb } = require("../db");
const { getSpPositionSummaries } = require("../utils/stabilityPoolPositions");
const { acquireLock, releaseLock } = require("../utils/lock");
const logger = require("../utils/logger");
const { shortenTroveId } = require("../utils/ethers/shortenTroveId");
const { shortenAddress } = require("../utils/ethers/shortenAddress");
const { formatLoanTroveLink, formatLpPositionLink, formatAddressLink } = require("../utils/links");
const { loadPriceCache, isStableUsd, normalizeSymbol } = require("../utils/priceCache");
const {
  hasHeartbeatTestOverride,
  consumeHeartbeatTestOverride,
} = require("./heartbeatTest");

function requireNumberEnv(name) {
  const raw = process.env[name];
  if (!raw || String(raw).trim() === "") {
    throw new Error(`Missing env var ${name}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be numeric (got "${raw}")`);
  return n;
}

const LOAN_SNAPSHOT_STALE_WARN_MIN = requireNumberEnv("LOAN_SNAPSHOT_STALE_WARN_MIN");
const LP_SNAPSHOT_STALE_WARN_MIN = requireNumberEnv("LP_SNAPSHOT_STALE_WARN_MIN");
const SP_POSITION_SNAPSHOT_STALE_WARN_MIN = requireNumberEnv("SP_POSITION_SNAPSHOT_STALE_WARN_MIN");
const SNAPSHOT_STALE_WARN_MS = Math.max(
  0,
  Math.floor(Math.max(LOAN_SNAPSHOT_STALE_WARN_MIN, LP_SNAPSHOT_STALE_WARN_MIN, SP_POSITION_SNAPSHOT_STALE_WARN_MIN) * 60 * 1000)
);
const DEFAULT_HEARTBEAT_TZ = process.env.HEARTBEAT_TZ || "America/Los_Angeles";
const SNAPSHOT_LOCK_NAME = "snapshot-refresh";

// -----------------------------
// Formatting helpers
// -----------------------------
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function chunkFieldsBySize(fields, baseSize, maxChars) {
  const out = [];
  let current = [];
  let size = baseSize;
  for (const f of fields) {
    const fSize = (f.name?.length || 0) + (f.value?.length || 0);
    if (current.length >= 25 || size + fSize > maxChars) {
      if (current.length) out.push(current);
      current = [];
      size = baseSize;
    }
    current.push(f);
    size += fSize;
  }
  if (current.length) out.push(current);
  return out;
}

const fmt2 = createDecimalFormatter(2, 2); // commas + exactly 2 decimals
const fmt4 = createDecimalFormatter(0, 1); // commas + up to 1 decimal
const fmt5 = createDecimalFormatter(0, 5); // commas + up to 5 decimals
const fmt6 = createDecimalFormatter(0, 6); // commas + up to 6 decimals
const fmtWhole = createDecimalFormatter(0, 0);
const fmtDebt = createDecimalFormatter(2, 2);

function fmtUsd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  if (n === 0) return "$0";
  return `$${fmt2.format(n)}`;
}

function computePoolSharePct(liquidityRaw, poolLiquidityRaw) {
  if (!liquidityRaw || !poolLiquidityRaw) return null;
  try {
    const liq = BigInt(liquidityRaw);
    const pool = BigInt(poolLiquidityRaw);
    if (pool <= 0n) return null;
    const bps = (liq * 10000n) / pool; // 2 decimals
    return Number(bps) / 100;
  } catch {
    return null;
  }
}

function normalizeRangeStatus(status) {
  const s = String(status || "").toUpperCase().replace(/\s+/g, "_");
  if (s === "OUT_OF_RANGE" || s === "IN_RANGE" || s === "INACTIVE" || s === "UNKNOWN") return s;
  return "UNKNOWN";
}

function getDisplayedPoolShare(summary) {
  const rangeStatus = normalizeRangeStatus(summary?.rangeStatus || summary?.status);
  if (rangeStatus === "OUT_OF_RANGE") {
    return { pct: 0, oor: true };
  }
  const raw = computePoolSharePct(summary?.liquidity, summary?.poolLiquidity);
  if (!Number.isFinite(raw)) return { pct: null, oor: false };
  return { pct: Math.max(0, Math.min(raw, 100)), oor: false };
}

function fmtNum5(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return fmt5.format(n);
}

function fmtNum2(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return fmt2.format(n);
}

function fmtPct2(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return `${n.toFixed(2)}%`;
}

function formatTokenAmountSigned(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const out = formatTokenAmount(n);
  return n > 0 ? `+${out}` : out;
}

function formatTokenAmount(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  if (abs === 0) return "0";
  if (abs >= 1) return fmt4.format(n);
  // 3 significant digits for small values
  const decimals = Math.max(0, 3 - Math.floor(Math.log10(abs || 1)) - 1);
  const fmtSig = createDecimalFormatter(0, decimals);
  return fmtSig.format(n);
}

function parseSnapshotTs(raw) {
  if (!raw) return null;
  const iso = String(raw).includes("T") ? String(raw) : String(raw).replace(" ", "T");
  const ts = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (!Number.isFinite(ts)) return null;
  return Math.floor(ts / 1000);
}

function formatSnapshotLine(snapshotAt) {
  const ts = parseSnapshotTs(snapshotAt);
  if (!ts) return null;
  const stale = Date.now() - ts * 1000 > SNAPSHOT_STALE_WARN_MS;
  const warn = stale ? " ⚠️ Data may be stale." : "";
  return `Data captured: <t:${ts}:f>${warn}`;
}

const tzFormatterCache = new Map();
function getHeartbeatHourNow(tz) {
  const timeZone = tz || DEFAULT_HEARTBEAT_TZ;
  let fmt = tzFormatterCache.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        hour12: false,
      });
      tzFormatterCache.set(timeZone, fmt);
    } catch (_) {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        hour: "2-digit",
        hour12: false,
      });
      tzFormatterCache.set(timeZone, fmt);
      logger.warn(`[Heartbeat] Invalid timezone "${timeZone}", using UTC`);
    }
  }
  const hourStr = fmt.format(new Date());
  const hour = Number.parseInt(hourStr, 10);
  return Number.isInteger(hour) ? hour : null;
}

function loanMeaning(tier, kind, aheadPctText) {
  const t = (tier || "UNKNOWN").toString().toUpperCase();
  const label = kind === "LIQUIDATION" ? "liquidation" : "redemption";
  const aheadSuffix =
    kind === "REDEMPTION" && aheadPctText
      ? ` with ${aheadPctText} of total loan debt in front of it.`
      : ".";
  if (t === "LOW") return `Your loan is comfortably safe from ${label}${aheadSuffix}`;
  if (t === "MEDIUM") return `Your loan is safe, but at slight risk of ${label}${aheadSuffix}`;
  if (t === "HIGH") return `Your loan is at elevated risk of ${label}${aheadSuffix}`;
  if (t === "CRITICAL") return `Your loan is at severe risk of ${label}${aheadSuffix}`;
  return `${label[0].toUpperCase()}${label.slice(1)} risk is unknown.`;
}

function formatLoanField(s, priceCache) {
  const rawId = s.troveId ?? s.tokenId ?? s.positionId ?? "?";
  const idKind = s.positionLabel || "Trove";
  const troveId = shortenTroveId(rawId);
  const troveLink = formatLoanTroveLink(s.protocol, rawId, troveId);
  const title = `${s.protocol || "UNKNOWN"} (${s.chainId || "?"})`;
  const lines = [];
  lines.push(`${idKind}: ${troveLink}`);
  if (s.owner) {
    const walletText = formatAddressLink(s.chainId, s.owner) || shortenAddress(s.owner);
    lines.push(`Wallet: ${walletText}`);
    if (s.walletLabel) lines.push(`Label: **${s.walletLabel}**`);
  }

  const status = s.status || "UNKNOWN";
  lines.push(`Status: ${status}`);
  const debtText =
    typeof s.debtAmount === "number" && Number.isFinite(s.debtAmount) ? fmtDebt.format(s.debtAmount) : "n/a";
  lines.push(`Debt: ${debtText}${s.debtSymbol ? ` ${s.debtSymbol}` : ""}`);
  if (s.kind === "PRIMEFI_ACCOUNT") {
    if (s.carry24h) {
      const c = s.carry24h;
      lines.push(`24h carry: ${typeof c.netCarryUsd === "number" && Number.isFinite(c.netCarryUsd) ? fmtUsd(c.netCarryUsd) : "n/a"}`);
      const collText = typeof c.collateralDeltaUsd === "number" && Number.isFinite(c.collateralDeltaUsd)
        ? `${c.collateralDeltaUsd > 0 ? "+" : c.collateralDeltaUsd < 0 ? "-" : ""}${fmtUsd(Math.abs(Number(c.collateralDeltaUsd)))}`
        : "n/a";
      const debtText = typeof c.debtDeltaUsd === "number" && Number.isFinite(c.debtDeltaUsd)
        ? `${c.debtDeltaUsd > 0 ? "+" : c.debtDeltaUsd < 0 ? "-" : ""}${fmtUsd(Math.abs(Number(c.debtDeltaUsd)))}`
        : "n/a";
      lines.push(`24h spot moves: Collateral ${collText} | Debt ${debtText}`);
    } else {
      lines.push(`24h carry: n/a (awaiting 24h baseline)`);
    }
  }
  lines.push("");

  if (s.hasPrice && typeof s.price === "number" && typeof s.liquidationPrice === "number") {
    const liqTier = (s.liquidationTier || "UNKNOWN").toString().toUpperCase();
    const liqEmoji = {
      CRITICAL: "🟥",
      HIGH: "🟧",
      MEDIUM: "🟨",
      LOW: "🟩",
      UNKNOWN: "⬜",
    }[liqTier] || "⬜";
    const ltvText = fmtPct2(s.ltvPct);
    const bufferText =
      typeof s.liquidationBufferFrac === "number"
        ? `${(s.liquidationBufferFrac * 100).toFixed(2)}%`
        : "n/a";
    lines.push(`${liqEmoji} Liquidation risk:`);
    lines.push(
      `LTV: ${ltvText} | Price: ${fmtNum5(s.price)} | Liq: ${fmtNum5(
        s.liquidationPrice
      )} | Buffer: ${bufferText} (${liqTier})`
    );
    if (typeof s.healthFactor === 'number' && Number.isFinite(s.healthFactor)) {
      lines.push(`Health factor: ${s.healthFactor.toFixed(2)}`);
    }
    lines.push(`Meaning: ${loanMeaning(s.liquidationTier, "LIQUIDATION")}`);
    lines.push("");
  } else {
    const liqTier = (s.liquidationTier || "UNKNOWN").toString().toUpperCase();
    const liqEmoji = {
      CRITICAL: "🟥",
      HIGH: "🟧",
      MEDIUM: "🟨",
      LOW: "🟩",
      UNKNOWN: "⬜",
    }[liqTier] || "⬜";
    lines.push(`${liqEmoji} Liquidation risk:`);
    lines.push("Price / liq: *(unavailable)*");
    lines.push(`Meaning: ${loanMeaning(s.liquidationTier, "LIQUIDATION")}`);
    lines.push("");
  }

  if (typeof s.interestPct === "number") {
    const redTier = (s.redemptionTier || "UNKNOWN").toString().toUpperCase();
    const redEmoji = {
      CRITICAL: "🟥",
      HIGH: "🟧",
      MEDIUM: "🟨",
      LOW: "🟩",
      UNKNOWN: "⬜",
    }[redTier] || "⬜";
    const deltaIr =
      typeof s.globalIrPct === "number" && Number.isFinite(s.globalIrPct)
        ? s.interestPct - s.globalIrPct
        : null;
    const deltaText =
      deltaIr == null || !Number.isFinite(deltaIr)
        ? "Δ n/a"
        : `Δ ${deltaIr >= 0 ? "+" : ""}${deltaIr.toFixed(2)} pp`;
    lines.push(`${redEmoji} Redemption risk:`);
    lines.push(
      `IR: ${s.interestPct.toFixed(2)}% | Global: ${
        typeof s.globalIrPct === "number" ? s.globalIrPct.toFixed(2) : "n/a"
      }% | ${deltaText}`
    );
    const debtAheadText = fmtNum2(s.redemptionDebtAhead);
    const debtTotalText = fmtNum2(s.redemptionTotalDebt);
    const aheadPctText =
      typeof s.redemptionDebtAheadPct === "number" && Number.isFinite(s.redemptionDebtAheadPct)
        ? `${(s.redemptionDebtAheadPct * 100).toFixed(2)}%`
        : "n/a";
    lines.push(
      `Debt ahead: ${debtAheadText} | Total: ${debtTotalText} | Ahead: ${aheadPctText} (${s.redemptionTier || "UNKNOWN"})`
    );
    lines.push(`Meaning: ${loanMeaning(s.redemptionTier, "REDEMPTION", aheadPctText)}`);
  }

  return { name: title, value: lines.join("\n") };
}

function lpPoolKey(s) {
  const pair =
    s.pairLabel ||
    `${s.token0Symbol || s.token0 || "?"}-${s.token1Symbol || s.token1 || "?"}`;
  return `${s.chainId || "?"}|${s.protocol || "UNKNOWN"}|${s.poolAddr || pair}`;
}

function isAlmPosition(s) {
  if (!s) return false;
  if (String(s.positionModel || "").toUpperCase() === "ALM") return true;
  if (String(s.contractKind || "").toUpperCase() === "LP_ALM") return true;
  return String(s.protocol || "").toUpperCase().includes("_ALM_");
}

function formatLpField(s, priceCache) {
  const tokenId = s.tokenId ?? s.positionId ?? "?";
  const tokenLink = formatLpPositionLink(s.protocol, tokenId, shortenTroveId(tokenId));
  const pair =
    s.pairLabel ||
    `${s.token0Symbol || s.token0 || "?"}-${s.token1Symbol || s.token1 || "?"}`;

  const rangeStatus = (s.rangeStatus || "UNKNOWN").toString().toUpperCase();
  const statusEmoji = {
    OUT_OF_RANGE: "🔴",
    IN_RANGE: "🟢",
    UNKNOWN: "⚪",
    INACTIVE: "⚫",
  }[rangeStatus] || "⚪";

  const title = `${s.protocol || "UNKNOWN"} ${pair} (${s.chainId || "?"})`;
  const parts = [];
  parts.push(`Token: ${tokenLink}`);
  if (s.owner) {
    const walletText = formatAddressLink(s.chainId, s.owner) || shortenAddress(s.owner);
    parts.push(`Wallet: ${walletText}`);
    if (s.walletLabel) parts.push(`Label: **${s.walletLabel}**`);
  }

  const chainId = String(s.chainId || "").toUpperCase();
  const priceMap = priceCache?.get(chainId);
  const baseSym = normalizeSymbol(s.priceBaseSymbol || s.token0Symbol || s.token0);
  const quoteSym = normalizeSymbol(s.priceQuoteSymbol || s.token1Symbol || s.token1);
  let priceBase = Number(priceMap?.get(baseSym));
  let priceQuote = Number(priceMap?.get(quoteSym));
  const price = Number(s.currentPrice);

  if (!Number.isFinite(priceBase) && isStableUsd(chainId, baseSym)) priceBase = 1;
  if (!Number.isFinite(priceQuote) && isStableUsd(chainId, quoteSym)) priceQuote = 1;

  if (!Number.isFinite(priceBase) && Number.isFinite(priceQuote) && Number.isFinite(price) && price > 0) {
    priceBase = priceQuote * price;
  } else if (
    !Number.isFinite(priceQuote) &&
    Number.isFinite(priceBase) &&
    Number.isFinite(price) &&
    price > 0
  ) {
    priceQuote = priceBase / price;
  }

  const hasAmounts =
    typeof s.amount0 === "number" &&
    Number.isFinite(s.amount0) &&
    typeof s.amount1 === "number" &&
    Number.isFinite(s.amount1);

  if (hasAmounts) {
    const sym0 = s.token0Symbol || "token0";
    const sym1 = s.token1Symbol || "token1";
    const usd0 =
      Number.isFinite(s.amount0) && Number.isFinite(priceBase)
        ? fmtUsd(s.amount0 * priceBase)
        : null;
    const usd1 =
      Number.isFinite(s.amount1) && Number.isFinite(priceQuote)
        ? fmtUsd(s.amount1 * priceQuote)
        : null;
    parts.push(
      `Principal: ${formatTokenAmount(s.amount0)} ${sym0}${usd0 ? ` (${usd0})` : ""}, ` +
        `${formatTokenAmount(s.amount1)} ${sym1}${usd1 ? ` (${usd1})` : ""}`
    );
  } else if (s.liquidity) {
    parts.push(`Principal: ${s.liquidity}`);
  }

  if (
    typeof s.fees0 === "number" &&
    Number.isFinite(s.fees0) &&
    typeof s.fees1 === "number" &&
    Number.isFinite(s.fees1)
  ) {
    const sym0 = s.token0Symbol || "token0";
    const sym1 = s.token1Symbol || "token1";
    const f0Usd =
      Number.isFinite(s.fees0) && Number.isFinite(priceBase) ? fmtUsd(s.fees0 * priceBase) : null;
    const f1Usd =
      Number.isFinite(s.fees1) && Number.isFinite(priceQuote) ? fmtUsd(s.fees1 * priceQuote) : null;
    parts.push(
      `Uncollected fees: ${formatTokenAmount(s.fees0)} ${sym0}${f0Usd ? ` (${f0Usd})` : ""}, ` +
        `${formatTokenAmount(s.fees1)} ${sym1}${f1Usd ? ` (${f1Usd})` : ""}`
    );
  }

  parts.push(`Status: ${s.status || "UNKNOWN"} | Range: ${statusEmoji} ${rangeStatus}`);

  if (s.lpRangeTier && s.lpRangeTier !== "UNKNOWN") {
    const tier = s.lpRangeTier.toString().toUpperCase();
    const tierEmoji = { CRITICAL: "🟥", HIGH: "🟧", MEDIUM: "🟨", LOW: "🟩", UNKNOWN: "⬜" }[tier] || "⬜";
    parts.push(
      `Range tier: ${tierEmoji} ${s.lpRangeTier}${s.lpRangeLabel ? ` (${s.lpRangeLabel})` : ""}`
    );
  }

  return { name: title, value: parts.join("\n") };
}

function formatAlmLpField(s, priceCache) {
  const tokenId = s.tokenId ?? s.positionId ?? "?";
  const tokenLink = formatLpPositionLink(s.protocol, tokenId, shortenTroveId(tokenId));
  const pair =
    s.pairLabel ||
    `${s.token0Symbol || s.token0 || "?"}-${s.token1Symbol || s.token1 || "?"}`;
  const title = `${s.protocol || "UNKNOWN"} ${pair} (${s.chainId || "?"})`;
  const parts = [];
  parts.push(`Vault: ${tokenLink}`);
  if (s.owner) {
    const walletText = formatAddressLink(s.chainId, s.owner) || shortenAddress(s.owner);
    parts.push(`Wallet: ${walletText}`);
    if (s.walletLabel) parts.push(`Label: **${s.walletLabel}**`);
  }

  const chainId = String(s.chainId || "").toUpperCase();
  const priceMap = priceCache?.get(chainId);
  const baseSym = normalizeSymbol(s.priceBaseSymbol || s.token0Symbol || s.token0);
  const quoteSym = normalizeSymbol(s.priceQuoteSymbol || s.token1Symbol || s.token1);
  let priceBase = Number(priceMap?.get(baseSym));
  let priceQuote = Number(priceMap?.get(quoteSym));
  const price = Number(s.currentPrice);

  if (!Number.isFinite(priceBase) && isStableUsd(chainId, baseSym)) priceBase = 1;
  if (!Number.isFinite(priceQuote) && isStableUsd(chainId, quoteSym)) priceQuote = 1;
  if (!Number.isFinite(priceBase) && Number.isFinite(priceQuote) && Number.isFinite(price) && price > 0) {
    priceBase = priceQuote * price;
  } else if (
    !Number.isFinite(priceQuote) &&
    Number.isFinite(priceBase) &&
    Number.isFinite(price) &&
    price > 0
  ) {
    priceQuote = priceBase / price;
  }

  const sharePctRaw = Number.isFinite(s.almSharePct)
    ? Number(s.almSharePct)
    : computePoolSharePct(s.liquidity, s.poolLiquidity);
  const sharePct = Number.isFinite(sharePctRaw)
    ? Math.max(0, Math.min(sharePctRaw, 100))
    : null;
  if (Number.isFinite(sharePct)) {
    parts.push(`Your share: **${sharePct.toFixed(2)}%**`);
  }


  const sym0 = s.token0Symbol || "token0";
  const sym1 = s.token1Symbol || "token1";

  if (
    typeof s.vaultTotalAmount0 === "number" &&
    Number.isFinite(s.vaultTotalAmount0) &&
    typeof s.vaultTotalAmount1 === "number" &&
    Number.isFinite(s.vaultTotalAmount1)
  ) {
    parts.push(
      `Vault total: ${formatTokenAmount(s.vaultTotalAmount0)} ${sym0}, ` +
        `${formatTokenAmount(s.vaultTotalAmount1)} ${sym1}`
    );
  }

  if (
    typeof s.amount0 === "number" &&
    Number.isFinite(s.amount0) &&
    typeof s.amount1 === "number" &&
    Number.isFinite(s.amount1)
  ) {
    const usd0 = Number.isFinite(priceBase) ? fmtUsd(s.amount0 * priceBase) : null;
    const usd1 = Number.isFinite(priceQuote) ? fmtUsd(s.amount1 * priceQuote) : null;
    parts.push(
      `Your vault share value: ${formatTokenAmount(s.amount0)} ${sym0}${usd0 ? ` (${usd0})` : ""}, ` +
        `${formatTokenAmount(s.amount1)} ${sym1}${usd1 ? ` (${usd1})` : ""}`
    );
  }

  if (s.almSinceStart) {
    const d0Num = Number(s.almSinceStart.strategyDeltaAmount0);
    const d1Num = Number(s.almSinceStart.strategyDeltaAmount1);
    const cur0 = Number(s.amount0);
    const cur1 = Number(s.amount1);

    const hold0Num = Number.isFinite(cur0) && Number.isFinite(d0Num) ? cur0 - d0Num : null;
    const hold1Num = Number.isFinite(cur1) && Number.isFinite(d1Num) ? cur1 - d1Num : null;
    if (Number.isFinite(hold0Num) || Number.isFinite(hold1Num)) {
      const h0Usd = Number.isFinite(hold0Num) && Number.isFinite(priceBase) ? fmtUsd(hold0Num * priceBase) : null;
      const h1Usd = Number.isFinite(hold1Num) && Number.isFinite(priceQuote) ? fmtUsd(hold1Num * priceQuote) : null;
      parts.push(
        `Your token values just holding: ${Number.isFinite(hold0Num) ? `${formatTokenAmount(hold0Num)} ${sym0}${h0Usd ? ` (${h0Usd})` : ""}` : `- ${sym0}`}, ` +
          `${Number.isFinite(hold1Num) ? `${formatTokenAmount(hold1Num)} ${sym1}${h1Usd ? ` (${h1Usd})` : ""}` : `- ${sym1}`}`
      );
    }

    const needsBase = Number.isFinite(d0Num) && d0Num !== 0;
    const needsQuote = Number.isFinite(d1Num) && d1Num !== 0;
    if ((needsBase && !Number.isFinite(priceBase)) || (needsQuote && !Number.isFinite(priceQuote))) {
      logger.warn(
        `[dailyHeartbeat][ALM][USD_MISSING] chain=${s.chainId || "?"} protocol=${s.protocol || "UNKNOWN"} token=${s.tokenId || "?"} ` +
        `pair=${sym0}/${sym1} price_${sym0}=${Number.isFinite(priceBase) ? priceBase : "n/a"} ` +
        `price_${sym1}=${Number.isFinite(priceQuote) ? priceQuote : "n/a"}`
      );
    }

    const canPriceUsd = (!needsBase || Number.isFinite(priceBase)) && (!needsQuote || Number.isFinite(priceQuote));
    if (canPriceUsd) {
      const usdDelta =
        (Number.isFinite(d0Num) && Number.isFinite(priceBase) ? d0Num * priceBase : 0) +
        (Number.isFinite(d1Num) && Number.isFinite(priceQuote) ? d1Num * priceQuote : 0);
      if (usdDelta > 0) {
        parts.push(`Strategy verdict: 📈 Gain of ${fmtUsd(usdDelta)} vs. just holding`);
      } else if (usdDelta < 0) {
        parts.push(`Strategy verdict: 📉 Loss of ${fmtUsd(Math.abs(usdDelta))} vs. just holding`);
      } else {
        parts.push(`Strategy verdict: ⚖️ Flat vs. just holding`);
      }
    } else {
      parts.push(`Strategy verdict: ⚪ USD comparison unavailable (missing price)`);
    }
  }
  return { name: title, value: parts.join("\n") };
}

function formatSpField(s) {
  const title = `${s.poolLabel || s.poolKey || "Unknown"} (${s.chainId || "?"})`;
  const lines = [];
  if (s.walletAddress) {
    const walletText = formatAddressLink(s.chainId, s.walletAddress) || shortenAddress(s.walletAddress);
    lines.push(`Wallet: ${walletText}`);
    if (s.walletLabel) lines.push(`Label: **${s.walletLabel}**`);
  }
  lines.push(`Current deposit: **${fmtNum2(Number(s.compoundedDeposit))} CDP**`);
  lines.push(`Pending CDP yield: **${fmtNum2(Number(s.yieldGain))} CDP**`);
  lines.push(`Claimable collateral: **${fmtNum5(Number(s.claimableCollateral))} ${s.collSymbol || "COLL"}**`);
  lines.push(`Pool share: **${fmtPct2(Number(s.poolSharePct))}**`);
  return { name: title, value: lines.join("\n") };
}

function worstLoanTier(loans) {
  const order = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];
  let worst = "UNKNOWN";
  for (const s of loans || []) {
    const tier = (s.liquidationTier || "UNKNOWN").toString().toUpperCase();
    if (order.indexOf(tier) !== -1 && order.indexOf(tier) < order.indexOf(worst)) worst = tier;
  }
  return worst;
}

function worstLpStatus(lps) {
  const order = ["OUT_OF_RANGE", "IN_RANGE", "UNKNOWN", "INACTIVE"];
  let worst = "UNKNOWN";
  for (const s of lps || []) {
    const st = (s.rangeStatus || "UNKNOWN").toString().toUpperCase();
    if (order.indexOf(st) !== -1 && order.indexOf(st) < order.indexOf(worst)) worst = st;
  }
  return worst;
}

function colorForLoanTier(tier) {
  return (
    {
      CRITICAL: "Red",
      HIGH: "Orange",
      MEDIUM: "Yellow",
      LOW: "Green",
      UNKNOWN: "Grey",
    }[tier] || "Grey"
  );
}

function colorForLpStatus(status) {
  return (
    {
      OUT_OF_RANGE: "Red",
      IN_RANGE: "Green",
      UNKNOWN: "Grey",
      INACTIVE: "DarkGrey",
    }[status] || "Grey"
  );
}

function buildHeartbeatEmbeds({ nowIso, loanSummaries, lpSummaries, spSummaries, client, priceCache }) {
  const embeds = [];
  const activeLoanSummaries = (loanSummaries || []).filter(
    (s) => String(s.status || "").toUpperCase() !== "CLOSED"
  );
  const activeLpSummaries = (lpSummaries || []).filter((s) => {
    const status = String(s.status || s.rangeStatus || "").toUpperCase();
    return status !== "INACTIVE";
  });
  const activeRegularLpSummaries = activeLpSummaries.filter((s) => !isAlmPosition(s));
  const activeAlmLpSummaries = activeLpSummaries.filter((s) => isAlmPosition(s));
  const activeSpSummaries = (spSummaries || []).filter((s) => Number(s.compoundedDeposit) > 0 || Number(s.yieldGain) > 0 || Number(s.claimableCollateral) > 0);
  const loanCount = activeLoanSummaries.length;
  const lpCount = activeRegularLpSummaries.length;
  const almCount = activeAlmLpSummaries.length;
  const spCount = activeSpSummaries.length;

  const snapshotTimes = []
    .concat(activeLoanSummaries)
    .concat(activeLpSummaries)
    .concat(activeSpSummaries)
    .map((s) => parseSnapshotTs(s?.snapshotAt))
    .filter((v) => v != null);
  const latestSnapshot = snapshotTimes.length ? Math.max(...snapshotTimes) : null;
  const snapshotLine = latestSnapshot
    ? formatSnapshotLine(new Date(latestSnapshot * 1000).toISOString())
    : null;

  const headerLines = [`Loans: **${loanCount}** | LPs: **${lpCount}** | ALMs: **${almCount}** | SPs: **${spCount}**`];
  if (snapshotLine) headerLines.push("", snapshotLine);

  const header = new EmbedBuilder()
    .setTitle("24h DeFi Heartbeat")
    .setDescription(headerLines.join("\n"))
    .setColor("DarkBlue");

  if (client?.user) header.setThumbnail(client.user.displayAvatarURL());
  embeds.push(header);

  const loanFields = activeLoanSummaries
    .slice()
    .sort((a, b) => {
      const av = typeof a.ltvPct === "number" ? a.ltvPct : -1;
      const bv = typeof b.ltvPct === "number" ? b.ltvPct : -1;
      return bv - av;
    })
    .map((s) => formatLoanField(s, priceCache));

  if (!loanFields.length) {
    embeds.push(
      new EmbedBuilder().setTitle("Loans").setDescription("_No monitored loans_").setColor("DarkBlue")
    );
  } else {
    const baseSize = "Loans".length + 200;
    const MAX_EMBED_CHARS = 5200;
    const chunks = chunkFieldsBySize(loanFields, baseSize, MAX_EMBED_CHARS);
    chunks.forEach((fields, idx) => {
      const fieldIds = new Set(fields.map((f) => f.name));
      const chunkLoans = activeLoanSummaries.filter((s) => {
        const rawId = s.troveId ?? s.tokenId ?? s.positionId ?? "?";
        const troveId = shortenTroveId(rawId);
        const title = `${s.protocol || "UNKNOWN"} (${s.chainId || "?"}) — trove ${troveId}`;
        const tier = (s.liquidationTier || "UNKNOWN").toString().toUpperCase();
        const tierEmoji = {
          CRITICAL: "🟥",
          HIGH: "🟧",
          MEDIUM: "🟨",
          LOW: "🟩",
          UNKNOWN: "⬜",
        }[tier] || "⬜";
        return fieldIds.has(`${tierEmoji} ${title}`);
      });
      const e = new EmbedBuilder()
        .setTitle(idx === 0 ? "Loans" : "Loans (cont.)")
        .setColor("DarkBlue")
        .addFields(fields);
      embeds.push(e);
    });
  }

  const order = { OUT_OF_RANGE: 0, UNKNOWN: 1, IN_RANGE: 2 };
  const regularLpFields = activeRegularLpSummaries
    .slice()
    .sort((a, b) => {
      const ra = order[a.rangeStatus] ?? 99;
      const rb = order[b.rangeStatus] ?? 99;
      if (ra !== rb) return ra - rb;
      return (a.protocol || "").localeCompare(b.protocol || "");
    })
    .map((s) => formatLpField(s, priceCache));
  const almLpFields = activeAlmLpSummaries
    .slice()
    .sort((a, b) => {
      const pa = (a.protocol || "").localeCompare(b.protocol || "");
      if (pa !== 0) return pa;
      return (a.pairLabel || "").localeCompare(b.pairLabel || "");
    })
    .map((s) => formatAlmLpField(s, priceCache));

  const poolShareTotals = new Map();
  const poolMeta = new Map();
  for (const s of activeLpSummaries) {
    const shareInfo = getDisplayedPoolShare(s);
    if (shareInfo.pct == null || !Number.isFinite(shareInfo.pct)) continue;
    const key = lpPoolKey(s);
    poolShareTotals.set(key, (poolShareTotals.get(key) || 0) + shareInfo.pct);
    if (!poolMeta.has(key)) {
      const pair =
        s.pairLabel ||
        `${s.token0Symbol || s.token0 || "?"}-${s.token1Symbol || s.token1 || "?"}`;
      poolMeta.set(key, {
        protocol: s.protocol || "UNKNOWN",
        chainId: s.chainId || "?",
        pair,
      });
    }
  }

  if (poolShareTotals.size) {
    const summaryFields = [];
    for (const [key, pct] of poolShareTotals.entries()) {
      const meta = poolMeta.get(key);
      const name = `${meta?.protocol || "UNKNOWN"} ${meta?.pair || "?"} (${meta?.chainId || "?"})`;
      summaryFields.push({
        name,
        value: `Total pool share: **${pct.toFixed(2)}%**`,
        inline: false,
        _pct: pct,
      });
    }
    summaryFields.sort((a, b) => (b._pct || 0) - (a._pct || 0));
    const summaryChunks = chunkFieldsBySize(summaryFields, "Total LP Pool Share".length + 200, 5200);
    summaryChunks.forEach((fields, idx) => {
      const e = new EmbedBuilder()
        .setTitle(idx === 0 ? "Total LP Pool Share" : "Total LP Pool Share (cont.)")
        .setColor("DarkBlue")
        .addFields(fields);
      embeds.push(e);
    });
  }

  if (!regularLpFields.length) {
    embeds.push(
      new EmbedBuilder()
        .setTitle("LP Positions")
        .setDescription("_No monitored LP positions_")
        .setColor("DarkBlue")
    );
  } else {
    const baseSize = "LP Positions".length + 200;
    const MAX_EMBED_CHARS = 5200;
    const chunks = chunkFieldsBySize(regularLpFields, baseSize, MAX_EMBED_CHARS);
    chunks.forEach((fields, idx) => {
      const fieldIds = new Set(fields.map((f) => f.name));
      const chunkLps = activeRegularLpSummaries.filter((s) => {
        const tokenId = s.tokenId ?? s.positionId ?? "?";
        const pair =
          s.pairLabel ||
          `${s.token0Symbol || s.token0 || "?"}-${s.token1Symbol || s.token1 || "?"}`;
        const title = `${s.protocol || "UNKNOWN"} ${pair} (${s.chainId || "?"}) — token ${shortenTroveId(
          tokenId
        )}`;
        return fieldIds.has(title);
      });
      const e = new EmbedBuilder()
        .setTitle(idx === 0 ? "LP Positions" : "LP Positions (cont.)")
        .setColor("DarkBlue")
        .addFields(fields);
      embeds.push(e);
    });
  }

  if (almLpFields.length) {
    const baseSize = "ALM LP Positions".length + 200;
    const MAX_EMBED_CHARS = 5200;
    const chunks = chunkFieldsBySize(almLpFields, baseSize, MAX_EMBED_CHARS);
    chunks.forEach((fields, idx) => {
      const e = new EmbedBuilder()
        .setTitle(idx === 0 ? "ALM LP Positions" : "ALM LP Positions (cont.)")
        .setColor("DarkBlue")
        .addFields(fields);
      if (idx === 0) {
        e.setDescription("_Managed vault positions shown with share and value metrics._");
      }
      embeds.push(e);
    });
  }

  const spFields = activeSpSummaries
    .slice()
    .sort((a, b) => {
      const av = Number(a.compoundedDeposit) || 0;
      const bv = Number(b.compoundedDeposit) || 0;
      if (bv !== av) return bv - av;
      return String(a.poolLabel || "").localeCompare(String(b.poolLabel || ""));
    })
    .map((s) => formatSpField(s));

  if (spFields.length) {
    const baseSize = "Stability Pools".length + 200;
    const MAX_EMBED_CHARS = 5200;
    const chunks = chunkFieldsBySize(spFields, baseSize, MAX_EMBED_CHARS);
    chunks.forEach((fields, idx) => {
      const e = new EmbedBuilder()
        .setTitle(idx === 0 ? "Stability Pools" : "Stability Pools (cont.)")
        .setColor("DarkBlue")
        .addFields(fields);
      if (idx === 0) {
        e.setDescription("_Current deposit is compounded CDP. Claimable collateral includes stashed + newly accrued collateral._");
      }
      embeds.push(e);
    });
  }

  if (embeds.length) {
    embeds[embeds.length - 1].setTimestamp();
  }
  return embeds;
}

// -----------------------------
// Recipient selection (DB-driven)
// -----------------------------
function getHeartbeatRecipients() {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT DISTINCT
      u.id           AS userId,
      u.discord_id   AS discordId,
      u.discord_name AS discordName,
      u.heartbeat_hour AS heartbeatHour,
      u.heartbeat_enabled AS heartbeatEnabled,
      u.heartbeat_tz AS heartbeatTz
    FROM users u
    JOIN user_wallets uw
      ON uw.user_id = u.id
     AND uw.is_enabled = 1
    WHERE
      u.accepts_dm = 1
      AND u.discord_id IS NOT NULL
  `
    )
    .all();
}

// If DM is blocked, stop trying daily until user re-enables via onboarding.
function markUserCannotDm(userId) {
  try {
    const db = getDb();
    db.prepare(
      `
      UPDATE users
      SET accepts_dm = 0,
          updated_at = datetime('now')
      WHERE id = ?
    `
    ).run(userId);
  } catch (e) {
    logger.warn(`[Heartbeat] Failed to mark accepts_dm=0 for userId=${userId}:`, e?.message || e);
  }
}

// -----------------------------
// Main
// -----------------------------
async function sendDailyHeartbeat(client) {
  if (!client?.users?.fetch) {
    throw new Error("[Heartbeat] Discord client not available (client.users.fetch missing).");
  }

  const recipients = getHeartbeatRecipients();
  if (!recipients || recipients.length === 0) {
    logger.info("[Heartbeat] No recipients (accepts_dm=1 with enabled wallets).");
    return;
  }
  const filteredRecipients = recipients.filter((r) => {
    const discordId = String(r.discordId || r.discord_id || "");
    if (hasHeartbeatTestOverride(discordId)) return true;
    if ((r.heartbeatEnabled ?? 1) !== 1) return false;
    const tz = r.heartbeatTz || DEFAULT_HEARTBEAT_TZ;
    const nowHour = getHeartbeatHourNow(tz);
    if (nowHour == null) return false;
    return Number(r.heartbeatHour ?? 3) === nowHour;
  });

  if (!filteredRecipients.length) {
    logger.info("[Heartbeat] No recipients scheduled for this hour.");
    return;
  }

  let allLoanSummaries = [];
  let allLpSummaries = [];
  try {
    [allLoanSummaries, allLpSummaries] = await Promise.all([getLoanSummaries(), getLpSummaries()]);
  } catch (err) {
    logger.error("[Heartbeat] Failed to fetch summaries:", err?.message || err);
    return;
  }

  const latestSnapshotTs = []
    .concat(allLoanSummaries || [])
    .concat(allLpSummaries || [])
    .map((s) => parseSnapshotTs(s?.snapshotAt))
    .filter((v) => v != null)
    .reduce((max, v) => (v > max ? v : max), 0);
  const latestSnapshotMs = latestSnapshotTs ? latestSnapshotTs * 1000 : 0;
  const isStale = !latestSnapshotMs || Date.now() - latestSnapshotMs > SNAPSHOT_STALE_WARN_MS;

  if (isStale) {
    logger.warn("[Heartbeat] Snapshot data stale; refreshing before send.");
    const lockPath = acquireLock(SNAPSHOT_LOCK_NAME);
    if (!lockPath) {
      logger.warn("[Heartbeat] Snapshot refresh lock busy; using stale data.");
    } else {
      try {
        await refreshLoanSnapshots();
      } catch (err) {
        logger.warn("[Heartbeat] Loan snapshot refresh failed:", err?.message || err);
      }
      try {
        await refreshLpSnapshots();
      } catch (err) {
        logger.warn("[Heartbeat] LP snapshot refresh failed:", err?.message || err);
      }
      try {
        [allLoanSummaries, allLpSummaries] = await Promise.all([
          getLoanSummaries(),
          getLpSummaries(),
        ]);
      } catch (err) {
        logger.error("[Heartbeat] Failed to re-fetch summaries; using stale data:", err?.message || err);
      } finally {
        releaseLock(lockPath);
      }
    }
  }

  const nowIso = new Date().toISOString();
  const db = getDb();

  const userCache = new Map(); // discordId -> Discord.User

  for (const r of filteredRecipients) {
    const userIdKey = String(r.userId);
    const discordId = String(r.discordId);
    consumeHeartbeatTestOverride(discordId);

    const userLoans = (allLoanSummaries || []).filter((s) => String(s.userId) === userIdKey);
    const userLps = (allLpSummaries || []).filter((s) => String(s.userId) === userIdKey);
    const userSps = getSpPositionSummaries(db, Number(r.userId));

    const priceCache = loadPriceCache(db);
    const embeds = buildHeartbeatEmbeds({
      nowIso,
      loanSummaries: userLoans,
      lpSummaries: userLps,
      spSummaries: userSps,
      client,
      priceCache,
    });

    try {
      let user = userCache.get(discordId);
      if (!user) {
        user = await client.users.fetch(discordId);
        userCache.set(discordId, user);
      }

      for (const e of embeds) {
        await user.send({ embeds: [e] });
      }

      logger.info(`[Heartbeat] Sent daily heartbeat to userId=${r.userId} discordId=${discordId}`);
    } catch (err) {
      const code = err?.code;
      const msgText = err?.message || String(err);

      logger.error(
        `[Heartbeat] Failed to send to discordId=${discordId} (userId=${r.userId}):`,
        msgText
      );

      if (code === 50007) {
        markUserCannotDm(r.userId);
        logger.warn(`[Heartbeat] Marked accepts_dm=0 (DM blocked) for userId=${r.userId}`);
      }
    }
  }
}

module.exports = { sendDailyHeartbeat };
