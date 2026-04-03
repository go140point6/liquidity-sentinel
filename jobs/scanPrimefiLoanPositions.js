const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '..', '.env'),
  quiet: true,
});

const baseLogger = require('../utils/logger');
const logger = baseLogger.forEnv('SCAN_DEBUG');
const { getDb } = require('../db');
const { refreshPrimefiLoanSnapshots } = require('../monitoring/primefiLoanMonitor');

async function main() {
  getDb();
  const runId = String(Date.now());
  logger.info('[scanPrimefiLoanPositions] start');
  const rows = await refreshPrimefiLoanSnapshots(runId);
  logger.info(`[scanPrimefiLoanPositions] done positions=${rows.length}`);
}

main().catch((err) => {
  logger.error('[scanPrimefiLoanPositions] FATAL:', err?.stack || err?.message || err);
  process.exitCode = 1;
});
