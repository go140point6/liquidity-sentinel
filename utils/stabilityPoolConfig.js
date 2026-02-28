"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const STABILITY_POOL_CONFIG_PATH = path.join(__dirname, "..", "data", "stability_pools.json");
let cached = null;

function mustObject(v, msg) {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(msg);
  }
  return v;
}

function loadStabilityPoolConfig() {
  if (cached) return cached;
  const raw = fs.readFileSync(STABILITY_POOL_CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const root = mustObject(parsed, "stability_pools.json must be an object");
  const chains = mustObject(root.chains, "stability_pools.json must have an object `chains`");
  cached = { chains };
  return cached;
}

function getStabilityPoolsForChain(chainId) {
  const cfg = loadStabilityPoolConfig();
  const key = String(chainId || "").toUpperCase();
  const chain = cfg.chains[key];
  if (!chain) return [];
  const src = Array.isArray(chain.pools) ? chain.pools : [];
  return src
    .filter((p) => p && typeof p === "object")
    .map((p) => {
      let addr = String(p.address || "").trim();
      try {
        addr = ethers.getAddress(addr);
      } catch {
        addr = "";
      }
      return {
        chainId: key,
        key: String(p.key || "").trim(),
        label: String(p.label || p.key || "").trim(),
        address: addr,
      };
    })
    .filter((p) => p.key && p.label && p.address);
}

module.exports = {
  STABILITY_POOL_CONFIG_PATH,
  loadStabilityPoolConfig,
  getStabilityPoolsForChain,
};
