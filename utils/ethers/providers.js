// utils/ethers/providers.js
const { ethers } = require("ethers");

/**
 * Returns an ethers provider for a given chain based on chainsConfig.
 * Expects chainsConfig[chainId] to have an `rpcEnvKey` (e.g. "FLR_MAINNET").
 *
 * No defaults. If config/env is missing, throws.
 */
function getProviderForChain(chainId, chainsConfig) {
  const cid = (chainId || "").toString().toUpperCase();
  const chainCfg = chainsConfig?.[cid];

  if (!chainCfg) {
    throw new Error(`No provider config for chain "${cid}"`);
  }

  const rpcKey = chainCfg.rpcEnvKey;
  if (!rpcKey) {
    throw new Error(`Missing rpcEnvKey for chain "${cid}" in CHAINS_CONFIG`);
  }

  const rpcUrl = process.env[rpcKey];
  if (!rpcUrl) {
    throw new Error(`Missing RPC URL for chain "${cid}": expected env var ${rpcKey}`);
  }

  return new ethers.JsonRpcProvider(rpcUrl);
}

module.exports = { getProviderForChain };
