const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { readFreshness, notification } = require('../utils/datasourceFreshness');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE contracts(id INTEGER PRIMARY KEY, is_enabled INTEGER);
    CREATE TABLE index_streams(id INTEGER PRIMARY KEY, contract_id INTEGER, chain_id TEXT, stream_key TEXT, is_enabled INTEGER, event_name TEXT);
    CREATE TABLE backfill_jobs(stream_id INTEGER, mode TEXT, status TEXT, finished_at TEXT);
    INSERT INTO contracts VALUES(1,1),(2,1),(3,1),(4,0);
    INSERT INTO index_streams VALUES
      (1,1,'FLR','FLR:one',1,'Transfer'),(2,2,'XDC','XDC:one',1,'Transfer'),
      (3,3,'XDC','XDC:two',1,'Transfer'),(4,4,'FLR','disabled',1,'Transfer');
    INSERT INTO backfill_jobs VALUES
      (1,'TAIL','DONE','2026-10-22 12:45:00'),
      (2,'TAIL','DONE','2026-10-22 12:45:00'),
      (3,'TAIL','DONE','2026-10-22 12:00:00'),
      (3,'TAIL','FAILED','2026-10-22 12:59:00'),
      (3,'BACKFILL','DONE','2026-10-22 12:59:00');
  `);
  return db;
}

test('one stale stream is not hidden by fresh streams, failed runs, or backfills', () => {
  const db = fixture();
  try {
    const result = readFreshness(db, { now: Date.parse('2026-10-22T13:00:00Z') });
    assert.equal(result.FLR.status, 'healthy');
    assert.equal(result.XDC.status, 'stale');
    assert.match(result.XDC.detail, /1\/2/);
    db.exec("INSERT INTO backfill_jobs VALUES(3,'TAIL','DONE','2026-10-22 12:55:00')");
    assert.equal(readFreshness(db, { now: Date.parse('2026-10-22T13:00:00Z') }).XDC.status, 'healthy');
  } finally { db.close(); }
});

test('missing history and absent streams are stale; threshold includes exact boundary', () => {
  const db = fixture();
  try {
    db.exec('DELETE FROM backfill_jobs; DELETE FROM index_streams WHERE chain_id = \'XDC\'');
    const result = readFreshness(db);
    assert.equal(result.FLR.status, 'stale');
    assert.equal(result.XDC.status, 'stale');
  } finally { db.close(); }
  const db2 = fixture();
  try {
    assert.equal(readFreshness(db2, { now: Date.parse('2026-10-22T13:15:00Z') }).FLR.status, 'stale');
  } finally { db2.close(); }
});

test('only status transitions notify, including partial recovery and unknown status', () => {
  const current = (flr, xdc) => ({ FLR: { status: flr, detail: 'test' }, XDC: { status: xdc, detail: 'test' } });
  assert.equal(notification({}, current('healthy', 'healthy')), null);
  assert.match(notification({}, current('healthy', 'stale')), /XDC: STALE/);
  const persisted = JSON.parse(JSON.stringify({ FLR: 'healthy', XDC: 'stale' }));
  assert.equal(notification(persisted, current('healthy', 'stale')), null);
  assert.match(notification(persisted, current('healthy', 'healthy')), /all clear/);
  assert.match(notification({ FLR: 'stale', XDC: 'stale' }, current('healthy', 'stale')), /FLR: RECOVERED/);
  assert.match(notification(persisted, current('unknown', 'unknown')), /UNKNOWN/);
});
