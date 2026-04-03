const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { ethers } = require('ethers');
const { getDb } = require('../db');
const baseLogger = require('../utils/logger');
const logger = baseLogger.forEnv('SCAN_DEBUG');
const primefiConfig = require('../data/primefi_loans.json');

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
function requireNonNegIntEnv(name) {
  const n = Number(requireEnv(name));
  if (!Number.isInteger(n) || n < 0) throw new Error(`Env var ${name} must be a non-negative integer`);
  return n;
}

const XDC_RPC_URL = requireEnv('XDC_MAINNET_SCAN');
const XDC_SCAN_BLOCKS = requireIntEnv('XDC_MAINNET_SCAN_BLOCKS');
const XDC_PAUSE_MS = requireNonNegIntEnv('XDC_MAINNET_SCAN_PAUSE_MS');

const iface = new ethers.Interface([
  'event Deposit(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referral)',
  'event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)',
  'event Borrow(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint256 borrowRateMode,uint256 borrowRate,uint16 indexed referral)',
  'event Repay(address indexed reserve,address indexed user,address indexed repayer,uint256 amount)',
  'event LiquidationCall(address indexed collateralAsset,address indexed debtAsset,address indexed user,uint256 debtToCover,uint256 liquidatedCollateralAmount,address liquidator,bool receiveAToken)',
]);
const TOPICS = {
  Deposit: iface.getEvent('Deposit').topicHash,
  Withdraw: iface.getEvent('Withdraw').topicHash,
  Borrow: iface.getEvent('Borrow').topicHash,
  Repay: iface.getEvent('Repay').topicHash,
  LiquidationCall: iface.getEvent('LiquidationCall').topicHash,
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function parseArgs(argv) {
  const out = { chain: 'XDC', marketKey: null, fromBlock: null, toBlock: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--market-key=')) out.marketKey = arg.split('=')[1];
    else if (arg.startsWith('--from-block=')) out.fromBlock = Number(arg.split('=')[1]);
    else if (arg.startsWith('--to-block=')) out.toBlock = Number(arg.split('=')[1]);
  }
  return out;
}
function getMarkets(chainId, marketKey = null) {
  const markets = (((primefiConfig || {}).chains || {})[chainId] || {}).markets || [];
  return markets.filter((m) => !marketKey || m.key === marketKey);
}
function lower(a) { return String(a || '').toLowerCase(); }
function amountNum(raw, decimals) {
  try {
    const n = Number(ethers.formatUnits(raw, decimals));
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

async function main() {
  const args = parseArgs(process.argv);
  const provider = new ethers.JsonRpcProvider(XDC_RPC_URL);
  const latestBlock = args.toBlock || await provider.getBlockNumber();
  const db = getDb();
  const markets = getMarkets('XDC', args.marketKey);
  if (!markets.length) throw new Error('No PrimeFi markets configured for scan');

  const upsertCursor = db.prepare(`
    INSERT INTO primefi_market_event_cursors (chain_id, market_key, start_block, last_scanned_block, last_scanned_at)
    VALUES (@chain_id, @market_key, @start_block, @last_scanned_block, datetime('now'))
    ON CONFLICT(chain_id, market_key) DO UPDATE SET
      start_block = excluded.start_block,
      last_scanned_block = excluded.last_scanned_block,
      last_scanned_at = datetime('now')
  `);
  const getCursor = db.prepare(`SELECT * FROM primefi_market_event_cursors WHERE chain_id = ? AND market_key = ?`);
  const insertEvent = db.prepare(`
    INSERT INTO primefi_market_events (
      chain_id, market_key, protocol, block_number, tx_hash, log_index, event_name, user_lower, event_json
    ) VALUES (
      @chain_id, @market_key, @protocol, @block_number, @tx_hash, @log_index, @event_name, @user_lower, @event_json
    )
    ON CONFLICT(market_key, tx_hash, log_index) DO NOTHING
  `);

  for (const market of markets) {
    const cursor = getCursor.get('XDC', market.key);
    const configuredStart = Number(market.start_block || 0);
    let startBlock = Number.isInteger(args.fromBlock) ? args.fromBlock : (cursor ? Number(cursor.last_scanned_block || 0) + 1 : configuredStart);
    if (!Number.isInteger(startBlock) || startBlock <= 0) {
      throw new Error(`PrimeFi market ${market.key} requires --from-block or a positive start_block in data/primefi_loans.json`);
    }
    const toBlock = latestBlock;
    if (startBlock > toBlock) {
      logger.info(`[scanPrimefiMarketEvents] ${market.key} already current at ${cursor?.last_scanned_block || 0}`);
      continue;
    }

    const totalWindows = Math.ceil((toBlock - startBlock + 1) / XDC_SCAN_BLOCKS);
    logger.info(`[scanPrimefiMarketEvents] ${market.key} scanning ${startBlock}-${toBlock} windows=${totalWindows}`);
    let from = startBlock;
    let idx = 0;
    while (from <= toBlock) {
      const end = Math.min(from + XDC_SCAN_BLOCKS - 1, toBlock);
      idx += 1;
      logger.debug(`[scanPrimefiMarketEvents] ${market.key} window ${idx}/${totalWindows}: ${from}-${end}`);
      const logs = await provider.getLogs({
        address: market.lendingPool,
        fromBlock: from,
        toBlock: end,
        topics: [[TOPICS.Deposit, TOPICS.Withdraw, TOPICS.Borrow, TOPICS.Repay, TOPICS.LiquidationCall]],
      });
      for (const lg of logs) {
        let parsed;
        try { parsed = iface.parseLog(lg); } catch { continue; }
        const name = parsed.name;
        const args = parsed.args;
        let include = false;
        let userLower = null;
        const eventObj = { event: name, txHash: lg.transactionHash, blockNumber: lg.blockNumber, logIndex: lg.index };
        if (name === 'Deposit') {
          include = lower(args.reserve) === lower(market.collateralAsset);
          userLower = lower(args.onBehalfOf || args.user);
          eventObj.reserve = args.reserve;
          eventObj.user = args.user;
          eventObj.onBehalfOf = args.onBehalfOf;
          eventObj.amountRaw = String(args.amount);
          eventObj.amountNum = amountNum(args.amount, 18);
        } else if (name === 'Withdraw') {
          include = lower(args.reserve) === lower(market.collateralAsset);
          userLower = lower(args.user);
          eventObj.reserve = args.reserve;
          eventObj.user = args.user;
          eventObj.to = args.to;
          eventObj.amountRaw = String(args.amount);
          eventObj.amountNum = amountNum(args.amount, 18);
        } else if (name === 'Borrow') {
          include = lower(args.reserve) === lower(market.debtAsset);
          userLower = lower(args.onBehalfOf || args.user);
          eventObj.reserve = args.reserve;
          eventObj.user = args.user;
          eventObj.onBehalfOf = args.onBehalfOf;
          eventObj.amountRaw = String(args.amount);
          eventObj.amountNum = amountNum(args.amount, 6);
          eventObj.borrowRateMode = Number(args.borrowRateMode);
        } else if (name === 'Repay') {
          include = lower(args.reserve) === lower(market.debtAsset);
          userLower = lower(args.user);
          eventObj.reserve = args.reserve;
          eventObj.user = args.user;
          eventObj.repayer = args.repayer;
          eventObj.amountRaw = String(args.amount);
          eventObj.amountNum = amountNum(args.amount, 6);
        } else if (name === 'LiquidationCall') {
          include = lower(args.collateralAsset) === lower(market.collateralAsset) && lower(args.debtAsset) === lower(market.debtAsset);
          userLower = lower(args.user);
          eventObj.collateralAsset = args.collateralAsset;
          eventObj.debtAsset = args.debtAsset;
          eventObj.user = args.user;
          eventObj.debtToCoverRaw = String(args.debtToCover);
          eventObj.debtToCoverNum = amountNum(args.debtToCover, 6);
          eventObj.liquidatedCollateralAmountRaw = String(args.liquidatedCollateralAmount);
          eventObj.liquidatedCollateralAmountNum = amountNum(args.liquidatedCollateralAmount, 18);
          eventObj.liquidator = args.liquidator;
          eventObj.receiveAToken = Boolean(args.receiveAToken);
        }
        if (!include) continue;
        insertEvent.run({
          chain_id: 'XDC',
          market_key: market.key,
          protocol: market.protocol,
          block_number: lg.blockNumber,
          tx_hash: lg.transactionHash,
          log_index: lg.index,
          event_name: name,
          user_lower: userLower || null,
          event_json: JSON.stringify(eventObj),
        });
      }
      upsertCursor.run({ chain_id: 'XDC', market_key: market.key, start_block: configuredStart, last_scanned_block: end });
      from = end + 1;
      if (XDC_PAUSE_MS > 0 && from <= toBlock) await sleep(XDC_PAUSE_MS);
    }
    logger.info(`[scanPrimefiMarketEvents] ${market.key} done to ${toBlock}`);
  }
}

main().catch((err) => {
  logger.error('[scanPrimefiMarketEvents] FATAL:', err?.stack || err?.message || err);
  process.exitCode = 1;
});
