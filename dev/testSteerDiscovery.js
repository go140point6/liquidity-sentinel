#!/usr/bin/env node
"use strict";

const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

const { ethers } = require("ethers");

const DEFAULT_PERIPHERY = "0x7Daa68204232a78dBF1Dd853a4018330EE934A39";
const DEFAULT_VAULT = "0x9f627706a6EFD7BC65707FFE601c68e64a802504";
const DEFAULT_SCAN_BLOCKS = 300000;
const DEFAULT_PAUSE_MS = 250;

const RPC_URL =
  process.env.FLR_MAINNET_SCAN ||
  process.env.FLR_MAINNET ||
  process.env.FLR_RPC_URL ||
  process.env.RPC_URL ||
  "";
const PERIPHERY =
  process.argv[2] || process.env.STEER_PERIPHERY_FLR || process.env.STEER_PERIPHERY || DEFAULT_PERIPHERY;
const KNOWN_VAULT = process.argv[3] || process.env.STEER_VAULT || DEFAULT_VAULT;
const SCAN_BLOCKS = Number(process.argv[4] || process.env.STEER_DISCOVERY_SCAN_BLOCKS || DEFAULT_SCAN_BLOCKS);
const REGISTRY_HINT = process.env.STEER_VAULT_REGISTRY_FLR || process.env.STEER_VAULT_REGISTRY || "";
const PAUSE_MS = Number(process.env.STEER_DISCOVERY_PAUSE_MS || DEFAULT_PAUSE_MS);

const peripheryAbi = [
  "function algebraVaultDetailsByAddress(address vault) view returns ((string vaultType,address token0,address token1,string name,string symbol,uint256 decimals,string token0Name,string token1Name,string token0Symbol,string token1Symbol,uint256 token0Decimals,uint256 token1Decimals,uint256 totalLPTokensIssued,uint256 token0Balance,uint256 token1Balance,address vaultCreator) details)",
  "function vaultDetailsByAddress(address vault) view returns ((string vaultType,address token0,address token1,string name,string symbol,uint256 decimals,string token0Name,string token1Name,string token0Symbol,string token1Symbol,uint256 token0Decimals,uint256 token1Decimals,uint256 feeTier,uint256 totalLPTokensIssued,uint256 token0Balance,uint256 token1Balance,address vaultCreator) details)",
];

const registryAbi = [
  "event VaultCreated(address deployer,address vault,string beaconName,uint256 indexed tokenId,address vaultManager)",
  "event VaultStateChanged(address indexed vault,uint8 newState)",
  "function beaconTypes(address) view returns (string)",
  "function getVaultDetails(address) view returns ((uint8 state,uint256 tokenId,uint256 vaultID,string payloadIpfs,address vaultAddress,string beaconName))",
];

const VAULT_CREATED_TOPIC = ethers.id("VaultCreated(address,address,string,uint256,address)");
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

function parseAddressFromSlot(hex32) {
  if (!hex32 || typeof hex32 !== "string" || !hex32.startsWith("0x")) return null;
  const clean = hex32.slice(2).padStart(64, "0");
  const addrHex = clean.slice(24);
  const addr = `0x${addrHex}`;
  if (/^0x0{40}$/i.test(addr)) return null;
  try {
    return ethers.getAddress(addr);
  } catch {
    return null;
  }
}

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

async function withRetry(fn, { maxAttempts = 6, baseBackoffMs = 500 } = {}) {
  let attempt = 0;
  let backoff = baseBackoffMs;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      const retryable = isRateLimitError(err);
      if (!retryable || attempt >= maxAttempts) throw err;
      const retryAfter = parseRetryAfterMs(err);
      await sleep(retryAfter ?? backoff);
      backoff = Math.min(backoff * 2, 10000);
    }
  }
  throw new Error("exhausted retries");
}

async function getCodeSize(provider, addr) {
  if (!addr) return 0;
  const code = await withRetry(() => provider.getCode(addr));
  return Math.max(0, (code.length - 2) / 2);
}

