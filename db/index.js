// db/index.js
const Database = require("better-sqlite3");
const { normalizeEvmAddress } = require("../utils/ethers/addresses");
const logger = require("../utils/logger");

const dbFile = process.env.MONITOR_DB_PATH;
if (!dbFile) {
  logger.error("[db] Missing MONITOR_DB_PATH in .env");
  process.exit(1);
}

function openDb({ fileMustExist = false } = {}) {
  const db = new Database(dbFile, { fileMustExist });

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  return db;
}

function getOrCreateUserId(db, { discordId, discordName = null } = {}) {
  if (!discordId) throw new Error("getOrCreateUserId: missing discordId");

  const insert = db.prepare(`
    INSERT INTO users (discord_id, discord_name)
    VALUES (?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      discord_name = COALESCE(excluded.discord_name, users.discord_name)
  `);

  const select = db.prepare(`SELECT id FROM users WHERE discord_id = ?`);

  const tx = db.transaction((did, dname) => {
    insert.run(did, dname);
    const row = select.get(did);
    if (!row) throw new Error(`Failed to create/find user for discord_id=${did}`);
    return row.id;
  });

  return tx(String(discordId), discordName);
}

/**
 * V2 schema helper:
 * Ensure a contract_scan_cursors row exists for a given contract.
 * This aligns with the new scanning model (per-contract, not per-wallet).
 *
 * - If cursor exists: no-op
 * - If missing: creates with provided startBlock (or contract default_start_block if omitted)
 */
function ensureContractScanCursor(db, { contractId, startBlock = null } = {}) {
  if (!contractId) throw new Error("ensureContractScanCursor: missing contractId");

  let sb = startBlock;

  if (sb == null) {
    const row = db
      .prepare(`SELECT default_start_block AS sb FROM contracts WHERE id = ?`)
      .get(contractId);
    if (!row) throw new Error(`ensureContractScanCursor: contract not found id=${contractId}`);
    sb = Number(row.sb);
    if (!Number.isInteger(sb) || sb < 0) {
      throw new Error(
        `ensureContractScanCursor: invalid default_start_block for contractId=${contractId}`
      );
    }
  } else {
    const n = Number(sb);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error("ensureContractScanCursor: startBlock must be a non-negative integer");
    }
    sb = n;
  }

  db.prepare(`
    INSERT INTO contract_scan_cursors (contract_id, start_block, last_scanned_block)
    VALUES (?, ?, 0)
    ON CONFLICT(contract_id) DO NOTHING
  `).run(contractId, sb);
}

/**
 * Adds (or returns) a wallet for a user on FLR/XDC.
 */
function getOrCreateWalletId(db, { userId, chainId, addressInput, label = null } = {}) {
  if (!userId) throw new Error("getOrCreateWalletId: missing userId");
  if (!chainId) throw new Error("getOrCreateWalletId: missing chainId");
  if (!addressInput) throw new Error("getOrCreateWalletId: missing addressInput");

  const chain = String(chainId).toUpperCase();
  const { checksum, lower } = normalizeEvmAddress(chain, addressInput);

  const cleanLabel = label == null ? null : String(label).trim() || null;

  const insert = db.prepare(`
    INSERT INTO user_wallets (
      user_id, chain_id, address_lower, address_eip55, label, is_enabled
    )
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(user_id, chain_id, address_lower) DO UPDATE SET
      address_eip55 = excluded.address_eip55,
      label = COALESCE(excluded.label, user_wallets.label),
      is_enabled = 1
  `);

  const select = db.prepare(`
    SELECT id
    FROM user_wallets
    WHERE user_id = ? AND chain_id = ? AND address_lower = ?
  `);

  const tx = db.transaction((uid, cid, addrLower, addrEip55, lbl) => {
    insert.run(uid, cid, addrLower, addrEip55, lbl);
    const row = select.get(uid, cid, addrLower);
    if (!row) throw new Error("Failed to create/find wallet");
    return row.id;
  });

  const walletId = tx(userId, chain, lower, checksum, cleanLabel);
  return { walletId, chainId: chain, address_lower: lower, address_eip55: checksum };
}

// --- Singleton DB (one connection for the process) ---
let _db = null;

function getDb({ fileMustExist = false } = {}) {
  if (_db) return _db;
  _db = openDb({ fileMustExist });

  const close = () => {
    try {
      _db?.close();
    } catch (_) {}
    _db = null;
  };

  process.once("exit", close);
  process.once("SIGINT", () => {
    close();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    close();
    process.exit(0);
  });

  return _db;
}

module.exports = {
  dbFile,
  openDb,
  getDb,
  getOrCreateUserId,
  getOrCreateWalletId,
  ensureContractScanCursor,
};
