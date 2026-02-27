#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const Database = require('better-sqlite3');

function argHas(flag) {
  return process.argv.includes(flag);
}

const execute = argHas('--execute');
const dbPath = process.env.DB_PATH;
if (!dbPath) {
  console.error('Missing DB_PATH in env');
  process.exit(1);
}

const db = new Database(dbPath);
try {
  const count = db.prepare('SELECT COUNT(*) AS c FROM alm_position_baselines').get().c;
  console.log(`DB: ${dbPath}`);
  console.log(`Existing ALM baselines: ${count}`);

  if (!execute) {
    console.log('Dry run only. Use --execute to delete all ALM baselines.');
    process.exit(0);
  }

  const res = db.prepare('DELETE FROM alm_position_baselines').run();
  console.log(`Deleted ALM baselines: ${res.changes}`);
} finally {
  db.close();
}
