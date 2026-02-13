#!/usr/bin/env node
"use strict";

const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

const { ethers } = require("ethers");
const registryAbi = require("../abi/steerVaultRegistry.json");

const DEFAULT_REGISTRY = "0x64F9A121Ccbb8956249Ed52C4f63d0f759da53Ce";
const DEFAULT_CHUNK = Number(process.env.FLR_MAINNET_SCAN_BLOCKS || 1000);
const DEFAULT_PAUSE_MS = 250;
const DEFAULT_BEACON = "MultiPositionSparkIntegral";
const DEFAULT_PROGRESS_EVERY = 25;

const RPC_URL =
  process.env.FLR_MAINNET_SCAN ||
  process.env.FLR_MAINNET ||
  process.env.FLR_RPC_URL ||
  process.env.RPC_URL ||
  "";

const REGISTRY = process.argv[2] || process.env.STEER_VAULT_REGISTRY_FLR || DEFAULT_REGISTRY;
const CHUNK = Number(process.argv[3] || process.env.STEER_DISCOVERY_SCAN_BLOCKS || DEFAULT_CHUNK);
const BEACON_FILTER = process.argv[4] || process.env.STEER_DISCOVERY_BEACON || DEFAULT_BEACON;
const PAUSE_MS = Number(process.env.STEER_DISCOVERY_PAUSE_MS || DEFAULT_PAUSE_MS);
const PROGRESS_EVERY = Number(process.env.STEER_DISCOVERY_PROGRESS_EVERY || DEFAULT_PROGRESS_EVERY);
const START_ARG = process.argv.find((a) => a.startsWith("--start="))?.split("=")[1];
const END_ARG = process.argv.find((a) => a.startsWith("--end="))?.split("=")[1];
const START_BLOCK_OPT = START_ARG ?? process.env.STEER_DISCOVERY_START_BLOCK ?? "";
const END_BLOCK_OPT = END_ARG ?? process.env.STEER_DISCOVERY_END_BLOCK ?? "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    msg.includes("too many requests") ||
    msg.includes("rate limit") ||
    msg.includes("retry in") ||
    msg.includes("-32090")
  );
}

function parseRetryAfterMs(err) {
  const msg = String(err?.message || "");
  const m = msg.match(/retry in\s+(\d+)\s*s/i);
  if (!m) return null;
  const sec = Number(m[1]);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}

async function withRetry(fn, { maxAttempts = 6, baseBackoffMs = 600 } = {}) {
  let attempt = 0;
  let backoff = baseBackoffMs;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= maxAttempts) throw err;
      const retryAfter = parseRetryAfterMs(err);
      await sleep(retryAfter ?? backoff);
      backoff = Math.min(backoff * 2, 10000);
    }
  }
  throw new Error("exhausted retries");
}

async function hasCodeAtBlock(provider, address, blockTag) {
  const code = await withRetry(() => provider.getCode(address, blockTag));
  return Boolean(code && code !== "0x");
}

async function findContractCreationBlock(provider, address) {
  const latest = await withRetry(() => provider.getBlockNumber());
  const existsAtLatest = await hasCodeAtBlock(provider, address, latest);
  if (!existsAtLatest) return null;

  let lo = 0;
  let hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const exists = await hasCodeAtBlock(provider, address, mid);
    if (exists) hi = mid;
    else lo = mid + 1;
    if (PAUSE_MS > 0) await sleep(PAUSE_MS);
  }
  return lo;
}