async function hasCodeAtBlock(provider, addr, blockTag) {
  const code = await withRetry(() => provider.getCode(addr, blockTag));
  return Boolean(code && code !== "0x");
}

async function readProxyInfo(provider, addr) {
  const [implRaw, adminRaw, beaconRaw] = await Promise.all([
    withRetry(() => provider.getStorage(addr, IMPLEMENTATION_SLOT)),
    withRetry(() => provider.getStorage(addr, ADMIN_SLOT)),
    withRetry(() => provider.getStorage(addr, BEACON_SLOT)),
  ]);
  return {
    implementation: parseAddressFromSlot(implRaw),
    admin: parseAddressFromSlot(adminRaw),
    beacon: parseAddressFromSlot(beaconRaw),
  };
}

async function callMaybeAddress(provider, to, sig) {
  const selector = ethers.id(sig).slice(0, 10);
  try {
    const out = await withRetry(() => provider.call({ to, data: selector }));
    if (!out || out === "0x") return null;
    if (out.length < 66) return null;
    const last32 = `0x${out.slice(-64)}`;
    return parseAddressFromSlot(last32);
  } catch {
    return null;
  }
}

async function resolveRegistryCandidates(provider, periphery) {
  const sigs = [
    "vaultRegistry()",
    "strategyRegistry()",
    "gasVault()",
    "stakingRewards()",
    "registry()",
    "vaultRegistryAddress()",
    "getVaultRegistry()",
  ];
  const out = [];
  for (const sig of sigs) {
    const addr = await callMaybeAddress(provider, periphery, sig);
    if (!addr) continue;
    const codeSize = await getCodeSize(provider, addr);
    out.push({ sig, addr, codeSize });
  }
  return out;
}

async function probeKnownVault(provider, peripheryAddr, vaultAddr) {
  const periphery = new ethers.Contract(peripheryAddr, peripheryAbi, provider);
  let details;
  let source;
  try {
    details = await periphery.algebraVaultDetailsByAddress(vaultAddr);
    source = "algebraVaultDetailsByAddress";
  } catch {
    details = await periphery.vaultDetailsByAddress(vaultAddr);
    source = "vaultDetailsByAddress";
  }
  return { source, details };
}

async function scanVaultCreated(provider, registryAddr, scanBlocks) {
  const latest = await withRetry(() => provider.getBlockNumber());
  const fromBlock = Math.max(0, latest - Math.max(1, scanBlocks));
  const logs = await withRetry(() =>
    provider.getLogs({
      address: registryAddr,
      fromBlock,
      toBlock: latest,
      topics: [VAULT_CREATED_TOPIC],
    })
  );
  const iface = new ethers.Interface(registryAbi);
  const rows = [];
  for (const log of logs) {
    try {
      const p = iface.parseLog(log);
      rows.push({
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        vault: p.args.vault,
        beaconName: p.args.beaconName,
        tokenId: p.args.tokenId.toString(),
      });
    } catch {
      // ignore undecodable logs
    }
  }
  return { latest, fromBlock, count: rows.length, rows };
}

