// ./utils/lock.js

const fs = require("fs");
const path = require("path");

const LOCK_DIR = path.join(__dirname, "..", "locks");
const STALE_MS = 30 * 60 * 1000; // 30 minutes

// Lazy logger getter — only resolves AFTER dotenv + logger are ready
function getLogger() {
  try {
    return require("./logger");
  } catch {
    return null;
  }
}

function ensureDir() {
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
  } catch (err) {
    const logger = getLogger();
    logger?.error("[LOCK] Failed to create lock directory:", err);
    throw err;
  }
}

function parseLockPid(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const data = JSON.parse(raw);
    const pid = Number(data?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH => no such process (dead)
    // EPERM => process exists but no permission (alive)
    if (err?.code === "EPERM") return true;
    return false;
  }
}

/**
 * Attempt to acquire a filesystem lock.
 *
 * @param {string} name - Logical lock name (file will be `${name}.lock`)
 * @returns {string|null} lockPath if acquired, otherwise null
 */
function acquireLock(name) {
  if (!name || typeof name !== "string") {
    throw new Error("acquireLock(name) requires a non-empty string name.");
  }

  ensureDir();

  const lockPath = path.join(LOCK_DIR, `${name}.lock`);
  const now = Date.now();
  const logger = getLogger();

  // Check for existing lock
  try {
    const stat = fs.statSync(lockPath);
    const age = now - stat.mtimeMs;
    const pid = parseLockPid(lockPath);
    const pidAlive = pid ? isPidAlive(pid) : null;

    // If the owner PID is gone, clear immediately (no need to wait STALE_MS).
    if (pid && !pidAlive) {
      try {
        fs.unlinkSync(lockPath);
        logger?.warn(`[LOCK] Removed dead-PID lock: ${lockPath} (pid ${pid})`);
      } catch {
        return null;
      }
    } else if (age < STALE_MS) {
      // Active lock
      return null;
    } else {
      // Stale lock by age — attempt cleanup
      try {
        fs.unlinkSync(lockPath);
        logger?.warn(`[LOCK] Removed stale lock: ${lockPath}`);
      } catch {
        return null;
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      return null;
    }
  }

  // Try to create the lock atomically
  try {
    fs.writeFileSync(
      lockPath,
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      { flag: "wx" }
    );

    logger?.info(`[LOCK] Acquired lock: ${lockPath}`);
    return lockPath;
  } catch {
    return null;
  }
}

/**
 * Release a previously acquired lock.
 *
 * @param {string|null} lockPath
 */
function releaseLock(lockPath) {
  if (!lockPath) return;

  try {
    fs.unlinkSync(lockPath);
    const logger = getLogger();
    logger?.info(`[LOCK] Released lock: ${lockPath}`);
  } catch {
    // best-effort
  }
}

module.exports = {
  acquireLock,
  releaseLock,
};