async function main() {
  if (!RPC_URL) {
    throw new Error("Missing RPC URL. Set FLR_MAINNET_SCAN (or FLR_MAINNET).");
  }
  if (!Number.isInteger(CHUNK) || CHUNK <= 0) {
    throw new Error(`Invalid chunk size: ${CHUNK}`);
  }
  if (START_BLOCK_OPT && (!Number.isInteger(Number(START_BLOCK_OPT)) || Number(START_BLOCK_OPT) < 0)) {
    throw new Error(`Invalid --start block: ${START_BLOCK_OPT}`);
  }
  if (END_BLOCK_OPT && END_BLOCK_OPT !== "latest" && (!Number.isInteger(Number(END_BLOCK_OPT)) || Number(END_BLOCK_OPT) < 0)) {
    throw new Error(`Invalid --end block: ${END_BLOCK_OPT}`);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const network = await withRetry(() => provider.getNetwork());
  const registry = ethers.getAddress(REGISTRY);
  const iface = new ethers.Interface(registryAbi);
  const topic = iface.getEvent("VaultCreated").topicHash;

  console.log("Find first Steer VaultCreated");
  console.log(`RPC:       ${RPC_URL}`);
  console.log(`ChainId:   ${network.chainId}`);
  console.log(`Registry:  ${registry}`);
  console.log(`Chunk:     ${CHUNK}`);
  console.log(`Beacon:    ${BEACON_FILTER || "(none)"}`);
  console.log(`Pause:     ${PAUSE_MS}ms`);
  console.log(`Progress:  every ${PROGRESS_EVERY} windows`);
  if (START_BLOCK_OPT) console.log(`Start arg:  ${START_BLOCK_OPT}`);
  if (END_BLOCK_OPT) console.log(`End arg:    ${END_BLOCK_OPT}`);

  const creationBlock = await findContractCreationBlock(provider, registry);
  if (creationBlock == null) {
    console.log("Registry has no code on this chain.");
    return;
  }
  const latest = await withRetry(() => provider.getBlockNumber());
  const configuredStart = START_BLOCK_OPT ? Number(START_BLOCK_OPT) : creationBlock;
  const configuredEnd =
    !END_BLOCK_OPT || END_BLOCK_OPT === "latest" ? latest : Number(END_BLOCK_OPT);
  const scanStart = Math.max(creationBlock, configuredStart);
  const scanEnd = Math.min(latest, configuredEnd);

  console.log(`Registry creation block: ${creationBlock}`);
  console.log(`Latest block:            ${latest}`);
  console.log(`Scan start block:        ${scanStart}`);
  console.log(`Scan end block:          ${scanEnd}`);

  if (scanStart > scanEnd) {
    console.log("No scan range (start > end).");
    return;
  }

  const totalWindows = Math.ceil((scanEnd - scanStart + 1) / CHUNK);
  let first = null;
  let firstParsed = null;
  let seenCount = 0;
  let v3Count = 0;
  let v4Count = 0;
  let windowIndex = 0;
  for (let from = scanStart; from <= scanEnd; from += CHUNK) {
    windowIndex += 1;
    const to = Math.min(scanEnd, from + CHUNK - 1);
    if (
      windowIndex === 1 ||
      windowIndex % PROGRESS_EVERY === 0 ||
      windowIndex === totalWindows
    ) {
      console.log(
        `[progress] window ${windowIndex}/${totalWindows} blocks ${from} -> ${to}`
      );
    }
    const logs = await withRetry(() =>
      provider.getLogs({
        address: registry,
        fromBlock: from,
        toBlock: to,
        topics: [topic],
      })
    );
    if (logs.length) {
      logs.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
        return (a.index ?? a.logIndex ?? 0) - (b.index ?? b.logIndex ?? 0);
      });
      for (const lg of logs) {
        let parsed;
        try {
          parsed = iface.parseLog({ topics: lg.topics, data: lg.data });
        } catch {
          continue;
        }
        const beaconName = String(parsed?.args?.beaconName || "");
        seenCount += 1;
        const isV4 = beaconName === BEACON_FILTER;
        if (isV4) v4Count += 1;
        else v3Count += 1;
        if (isV4) {
          console.log(
            `[vaultCreated #${seenCount}] V4 match block=${lg.blockNumber} tokenId=${parsed.args.tokenId.toString()} ` +
              `beacon=${beaconName} vault=${parsed.args.vault} tx=${lg.transactionHash}`
          );
        } else {
          console.log(`[vaultCreated #${seenCount}] non-v4 beacon=${beaconName} block=${lg.blockNumber}`);
        }
        if (isV4) {
          first = lg;
          firstParsed = parsed;
          break;
        }
      }
      if (first) break;
    }
    if (PAUSE_MS > 0) await sleep(PAUSE_MS);
  }

  if (!first) {
    console.log(
      `No ${BEACON_FILTER} VaultCreated found in range. seen=${seenCount} v3Like=${v3Count} v4=${v4Count}`
    );
    return;
  }

  const parsed = firstParsed;

  console.log("\nFirst VaultCreated event:");
  console.log(`Block:     ${first.blockNumber}`);
  console.log(`Tx hash:   ${first.transactionHash}`);
  console.log(`Log index: ${first.index ?? first.logIndex ?? "n/a"}`);
  if (parsed) {
    console.log(`Vault:     ${parsed.args.vault}`);
    console.log(`TokenId:   ${parsed.args.tokenId.toString()}`);
    console.log(`Beacon:    ${parsed.args.beaconName}`);
    console.log(`Deployer:  ${parsed.args.deployer}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exitCode = 1;
});
