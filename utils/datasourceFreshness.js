const CHAINS = ["FLR", "XDC"];

function readFreshness(db, { now = Date.now(), staleMinutes = 30 } = {}) {
  const rows = db.prepare(`
    SELECT s.chain_id, s.stream_key, MAX(j.finished_at) AS last_success
    FROM index_streams s
    JOIN contracts c ON c.id = s.contract_id
    LEFT JOIN backfill_jobs j ON j.stream_id = s.id
      AND j.mode = 'TAIL' AND j.status = 'DONE'
    WHERE s.is_enabled = 1 AND c.is_enabled = 1
      AND s.event_name = 'Transfer' AND s.chain_id IN ('FLR', 'XDC')
    GROUP BY s.id
  `).all();
  return Object.fromEntries(CHAINS.map((chain) => {
    const streams = rows.filter((row) => row.chain_id === chain);
    const stale = streams.filter((row) => {
      const time = row.last_success ? Date.parse(row.last_success.replace(' ', 'T') + 'Z') : NaN;
      return !Number.isFinite(time) || now - time >= staleMinutes * 60000;
    });
    return [chain, {
      status: !streams.length || stale.length ? 'stale' : 'healthy',
      detail: !streams.length ? 'No enabled transfer streams found.' : stale.length
        ? `${stale.length}/${streams.length} streams have no completed tail scan within ${staleMinutes} minutes. ` +
          stale.slice(0, 3).map((s) => `${s.stream_key}: ${s.last_success || 'never'} UTC`).join('; ')
        : `All ${streams.length} streams completed tail scans within ${staleMinutes} minutes.`,
    }];
  }));
}

function notification(previous, current) {
  const changed = CHAINS.filter((chain) => previous[chain] !== current[chain].status &&
    (previous[chain] != null || current[chain].status !== 'healthy'));
  if (!changed.length) return null;
  const healthy = CHAINS.every((chain) => current[chain].status === 'healthy');
  const lines = [healthy ? '✅ Sentinel data monitor: all clear — FLR and XDC scans are fresh.' :
    '⚠️ Sentinel data monitor: source health changed.'];
  for (const chain of CHAINS) {
    const recovered = changed.includes(chain) && current[chain].status === 'healthy';
    lines.push(`${chain}: ${recovered ? 'RECOVERED' : current[chain].status.toUpperCase()} — ${current[chain].detail}`);
  }
  lines.push(`Checked: ${new Date().toISOString()}`);
  return lines.join('\n').slice(0, 1950);
}

module.exports = { CHAINS, readFreshness, notification };
