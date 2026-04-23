const { ethers } = require("ethers");
const primefiConfig = require("../data/primefi_loans.json");
const { getDb } = require("../db");
const logger = require("../utils/logger");
const { getProviderForChain } = require("../utils/ethers/providers");
const { loadPriceCache, isStableUsd, normalizeSymbol } = require("../utils/priceCache");

function requireNumberEnv(name) {
  const raw = process.env[name];
  if (!raw || String(raw).trim() === "") throw new Error(`Missing env var ${name}`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be numeric (got \"${raw}\")`);
  return n;
}

const LIQ_BUFFER_WARN = requireNumberEnv("LIQ_BUFFER_WARN");
const LIQ_BUFFER_HIGH = requireNumberEnv("LIQ_BUFFER_HIGH");
const LIQ_BUFFER_CRIT = requireNumberEnv("LIQ_BUFFER_CRIT");
const CHAINS_CONFIG = {
  FLR: { rpcEnvKey: "FLR_MAINNET" },
  XDC: { rpcEnvKey: "XDC_MAINNET" },
};
const DAY_MS = 24 * 60 * 60 * 1000;

const lendingPoolAbi = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralETH,uint256 totalDebtETH,uint256 availableBorrowsETH,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
];

const dataProviderAbi = [
  "function getUserReserveData(address asset,address user) view returns (uint256 currentATokenBalance,uint256 currentStableDebt,uint256 currentVariableDebt,uint256 principalStableDebt,uint256 scaledVariableDebt,uint256 stableBorrowRate,uint256 liquidityRate,uint40 stableRateLastUpdated,bool usageAsCollateralEnabled)",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,bool usageAsCollateralEnabled,bool borrowingEnabled,bool stableBorrowRateEnabled,bool isActive,bool isFrozen)",
];

function classifyLiquidationRisk(bufferFrac) {
  if (bufferFrac == null || !Number.isFinite(bufferFrac)) return { tier: "UNKNOWN" };
  if (bufferFrac <= LIQ_BUFFER_CRIT) return { tier: "CRITICAL" };
  if (bufferFrac <= LIQ_BUFFER_HIGH) return { tier: "HIGH" };
  if (bufferFrac <= LIQ_BUFFER_WARN) return { tier: "MEDIUM" };
  return { tier: "LOW" };
}

function getPrimefiMarkets(chainId = null) {
  const chains = primefiConfig?.chains || {};
  const entries = [];
  for (const [cid, cfg] of Object.entries(chains)) {
    if (chainId && String(chainId).toUpperCase() !== String(cid).toUpperCase()) continue;
    for (const market of cfg?.markets || []) {
      entries.push({ chainId: String(cid).toUpperCase(), ...market });
    }
  }
  return entries;
}

function getPriceForSymbol(priceMap, chainId, symbol) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return null;
  let price = Number(priceMap?.get(sym));
  if (!Number.isFinite(price) && sym === "WXDC") price = Number(priceMap?.get("XDC"));
  if (!Number.isFinite(price) && isStableUsd(chainId, sym)) price = 1;
  return Number.isFinite(price) && price > 0 ? price : null;
}

