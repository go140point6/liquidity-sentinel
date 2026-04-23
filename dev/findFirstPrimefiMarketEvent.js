const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { ethers } = require('ethers');
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
const DEFAULT_PROGRESS_EVERY = 25;

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

function parseArgs(argv) {
  const out = { marketKey: null, fromBlock: null, toBlock: null, progressEvery: DEFAULT_PROGRESS_EVERY };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--market-key=')) out.marketKey = arg.split('=')[1];
    else if (arg.startsWith('--from-block=')) out.fromBlock = Number(arg.split('=')[1]);
    else if (arg.startsWith('--to-block=')) out.toBlock = Number(arg.split('=')[1]);
    else if (arg.startsWith('--progress-every=')) out.progressEvery = Number(arg.split('=')[1]);
  }
  return out;
}
function getMarket(marketKey) {
  const markets = (((primefiConfig || {}).chains || {}).XDC || {}).markets || [];
  if (marketKey) return markets.find((m) => m.key === marketKey) || null;
  if (markets.length === 1) return markets[0];
  return null;
}
function lower(a) { return String(a || '').toLowerCase(); }
function amountNum(raw, decimals) {
  try {
    const n = Number(ethers.formatUnits(raw, decimals));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fmtNum(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 6 }) : 'n/a';
}

function parseEventForMarket(parsed, market, log) {
  const name = parsed.name;
  const args = parsed.args;
  const out = { event: name, txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.index };
  let include = false;

  if (name === 'Deposit') {
    include = lower(args.reserve) === lower(market.collateralAsset);
    out.user = args.user;
    out.onBehalfOf = args.onBehalfOf;
    out.reserve = args.reserve;
    out.amountNum = amountNum(args.amount, 18);
  } else if (name === 'Withdraw') {
    include = lower(args.reserve) === lower(market.collateralAsset);
    out.user = args.user;
    out.to = args.to;
    out.reserve = args.reserve;
    out.amountNum = amountNum(args.amount, 18);
  } else if (name === 'Borrow') {
    include = lower(args.reserve) === lower(market.debtAsset);
    out.user = args.user;
    out.onBehalfOf = args.onBehalfOf;
    out.reserve = args.reserve;
    out.amountNum = amountNum(args.amount, 6);
    out.borrowRateMode = Number(args.borrowRateMode);
  } else if (name === 'Repay') {
    include = lower(args.reserve) === lower(market.debtAsset);
    out.user = args.user;
    out.repayer = args.repayer;
    out.reserve = args.reserve;
    out.amountNum = amountNum(args.amount, 6);
  } else if (name === 'LiquidationCall') {
    include = lower(args.collateralAsset) === lower(market.collateralAsset) && lower(args.debtAsset) === lower(market.debtAsset);
    out.user = args.user;
    out.collateralAsset = args.collateralAsset;
    out.debtAsset = args.debtAsset;
    out.debtToCoverNum = amountNum(args.debtToCover, 6);
    out.liquidatedCollateralAmountNum = amountNum(args.liquidatedCollateralAmount, 18);
    out.liquidator = args.liquidator;
  }

  return include ? out : null;
}

async function main() {
  const args = parseArgs(process.argv);
  const market = getMarket(args.marketKey);
  if (!market) {
    throw new Error('Provide --market-key=<key> or ensure exactly one XDC PrimeFi market is configured');
  }

  const provider = new ethers.JsonRpcProvider(XDC_RPC_URL);
  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Number.isInteger(args.fromBlock) && args.fromBlock > 0 ? args.fromBlock : 1;
  const toBlock = Number.isInteger(args.toBlock) && args.toBlock > 0 ? args.toBlock : latestBlock;
  if (fromBlock > toBlock) throw new Error(`from-block ${fromBlock} is greater than to-block ${toBlock}`);

  const totalWindows = Math.ceil((toBlock - fromBlock + 1) / XDC_SCAN_BLOCKS);
  const progressEvery = Number.isInteger(args.progressEvery) && args.progressEvery > 0 ? args.progressEvery : DEFAULT_PROGRESS_EVERY;

  console.log('Find first PrimeFi market event');
  console.log(`RPC:        ${XDC_RPC_URL}`);
  console.log(`Market:     ${market.key} (${market.protocol})`);
  console.log(`LendingPool:${market.lendingPool}`);
  console.log(`Assets:     ${market.collateralSymbol}/${market.debtSymbol}`);
  console.log(`Window:     ${XDC_SCAN_BLOCKS}`);
  console.log(`Pause:      ${XDC_PAUSE_MS}ms`);
  console.log(`Range:      ${fromBlock} -> ${toBlock}`);
  console.log(`Windows:    ${totalWindows}`);
  console.log('');

  let current = fromBlock;
  let windowIdx = 0;
  while (current <= toBlock) {
    const end = Math.min(current + XDC_SCAN_BLOCKS - 1, toBlock);
    windowIdx += 1;
    if (windowIdx === 1 || windowIdx % progressEvery === 0 || end === toBlock) {
      console.log(`[${windowIdx}/${totalWindows}] blocks ${current} -> ${end}`);
    }
    const logs = await provider.getLogs({
      address: market.lendingPool,
      fromBlock: current,
      toBlock: end,
      topics: [[TOPICS.Deposit, TOPICS.Withdraw, TOPICS.Borrow, TOPICS.Repay, TOPICS.LiquidationCall]],
    });

    for (const lg of logs) {
      let parsed;
      try {
        parsed = iface.parseLog(lg);
      } catch {
        continue;
      }
      const match = parseEventForMarket(parsed, market, lg);
      if (!match) continue;

      console.log('');
      console.log('First matching PrimeFi market event:');
      console.log(`Block:      ${match.blockNumber}`);
      console.log(`Tx hash:    ${match.txHash}`);
      console.log(`Log index:  ${match.logIndex}`);
      console.log(`Event:      ${match.event}`);
      if (match.user) console.log(`User:       ${match.user}`);
      if (match.onBehalfOf) console.log(`On behalf:  ${match.onBehalfOf}`);
      if (match.reserve) console.log(`Reserve:    ${match.reserve}`);
      if (typeof match.amountNum === 'number') console.log(`Amount:     ${fmtNum(match.amountNum)}`);
      if (typeof match.debtToCoverNum === 'number') console.log(`Debt cover: ${fmtNum(match.debtToCoverNum)}`);
      if (typeof match.liquidatedCollateralAmountNum === 'number') console.log(`Coll seized:${fmtNum(match.liquidatedCollateralAmountNum)}`);
      return;
    }

    current = end + 1;
    if (XDC_PAUSE_MS > 0 && current <= toBlock) await sleep(XDC_PAUSE_MS);
  }

  console.log('');
  console.log('No matching market events found in range.');
}

main().catch((err) => {
  console.error('FATAL:', err?.stack || err?.message || err);
  process.exitCode = 1;
});
