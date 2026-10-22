const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const baseLogger = require("../utils/logger");
const logger = baseLogger.forEnv("SCAN_DEBUG");
const { acquireLock, releaseLock, isLockActive } = require("../utils/lock");

const LOCK_NAME = "index-pipeline-cycle";
const INTEGRITY_LOCK_NAME = "index-daily-integrity";
const METRICS_DIR = path.join(__dirname, "..", "data", "metrics");
const METRICS_JSONL = path.join(METRICS_DIR, "index-cycle-runs.jsonl");
const METRICS_SUMMARY = path.join(METRICS_DIR, "index-cycle-summary.json");
const DEFAULT_STAGE_TIMEOUT_MS = 5 * 60 * 1000;

function getStageTimeoutMs() {
  const raw = process.env.INDEX_PIPELINE_STAGE_TIMEOUT_MS;
  if (raw == null || raw === "") return DEFAULT_STAGE_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("INDEX_PIPELINE_STAGE_TIMEOUT_MS must be a positive integer");
  }
  return value;
}

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
    degraded_count: runs.filter((r) => Number(r?.degraded) === 1).length,
    skipped_count: runs.filter((r) => Number(r?.skipped) === 1).length,
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
let activeChild = null;
let shutdownCode = null;
function safeReleaseLock() {
  if (lockReleased) return;
  lockReleased = true;
  try {
    releaseLock(lockPath);
  } catch (_) {}
}

process.once("exit", safeReleaseLock);
function handleShutdown(signal, code) {
  shutdownCode = code;
  process.exitCode = code;
  if (!activeChild) {
    safeReleaseLock();
    return;
  }
  logger.warn(`[indexPipelineCycle] received ${signal}; forwarding to active stage process`);
  activeChild.kill(signal);
  const childToStop = activeChild;
  const killTimer = setTimeout(() => {
    if (activeChild === childToStop) childToStop.kill("SIGKILL");
  }, 10_000);
  killTimer.unref();
  childToStop.once("exit", () => clearTimeout(killTimer));
}

