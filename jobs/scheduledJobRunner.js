const path = require("node:path");
const { spawn } = require("node:child_process");
const cron = require("node-cron");

const baseLogger = require("../utils/logger");
const logger = baseLogger.forEnv("SCAN_DEBUG");

const [scriptArg, schedule] = process.argv.slice(2);
const repoRoot = path.join(__dirname, "..");
const scriptPath = scriptArg ? path.resolve(repoRoot, scriptArg) : null;

if (!scriptPath || !scriptPath.startsWith(`${repoRoot}${path.sep}`)) {
  logger.error("[scheduledJobRunner] Provide a job script path inside the repo.");
  process.exit(1);
}

if (!schedule || !cron.validate(schedule)) {
  logger.error(`[scheduledJobRunner] Invalid or missing cron schedule: ${schedule || "(empty)"}`);
  process.exit(1);
}

let child = null;
let shuttingDown = false;
let shutdownTimer = null;

function runJob(trigger) {
  if (shuttingDown) return Promise.resolve();
  if (child) {
    logger.warn(`[scheduledJobRunner] ${path.basename(scriptPath)} still running; skipping ${trigger} trigger.`);
    return Promise.resolve();
  }

  logger.info(`[scheduledJobRunner] Starting ${path.relative(repoRoot, scriptPath)} (${trigger}).`);

  return new Promise((resolve) => {
    const job = spawn(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    child = job;
    let finished = false;

    const finish = (message, level = "info") => {
      if (finished) return;
      finished = true;
      if (child === job) child = null;
      if (message) logger[level](message);
      if (shuttingDown) {
        if (shutdownTimer) clearTimeout(shutdownTimer);
        process.exit(0);
      }
      resolve();
    };

    job.once("error", (err) => {
      finish(`[scheduledJobRunner] Could not launch ${path.basename(scriptPath)}: ${err.message}`, "error");
    });
    job.once("exit", (code, signal) => {
      if (code === 0 && !signal) {
        finish(`[scheduledJobRunner] ${path.basename(scriptPath)} completed.`);
      } else {
        finish(
          `[scheduledJobRunner] ${path.basename(scriptPath)} ended code=${code} signal=${signal || "none"}; next scheduled run remains enabled.`,
          "warn"
        );
      }
    });
  });
}

const task = cron.schedule(schedule, () => runJob("scheduled"), { noOverlap: true });
logger.startup(
  `[scheduledJobRunner] Persistent scheduler online for ${path.relative(repoRoot, scriptPath)}; schedule=${schedule}; timezone=${Intl.DateTimeFormat().resolvedOptions().timeZone || "system"}`
);

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  task.stop();

  if (!child) {
    process.exit(0);
    return;
  }

  logger.warn(`[scheduledJobRunner] Received ${signal}; forwarding to active job.`);
  child.kill(signal);
  shutdownTimer = setTimeout(() => {
    if (child) {
      logger.warn("[scheduledJobRunner] Active job did not stop in time; sending SIGKILL.");
      child.kill("SIGKILL");
    }
  }, 10_000);
  shutdownTimer.unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

// Run once when PM2 starts or recovers the scheduler, then follow the wall-clock schedule.
void runJob("startup");
