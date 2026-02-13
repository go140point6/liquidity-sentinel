"use strict";

const fs = require("fs");
const path = require("path");

const ALM_CONFIG_PATH = path.join(__dirname, "..", "data", "alm_contracts.json");
let cached = null;

function mustObject(v, msg) {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(msg);
  }
  return v;
}

function loadAlmConfig() {
  if (cached) return cached;
  const raw = fs.readFileSync(ALM_CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const root = mustObject(parsed, "alm_contracts.json must be an object");
  const chains = mustObject(root.chains, "alm_contracts.json must have an object `chains`");
  cached = { chains };
  return cached;
}

function getAlmPeripheryAddress(chainId) {
  const cfg = loadAlmConfig();
  const key = String(chainId || "").toUpperCase();
  const chain = cfg.chains[key];
  if (!chain) return null;
  const periphery = chain.periphery;
  return typeof periphery === "string" && periphery.trim() ? periphery.trim() : null;
}

function getAlmDiscoveriesForChain(chainId) {
  const cfg = loadAlmConfig();
  const key = String(chainId || "").toUpperCase();
  const chain = cfg.chains[key];
  if (!chain) return [];
  const src = Array.isArray(chain.discoveries) ? chain.discoveries : [];
  return src
    .filter((d) => d && typeof d === "object")
    .map((d) => ({
      key: String(d.key || "").trim(),
      protocol: String(d.protocol || "").trim(),
      kind: String(d.kind || "LP_ALM").toUpperCase(),
      registry: String(d.registry || "").trim(),
      startBlock: Number(d.start_block),
      beaconName: String(d.beacon_name || "").trim(),
      contractKeyPrefix: String(d.contract_key_prefix || "").trim(),
      chainId: key,
    }))
    .filter(
      (d) =>
        d.key &&
        d.protocol &&
        d.kind === "LP_ALM" &&
        d.registry &&
        Number.isInteger(d.startBlock) &&
        d.startBlock >= 0 &&
        d.beaconName &&
        d.contractKeyPrefix
    );
}

module.exports = {
  ALM_CONFIG_PATH,
  loadAlmConfig,
  getAlmPeripheryAddress,
  getAlmDiscoveriesForChain,
};

