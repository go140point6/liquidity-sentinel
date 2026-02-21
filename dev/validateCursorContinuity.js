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

const includeNonDone = process.argv.includes("--include-non-done");

const db = new Database(requireEnv("DB_PATH"));
initSchema(db);

try {
  const jobs = db
    .prepare(`
      SELECT j.id, j.stream_id, j.mode, j.from_block, j.to_block, j.status, s.stream_key
      FROM backfill_jobs j
      JOIN index_streams s ON s.id = j.stream_id
      ${includeNonDone ? "" : "WHERE j.status = 'DONE'"}
      ORDER BY j.id
    `)
    .all();

  console.log(`[continuity] start jobs=${jobs.length} include_non_done=${includeNonDone ? 1 : 0}`);
  let issues = 0;
  let checked = 0;

  for (const j of jobs) {
    checked += 1;
    if (checked % 25 === 0) {
      console.log(`[continuity] progress checked=${checked}/${jobs.length}`);
    }
    const windows = db
      .prepare(`
        SELECT from_block, to_block, status
        FROM backfill_windows
        WHERE job_id = ?
        ORDER BY from_block, to_block, attempt_no
      `)
      .all(j.id)
      .filter((w) => w.status === "OK");

    if (!windows.length) {
      console.log(`[continuity] WARN job=${j.id} stream=${j.stream_key} has no OK windows`);
      issues += 1;
      continue;
    }

    const first = windows[0];
    if (first.from_block !== j.from_block) {
      console.log(
        `[continuity] GAP_START job=${j.id} stream=${j.stream_key} expected_from=${j.from_block} got=${first.from_block}`
      );
      issues += 1;
    }

    let prevTo = first.to_block;
    for (let i = 1; i < windows.length; i += 1) {
      const w = windows[i];
      if (w.from_block > prevTo + 1) {
        console.log(
          `[continuity] GAP job=${j.id} stream=${j.stream_key} prev_to=${prevTo} next_from=${w.from_block}`
        );
        issues += 1;
      }
      prevTo = Math.max(prevTo, w.to_block);
    }

    if (j.status === "DONE" && j.to_block != null && prevTo < j.to_block) {
      console.log(
        `[continuity] GAP_END job=${j.id} stream=${j.stream_key} expected_to=${j.to_block} last_ok_to=${prevTo}`
      );
      issues += 1;
    }
  }

  if (issues === 0) {
    console.log(`[continuity] OK checked_jobs=${jobs.length}`);
  } else {
    console.log(`[continuity] FAIL issues=${issues} checked_jobs=${jobs.length}`);
    process.exitCode = 1;
  }
} finally {
  db.close();
}
