const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const baseLogger = require("../utils/logger");
const logger = baseLogger.forEnv("SCAN_DEBUG");
const { acquireLock, releaseLock } = require("../utils/lock");

const LOCK_NAME = "index-pipeline-cycle";
const METRICS_DIR = path.join(__dirname, "..", "data", "metrics");
const METRICS_JSONL = path.join(METRICS_DIR, "index-cycle-runs.jsonl");
const METRICS_SUMMARY = path.join(METRICS_DIR, "index-cycle-summary.json");

function ensureMetricsDir() {
  fs.mkdirSync(METRICS_DIR, { recursive: true });
}

function percentile(sortedAsc, p) {
  if (!Array.isArray(sortedAsc) || sortedAsc.length === 0) return null;
  const clampedP = Math.max(0, Math.min(100, Number(p) || 0));
  const idx = Math.ceil((clampedP / 100) * sortedAsc.length) - 1;
  const safeIdx = Math.max(0, Math.min(sortedAsc.length - 1, idx));
  return sortedAsc[safeIdx];
}

function loadRunMetrics() {
  if (!fs.existsSync(METRICS_JSONL)) return [];
  const raw = fs.readFileSync(METRICS_JSONL, "utf8");
  const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (!Number.isFinite(Number(row?.elapsed_ms))) continue;
      out.push(row);
    } catch (_) {}
  }
  return out;
}

function appendAndSummarizeMetrics(entry) {
  ensureMetricsDir();
  fs.appendFileSync(METRICS_JSONL, `${JSON.stringify(entry)}\n`, "utf8");

  const runs = loadRunMetrics().filter((r) => Number.isFinite(Number(r.elapsed_ms)));
  const elapsed = runs.map((r) => Number(r.elapsed_ms)).sort((a, b) => a - b);
  const summary = {
    updated_at: new Date().toISOString(),
    count: elapsed.length,
    ok_count: runs.filter((r) => r.ok === 1).length,
    fail_count: runs.filter((r) => r.ok === 0).length,
    min_ms: elapsed.length ? elapsed[0] : null,
    p50_ms: percentile(elapsed, 50),
    p95_ms: percentile(elapsed, 95),
    max_ms: elapsed.length ? elapsed[elapsed.length - 1] : null,
  };

  fs.writeFileSync(METRICS_SUMMARY, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

const lockPath = acquireLock(LOCK_NAME);
if (!lockPath) {
  logger.warn("[indexPipelineCycle] another cycle is running, exiting");
  process.exit(0);
}

let lockReleased = false;
function safeReleaseLock() {
  if (lockReleased) return;
  lockReleased = true;
  try {
    releaseLock(lockPath);
  } catch (_) {}
}

process.once("exit", safeReleaseLock);
process.once("SIGINT", () => {
  safeReleaseLock();
  process.exit(130);
});
process.once("SIGTERM", () => {
  safeReleaseLock();
  process.exit(143);
});
process.once("uncaughtException", (err) => {
  logger.error("[indexPipelineCycle] FATAL (uncaughtException):", err);
  safeReleaseLock();
  process.exit(1);
});
process.once("unhandledRejection", (err) => {
  logger.error("[indexPipelineCycle] FATAL (unhandledRejection):", err);
  safeReleaseLock();
  process.exit(1);
});

function runNodeScript(scriptRelPath, args = []) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, "..", scriptRelPath);
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: path.join(__dirname, ".."),
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${scriptRelPath} terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${scriptRelPath} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

const runStartMs = Date.now();
const runStartIso = new Date(runStartMs).toISOString();

async function main() {
  logger.info("[indexPipelineCycle] start");

  // Phase 1: index tail
  logger.info("[indexPipelineCycle] stage 1/5: index tail FLR");
  await runNodeScript("jobs/indexTail.js", ["--chain=FLR"]);

  logger.info("[indexPipelineCycle] stage 2/5: index tail XDC");
  await runNodeScript("jobs/indexTail.js", ["--chain=XDC"]);

  // Phase 2: derive indexed ownership
  logger.info("[indexPipelineCycle] stage 3/5: derive NFT FLR");
  await runNodeScript("jobs/deriveNftStateFromEvents.js", ["--chain=FLR"]);

  logger.info("[indexPipelineCycle] stage 4/5: derive NFT XDC");
  await runNodeScript("jobs/deriveNftStateFromEvents.js", ["--chain=XDC"]);

  // Phase 3: refresh snapshots/alerts (with INDEXER_SKIP_DIRECT_SCAN=1 expected)
  logger.info("[indexPipelineCycle] stage 5/5: scan + snapshot refresh");
  await runNodeScript("jobs/scanLoanLpPositions.js");

  const elapsed = Date.now() - runStartMs;
  logger.info(`[indexPipelineCycle] done (elapsed ${elapsed} ms)`);

  const summary = appendAndSummarizeMetrics({
    started_at: runStartIso,
    ended_at: new Date().toISOString(),
    elapsed_ms: elapsed,
    ok: 1,
  });
  logger.info(
    `[indexPipelineCycle] metrics count=${summary.count} p50=${summary.p50_ms}ms p95=${summary.p95_ms}ms max=${summary.max_ms}ms file=${METRICS_SUMMARY}`
  );
}

main()
  .catch((err) => {
    const endedAtMs = Date.now();
    const elapsed = Math.max(0, endedAtMs - runStartMs);
    try {
      const summary = appendAndSummarizeMetrics({
        started_at: runStartIso,
        ended_at: new Date(endedAtMs).toISOString(),
        elapsed_ms: elapsed,
        ok: 0,
        error: String(err?.message || err),
      });
      logger.warn(
        `[indexPipelineCycle] metrics count=${summary.count} p50=${summary.p50_ms}ms p95=${summary.p95_ms}ms max=${summary.max_ms}ms file=${METRICS_SUMMARY}`
      );
    } catch (_) {}
    logger.error("[indexPipelineCycle] FATAL:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    safeReleaseLock();
  });
