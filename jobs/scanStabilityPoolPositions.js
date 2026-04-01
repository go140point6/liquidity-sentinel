const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const { ethers } = require("ethers");

const stabilityPoolAbi = require("../abi/stabilityPool.json");
const { getDb } = require("../db");
const { getProviderForChain } = require("../utils/ethers/providers");
const baseLogger = require("../utils/logger");
const logger = baseLogger.forEnv("SCAN_DEBUG");
const { acquireLock, releaseLock } = require("../utils/lock");
const { getStabilityPoolsForChain } = require("../utils/stabilityPoolConfig");
const { getPoolShortLabel } = require("../utils/stabilityPoolSignals");

const CHAINS_CONFIG = {
  FLR: { rpcEnvKey: "FLR_MAINNET" },
};
const LOCK_NAME = "sp-position-scan";

function requireEnv(name) {
  const raw = process.env[name];
  if (!raw || !String(raw).trim()) throw new Error(`Missing env var ${name}`);
  return String(raw).trim();
}

function requireNumberEnv(name) {
  const raw = requireEnv(name);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Env var ${name} must be a positive number (got "${raw}")`);
  }
  return Math.floor(n);
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function toBigInt(value) {
  try {
    return BigInt(value ?? 0);
  } catch {
    return 0n;
  }
}

function percentOf(total, part) {
  const t = toBigInt(total);
  const p = toBigInt(part);
  if (t <= 0n || p < 0n) return null;
  const scaled = Number((p * 10000n) / t) / 100;
  return Number.isFinite(scaled) ? scaled : null;
}

function format18(raw) {
  return Number(ethers.formatUnits(toBigInt(raw), 18));
}

function extractInitialDeposit(rawResult) {
  if (typeof rawResult === "bigint") return rawResult;
  if (rawResult && typeof rawResult === "object") {
    if (typeof rawResult.initialValue === "bigint") return rawResult.initialValue;
    if (Array.isArray(rawResult) && typeof rawResult[0] === "bigint") return rawResult[0];
  }
  return 0n;
}

async function main() {
  const lockPath = acquireLock(LOCK_NAME);
  if (!lockPath) {
    logger.warn("[sp-position-scan] Previous run still active; skipping.");
    return;
  }

  try {
    const rpcTimeoutMs = requireNumberEnv("SP_POSITION_RPC_TIMEOUT_MS");
    const provider = getProviderForChain("FLR", CHAINS_CONFIG);
    const pools = getStabilityPoolsForChain("FLR");
    const db = getDb();

    const wallets = db.prepare(`
      SELECT uw.id AS wallet_id, uw.user_id, uw.address_eip55, uw.label AS wallet_label
      FROM user_wallets uw
      WHERE uw.chain_id = 'FLR' AND uw.is_enabled = 1
      ORDER BY uw.user_id, COALESCE(uw.label, ''), uw.address_lower
    `).all();

    db.prepare(`
      DELETE FROM sp_position_snapshots
      WHERE wallet_id NOT IN (
        SELECT id FROM user_wallets WHERE chain_id = 'FLR' AND is_enabled = 1
      )
    `).run();

    const upsert = db.prepare(`
      INSERT INTO sp_position_snapshots (
        user_id,
        wallet_id,
        chain_id,
        pool_key,
        pool_address,
        pool_label,
        snapshot_json,
        snapshot_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(user_id, wallet_id, chain_id, pool_key)
      DO UPDATE SET
        pool_address = excluded.pool_address,
        pool_label = excluded.pool_label,
        snapshot_json = excluded.snapshot_json,
        snapshot_at = datetime('now'),
        updated_at = datetime('now')
    `);
    const del = db.prepare(`
      DELETE FROM sp_position_snapshots
      WHERE user_id = ? AND wallet_id = ? AND chain_id = ? AND pool_key = ?
    `);

    const contracts = new Map();
    for (const pool of pools) {
      contracts.set(pool.key, new ethers.Contract(pool.address, stabilityPoolAbi, provider));
    }

    let activeCount = 0;
    let scannedCount = 0;

    for (const pool of pools) {
      const contract = contracts.get(pool.key);
      const totalBoldDeposits = await withTimeout(
        contract.getTotalBoldDeposits(),
        rpcTimeoutMs,
        `${pool.key}.getTotalBoldDeposits`
      );

      for (const wallet of wallets) {
        scannedCount += 1;
        const addr = wallet.address_eip55;
        try {
          const [depositStruct, compounded, yieldGain, collGain, stashedColl] = await Promise.all([
            withTimeout(contract.deposits(addr), rpcTimeoutMs, `${pool.key}.deposits(${addr})`),
            withTimeout(contract.getCompoundedBoldDeposit(addr), rpcTimeoutMs, `${pool.key}.getCompoundedBoldDeposit(${addr})`),
            withTimeout(contract.getDepositorYieldGain(addr), rpcTimeoutMs, `${pool.key}.getDepositorYieldGain(${addr})`),
            withTimeout(contract.getDepositorCollGain(addr), rpcTimeoutMs, `${pool.key}.getDepositorCollGain(${addr})`),
            withTimeout(contract.stashedColl(addr), rpcTimeoutMs, `${pool.key}.stashedColl(${addr})`),
          ]);

          const initialDepositRaw = extractInitialDeposit(depositStruct);
          const compoundedRaw = toBigInt(compounded);
          const yieldRaw = toBigInt(yieldGain);
          const collGainRaw = toBigInt(collGain);
          const stashedCollRaw = toBigInt(stashedColl);
          const collClaimableRaw = collGainRaw + stashedCollRaw;

          const isActive =
            initialDepositRaw > 0n ||
            compoundedRaw > 0n ||
            yieldRaw > 0n ||
            collClaimableRaw > 0n;

          if (!isActive) {
            del.run(wallet.user_id, wallet.wallet_id, "FLR", pool.key);
            continue;
          }

          const snapshot = {
            chainId: "FLR",
            userId: wallet.user_id,
            walletId: wallet.wallet_id,
            walletAddress: addr,
            walletLabel: wallet.wallet_label || null,
            poolKey: pool.key,
            poolAddress: pool.address,
            poolLabel: pool.label,
            collSymbol: pool.collSymbol || getPoolShortLabel(pool),
            initialDepositRaw: initialDepositRaw.toString(),
            initialDeposit: format18(initialDepositRaw),
            compoundedDepositRaw: compoundedRaw.toString(),
            compoundedDeposit: format18(compoundedRaw),
            yieldGainRaw: yieldRaw.toString(),
            yieldGain: format18(yieldRaw),
            collateralGainRaw: collGainRaw.toString(),
            collateralGain: format18(collGainRaw),
            stashedCollateralRaw: stashedCollRaw.toString(),
            stashedCollateral: format18(stashedCollRaw),
            claimableCollateralRaw: collClaimableRaw.toString(),
            claimableCollateral: format18(collClaimableRaw),
            totalPoolDepositsRaw: totalBoldDeposits.toString(),
            totalPoolDeposits: format18(totalBoldDeposits),
            poolSharePct: percentOf(totalBoldDeposits, compoundedRaw),
          };

          upsert.run(
            wallet.user_id,
            wallet.wallet_id,
            "FLR",
            pool.key,
            pool.address,
            pool.label,
            JSON.stringify(snapshot)
          );
          activeCount += 1;
        } catch (err) {
          logger.error(`[sp-position-scan] failed pool=${pool.key} wallet=${addr}: ${err?.message || err}`);
        }
      }
    }

    logger.info(
      `[sp-position-scan] Done pools=${pools.length} wallets=${wallets.length} scanned=${scannedCount} active=${activeCount}`
    );
  } finally {
    releaseLock(lockPath);
  }
}

main().catch((err) => {
  logger.error(`[sp-position-scan] FATAL: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
