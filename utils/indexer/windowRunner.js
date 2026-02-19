function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(err) {
  const msg = String(err?.message || "");
  const m = msg.match(/retry in\s+(\d+)\s*s/i);
  if (!m) return null;
  const sec = Number(m[1]);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}

function isRateLimitError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("-32090");
}

async function getLogsWithRetry(provider, filter, { maxAttempts = 6, baseBackoffMs = 750 } = {}) {
  let attempt = 0;
  let backoffMs = baseBackoffMs;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const logs = await provider.getLogs(filter);
      return { ok: true, logs, attempt };
    } catch (err) {
      const retryAfterMs = parseRetryAfterMs(err);
      const shouldRetry = isRateLimitError(err) || retryAfterMs != null;

      if (!shouldRetry || attempt >= maxAttempts) {
        return { ok: false, error: err, attempt };
      }

      await sleep(retryAfterMs ?? backoffMs);
      backoffMs = Math.min(backoffMs * 2, 10000);
    }
  }

  return { ok: false, error: new Error("exhausted retries"), attempt: maxAttempts };
}

async function runWindowedScan({
  provider,
  address,
  topic0,
  fromBlock,
  toBlock,
  windowSize,
  pauseMs = 0,
  maxAttempts = 6,
  onWindowStart,
  onWindow,
}) {
  if (!Number.isInteger(fromBlock) || fromBlock < 0) {
    throw new Error("runWindowedScan: fromBlock must be a non-negative integer");
  }
  if (!Number.isInteger(toBlock) || toBlock < fromBlock) {
    throw new Error("runWindowedScan: toBlock must be >= fromBlock");
  }
  if (!Number.isInteger(windowSize) || windowSize <= 0) {
    throw new Error("runWindowedScan: windowSize must be a positive integer");
  }

  for (let start = fromBlock; start <= toBlock; start += windowSize + 1) {
    const end = Math.min(toBlock, start + windowSize);
    const t0 = Date.now();
    if (typeof onWindowStart === "function") {
      await onWindowStart({ fromBlock: start, toBlock: end });
    }

    const res = await getLogsWithRetry(
      provider,
      {
        address,
        fromBlock: start,
        toBlock: end,
        topics: [topic0],
      },
      { maxAttempts }
    );

    const elapsedMs = Date.now() - t0;

    await onWindow({
      fromBlock: start,
      toBlock: end,
      elapsedMs,
      ...res,
    });

    if (!res.ok) {
      break;
    }

    if (pauseMs > 0) {
      await sleep(pauseMs);
    }
  }
}

module.exports = {
  sleep,
  getLogsWithRetry,
  runWindowedScan,
};