process.once("SIGINT", () => handleShutdown("SIGINT", 130));
process.once("SIGTERM", () => handleShutdown("SIGTERM", 143));
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
  if (shutdownCode != null) {
    return Promise.reject(new Error(`pipeline shutting down (exit ${shutdownCode})`));
  }
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, "..", scriptRelPath);
    const timeoutMs = getStageTimeoutMs();
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: path.join(__dirname, ".."),
      env: process.env,
      stdio: "inherit",
    });
    activeChild = child;

    let settled = false;
    let killTimer = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = null;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (err) reject(err);
      else resolve();
    };
    const timeout = setTimeout(() => {
      logger.warn(`[indexPipelineCycle] ${scriptRelPath} exceeded ${timeoutMs}ms; sending SIGTERM`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) {
          logger.warn(`[indexPipelineCycle] ${scriptRelPath} did not stop after SIGTERM; sending SIGKILL`);
          child.kill("SIGKILL");
        }
      }, 10_000);
      killTimer.unref();
    }, timeoutMs);
    timeout.unref();

    child.on("error", (err) => finish(err));
    child.on("exit", (code, signal) => {
      if (signal) {
        finish(new Error(`${scriptRelPath} terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        finish(new Error(`${scriptRelPath} exited with code ${code}`));
        return;
      }
      finish();
    });
  });
}

async function runIndependentStage(stage, script, args, degradedStages) {
  try {
    await runNodeScript(script, args);
  } catch (err) {
    const error = String(err?.message || err);
    degradedStages.push({ stage, error });
    logger.warn(`[indexPipelineCycle] ${stage} degraded; continuing: ${error}`);
  }
}

const runStartMs = Date.now();
const runStartIso = new Date(runStartMs).toISOString();

async function main() {
  const degradedStages = [];

  logger.info("[indexPipelineCycle] start");
  if (isLockActive(INTEGRITY_LOCK_NAME)) {
    logger.warn("[indexPipelineCycle] integrity run is active, skipping this cycle");
    const elapsed = Date.now() - runStartMs;
    const summary = appendAndSummarizeMetrics({
      started_at: runStartIso,
      ended_at: new Date().toISOString(),
      elapsed_ms: elapsed,
      ok: 1,
      skipped: 1,
      skip_reason: "integrity_lock_active",
    });
    logger.info(
      `[indexPipelineCycle] metrics count=${summary.count} skipped=${summary.skipped_count} p50=${summary.p50_ms}ms p95=${summary.p95_ms}ms max=${summary.max_ms}ms file=${METRICS_SUMMARY}`
    );
    return;
  }

  // Phase 1: index tail
  logger.info("[indexPipelineCycle] stage 1/10: index tail FLR");
  await runIndependentStage("index_tail_flr", "jobs/indexTail.js", ["--chain=FLR"], degradedStages);

  logger.info("[indexPipelineCycle] stage 2/10: index tail XDC");
  await runIndependentStage("index_tail_xdc", "jobs/indexTail.js", ["--chain=XDC"], degradedStages);

  // Phase 2: derive indexed ownership
  logger.info("[indexPipelineCycle] stage 3/10: derive NFT FLR");
  await runIndependentStage("derive_nft_flr", "jobs/deriveNftStateFromEvents.js", ["--chain=FLR"], degradedStages);

  logger.info("[indexPipelineCycle] stage 4/10: derive NFT XDC");
  await runIndependentStage("derive_nft_xdc", "jobs/deriveNftStateFromEvents.js", ["--chain=XDC"], degradedStages);

  // Phase 3: derive ALM share flow ledger
  logger.info("[indexPipelineCycle] stage 5/10: derive ALM flows FLR");
  await runIndependentStage("derive_alm_flows_flr", "jobs/deriveAlmFlowsFromEvents.js", ["--chain=FLR"], degradedStages);

  logger.info("[indexPipelineCycle] stage 6/10: derive ALM flows XDC");
  await runIndependentStage("derive_alm_flows_xdc", "jobs/deriveAlmFlowsFromEvents.js", ["--chain=XDC"], degradedStages);

  // Phase 4: loan redemption event indexing
  logger.info("[indexPipelineCycle] stage 7/10: scan loan redemption events");
  await runIndependentStage("loan_redemption_events_flr", "jobs/scanLoanRedemptionEvents.js", ["--chain=FLR"], degradedStages);
  await runIndependentStage("loan_redemption_events_xdc", "jobs/scanLoanRedemptionEvents.js", ["--chain=XDC"], degradedStages);

  // Phase 5: refresh snapshots/alerts (with INDEXER_SKIP_DIRECT_SCAN=1 expected)
  logger.info("[indexPipelineCycle] stage 8/10: scan + snapshot refresh");
  await runNodeScript("jobs/scanLoanLpPositions.js");

  // Phase 6: refresh tracked Stability Pool positions. This remains non-blocking
  // so an SP-specific RPC or contract issue cannot stall the core index pipeline.
  logger.info("[indexPipelineCycle] stage 9/10: scan Stability Pool positions");
  try {
    await runNodeScript("jobs/scanStabilityPoolPositions.js");
  } catch (err) {
    const error = String(err?.message || err);
    degradedStages.push({ stage: "scan_stability_pool_positions", error });
    logger.warn(
      `[indexPipelineCycle] stage 9/10 degraded: Stability Pool position scan failed; completing pipeline with prior SP snapshots preserved: ${error}`
    );
  }

  // Phase 7: refresh SP market/rate snapshots only when their configured
  // polling interval has elapsed. Each pool tracks its own due state.
  logger.info("[indexPipelineCycle] stage 10/10: collect due Stability Pool market snapshots");
  try {
    await runNodeScript("jobs/collectStabilityPoolSnapshots.js", ["--if-due"]);
  } catch (err) {
    const error = String(err?.message || err);
    degradedStages.push({ stage: "collect_stability_pool_snapshots", error });
    logger.warn(
      `[indexPipelineCycle] stage 10/10 degraded: Stability Pool market snapshot collection failed; completing pipeline with prior market snapshots preserved: ${error}`
    );
  }

  const elapsed = Date.now() - runStartMs;
  const degraded = degradedStages.length > 0;
  if (degraded) {
    logger.warn(
      `[indexPipelineCycle] done degraded stages=${degradedStages.map((item) => item.stage).join(",")} (elapsed ${elapsed} ms)`
    );
  } else {
    logger.info(`[indexPipelineCycle] done (elapsed ${elapsed} ms)`);
  }

  const summary = appendAndSummarizeMetrics({
    started_at: runStartIso,
    ended_at: new Date().toISOString(),
    elapsed_ms: elapsed,
    ok: 1,
    skipped: 0,
    degraded: degraded ? 1 : 0,
    degraded_stages: degradedStages,
  });
  logger.info(
    `[indexPipelineCycle] metrics count=${summary.count} degraded=${summary.degraded_count} skipped=${summary.skipped_count} p50=${summary.p50_ms}ms p95=${summary.p95_ms}ms max=${summary.max_ms}ms file=${METRICS_SUMMARY}`
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
        skipped: 0,
        error: String(err?.message || err),
      });
      logger.warn(
        `[indexPipelineCycle] metrics count=${summary.count} skipped=${summary.skipped_count} p50=${summary.p50_ms}ms p95=${summary.p95_ms}ms max=${summary.max_ms}ms file=${METRICS_SUMMARY}`
      );
    } catch (_) {}
    logger.error("[indexPipelineCycle] FATAL:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    safeReleaseLock();
  });
