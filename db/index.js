// db/index.js
const Database = require("better-sqlite3");
const { normalizeEvmAddress } = require("../utils/ethers/addresses");
const logger = require("../utils/logger");

const dbFile = process.env.DB_PATH;
if (!dbFile) {
  logger.error("[db] Missing DB_PATH in .env");
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

function initSchema(db) {
  const schemaSql = `
  CREATE TABLE IF NOT EXISTS chains (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contracts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id        TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('LP_NFT', 'LP_ALM', 'LOAN_NFT')),
    contract_key    TEXT NOT NULL UNIQUE,
    protocol        TEXT NOT NULL,
    address_lower   TEXT NOT NULL,
    address_eip55   TEXT NOT NULL,
    default_start_block INTEGER NOT NULL DEFAULT 0 CHECK (default_start_block >= 0),
    is_enabled      INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0,1)),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (chain_id) REFERENCES chains(id) ON DELETE RESTRICT,
    CHECK (address_lower = lower(address_lower)),
    CHECK (length(address_lower) = 42 AND substr(address_lower, 1, 2) = '0x'),
    CHECK (length(address_eip55) = 42 AND substr(address_eip55, 1, 2) = '0x'),
    UNIQUE (chain_id, address_lower)
  );

  CREATE TABLE IF NOT EXISTS contract_scan_cursors (
    contract_id            INTEGER PRIMARY KEY,
    start_block            INTEGER NOT NULL DEFAULT 0 CHECK (start_block >= 0),
    last_scanned_block     INTEGER NOT NULL DEFAULT 0 CHECK (last_scanned_block >= 0),
    last_scanned_log_index INTEGER,
    last_scanned_at        TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS nft_transfers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id     INTEGER NOT NULL,
    block_number    INTEGER NOT NULL,
    tx_hash         TEXT NOT NULL,
    log_index       INTEGER NOT NULL,
    from_lower      TEXT NOT NULL,
    from_eip55      TEXT NOT NULL,
    to_lower        TEXT NOT NULL,
    to_eip55        TEXT NOT NULL,
    token_id        TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
    CHECK (length(from_lower) = 42 AND substr(from_lower, 1, 2) = '0x'),
    CHECK (length(to_lower)   = 42 AND substr(to_lower,   1, 2) = '0x'),
    UNIQUE (contract_id, tx_hash, log_index)
  );

  CREATE TABLE IF NOT EXISTS nft_tokens (
    contract_id       INTEGER NOT NULL,
    token_id          TEXT NOT NULL,
    owner_lower       TEXT NOT NULL,
    owner_eip55       TEXT NOT NULL,
    is_burned         INTEGER NOT NULL DEFAULT 0 CHECK (is_burned IN (0,1)),
    last_block        INTEGER,
    last_tx_hash      TEXT,
    last_log_index    INTEGER,
    first_seen_block  INTEGER,
    first_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (contract_id, token_id),
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
    CHECK (length(owner_lower) = 42 AND substr(owner_lower, 1, 2) = '0x'),
    CHECK (length(owner_eip55) = 42 AND substr(owner_eip55, 1, 2) = '0x')
  );

  CREATE TABLE IF NOT EXISTS lp_token_meta (
    contract_id     INTEGER NOT NULL,
    token_id        TEXT NOT NULL,
    pair_label      TEXT,
    token0_lower    TEXT,
    token1_lower    TEXT,
    fee             INTEGER,
    tick_lower      INTEGER,
    tick_upper      INTEGER,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (contract_id, token_id),
    FOREIGN KEY (contract_id, token_id)
      REFERENCES nft_tokens(contract_id, token_id)
      ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS loan_token_meta (
    contract_id     INTEGER NOT NULL,
    token_id        TEXT NOT NULL,
    status          TEXT,
    collateral_sym  TEXT,
    debt_sym        TEXT,
    collateral_amt  TEXT,
    debt_amt        TEXT,
    icr             TEXT,
    liquidation_px  TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (contract_id, token_id),
    FOREIGN KEY (contract_id, token_id)
      REFERENCES nft_tokens(contract_id, token_id)
      ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS global_params (
    chain_id        TEXT NOT NULL,
    param_key       TEXT NOT NULL,
    value_text      TEXT NOT NULL,
    source          TEXT,
    fetched_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chain_id, param_key),
    FOREIGN KEY (chain_id) REFERENCES chains(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS price_cache (
    chain_id    TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    price_usd   REAL NOT NULL,
    source      TEXT,
    fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chain_id, symbol)
  );

  CREATE TABLE IF NOT EXISTS price_cache_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id   TEXT NOT NULL,
    symbol     TEXT NOT NULL,
    price_usd  REAL NOT NULL,
    source     TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS index_streams (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id      TEXT NOT NULL,
    contract_id   INTEGER NOT NULL,
    stream_key    TEXT NOT NULL UNIQUE,
    event_name    TEXT NOT NULL,
    topic0        TEXT NOT NULL,
    start_block   INTEGER NOT NULL DEFAULT 0 CHECK (start_block >= 0),
    is_enabled    INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0,1)),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (chain_id) REFERENCES chains(id) ON DELETE CASCADE,
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS index_cursors (
    stream_id              INTEGER PRIMARY KEY,
    last_scanned_block     INTEGER NOT NULL DEFAULT 0 CHECK (last_scanned_block >= 0),
    last_scanned_log_index INTEGER,
    last_scanned_tx_hash   TEXT,
    last_scanned_at        TEXT,
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (stream_id) REFERENCES index_streams(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS derive_cursors (
    derive_key       TEXT PRIMARY KEY,
    last_event_id    INTEGER NOT NULL DEFAULT 0 CHECK (last_event_id >= 0),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS backfill_jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id    INTEGER NOT NULL,
    mode         TEXT NOT NULL CHECK (mode IN ('BACKFILL','TAIL')),
    from_block   INTEGER NOT NULL CHECK (from_block >= 0),
    to_block     INTEGER CHECK (to_block IS NULL OR to_block >= from_block),
    status       TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','DONE','FAILED','PAUSED')),
    started_at   TEXT,
    finished_at  TEXT,
    error_text   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (stream_id) REFERENCES index_streams(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS backfill_windows (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      INTEGER NOT NULL,
    from_block  INTEGER NOT NULL CHECK (from_block >= 0),
    to_block    INTEGER NOT NULL CHECK (to_block >= from_block),
    attempt_no  INTEGER NOT NULL CHECK (attempt_no > 0),
    logs_found  INTEGER NOT NULL DEFAULT 0 CHECK (logs_found >= 0),
    status      TEXT NOT NULL CHECK (status IN ('OK','FAILED','SKIPPED')),
    error_text  TEXT,
    elapsed_ms  INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (job_id) REFERENCES backfill_jobs(id) ON DELETE CASCADE,
    UNIQUE (job_id, from_block, to_block, attempt_no)
  );

  CREATE TABLE IF NOT EXISTS chain_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id      TEXT NOT NULL,
    contract_id   INTEGER NOT NULL,
    stream_id     INTEGER NOT NULL,
    block_number  INTEGER NOT NULL CHECK (block_number >= 0),
    block_hash    TEXT,
    tx_hash       TEXT NOT NULL,
    tx_index      INTEGER,
    log_index     INTEGER NOT NULL CHECK (log_index >= 0),
    topic0        TEXT NOT NULL,
    topics_json   TEXT NOT NULL,
    data_hex      TEXT NOT NULL,
    event_name    TEXT,
    decoded_json  TEXT,
    removed       INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0,1)),
    ingested_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (chain_id) REFERENCES chains(id) ON DELETE CASCADE,
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id) REFERENCES index_streams(id) ON DELETE CASCADE,
    UNIQUE (chain_id, tx_hash, log_index)
  );

  CREATE TABLE IF NOT EXISTS alm_share_flows (
    event_id      INTEGER PRIMARY KEY,
    chain_id      TEXT NOT NULL,
    contract_id   INTEGER NOT NULL,
    stream_id     INTEGER NOT NULL,
    block_number  INTEGER NOT NULL CHECK (block_number >= 0),
    tx_hash       TEXT NOT NULL,
    log_index     INTEGER NOT NULL CHECK (log_index >= 0),
    from_lower    TEXT NOT NULL,
    from_eip55    TEXT NOT NULL,
    to_lower      TEXT NOT NULL,
    to_eip55      TEXT NOT NULL,
    amount_raw    TEXT NOT NULL,
    flow_kind     TEXT NOT NULL CHECK (flow_kind IN ('MINT','BURN','TRANSFER')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (event_id) REFERENCES chain_events(id) ON DELETE CASCADE,
    FOREIGN KEY (chain_id) REFERENCES chains(id) ON DELETE CASCADE,
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id) REFERENCES index_streams(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS alm_position_baselines (
    user_id             INTEGER NOT NULL,
    wallet_id           INTEGER NOT NULL,
    contract_id         INTEGER NOT NULL,
    token_id            TEXT NOT NULL,
    chain_id            TEXT NOT NULL,
    protocol            TEXT NOT NULL,
    token0_symbol       TEXT,
    token1_symbol       TEXT,
    baseline_snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
    baseline_amount0    REAL,
    baseline_amount1    REAL,
    baseline_shares_raw TEXT NOT NULL,
    baseline_share_pct  REAL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, wallet_id, contract_id, token_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (wallet_id) REFERENCES user_wallets(id) ON DELETE CASCADE,
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
    FOREIGN KEY (chain_id) REFERENCES chains(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id    TEXT NOT NULL UNIQUE,
    discord_name  TEXT,
    accepts_dm    INTEGER NOT NULL DEFAULT 0 CHECK (accepts_dm IN (0,1)),
    heartbeat_hour    INTEGER NOT NULL DEFAULT 3 CHECK (heartbeat_hour BETWEEN 0 AND 23),
    heartbeat_enabled INTEGER NOT NULL DEFAULT 1 CHECK (heartbeat_enabled IN (0,1)),
    heartbeat_tz  TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS firelight_config (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    channel_id     TEXT NOT NULL,
    message_id     TEXT NOT NULL,
    last_state     TEXT,
    last_assets    TEXT,
    last_capacity  TEXT,
    last_checked_at TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS firelight_subscriptions (
    user_id     INTEGER PRIMARY KEY,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );


  CREATE TABLE IF NOT EXISTS sp_apr_config (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    channel_id       TEXT NOT NULL,
    message_id       TEXT NOT NULL,
    last_top_pool_key TEXT,
    last_checked_at  TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sp_apr_subscriptions (
    user_id     INTEGER PRIMARY KEY,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sp_apr_snapshots (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id              TEXT NOT NULL,
    pool_key              TEXT NOT NULL,
    pool_address          TEXT NOT NULL,
    pool_label            TEXT NOT NULL,
    coll_symbol           TEXT,
    total_bold_deposits   TEXT,
    total_bold_deposits_num REAL,
    current_scale         TEXT,
    p_value               TEXT,
    scale_b_value         TEXT,
    index_value           REAL,
    apr_24h_pct           REAL,
    fee_24h_pct           REAL,
    aps_24h_pct           REAL,
    rflr_24h_pct          REAL,
    created_at            TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sp_apr_snapshots_chain_pool_time
    ON sp_apr_snapshots(chain_id, pool_key, created_at);

  CREATE TABLE IF NOT EXISTS sp_position_snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    wallet_id     INTEGER NOT NULL,
    chain_id      TEXT NOT NULL,
    pool_key      TEXT NOT NULL,
    pool_address  TEXT NOT NULL,
    pool_label    TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    snapshot_at   TEXT NOT NULL DEFAULT (datetime('now')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (wallet_id) REFERENCES user_wallets(id) ON DELETE CASCADE,
    FOREIGN KEY (chain_id) REFERENCES chains(id) ON DELETE RESTRICT,
    UNIQUE (user_id, wallet_id, chain_id, pool_key)
  );

  CREATE INDEX IF NOT EXISTS idx_sp_position_snapshots_user_time
    ON sp_position_snapshots(user_id, snapshot_at);

  CREATE TABLE IF NOT EXISTS user_wallets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    chain_id        TEXT NOT NULL,
    address_lower   TEXT NOT NULL,
    address_eip55   TEXT NOT NULL,
    label           TEXT,
    lp_alerts_status_only INTEGER NOT NULL DEFAULT 0 CHECK (lp_alerts_status_only IN (0,1)),
    is_enabled      INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0,1)),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
    FOREIGN KEY (chain_id) REFERENCES chains(id) ON DELETE RESTRICT,
    CHECK (address_lower = lower(address_lower)),
    CHECK (length(address_lower) = 42 AND substr(address_lower, 1, 2) = '0x'),
    CHECK (length(address_eip55) = 42 AND substr(address_eip55, 1, 2) = '0x'),
    UNIQUE (user_id, chain_id, address_lower)
  );

  CREATE TABLE IF NOT EXISTS position_ignores (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    position_kind TEXT NOT NULL CHECK (position_kind IN ('LP','LOAN')),
    wallet_id     INTEGER NOT NULL,
    contract_id   INTEGER NOT NULL,
    token_id      TEXT,
    reason        TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id)     REFERENCES users(id)        ON DELETE CASCADE,
    FOREIGN KEY (wallet_id)   REFERENCES user_wallets(id) ON DELETE CASCADE,
    FOREIGN KEY (contract_id) REFERENCES contracts(id)    ON DELETE CASCADE,
    UNIQUE (user_id, position_kind, wallet_id, contract_id, token_id)
  );

  CREATE TABLE IF NOT EXISTS alert_state (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    wallet_id     INTEGER NOT NULL,
    contract_id   INTEGER NOT NULL,
    token_id      TEXT NOT NULL,
    alert_type    TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
    signature     TEXT,
    state_json    TEXT,
    last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id)     REFERENCES users(id)         ON DELETE CASCADE,
    FOREIGN KEY (wallet_id)   REFERENCES user_wallets(id)  ON DELETE CASCADE,
    FOREIGN KEY (contract_id) REFERENCES contracts(id)     ON DELETE CASCADE,
    UNIQUE (user_id, wallet_id, contract_id, token_id, alert_type)
  );

  CREATE TABLE IF NOT EXISTS alert_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    wallet_id     INTEGER NOT NULL,
    contract_id   INTEGER NOT NULL,
    token_id      TEXT NOT NULL,
    alert_type    TEXT NOT NULL,
    phase         TEXT NOT NULL,
    message       TEXT NOT NULL,
    meta_json     TEXT,
    signature     TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id)     REFERENCES users(id)        ON DELETE CASCADE,
    FOREIGN KEY (wallet_id)   REFERENCES user_wallets(id) ON DELETE CASCADE,
    FOREIGN KEY (contract_id) REFERENCES contracts(id)    ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS loan_position_snapshots (
    user_id         INTEGER NOT NULL,
    wallet_id       INTEGER NOT NULL,
    contract_id     INTEGER NOT NULL,
    token_id        TEXT NOT NULL,
    chain_id        TEXT NOT NULL,
    protocol        TEXT NOT NULL,
    wallet_label    TEXT,
    snapshot_run_id TEXT NOT NULL,
    snapshot_at     TEXT NOT NULL DEFAULT (datetime('now')),
    snapshot_json   TEXT NOT NULL,
    PRIMARY KEY (user_id, wallet_id, contract_id, token_id),
    FOREIGN KEY (user_id)     REFERENCES users(id)         ON DELETE CASCADE,
    FOREIGN KEY (wallet_id)   REFERENCES user_wallets(id)  ON DELETE CASCADE,
    FOREIGN KEY (contract_id) REFERENCES contracts(id)     ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS redemption_rate_snapshots (
    contract_id   INTEGER PRIMARY KEY,
    chain_id      TEXT NOT NULL,
    protocol      TEXT NOT NULL,
    snapshot_at   TEXT NOT NULL DEFAULT (datetime('now')),
    snapshot_json TEXT NOT NULL,
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS lp_position_snapshots (
    user_id         INTEGER NOT NULL,
    wallet_id       INTEGER NOT NULL,
    contract_id     INTEGER NOT NULL,
    token_id        TEXT NOT NULL,
    chain_id        TEXT NOT NULL,
    protocol        TEXT NOT NULL,
    wallet_label    TEXT,
    snapshot_run_id TEXT NOT NULL,
    snapshot_at     TEXT NOT NULL DEFAULT (datetime('now')),
    snapshot_json   TEXT NOT NULL,
    PRIMARY KEY (user_id, wallet_id, contract_id, token_id),
    FOREIGN KEY (user_id)     REFERENCES users(id)         ON DELETE CASCADE,
    FOREIGN KEY (wallet_id)   REFERENCES user_wallets(id)  ON DELETE CASCADE,
    FOREIGN KEY (contract_id) REFERENCES contracts(id)     ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_contracts_chain_kind ON contracts(chain_id, kind);
  CREATE INDEX IF NOT EXISTS idx_contracts_protocol   ON contracts(protocol);
  CREATE INDEX IF NOT EXISTS idx_redemption_rate_protocol ON redemption_rate_snapshots(protocol);
  CREATE INDEX IF NOT EXISTS idx_contract_scan_last_block ON contract_scan_cursors(last_scanned_block);
  CREATE INDEX IF NOT EXISTS idx_nft_transfers_contract_block ON nft_transfers(contract_id, block_number);
  CREATE INDEX IF NOT EXISTS idx_nft_transfers_to            ON nft_transfers(contract_id, to_lower);
  CREATE INDEX IF NOT EXISTS idx_nft_transfers_from          ON nft_transfers(contract_id, from_lower);
  CREATE INDEX IF NOT EXISTS idx_nft_transfers_token         ON nft_transfers(contract_id, token_id);
  CREATE INDEX IF NOT EXISTS idx_nft_tokens_owner            ON nft_tokens(owner_lower, is_burned);
  CREATE INDEX IF NOT EXISTS idx_nft_tokens_contract_owner   ON nft_tokens(contract_id, owner_lower, is_burned);
  CREATE INDEX IF NOT EXISTS idx_nft_tokens_contract_burned  ON nft_tokens(contract_id, is_burned);
  CREATE INDEX IF NOT EXISTS idx_lp_token_meta_pair          ON lp_token_meta(pair_label);
  CREATE INDEX IF NOT EXISTS idx_loan_token_meta_status      ON loan_token_meta(status);
  CREATE INDEX IF NOT EXISTS idx_users_discord_id            ON users(discord_id);
  CREATE INDEX IF NOT EXISTS idx_users_accepts_dm            ON users(accepts_dm);
  CREATE INDEX IF NOT EXISTS idx_wallets_user                ON user_wallets(user_id);
  CREATE INDEX IF NOT EXISTS idx_wallets_chain_addr          ON user_wallets(chain_id, address_lower);
  CREATE INDEX IF NOT EXISTS idx_position_ignores_user       ON position_ignores(user_id, position_kind);
  CREATE INDEX IF NOT EXISTS idx_position_ignores_wallet     ON position_ignores(wallet_id, position_kind);
  CREATE INDEX IF NOT EXISTS idx_position_ignores_contract   ON position_ignores(contract_id, position_kind);
  CREATE INDEX IF NOT EXISTS idx_alert_state_user_active     ON alert_state(user_id, is_active);
  CREATE INDEX IF NOT EXISTS idx_alert_state_position        ON alert_state(wallet_id, contract_id, token_id, alert_type);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_state_identity  ON alert_state(user_id, wallet_id, contract_id, token_id, alert_type);
  CREATE INDEX IF NOT EXISTS idx_alert_log_user_created      ON alert_log(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_alert_log_position          ON alert_log(wallet_id, contract_id, token_id);
  CREATE INDEX IF NOT EXISTS idx_loan_snapshots_user         ON loan_position_snapshots(user_id);
  CREATE INDEX IF NOT EXISTS idx_lp_snapshots_user           ON lp_position_snapshots(user_id);
  CREATE INDEX IF NOT EXISTS idx_index_streams_chain_enabled ON index_streams(chain_id, is_enabled);
  CREATE INDEX IF NOT EXISTS idx_index_streams_contract_event ON index_streams(contract_id, event_name);
  CREATE INDEX IF NOT EXISTS idx_derive_cursors_updated_at ON derive_cursors(updated_at);
  CREATE INDEX IF NOT EXISTS idx_backfill_jobs_stream_status ON backfill_jobs(stream_id, status, mode);
  CREATE INDEX IF NOT EXISTS idx_backfill_windows_job_block ON backfill_windows(job_id, from_block, to_block);
  CREATE INDEX IF NOT EXISTS idx_chain_events_stream_block ON chain_events(stream_id, block_number, log_index);
  CREATE INDEX IF NOT EXISTS idx_chain_events_contract_block ON chain_events(contract_id, block_number, log_index);
  CREATE INDEX IF NOT EXISTS idx_chain_events_chain_block ON chain_events(chain_id, block_number, log_index);
  CREATE INDEX IF NOT EXISTS idx_price_cache_history_chain_symbol_time ON price_cache_history(chain_id, symbol, fetched_at);
  CREATE INDEX IF NOT EXISTS idx_alm_share_flows_contract_block ON alm_share_flows(contract_id, block_number, log_index);
  CREATE INDEX IF NOT EXISTS idx_alm_share_flows_from ON alm_share_flows(contract_id, from_lower, block_number);
  CREATE INDEX IF NOT EXISTS idx_alm_share_flows_to ON alm_share_flows(contract_id, to_lower, block_number);
  CREATE INDEX IF NOT EXISTS idx_alm_baselines_user ON alm_position_baselines(user_id);
  CREATE INDEX IF NOT EXISTS idx_alm_baselines_contract ON alm_position_baselines(contract_id, token_id);

  CREATE TRIGGER IF NOT EXISTS trg_contracts_updated_at
  AFTER UPDATE ON contracts
  FOR EACH ROW
  BEGIN
    UPDATE contracts SET updated_at = datetime('now') WHERE id = OLD.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_contract_scan_cursors_updated_at
  AFTER UPDATE ON contract_scan_cursors
  FOR EACH ROW
  BEGIN
    UPDATE contract_scan_cursors
    SET updated_at = datetime('now')
    WHERE contract_id = OLD.contract_id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_users_updated_at
  AFTER UPDATE ON users
  FOR EACH ROW
  BEGIN
    UPDATE users SET updated_at = datetime('now') WHERE id = OLD.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_user_wallets_updated_at
  AFTER UPDATE ON user_wallets
  FOR EACH ROW
  BEGIN
    UPDATE user_wallets SET updated_at = datetime('now') WHERE id = OLD.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_alert_state_updated_at
  AFTER UPDATE ON alert_state
  FOR EACH ROW
  BEGIN
    UPDATE alert_state SET updated_at = datetime('now') WHERE id = OLD.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_index_streams_updated_at
  AFTER UPDATE ON index_streams
  FOR EACH ROW
  BEGIN
    UPDATE index_streams SET updated_at = datetime('now') WHERE id = OLD.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_index_cursors_updated_at
  AFTER UPDATE ON index_cursors
  FOR EACH ROW
  BEGIN
    UPDATE index_cursors SET updated_at = datetime('now') WHERE stream_id = OLD.stream_id;
  END;
  `;

  db.exec(schemaSql);

  db.exec(`
    INSERT OR IGNORE INTO chains (id, name) VALUES
      ('FLR', 'Flare'),
      ('XDC', 'XDC Network');
  `);

  const contractsSqlRow = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'contracts'`)
    .get();
  const contractsSql = String(contractsSqlRow?.sql || "").toUpperCase();
  const supportsLpAlm = contractsSql.includes("LP_ALM");
  if (!supportsLpAlm) {
    const fkWasOn = Number(db.pragma("foreign_keys", { simple: true })) === 1;
    if (fkWasOn) db.pragma("foreign_keys = OFF");
    try {
      db.exec(`
        CREATE TABLE contracts__new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          chain_id        TEXT NOT NULL,
          kind            TEXT NOT NULL CHECK (kind IN ('LP_NFT', 'LP_ALM', 'LOAN_NFT')),
          contract_key    TEXT NOT NULL UNIQUE,
          protocol        TEXT NOT NULL,
          address_lower   TEXT NOT NULL,
          address_eip55   TEXT NOT NULL,
          default_start_block INTEGER NOT NULL DEFAULT 0 CHECK (default_start_block >= 0),
          is_enabled      INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0,1)),
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (chain_id) REFERENCES chains(id) ON DELETE RESTRICT,
          CHECK (address_lower = lower(address_lower)),
          CHECK (length(address_lower) = 42 AND substr(address_lower, 1, 2) = '0x'),
          CHECK (length(address_eip55) = 42 AND substr(address_eip55, 1, 2) = '0x'),
          UNIQUE (chain_id, address_lower)
        );

        INSERT INTO contracts__new (
          id, chain_id, kind, contract_key, protocol, address_lower, address_eip55,
          default_start_block, is_enabled, created_at, updated_at
        )
        SELECT
          id, chain_id, kind, contract_key, protocol, address_lower, address_eip55,
          default_start_block, is_enabled, created_at, updated_at
        FROM contracts;

        DROP TABLE contracts;
        ALTER TABLE contracts__new RENAME TO contracts;
      `);
    } finally {
      if (fkWasOn) db.pragma("foreign_keys = ON");
    }
  }

  // Recreate contracts indexes/trigger in case contracts table was rebuilt above.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_contracts_chain_kind ON contracts(chain_id, kind);
    CREATE INDEX IF NOT EXISTS idx_contracts_protocol   ON contracts(protocol);
    CREATE TRIGGER IF NOT EXISTS trg_contracts_updated_at
    AFTER UPDATE ON contracts
    FOR EACH ROW
    BEGIN
      UPDATE contracts SET updated_at = datetime('now') WHERE id = OLD.id;
    END;
  `);

  const ensureColumn = (table, column, sqlType) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    const hasCol = cols.some((c) => c.name === column);
    if (!hasCol) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
    }
    return !hasCol;
  };

  const alertTypeAdded = ensureColumn(
    "alert_state",
    "alert_type",
    "TEXT NOT NULL DEFAULT 'GENERIC'"
  );

  ensureColumn(
    "user_wallets",
    "lp_alerts_status_only",
    "INTEGER NOT NULL DEFAULT 0 CHECK (lp_alerts_status_only IN (0,1))"
  );

  ensureColumn("firelight_config", "last_capacity", "TEXT");
  ensureColumn("sp_apr_snapshots", "total_bold_deposits_num", "REAL");
  ensureColumn("sp_apr_snapshots", "apr_24h_pct", "REAL");
  ensureColumn("sp_apr_snapshots", "fee_24h_pct", "REAL");
  ensureColumn("sp_apr_snapshots", "aps_24h_pct", "REAL");
  ensureColumn("sp_apr_snapshots", "rflr_24h_pct", "REAL");
  ensureColumn("users", "heartbeat_hour", "INTEGER NOT NULL DEFAULT 3");
  ensureColumn("users", "heartbeat_enabled", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn("users", "heartbeat_tz", "TEXT NOT NULL DEFAULT 'America/Los_Angeles'");

  db.exec(`
    UPDATE users
    SET heartbeat_hour = COALESCE(heartbeat_hour, 3),
        heartbeat_enabled = COALESCE(heartbeat_enabled, 1),
        heartbeat_tz = COALESCE(heartbeat_tz, 'America/Los_Angeles')
    WHERE heartbeat_hour IS NULL OR heartbeat_enabled IS NULL OR heartbeat_tz IS NULL
  `);

  if (alertTypeAdded) {
    const rows = db
      .prepare(`SELECT id, state_json FROM alert_state WHERE alert_type = 'GENERIC'`)
      .all();
    const upd = db.prepare(`UPDATE alert_state SET alert_type = ? WHERE id = ?`);
    for (const r of rows) {
      let inferred = "GENERIC";
      try {
        const obj = r.state_json ? JSON.parse(r.state_json) : null;
        if (obj?.kind === "LP") inferred = "LP_RANGE";
        else if (obj?.kind === "LOAN") {
          if (obj?.cdpIR != null || obj?.globalIR != null) inferred = "REDEMPTION";
          else inferred = "LIQUIDATION";
        }
      } catch (_) {}
      upd.run(inferred, r.id);
    }
  }
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
  initSchema(_db);

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
  initSchema,
  getDb,
  getOrCreateUserId,
  getOrCreateWalletId,
  ensureContractScanCursor,
};
