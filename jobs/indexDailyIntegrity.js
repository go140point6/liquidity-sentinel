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

const LOCK_NAME = "index-daily-integrity";
const PIPELINE_LOCK_NAME = "index-pipeline-cycle";
const WAIT_POLL_MS = 15000;
const WAIT_MAX_MS = 15 * 60 * 1000;
const METRICS_DIR = path.join(__dirname, "..", "data", "metrics");
const RUNS_JSONL = path.join(METRICS_DIR, "index-integrity-runs.jsonl");
const LATEST_JSON = path.join(METRICS_DIR, "index-integrity-latest.json");

function ensureMetricsDir() {
  fs.mkdirSync(METRICS_DIR, { recursive: true });
}

function appendRunSummary(summary) {
  ensureMetricsDir();
  fs.appendFileSync(RUNS_JSONL, `${JSON.stringify(summary)}\n`, "utf8");
  fs.writeFileSync(LATEST_JSON, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPipelineIdle() {
  const waitStart = Date.now();
  while (true) {
    if (!isLockActive(PIPELINE_LOCK_NAME)) {
      const waited = Date.now() - waitStart;
      if (waited > 0) {
        logger.info(`[indexDailyIntegrity] pipeline idle after waiting ${waited}ms`);
      }
      return true;
    }

    const waited = Date.now() - waitStart;
    if (waited >= WAIT_MAX_MS) {
      logger.warn(
        `[indexDailyIntegrity] pipeline lock still active after ${waited}ms; skipping this run`
      );
      return false;
    }

    logger.info(
      `[indexDailyIntegrity] waiting for pipeline lock (${waited}ms elapsed, poll=${WAIT_POLL_MS}ms)`
    );
    await sleep(WAIT_POLL_MS);
  }
}

function runNodeScript(scriptRelPath, args = []) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, "..", scriptRelPath);
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: path.join(__dirname, ".."),
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", (err) => {
      resolve({ ok: 0, code: null, signal: null, error: String(err?.message || err) });
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        resolve({ ok: 0, code: null, signal: String(signal), error: `terminated by signal ${signal}` });
        return;
      }
      resolve({ ok: code === 0 ? 1 : 0, code: Number(code), signal: null, error: code === 0 ? null : `exit code ${code}` });
    });
  });
}

const lockPath = acquireLock(LOCK_NAME);
if (!lockPath) {
  logger.warn("[indexDailyIntegrity] another run is active, exiting");
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

async function main() {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();

  const steps = [
    { name: "validateCursorContinuity", script: "dev/validateCursorContinuity.js", args: [] },
    { name: "validateEventDuplicates", script: "dev/validateEventDuplicates.js", args: [] },
    { name: "validateBackfillBoundaries", script: "dev/validateBackfillBoundaries.js", args: [] },
    { name: "shadowDiffNft_FLR", script: "dev/shadowDiffNftState.js", args: ["--chain=FLR"] },
    { name: "shadowDiffNft_XDC", script: "dev/shadowDiffNftState.js", args: ["--chain=XDC"] },
    { name: "shadowDiffCursors_FLR", script: "dev/shadowDiffCursors.js", args: ["--chain=FLR"] },
    { name: "shadowDiffCursors_XDC", script: "dev/shadowDiffCursors.js", args: ["--chain=XDC"] },
  ];

  logger.info("[indexDailyIntegrity] start");
  const pipelineIdle = await waitForPipelineIdle();
  if (!pipelineIdle) {
    const endedMs = Date.now();
    const elapsedMs = endedMs - startedMs;
    const summary = {
      started_at: startedAt,
      ended_at: new Date(endedMs).toISOString(),
      elapsed_ms: elapsedMs,
      ok: 1,
      skipped: 1,
      skip_reason: "pipeline_lock_timeout",
      fail_count: 0,
      step_count: steps.length,
      steps: [],
      latest_summary_file: LATEST_JSON,
    };
    appendRunSummary(summary);
    return;
  }

  const stepResults = [];
  let failCount = 0;

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const t0 = Date.now();
    logger.info(`[indexDailyIntegrity] step ${i + 1}/${steps.length} start: ${step.name}`);

    const res = await runNodeScript(step.script, step.args);
    const elapsedMs = Date.now() - t0;

    if (!res.ok) failCount += 1;

    logger.info(
      `[indexDailyIntegrity] step ${i + 1}/${steps.length} ${res.ok ? "OK" : "FAIL"}: ${step.name} elapsed=${elapsedMs}ms`
    );

    stepResults.push({
      name: step.name,
      script: step.script,
      args: step.args,
      ok: res.ok,
      code: res.code,
      signal: res.signal,
      error: res.error,
      elapsed_ms: elapsedMs,
    });
  }

  const endedMs = Date.now();
  const elapsedMs = endedMs - startedMs;
  const ok = failCount === 0 ? 1 : 0;

  const summary = {
    started_at: startedAt,
    ended_at: new Date(endedMs).toISOString(),
    elapsed_ms: elapsedMs,
    ok,
    skipped: 0,
    skip_reason: null,
    fail_count: failCount,
    step_count: steps.length,
    steps: stepResults,
    latest_summary_file: LATEST_JSON,
  };

  appendRunSummary(summary);

  logger.info(
    `[indexDailyIntegrity] done ok=${ok} fail_count=${failCount} elapsed=${elapsedMs}ms summary=${LATEST_JSON}`
  );

  if (!ok) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    logger.error("[indexDailyIntegrity] FATAL:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    safeReleaseLock();
  });