async function scanVaultCreatedFromPeriphery(provider, peripheryAddr, scanBlocks, chunkSize = 4000) {
  const latest = await withRetry(() => provider.getBlockNumber());
  const fromBlock = Math.max(0, latest - Math.max(1, scanBlocks));
  const iface = new ethers.Interface(registryAbi);
  const pAddr = ethers.getAddress(peripheryAddr);
  const byRegistry = new Map();
  let totalLogs = 0;

  for (let start = fromBlock; start <= latest; start += chunkSize) {
    const end = Math.min(latest, start + chunkSize - 1);
    let logs = [];
    try {
      logs = await withRetry(() =>
        provider.getLogs({
          fromBlock: start,
          toBlock: end,
          topics: [VAULT_CREATED_TOPIC],
        })
      );
    } catch {
      continue;
    }
    totalLogs += logs.length;

    for (const log of logs) {
      let parsed = null;
      try {
        parsed = iface.parseLog(log);
      } catch {
        continue;
      }
      let tx;
      try {
        tx = await withRetry(() => provider.getTransaction(log.transactionHash));
      } catch {
        continue;
      }
      if (!tx?.to) continue;
      let txTo;
      try {
        txTo = ethers.getAddress(tx.to);
      } catch {
        continue;
      }
      if (txTo !== pAddr) continue;

      const reg = ethers.getAddress(log.address);
      if (!byRegistry.has(reg)) byRegistry.set(reg, []);
      byRegistry.get(reg).push({
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        tokenId: parsed.args.tokenId.toString(),
        vault: parsed.args.vault,
        beaconName: parsed.args.beaconName,
      });
    }
    if (PAUSE_MS > 0) await sleep(PAUSE_MS);
  }

  return { latest, fromBlock, totalLogs, byRegistry };
}

async function scanVaultCreatedEmitters(provider, scanBlocks, chunkSize = 4000) {
  const latest = await withRetry(() => provider.getBlockNumber());
  const fromBlock = Math.max(0, latest - Math.max(1, scanBlocks));
  const emitters = new Map();
  let totalLogs = 0;

  for (let start = fromBlock; start <= latest; start += chunkSize) {
    const end = Math.min(latest, start + chunkSize - 1);
    let logs = [];
    try {
      logs = await withRetry(() =>
        provider.getLogs({
          fromBlock: start,
          toBlock: end,
          topics: [VAULT_CREATED_TOPIC],
        })
      );
    } catch {
      continue;
    }
    totalLogs += logs.length;
    for (const log of logs) {
      try {
        const addr = ethers.getAddress(log.address);
        emitters.set(addr, (emitters.get(addr) || 0) + 1);
      } catch {
        // ignore invalid emitter address
      }
    }
    if (PAUSE_MS > 0) await sleep(PAUSE_MS);
  }

  return { latest, fromBlock, totalLogs, emitters };
}

async function findCodeCreationBlock(provider, addr) {
  const latest = await withRetry(() => provider.getBlockNumber());
  const existsLatest = await hasCodeAtBlock(provider, addr, latest);
  if (!existsLatest) return null;

  let lo = 0;
  let hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const exists = await hasCodeAtBlock(provider, addr, mid);
    if (exists) hi = mid;
    else lo = mid + 1;
    if (PAUSE_MS > 0) await sleep(PAUSE_MS);
  }
  return lo;
}

async function findVaultCreatedNearBlock(provider, vaultAddr, centerBlock, radius = 2000, chunkSize = 400) {
  const iface = new ethers.Interface(registryAbi);
  const targetVault = ethers.getAddress(vaultAddr);
  const latest = await withRetry(() => provider.getBlockNumber());
  const fromBlock = Math.max(0, centerBlock - radius);
  const toBlock = Math.min(latest, centerBlock + radius);
  const matches = [];

  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(toBlock, start + chunkSize - 1);
    let logs = [];
    try {
      logs = await withRetry(() =>
        provider.getLogs({
          fromBlock: start,
          toBlock: end,
          topics: [VAULT_CREATED_TOPIC],
        })
      );
    } catch {
      continue;
    }

    for (const log of logs) {
      try {
        const p = iface.parseLog(log);
        const v = ethers.getAddress(p.args.vault);
        if (v !== targetVault) continue;
        matches.push({
          registry: ethers.getAddress(log.address),
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          tokenId: p.args.tokenId.toString(),
          beaconName: p.args.beaconName,
          vaultManager: p.args.vaultManager,
          deployer: p.args.deployer,
        });
      } catch {
        // ignore
      }
    }
    if (PAUSE_MS > 0) await sleep(PAUSE_MS);
  }

  return { fromBlock, toBlock, matches };
}

