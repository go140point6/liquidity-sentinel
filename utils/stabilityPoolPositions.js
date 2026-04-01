"use strict";

function parseSnapshotTime(raw) {
  if (!raw) return null;
  const iso = String(raw).includes("T") ? String(raw) : String(raw).replace(" ", "T");
  const ms = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (!Number.isFinite(ms)) return null;
  return { ms, sec: Math.floor(ms / 1000) };
}

function getSpPositionSummaries(db, userId) {
  const rows = db.prepare(`
    SELECT s.snapshot_json, s.snapshot_at
    FROM sp_position_snapshots s
    WHERE s.user_id = ?
    ORDER BY s.pool_label, s.wallet_id
  `).all(userId);

  const out = [];
  for (const row of rows) {
    try {
      const snap = JSON.parse(row.snapshot_json);
      if (!snap || typeof snap !== "object") continue;
      out.push({
        ...snap,
        snapshotAt: row.snapshot_at,
      });
    } catch {
      // ignore bad row
    }
  }
  return out;
}

module.exports = {
  getSpPositionSummaries,
  parseSnapshotTime,
};
