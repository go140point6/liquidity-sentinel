const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { ethers } = require('ethers');
const { getDb } = require('../db');

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var ${name}`);
  return String(v).trim();
}
function requireIntEnv(name) {
  const n = Number(requireEnv(name));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Env var ${name} must be a positive integer`);
  return n;
}
function parseArgs(argv) {
  const out = { chain: 'XDC', marketKey: null, limit: null, pauseMs: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--market-key=')) out.marketKey = arg.split('=')[1];
    else if (arg.startsWith('--limit=')) out.limit = Number(arg.split('=')[1]);
    else if (arg.startsWith('--pause-ms=')) out.pauseMs = Number(arg.split('=')[1]);
  }
  return out;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const XDC_RPC_URL = requireEnv('XDC_MAINNET_SCAN');
const DEFAULT_PAUSE_MS = requireIntEnv('XDC_MAINNET_SCAN_PAUSE_MS');

async function main() {
  const args = parseArgs(process.argv);
  const provider = new ethers.JsonRpcProvider(XDC_RPC_URL);
  const db = getDb();
  const pauseMs = Number.isInteger(args.pauseMs) && args.pauseMs >= 0 ? args.pauseMs : DEFAULT_PAUSE_MS;
  const limitClause = Number.isInteger(args.limit) && args.limit > 0 ? `LIMIT ${args.limit}` : '';
  const params = [];
  let where = 'WHERE chain_id = ? AND block_timestamp IS NULL';
  params.push(args.chain);
  if (args.marketKey) {
    where += ' AND market_key = ?';
    params.push(args.marketKey);
  }

  const rows = db.prepare(`
    SELECT id, chain_id, market_key, block_number
    FROM primefi_market_events
    ${where}
    ORDER BY block_number ASC, id ASC
    ${limitClause}
  `).all(...params);

  console.log('Repair PrimeFi event timestamps');
  console.log(`RPC:        ${XDC_RPC_URL}`);
  console.log(`Chain:      ${args.chain}`);
  console.log(`Market:     ${args.marketKey || 'ALL'}`);
  console.log(`Rows:       ${rows.length}`);
  console.log(`Pause:      ${pauseMs}ms`);
  console.log('');

  if (!rows.length) {
    console.log('No rows need repair.');
    return;
  }

  const update = db.prepare('UPDATE primefi_market_events SET block_timestamp = ? WHERE id = ?');
  const cache = new Map();
  let done = 0;
  for (const row of rows) {
    let ts = cache.get(row.block_number);
    if (typeof ts !== 'number') {
      const block = await provider.getBlock(row.block_number);
      ts = block && Number.isInteger(Number(block.timestamp)) ? Number(block.timestamp) : null;
      cache.set(row.block_number, ts);
    }
    update.run(ts, row.id);
    done += 1;
    if (done === 1 || done % 25 === 0 || done === rows.length) {
      console.log(`[${done}/${rows.length}] id=${row.id} block=${row.block_number} timestamp=${ts ?? 'null'}`);
    }
    if (pauseMs > 0 && done < rows.length) await sleep(pauseMs);
  }

  console.log('');
  console.log('Repair complete.');
}

main().catch((err) => {
  console.error('FATAL:', err?.stack || err?.message || err);
  process.exitCode = 1;
});
