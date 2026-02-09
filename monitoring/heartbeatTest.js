// monitoring/heartbeatTest.js
// In-memory overrides for testing daily heartbeat; resets on process restart.

const overrides = new Map(); // discordId -> timestamp

function setHeartbeatTestOverride(discordId) {
  if (!discordId) return;
  overrides.set(String(discordId), Date.now());
}

function hasHeartbeatTestOverride(discordId) {
  if (!discordId) return false;
  return overrides.has(String(discordId));
}

function consumeHeartbeatTestOverride(discordId) {
  if (!discordId) return false;
  const key = String(discordId);
  if (!overrides.has(key)) return false;
  overrides.delete(key);
  return true;
}

module.exports = {
  setHeartbeatTestOverride,
  hasHeartbeatTestOverride,
  consumeHeartbeatTestOverride,
};
