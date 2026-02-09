// jobs/monitoringJob.js
const cron = require("node-cron");
const { monitorLoans } = require("../monitoring/loanMonitor");
const { monitorLPs } = require("../monitoring/lpMonitor");

const logger = require("../utils/logger");

function mustEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") {
    logger.error(`[monitoringJob] Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

function startMonitoringJob() {
  const CRON_SCHED = mustEnv("CRON_SCHED");

  if (!cron.validate(CRON_SCHED)) {
    logger.error(`[monitoringJob] Invalid CRON_SCHED: "${CRON_SCHED}"`);
    process.exit(1);
  }

  logger.startup(`[CRON] Using schedule: ${CRON_SCHED}`);

  let isRunning = false;
  const JITTER_MAX_MS = 60_000;

  async function runOnce(label) {
    if (isRunning) {
      logger.warn(`[CRON] Previous ${label} cycle still running — skipping.`);
      return;
    }

    isRunning = true;
    const t0 = Date.now();
    logger.info(`▶️  ${label} start`);

    try {
      await monitorLoans();
      await monitorLPs();
    } catch (e) {
      logger.error(`❌ ${label} failed:`, e);
    } finally {
      const elapsed = Date.now() - t0;
      logger.info(`⏹️  ${label} end (elapsed ${elapsed} ms)`);
      isRunning = false;
    }
  }

  // Run immediately at startup
  void runOnce("(startup) Loan + LP monitor");

  // Schedule recurring
  cron.schedule(CRON_SCHED, () => {
    const jitterMs = Math.floor(Math.random() * JITTER_MAX_MS);
    logger.debug(`[CRON] Jittering monitor by ${jitterMs}ms`);
    setTimeout(() => runOnce("Loan + LP monitor"), jitterMs);
  });
}

module.exports = { startMonitoringJob };
