// utils/runtimeGuards.js
const logger = require("./logger");

function requireNumberEnv(name) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") {
    throw new Error(`[runtimeGuards] Missing required env var: ${name}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`[runtimeGuards] Invalid ${name}="${raw}" (must be numeric)`);
  }
  return n;
}

function installNodeCronWarnThrottle() {
  const windowMs = Math.max(1000, Math.floor(requireNumberEnv("NODE_CRON_WARN_THROTTLE_MS")));
  const originalWarn = console.warn.bind(console);
  let lastMissedExecutionAt = 0;
  let suppressedCount = 0;

  console.warn = (...args) => {
    const first = String(args?.[0] || "");
    const isNodeCronMissed =
      first.includes("[NODE-CRON]") && first.includes("missed execution at");

    if (!isNodeCronMissed) {
      originalWarn(...args);
      return;
    }

    const now = Date.now();
    if (now - lastMissedExecutionAt >= windowMs) {
      lastMissedExecutionAt = now;
      if (suppressedCount > 0) {
        originalWarn(
          `${first} (throttled: suppressed ${suppressedCount} similar warnings in last ${Math.round(
            windowMs / 1000
          )}s)`
        );
        suppressedCount = 0;
      } else {
        originalWarn(...args);
      }
      return;
    }

    suppressedCount += 1;
  };

  logger.startup(`[runtime] node-cron warn throttle enabled (${windowMs}ms window)`);
}

function startEventLoopWatchdog() {
  const intervalMs = Math.max(1000, Math.floor(requireNumberEnv("EVENT_LOOP_LAG_CHECK_MS")));
  const warnMs = Math.max(100, requireNumberEnv("EVENT_LOOP_LAG_WARN_MS"));
  const exitMs = Math.max(warnMs, requireNumberEnv("EVENT_LOOP_LAG_EXIT_MS"));
  const strikesToExit = Math.max(1, Math.floor(requireNumberEnv("EVENT_LOOP_LAG_STRIKES")));

  let expected = Date.now() + intervalMs;
  let strikes = 0;

  setInterval(() => {
    const now = Date.now();
    const lagMs = now - expected;
    expected = now + intervalMs;

    if (lagMs >= warnMs) {
      strikes += 1;
      logger.warn(
        `[runtime] Event-loop lag detected: ${lagMs}ms (warn>=${warnMs}ms, strike ${strikes}/${strikesToExit})`
      );
    } else {
      strikes = 0;
    }

    if (lagMs >= exitMs && strikes >= strikesToExit) {
      logger.error(
        `[runtime] Event-loop lag critical: ${lagMs}ms (exit>=${exitMs}ms for ${strikesToExit} strikes). Exiting for PM2 restart.`
      );
      process.exit(1);
    }
  }, intervalMs).unref();

  logger.startup(
    `[runtime] Event-loop watchdog enabled (check=${intervalMs}ms warn=${warnMs}ms exit=${exitMs}ms strikes=${strikesToExit})`
  );
}

module.exports = {
  installNodeCronWarnThrottle,
  startEventLoopWatchdog,
};
