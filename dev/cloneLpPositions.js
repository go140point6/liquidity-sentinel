// dev/cloneLpPositions.js
// Clone existing LP snapshots to create multiple positions per pool for UI testing.

const path = require("node:path");
const Database = require("better-sqlite3");

function readEnvDbPath() {
  const raw = process.env.DB_PATH || "./data/liquidity-sentinel-dev.sqlite";
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function parseArgs(argv) {
  const out = { count: 3, protocol: null, pair: null, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--count" && argv[i + 1]) {
      out.count = Number(argv[i + 1]);
      i += 1;
    } else if (a === "--protocol" && argv[i + 1]) {
      out.protocol = String(argv[i + 1]).toUpperCase();
      i += 1;
    } else if (a === "--pair" && argv[i + 1]) {
      out.pair = String(argv[i + 1]).toUpperCase();
      i += 1;
    } else if (a === "--dry-run") {
      out.dryRun = true;
    }
  }
  if (!Number.isFinite(out.count) || out.count < 1) out.count = 3;
  return out;
}

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function toNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

function cloneSnapshotJson(base, idx) {
  const obj = { ...base };
  const newTokenId = `CLONE-${base.tokenId}-${idx + 1}`;
  obj.tokenId = newTokenId;
  obj.positionId = newTokenId;

  if (obj.tickLower != null && obj.tickUpper != null) {
    const width = Number(obj.tickUpper) - Number(obj.tickLower);
    const shift = Math.round(width * randBetween(-0.2, 0.2));
    obj.tickLower = Number(obj.tickLower) + shift;
    obj.tickUpper = Number(obj.tickUpper) + shift;
  }

  if (obj.currentTick != null) {
    obj.currentTick = Number(obj.currentTick) + Math.round(randBetween(-5, 5));
  }

  const amount0 = toNum(obj.amount0);
  const amount1 = toNum(obj.amount1);
  if (amount0 != null) obj.amount0 = amount0 * randBetween(0.6, 1.4);
  if (amount1 != null) obj.amount1 = amount1 * randBetween(0.6, 1.4);

  const fees0 = toNum(obj.fees0);
  const fees1 = toNum(obj.fees1);
  if (fees0 != null) obj.fees0 = fees0 * randBetween(0.3, 1.7);
  if (fees1 != null) obj.fees1 = fees1 * randBetween(0.3, 1.7);

  const liq = toNum(obj.liquidity);
  if (liq != null) obj.liquidity = String(Math.max(1, Math.round(liq * randBetween(0.5, 1.5))));

  return obj;
}

function main() {
  const args = parseArgs(process.argv);
  const dbPath = readEnvDbPath();
  const db = new Database(dbPath);

  const rows = db
    .prepare(
      `
      SELECT user_id, wallet_id, contract_id, token_id, chain_id, protocol, wallet_label, snapshot_json
      FROM lp_position_snapshots
      ORDER BY chain_id, protocol, token_id
    `
    )
    .all();

  const filtered = rows.filter((r) => {
    if (args.protocol && String(r.protocol || "").toUpperCase() !== args.protocol) return false;
    if (args.pair) {
      const obj = safeParseJson(r.snapshot_json);
      const pair = (obj?.pairLabel || "").toString().toUpperCase();
      if (!pair.includes(args.pair)) return false;
    }
    const obj = safeParseJson(r.snapshot_json);
    const status = String(obj?.status || obj?.rangeStatus || "").toUpperCase();
    if (status === "INACTIVE") return false;
    return true;
  });

  if (!filtered.length) {
    console.log("No LP snapshots matched the filters.");
    return;
  }

  const runId = `dev-clone-${Date.now()}`;
  const insert = db.prepare(
    `
    INSERT OR REPLACE INTO lp_position_snapshots (
      user_id, wallet_id, contract_id, token_id,
      chain_id, protocol, wallet_label,
      snapshot_run_id, snapshot_at, snapshot_json
    ) VALUES (
      @user_id, @wallet_id, @contract_id, @token_id,
      @chain_id, @protocol, @wallet_label,
      @snapshot_run_id, datetime('now'), @snapshot_json
    )
  `
  );

  let total = 0;
  for (const row of filtered) {
    const base = safeParseJson(row.snapshot_json);
    if (!base) continue;
    for (let i = 0; i < args.count; i += 1) {
      const clone = cloneSnapshotJson(base, i);
      const payload = {
        user_id: row.user_id,
        wallet_id: row.wallet_id,
        contract_id: row.contract_id,
        token_id: clone.tokenId,
        chain_id: row.chain_id,
        protocol: row.protocol,
        wallet_label: row.wallet_label || null,
        snapshot_run_id: runId,
        snapshot_json: JSON.stringify(clone),
      };
      total += 1;
      if (!args.dryRun) insert.run(payload);
    }
  }

  console.log(
    `${args.dryRun ? "[dry-run] " : ""}Inserted ${total} cloned LP snapshots (runId=${runId}).`
  );
}

main();
