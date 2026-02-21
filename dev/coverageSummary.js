const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const Database = require("better-sqlite3");
const { initSchema } = require("../db");

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var ${name}`);
  return String(v).trim();
}

const db = new Database(requireEnv("DB_PATH"));
initSchema(db);

try {
  const rows = db
    .prepare(`
      SELECT
        s.id,
        s.stream_key,
        s.chain_id,
        s.event_name,
        s.start_block,
        cur.last_scanned_block,
        (
          SELECT COUNT(*) FROM chain_events e WHERE e.stream_id = s.id
        ) AS events_count,
        (
          SELECT MIN(block_number) FROM chain_events e WHERE e.stream_id = s.id
        ) AS first_block,
        (
          SELECT MAX(block_number) FROM chain_events e WHERE e.stream_id = s.id
        ) AS last_block,
        (
          SELECT COUNT(*) FROM backfill_jobs j WHERE j.stream_id = s.id AND j.status = 'DONE'
        ) AS done_jobs,
        (
          SELECT COUNT(*) FROM backfill_jobs j WHERE j.stream_id = s.id AND j.status = 'FAILED'
        ) AS failed_jobs
      FROM index_streams s
      LEFT JOIN index_cursors cur ON cur.stream_id = s.id
      ORDER BY s.chain_id, s.stream_key
    `)
    .all();

  if (!rows.length) {
    console.log("[coverage] no streams found");
    return;
  }

  for (const r of rows) {
    const lag = Number.isInteger(r.last_block) && Number.isInteger(r.last_scanned_block)
      ? Math.max(0, r.last_block - r.last_scanned_block)
      : null;

    console.log(
      [
        `[coverage] stream=${r.stream_key}`,
        `chain=${r.chain_id}`,
        `event=${r.event_name}`,
        `start=${r.start_block}`,
        `cursor=${r.last_scanned_block ?? "-"}`,
        `events=${r.events_count}`,
        `first=${r.first_block ?? "-"}`,
        `last=${r.last_block ?? "-"}`,
        `lag_vs_last_event=${lag == null ? "-" : lag}`,
        `jobs_done=${r.done_jobs}`,
        `jobs_failed=${r.failed_jobs}`,
      ].join(" ")
    );
  }
} finally {
  db.close();
}
