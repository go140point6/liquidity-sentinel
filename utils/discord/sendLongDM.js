// utils/discord/sendLongDM.js
const DISCORD_MSG_MAX = 2000;

// Default headroom so we can safely add "(i/n) " prefixes + avoid edge-case overflow
const DISCORD_SAFE_MAX = 1900;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Splits text into Discord-sized messages, preferring newline boundaries.
 * - Hard-splits any single line longer than maxLen.
 * - Keeps chunks <= maxLen (caller may add a small prefix).
 */
function splitIntoDiscordMessages(text, maxLen = DISCORD_SAFE_MAX) {
  if (text == null) return [];

  const raw = String(text);
  if (!raw.trim()) return [];

  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const chunks = [];
  let buf = "";

  for (const line of lines) {
    // If a single line is too long, hard-split it
    if (line.length > maxLen) {
      if (buf.length) {
        chunks.push(buf);
        buf = "";
      }
      for (let i = 0; i < line.length; i += maxLen) {
        chunks.push(line.slice(i, i + maxLen));
      }
      continue;
    }

    const addLen = (buf.length === 0 ? 0 : 1) + line.length;

    // If adding this line would exceed max, flush buffer
    if (buf.length + addLen > maxLen) {
      if (buf.length) chunks.push(buf);
      buf = line;
      continue;
    }

    buf = buf.length ? `${buf}\n${line}` : line;
  }

  if (buf.length) chunks.push(buf);

  // Ensure invariant: no chunk > maxLen
  // (Should already be true, but enforce to avoid surprises.)
  const out = [];
  for (const c of chunks) {
    if (c.length <= maxLen) {
      out.push(c);
    } else {
      for (let i = 0; i < c.length; i += maxLen) {
        out.push(c.slice(i, i + maxLen));
      }
    }
  }

  return out;
}

/**
 * Sends long content as multiple DMs (chunked).
 * Adds "(i/n) " prefix when multiple chunks.
 *
 * Includes a small delay between sends to reduce 429 risk.
 */
async function sendLongDM(user, content, opts = {}) {
  const { maxLen = DISCORD_SAFE_MAX, interMessageDelayMs = 350 } = opts;

  const chunks = splitIntoDiscordMessages(content, maxLen);

  if (!chunks.length) return;

  const total = chunks.length;

  for (let i = 0; i < total; i++) {
    const prefix = total > 1 ? `(${i + 1}/${total}) ` : "";

    // Guarantee final payload <= 2000 including prefix
    const room = DISCORD_MSG_MAX - prefix.length;
    const body = chunks[i].length > room ? chunks[i].slice(0, room) : chunks[i];

    await user.send({ content: prefix + body });

    // Rate-limit friendliness (skip delay after last message)
    if (interMessageDelayMs > 0 && i < total - 1) {
      await sleep(interMessageDelayMs);
    }
  }
}

module.exports = { splitIntoDiscordMessages, sendLongDM };
