"use strict";

const { getStabilityPoolsForChain } = require("./stabilityPoolConfig");

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fetchJsonWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, {
    signal: ctrl.signal,
    headers: { accept: "application/json" },
  })
    .then(async (res) => {
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        throw new Error("Invalid JSON response");
      }
    })
    .finally(() => clearTimeout(timer));
}

function inferBranchKey(poolCfg) {
  const explicit = String(poolCfg?.branchKey || "").trim().toUpperCase();
  if (explicit) return explicit;
  const t = `${poolCfg?.key || ""} ${poolCfg?.label || ""} ${poolCfg?.collSymbol || ""}`.toUpperCase();
  if (t.includes("FXRP")) return "FXRP";
  if (t.includes("WFLR")) return "WFLR";
  if (t.includes("STXRP")) return "STXRP";
  if (t.includes("SFLR")) return "SFLR";
  return null;
}

function getPoolShortLabel(poolCfg) {
  return String(poolCfg?.collSymbol || inferBranchKey(poolCfg) || poolCfg?.label || poolCfg?.key || "Pool").toUpperCase();
}

function parseBranchApr(branchObj) {
  if (!branchObj || typeof branchObj !== "object") {
    return { totalPct: null, feePct: null, apsPct: null, rflrPct: null };
  }

  const total = toNumber(branchObj.sp_apy_1d_total);
  const fee = toNumber(branchObj.sp_apy_avg_1d);
  const aps = toNumber(branchObj?.incentives?.aps?.apy_1d);
  const rflr = toNumber(branchObj?.incentives?.rflr?.apy_1d);

  const summed =
    (fee == null ? 0 : fee) +
    (aps == null ? 0 : aps) +
    (rflr == null ? 0 : rflr);

  return {
    totalPct: total != null ? total * 100 : (fee != null || aps != null || rflr != null ? summed * 100 : null),
    feePct: fee == null ? null : fee * 100,
    apsPct: aps == null ? null : aps * 100,
    rflrPct: rflr == null ? null : rflr * 100,
  };
}

function getAprRowsFromJson(chainId, json) {
  const pools = getStabilityPoolsForChain(chainId);
  return pools.map((poolCfg) => {
    const branchKey = inferBranchKey(poolCfg);
    const branchObj = branchKey ? json?.branch?.[branchKey] : null;
    const apr = parseBranchApr(branchObj);
    return {
      chainId: String(chainId || "").toUpperCase(),
      key: poolCfg.key,
      label: poolCfg.label,
      collSymbol: poolCfg.collSymbol || branchKey,
      branchKey,
      apr24hPct: apr.totalPct,
      fee24hPct: apr.feePct,
      aps24hPct: apr.apsPct,
      rflr24hPct: apr.rflrPct,
    };
  });
}

function getLatestStabilityPoolSnapshots(db, chainId = "FLR") {
  return db.prepare(`
    SELECT
      ranked.id,
      ranked.chain_id,
      ranked.pool_key,
      ranked.pool_address,
      ranked.pool_label,
      ranked.coll_symbol,
      ranked.total_bold_deposits,
      ranked.total_bold_deposits_num,
      ranked.current_scale,
      ranked.p_value,
      ranked.scale_b_value,
      ranked.index_value,
      ranked.apr_24h_pct,
      ranked.fee_24h_pct,
      ranked.aps_24h_pct,
      ranked.rflr_24h_pct,
      ranked.created_at
    FROM (
      SELECT
        s.*,
        ROW_NUMBER() OVER (
          PARTITION BY s.chain_id, s.pool_key
          ORDER BY s.created_at DESC, s.id DESC
        ) AS rn
      FROM sp_apr_snapshots s
      WHERE s.chain_id = ?
    ) ranked
    WHERE rn = 1
    ORDER BY pool_key
  `).all(String(chainId || "").toUpperCase());
}

function recommendSinglePoolAllocation(snapshots, depositAmount) {
  const amount = Number(depositAmount);
  if (!Number.isFinite(amount) || amount <= 0) return [];

  return (Array.isArray(snapshots) ? snapshots : [])
    .map((row) => {
      const poolSize = Number(row.total_bold_deposits_num);
      const aprPct = Number(row.apr_24h_pct);
      if (!Number.isFinite(poolSize) || poolSize < 0 || !Number.isFinite(aprPct)) return null;
      const postPoolSize = poolSize + amount;
      if (!Number.isFinite(postPoolSize) || postPoolSize <= 0) return null;
      const dilutionFactor = poolSize / postPoolSize;
      const feeAprPct = Number(row.fee_24h_pct);
      const apsAprPct = Number(row.aps_24h_pct);
      const rflrAprPct = Number(row.rflr_24h_pct);
      const depositPctOfPool = poolSize > 0 ? (amount / poolSize) * 100 : null;
      const dilutedAprPct = aprPct * dilutionFactor;
      const dilutedFeeAprPct = Number.isFinite(feeAprPct) ? feeAprPct * dilutionFactor : null;
      const dilutedApsAprPct = Number.isFinite(apsAprPct) ? apsAprPct * dilutionFactor : null;
      const dilutedRflrAprPct = Number.isFinite(rflrAprPct) ? rflrAprPct * dilutionFactor : null;
      const dailyReturn = amount * (dilutedAprPct / 100) / 365;
      const dailyFeeReturn = Number.isFinite(dilutedFeeAprPct)
        ? amount * (dilutedFeeAprPct / 100) / 365
        : null;
      const dailyApsReturn = Number.isFinite(dilutedApsAprPct)
        ? amount * (dilutedApsAprPct / 100) / 365
        : null;
      const dailyRflrReturn = Number.isFinite(dilutedRflrAprPct)
        ? amount * (dilutedRflrAprPct / 100) / 365
        : null;
      const weeklyReturn = Number.isFinite(dailyReturn) ? dailyReturn * 7 : null;
      const weeklyFeeReturn = Number.isFinite(dailyFeeReturn) ? dailyFeeReturn * 7 : null;
      const weeklyApsReturn = Number.isFinite(dailyApsReturn) ? dailyApsReturn * 7 : null;
      const weeklyRflrReturn = Number.isFinite(dailyRflrReturn) ? dailyRflrReturn * 7 : null;
      return {
        chainId: row.chain_id,
        poolKey: row.pool_key,
        poolLabel: row.pool_label,
        collSymbol: row.coll_symbol || getPoolShortLabel(row),
        snapshotAt: row.created_at,
        poolSize,
        aprPct,
        feeAprPct,
        apsAprPct,
        rflrAprPct,
        postPoolSize,
        depositPctOfPool,
        dilutedAprPct,
        dilutedFeeAprPct,
        dilutedApsAprPct,
        dilutedRflrAprPct,
        dailyReturn,
        dailyFeeReturn,
        dailyApsReturn,
        dailyRflrReturn,
        weeklyReturn,
        weeklyFeeReturn,
        weeklyApsReturn,
        weeklyRflrReturn,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.dilutedAprPct - a.dilutedAprPct);
}

module.exports = {
  fetchJsonWithTimeout,
  inferBranchKey,
  getAprRowsFromJson,
  getLatestStabilityPoolSnapshots,
  getPoolShortLabel,
  parseBranchApr,
  recommendSinglePoolAllocation,
  toNumber,
};
