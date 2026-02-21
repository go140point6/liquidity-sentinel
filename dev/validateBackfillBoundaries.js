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
  const jobs = db
    .prepare(`
      SELECT j.id, j.stream_id, j.from_block, j.to_block, j.status, s.stream_key
      FROM backfill_jobs j
      JOIN index_streams s ON s.id = j.stream_id
      WHERE j.status = 'DONE'
      ORDER BY j.id
    `)
    .all();

  console.log(`[boundaries] start jobs=${jobs.length}`);
  let issues = 0;

  for (const j of jobs) {
    const bounds = db
      .prepare(`
        SELECT MIN(block_number) AS min_block, MAX(block_number) AS max_block, COUNT(*) AS cnt
        FROM chain_events
        WHERE stream_id = ?
          AND block_number BETWEEN ? AND ?
      `)
      .get(j.stream_id, j.from_block, j.to_block);

    const okWindows = db
      .prepare(`
        SELECT from_block, to_block
        FROM backfill_windows
        WHERE job_id = ?
          AND status = 'OK'
        ORDER BY from_block, to_block
      `)
      .all(j.id);

    if (!okWindows.length) {
      console.log(`[boundaries] NO_OK_WINDOWS job=${j.id} stream=${j.stream_key}`);
      issues += 1;
    }

    for (const w of okWindows) {
      const c = db
        .prepare(`
          SELECT COUNT(*) AS cnt
          FROM chain_events
          WHERE stream_id = ?
            AND block_number BETWEEN ? AND ?
        `)
        .get(j.stream_id, w.from_block, w.to_block)?.cnt;
      if (!Number.isFinite(c)) {
        console.log(
          `[boundaries] WINDOW_COUNT_ERROR job=${j.id} stream=${j.stream_key} window=${w.from_block}-${w.to_block}`
        );
        issues += 1;
      }
    }

    console.log(
      `[boundaries] job=${j.id} stream=${j.stream_key} range=${j.from_block}-${j.to_block} ok_windows=${okWindows.length} events_in_job_range=${bounds?.cnt || 0} first=${bounds?.min_block ?? "-"} last=${bounds?.max_block ?? "-"}`
    );
  }

  if (issues > 0) {
    console.log(`[boundaries] FAIL issues=${issues}`);
    process.exitCode = 1;
  } else {
    console.log(`[boundaries] OK checked_jobs=${jobs.length}`);
  }
} finally {
  db.close();
}