function toNumUnits(raw, decimals) {
  try {
    const n = Number(ethers.formatUnits(raw, decimals));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function parseSnapshotTs(raw) {
  if (!raw) return null;
  const iso = String(raw).includes("T") ? String(raw) : String(raw).replace(" ", "T");
  const ms = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function deriveOriginBaselineFromEvents(db, summary) {
  if (!summary || !summary.owner || !summary.marketKey) return null;
  const rows = db.prepare(`
    SELECT event_name, event_json
    FROM primefi_market_events
    WHERE chain_id = ? AND market_key = ? AND user_lower = ?
    ORDER BY block_number ASC, log_index ASC, id ASC
  `).all(String(summary.chainId || '').toUpperCase(), String(summary.marketKey), String(summary.owner || '').toLowerCase());

  if (!rows.length) return null;
  let collateralPrincipal = 0;
  let debtPrincipal = 0;
  for (const r of rows) {
    let ev;
    try { ev = JSON.parse(r.event_json); } catch { continue; }
    const name = String(r.event_name || ev?.event || '');
    if (name === 'Deposit') {
      collateralPrincipal += Number(ev.amountNum || 0);
    } else if (name === 'Withdraw') {
      collateralPrincipal -= Number(ev.amountNum || 0);
    } else if (name === 'Borrow') {
      debtPrincipal += Number(ev.amountNum || 0);
    } else if (name === 'Repay') {
      debtPrincipal -= Number(ev.amountNum || 0);
    } else if (name === 'LiquidationCall') {
      collateralPrincipal -= Number(ev.liquidatedCollateralAmountNum || 0);
      debtPrincipal -= Number(ev.debtToCoverNum || 0);
    }
  }
  if (!Number.isFinite(collateralPrincipal) && !Number.isFinite(debtPrincipal)) return null;
  collateralPrincipal = Number.isFinite(collateralPrincipal) ? Math.max(0, collateralPrincipal) : 0;
  debtPrincipal = Number.isFinite(debtPrincipal) ? Math.max(0, debtPrincipal) : 0;
  const collateralGrowthAmount = Number(summary.collAmount) - collateralPrincipal;
  const debtGrowthAmount = Number(summary.debtAmount) - debtPrincipal;
  const collateralGrowthUsd = Number.isFinite(Number(summary.price)) ? collateralGrowthAmount * Number(summary.price) : null;
  const debtGrowthUsd = Number(debtGrowthAmount);
  const netCarryUsd = Number.isFinite(collateralGrowthUsd) && Number.isFinite(debtGrowthUsd)
    ? collateralGrowthUsd - debtGrowthUsd
    : null;
  return {
    collateralPrincipal,
    debtPrincipal,
    collateralGrowthAmount,
    debtGrowthAmount,
    collateralGrowthUsd,
    debtGrowthUsd,
    netCarryUsd,
  };
}

function enrichPrimefiSummary(db, summary, historyRows) {
  if (!summary || typeof summary !== "object") return summary;
  const rows = (historyRows || [])
    .map((r) => {
      try {
        return { ...JSON.parse(r.snapshot_json), snapshotAt: r.snapshot_at };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (parseSnapshotTs(a.snapshotAt) || 0) - (parseSnapshotTs(b.snapshotAt) || 0));

  if (!rows.length) return summary;
  const first = rows[0];
  const nowTs = parseSnapshotTs(summary.snapshotAt) || Date.now();
  const target24h = nowTs - DAY_MS;
  let nearest24h = null;
  for (const row of rows) {
    const ts = parseSnapshotTs(row.snapshotAt);
    if (ts != null && ts <= target24h) nearest24h = row;
  }
  const mkCarry = (base) => {
    if (!base) return null;
    const collateralDeltaAmount = Number(summary.collAmount) - Number(base.collAmount);
    const debtDeltaAmount = Number(summary.debtAmount) - Number(base.debtAmount);
    const collateralDeltaUsd = Number.isFinite(Number(summary.price)) ? collateralDeltaAmount * Number(summary.price) : null;
    const debtDeltaUsd = Number(debtDeltaAmount);
    const netCarryUsd = Number.isFinite(collateralDeltaUsd) && Number.isFinite(debtDeltaUsd)
      ? collateralDeltaUsd - debtDeltaUsd
      : null;
    return {
      collateralDeltaAmount,
      debtDeltaAmount,
      collateralDeltaUsd,
      debtDeltaUsd,
      netCarryUsd,
      baseSnapshotAt: base.snapshotAt,
    };
  };

  summary.carrySinceTracking = mkCarry(first);
  summary.carry24h = mkCarry(nearest24h);
  summary.carrySinceOrigin = deriveOriginBaselineFromEvents(db, summary);
  return summary;
}

async function refreshPrimefiLoanSnapshots(runId) {
  const db = getDb();
  const wallets = db.prepare(`
    SELECT uw.id AS walletId, uw.user_id AS userId, uw.chain_id AS chainId,
           uw.address_eip55 AS addressEip55, uw.label AS walletLabel
    FROM user_wallets uw
    WHERE uw.is_enabled = 1 AND uw.chain_id = 'XDC'
    ORDER BY uw.user_id, uw.id
  `).all();

  if (!wallets.length) {
    db.prepare(`DELETE FROM primefi_loan_position_snapshots WHERE snapshot_run_id != ?`).run(runId);
    return [];
  }

  const providers = new Map();
  const getProvider = (chainId) => {
    if (!providers.has(chainId)) providers.set(chainId, getProviderForChain(chainId, CHAINS_CONFIG));
    return providers.get(chainId);
  };

  const priceCache = loadPriceCache(db);
  const upsertStmt = db.prepare(`
    INSERT INTO primefi_loan_position_snapshots (
      user_id, wallet_id, chain_id, protocol, market_key, wallet_label,
      snapshot_run_id, snapshot_at, snapshot_json
    ) VALUES (
      @user_id, @wallet_id, @chain_id, @protocol, @market_key, @wallet_label,
      @snapshot_run_id, datetime('now'), @snapshot_json
    )
    ON CONFLICT(user_id, wallet_id, chain_id, protocol, market_key) DO UPDATE SET
      wallet_label = excluded.wallet_label,
      snapshot_run_id = excluded.snapshot_run_id,
      snapshot_at = datetime('now'),
      snapshot_json = excluded.snapshot_json
  `);
  const historyStmt = db.prepare(`
    INSERT INTO primefi_loan_position_snapshot_history (
      user_id, wallet_id, chain_id, protocol, market_key, snapshot_at, snapshot_json
    ) VALUES (
      @user_id, @wallet_id, @chain_id, @protocol, @market_key, datetime('now'), @snapshot_json
    )
  `);

  const inserted = [];
  for (const wallet of wallets) {
    const markets = getPrimefiMarkets(wallet.chainId);
    const provider = getProvider(wallet.chainId);
    const priceMap = priceCache.get(wallet.chainId);

    for (const market of markets) {
      try {
        const lendingPool = new ethers.Contract(market.lendingPool, lendingPoolAbi, provider);
        const dataProvider = new ethers.Contract(market.dataProvider, dataProviderAbi, provider);
        const [accountData, collateralCfg, collateralUserReserve, debtUserReserve] = await Promise.all([
          lendingPool.getUserAccountData(wallet.addressEip55),
          dataProvider.getReserveConfigurationData(market.collateralAsset),
          dataProvider.getUserReserveData(market.collateralAsset, wallet.addressEip55),
          dataProvider.getUserReserveData(market.debtAsset, wallet.addressEip55),
        ]);

        const collDecimals = Number(collateralCfg.decimals);
        const debtDecimals = 6;
        const collAmount = toNumUnits(collateralUserReserve.currentATokenBalance, collDecimals);
        const variableDebt = toNumUnits(debtUserReserve.currentVariableDebt, debtDecimals) || 0;
        const stableDebt = toNumUnits(debtUserReserve.currentStableDebt, debtDecimals) || 0;
        const debtAmount = variableDebt + stableDebt;
        if (!(Number(collAmount) > 0 || Number(debtAmount) > 0)) continue;

        const totalCollateralBase = Number(accountData.totalCollateralETH);
        const totalDebtBase = Number(accountData.totalDebtETH);
        const liqThresholdFrac = Number(collateralCfg.liquidationThreshold) / 10000;
        const liqThresholdPct = liqThresholdFrac * 100;
        let debtAssetPrice = getPriceForSymbol(priceMap, wallet.chainId, market.debtSymbol);
        if (!Number.isFinite(debtAssetPrice) && String(market.debtSymbol).toUpperCase() === "USDC") debtAssetPrice = 1;

        let collateralPrice = null;
        if (Number(collAmount) > 0 && Number(debtAmount) > 0 && totalCollateralBase > 0 && totalDebtBase > 0) {
          const collBasePerUnit = totalCollateralBase / collAmount;
          const debtBasePerUnit = totalDebtBase / debtAmount;
          if (Number.isFinite(collBasePerUnit) && Number.isFinite(debtBasePerUnit) && debtBasePerUnit > 0) {
            collateralPrice = collBasePerUnit / debtBasePerUnit;
            if (Number.isFinite(debtAssetPrice)) collateralPrice *= debtAssetPrice;
          }
        }
        if (!Number.isFinite(collateralPrice)) collateralPrice = getPriceForSymbol(priceMap, wallet.chainId, market.collateralSymbol);

        const collateralUsd = Number.isFinite(collateralPrice) && Number.isFinite(collAmount) ? collAmount * collateralPrice : null;
        const debtUsd = Number.isFinite(debtAssetPrice) && Number.isFinite(debtAmount) ? debtAmount * debtAssetPrice : null;
        const ltvPct = collateralUsd > 0 && Number.isFinite(debtUsd) ? (debtUsd / collateralUsd) * 100 : null;
        const liquidationPrice = Number.isFinite(debtAssetPrice) && Number(collAmount) > 0 && liqThresholdFrac > 0
          ? (debtAmount * debtAssetPrice) / (collAmount * liqThresholdFrac)
          : null;
        const liquidationBufferFrac = Number.isFinite(collateralPrice) && Number.isFinite(liquidationPrice) && liquidationPrice > 0
          ? (collateralPrice / liquidationPrice) - 1
          : null;
        const liqClass = classifyLiquidationRisk(liquidationBufferFrac);
        const healthFactor = Number(ethers.formatUnits(accountData.healthFactor, 18));

        const summary = {
          kind: "PRIMEFI_ACCOUNT",
          userId: wallet.userId,
          walletId: wallet.walletId,
          owner: wallet.addressEip55,
          chainId: wallet.chainId,
          protocol: market.protocol,
          marketKey: market.key,
          walletLabel: wallet.walletLabel,
          positionId: `${market.collateralSymbol}/${market.debtSymbol}`,
          positionLabel: "Market",
          status: debtAmount > 0 ? "ACTIVE" : "SUPPLIED",
          collSymbol: market.collateralSymbol,
          collAmount,
          debtSymbol: market.debtSymbol,
          debtAmount,
          debtVariableAmount: variableDebt,
          debtStableAmount: stableDebt,
          currentLiqThresholdPct: liqThresholdPct,
          healthFactor: Number.isFinite(healthFactor) ? healthFactor : null,
          ltvPct,
          price: collateralPrice,
          hasPrice: Number.isFinite(collateralPrice) && Number.isFinite(liquidationPrice),
          liquidationPrice,
          liquidationBufferFrac,
          liquidationTier: liqClass.tier,
          redemptionTier: null,
          interestPct: null,
          globalIrPct: null,
          priceBasis: "primefi-account-data",
        };

        const snapshotJson = JSON.stringify(summary);
        upsertStmt.run({
          user_id: wallet.userId,
          wallet_id: wallet.walletId,
          chain_id: wallet.chainId,
          protocol: market.protocol,
          market_key: market.key,
          wallet_label: wallet.walletLabel || null,
          snapshot_run_id: runId,
          snapshot_json: snapshotJson,
        });
        historyStmt.run({
          user_id: wallet.userId,
          wallet_id: wallet.walletId,
          chain_id: wallet.chainId,
          protocol: market.protocol,
          market_key: market.key,
          snapshot_json: snapshotJson,
        });
        inserted.push(summary);
      } catch (err) {
        logger.warn(`[primefiLoanMonitor] snapshot failed wallet=${wallet.addressEip55} protocol=${market.protocol}: ${err?.message || err}`);
      }
    }
  }

  db.prepare(`DELETE FROM primefi_loan_position_snapshots WHERE snapshot_run_id != ?`).run(runId);
  return inserted;
}

function getPrimefiLoanSummaries(userId = null) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT user_id, wallet_id, chain_id, protocol, market_key, snapshot_json, snapshot_at
    FROM primefi_loan_position_snapshots
    WHERE (? IS NULL OR user_id = ?)
    ORDER BY chain_id, protocol, market_key
  `).all(userId, userId);

  const historyStmt = db.prepare(`
    SELECT snapshot_json, snapshot_at
    FROM primefi_loan_position_snapshot_history
    WHERE user_id = ? AND wallet_id = ? AND chain_id = ? AND protocol = ? AND market_key = ?
    ORDER BY snapshot_at ASC, id ASC
  `);

  const out = [];
  for (const r of rows) {
    try {
      const obj = JSON.parse(r.snapshot_json);
      if (!obj || typeof obj !== "object") continue;
      obj.snapshotAt = r.snapshot_at;
      const historyRows = historyStmt.all(r.user_id, r.wallet_id, r.chain_id, r.protocol, r.market_key);
      out.push(enrichPrimefiSummary(db, obj, historyRows));
    } catch (_) {}
  }
  return out;
}

module.exports = {
  getPrimefiLoanSummaries,
  refreshPrimefiLoanSnapshots,
};
