// ./utils/logger.js

function requireIntEnv(name, { min = 0, max = 3 } = {}) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") {
    throw new Error(`[logger] Missing required env var: ${name}`);
  }

  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(
      `[logger] Invalid ${name}="${raw}". Must be an integer in range ${min}-${max}.`
    );
  }

  return n;
}

/**
 * Log levels:
 *   0 = errors only
 *   1 = warnings
 *   2 = info
 *   3 = debug
 *
 * startup() always prints, regardless of level.
 *
 * Color behavior:
 * - Enabled automatically when running in a TTY
 * - Disabled if NO_COLOR is set
 * - Forced on if FORCE_COLOR is set
 */

const isTTY = Boolean(process.stdout.isTTY);
const useColor =
  (process.env.FORCE_COLOR ? true : isTTY) && !process.env.NO_COLOR;

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
};

function ts() {
  return new Date().toISOString();
}

function formatLabel(label) {
  if (!useColor) return `[${label}]`;

  switch (label) {
    case "STARTUP":
      return `${ANSI.green}[${label}]${ANSI.reset}`;
    case "ERROR":
      return `${ANSI.red}[${label}]${ANSI.reset}`;
    case "WARN":
      return `${ANSI.yellow}[${label}]${ANSI.reset}`;
    case "INFO":
      return `${ANSI.blue}[${label}]${ANSI.reset}`;
    case "DEBUG":
      return `${ANSI.gray}[${label}]${ANSI.reset}`;
    default:
      return `[${label}]`;
  }
}

function _log(label, args) {
  const stamp = useColor
    ? `${ANSI.dim}[${ts()}]${ANSI.reset}`
    : `[${ts()}]`;

  console.log(`${stamp} ${formatLabel(label)}`, ...args);
}

function createLogger(level) {
  if (!Number.isInteger(level) || level < 0 || level > 3) {
    throw new Error(`[logger] Invalid level=${level}. Must be 0-3.`);
  }

  function startup(...args) {
    _log("STARTUP", args);
  }

  function error(...args) {
    _log("ERROR", args);
  }

  function warn(...args) {
    if (level >= 1) _log("WARN", args);
  }

  function info(...args) {
    if (level >= 2) _log("INFO", args);
  }

  function debug(...args) {
    if (level >= 3) _log("DEBUG", args);
  }

  return { startup, error, warn, info, debug };
}

// Global logger must be configured via DEBUG in env (fail fast if missing/invalid)
const DEBUG_LEVEL = requireIntEnv("DEBUG", { min: 0, max: 3 });
const logger = createLogger(DEBUG_LEVEL);

// For job-specific overrides (e.g. SCAN_DEBUG), fail fast if missing/invalid
function forEnv(envVarName) {
  const level = requireIntEnv(envVarName, { min: 0, max: 3 });
  return createLogger(level);
}

module.exports = {
  ...logger,
  createLogger,
  forEnv,
};
