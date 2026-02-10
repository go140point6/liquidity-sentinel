// jobs/heartbeatJob.js
const cron = require("node-cron");
const { sendDailyHeartbeat } = require("../monitoring/dailyHeartbeat");
const logger = require("../utils/logger");

function mustEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") {
    logger.error(`[heartbeatJob] Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

function startHeartbeatJob(client) {
  const HEARTBEAT_CRON = mustEnv("HEARTBEAT_CRON");

  if (!cron.validate(HEARTBEAT_CRON)) {
    logger.error(`[heartbeatJob] Invalid HEARTBEAT_CRON: "${HEARTBEAT_CRON}"`);
    process.exit(1);
  }

  logger.startup(`[CRON] Using heartbeat schedule: ${HEARTBEAT_CRON}`);

  let isRunning = false;

  async function runOnce(label) {
    if (isRunning) {
      logger.warn(`[CRON] Previous ${label} still running — skipping.`);
      return;
    }

    isRunning = true;
    const t0 = Date.now();
    logger.info(`▶️  ${label} start`);

    try {
      await sendDailyHeartbeat(client); // dailyHeartbeat handles DB targets + chunking
    } catch (e) {
      logger.error(`❌ ${label} failed:`, e);
    } finally {
      const elapsed = Date.now() - t0;
      logger.info(`⏹️  ${label} end (elapsed ${elapsed} ms)`);
      isRunning = false;
    }
  }

  cron.schedule(HEARTBEAT_CRON, () => runOnce("Daily heartbeat"));
}

module.exports = { startHeartbeatJob };