async function probeRegistryLike(provider, candidate, knownVault) {
  const out = {
    addr: candidate,
    codeSize: await getCodeSize(provider, candidate),
    beaconType: null,
    hasVaultDetails: false,
  };
  if (!out.codeSize) return out;
  const c = new ethers.Contract(candidate, registryAbi, provider);
  try {
    const bt = await c.beaconTypes(knownVault);
    if (typeof bt === "string") out.beaconType = bt;
  } catch {}
  try {
    const vd = await c.getVaultDetails(knownVault);
    if (vd && vd.vaultAddress) out.hasVaultDetails = true;
  } catch {}
  return out;
}

async function dumpAddressLikeSlots(provider, proxyAddr, knownVault, maxSlots = 30) {
  const rows = [];
  for (let i = 0; i < maxSlots; i += 1) {
    const raw = await withRetry(() => provider.getStorage(proxyAddr, i));
    const addr = parseAddressFromSlot(raw);
    if (!addr) continue;
    const p = await probeRegistryLike(provider, addr, knownVault);
    rows.push({ slot: i, ...p });
    if (PAUSE_MS > 0) await sleep(PAUSE_MS);
  }
  return rows;
}

async function main() {
  if (!RPC_URL) {
    throw new Error("Missing RPC URL. Set FLR_MAINNET_SCAN (or FLR_MAINNET).");
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const chain = await provider.getNetwork();

  console.log("Steer discovery probe");
  console.log(`RPC:        ${RPC_URL}`);
  console.log(`ChainId:    ${chain.chainId}`);
  console.log(`Periphery:  ${PERIPHERY}`);
  console.log(`Known vault:${KNOWN_VAULT}`);
  console.log(`Throttle:   ${PAUSE_MS}ms pause between heavy calls`);
  if (REGISTRY_HINT) console.log(`Registry hint: ${REGISTRY_HINT}`);

  const peripheryCode = await getCodeSize(provider, PERIPHERY);
  console.log(`Periphery code size: ${peripheryCode} bytes`);

  const proxy = await readProxyInfo(provider, PERIPHERY);
  console.log("\n[Proxy info]");
  console.log(`Implementation: ${proxy.implementation || "n/a"}`);
  console.log(`Admin:          ${proxy.admin || "n/a"}`);
  console.log(`Beacon:         ${proxy.beacon || "n/a"}`);
  if (proxy.implementation) {
    const implCode = await getCodeSize(provider, proxy.implementation);
    console.log(`Impl code size: ${implCode} bytes`);
  }

  console.log("\n[Known vault probe via periphery]");
  try {
    const { source, details } = await probeKnownVault(provider, PERIPHERY, KNOWN_VAULT);
    console.log(`Source:      ${source}`);
    console.log(`Vault type:  ${details.vaultType}`);
    console.log(`Name/Symbol: ${details.name} (${details.symbol})`);
    console.log(`Token0:      ${details.token0Symbol} (${details.token0})`);
    console.log(`Token1:      ${details.token1Symbol} (${details.token1})`);
  } catch (err) {
    console.log(`Failed: ${err?.shortMessage || err?.message || err}`);
  }

  console.log("\n[Periphery getter probes]");
  const candidates = await resolveRegistryCandidates(provider, PERIPHERY);
  if (!candidates.length) {
    console.log("No getter-based addresses resolved.");
  } else {
    for (const c of candidates) {
      console.log(`- ${c.sig} => ${c.addr} (code ${c.codeSize} bytes)`);
    }
  }

  const registries = new Map();
  if (REGISTRY_HINT) registries.set(ethers.getAddress(REGISTRY_HINT), "env hint");
  for (const c of candidates) {
    registries.set(c.addr, c.sig);
  }

  if (!registries.size) {
    console.log("\n[Known vault creation discovery]");
    try {
      const createdAt = await findCodeCreationBlock(provider, KNOWN_VAULT);
      if (createdAt == null) {
        console.log("Known vault has no code on chain (unexpected).");
      } else {
        console.log(`Vault code first appears at block: ${createdAt}`);
        const near = await findVaultCreatedNearBlock(provider, KNOWN_VAULT, createdAt, 4000, 400);
        console.log(
          `Scanning VaultCreated near creation: blocks ${near.fromBlock} -> ${near.toBlock} | matches=${near.matches.length}`
        );
        for (const m of near.matches) {
          console.log(
            `- registry=${m.registry} block=${m.blockNumber} tokenId=${m.tokenId} beacon=${m.beaconName} tx=${m.txHash}`
          );
        }
      }
    } catch (err) {
      console.log(`Creation discovery failed: ${err?.shortMessage || err?.message || err}`);
    }

    console.log("\n[Fallback discovery] Global VaultCreated scan filtered by tx.to == periphery");
    const fallback = await scanVaultCreatedFromPeriphery(provider, PERIPHERY, SCAN_BLOCKS);
    console.log(
      `Window: blocks ${fallback.fromBlock} -> ${fallback.latest} | total VaultCreated logs=${fallback.totalLogs}`
    );
    if (fallback.byRegistry.size) {
      for (const [reg, rows] of fallback.byRegistry.entries()) {
        console.log(`\nCandidate registry: ${reg} | matches=${rows.length}`);
        for (const r of rows.slice(-10)) {
          console.log(`- b${r.blockNumber} tokenId=${r.tokenId} vault=${r.vault} beacon=${r.beaconName}`);
        }
      }
      return;
    }
    console.log("No VaultCreated events tied to this periphery in scan window.");
    console.log("\n[Global emitter discovery] scanning VaultCreated emitters in same window...");
    const global = await scanVaultCreatedEmitters(provider, SCAN_BLOCKS);
    console.log(
      `Window: blocks ${global.fromBlock} -> ${global.latest} | total VaultCreated logs=${global.totalLogs} | emitters=${global.emitters.size}`
    );
    if (global.emitters.size) {
      const sorted = Array.from(global.emitters.entries()).sort((a, b) => b[1] - a[1]);
      for (const [emitter, count] of sorted.slice(0, 20)) {
        const p = await probeRegistryLike(provider, emitter, KNOWN_VAULT);
        console.log(
          `- emitter ${emitter} count=${count} code=${p.codeSize} ` +
            `beaconTypes=${p.beaconType == null ? "n/a" : JSON.stringify(p.beaconType)} ` +
            `getVaultDetails=${p.hasVaultDetails ? "yes" : "no"}`
        );
      }
    }
    console.log("\n[Storage-slot heuristic] scanning first 30 slots for address-like values...");
    const slotRows = await dumpAddressLikeSlots(provider, PERIPHERY, KNOWN_VAULT, 30);
    if (!slotRows.length) {
      console.log("No address-like values found in first 30 slots.");
      return;
    }
    for (const r of slotRows) {
      console.log(
        `- slot ${r.slot}: ${r.addr} (code ${r.codeSize}) ` +
          `beaconTypes=${r.beaconType == null ? "n/a" : JSON.stringify(r.beaconType)} ` +
          `getVaultDetails=${r.hasVaultDetails ? "yes" : "no"}`
      );
    }
    return;
  }

  for (const [registryAddr, source] of registries.entries()) {
    console.log(`\n[VaultCreated scan] ${registryAddr} (${source})`);
    try {
      const result = await scanVaultCreated(provider, registryAddr, SCAN_BLOCKS);
      console.log(
        `Window: blocks ${result.fromBlock} -> ${result.latest} | events=${result.count}`
      );
      for (const r of result.rows.slice(-10)) {
        console.log(
          `- b${r.blockNumber} tokenId=${r.tokenId} vault=${r.vault} beacon=${r.beaconName}`
        );
      }
    } catch (err) {
      console.log(`Scan failed: ${err?.shortMessage || err?.message || err}`);
    }
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exitCode = 1;
});
