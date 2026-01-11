// utils/addresses.js
const { ethers } = require("ethers");

// Only supporting FLR + XDC right now (both are EVM-addressed)
const SUPPORTED_CHAINS = new Set(["FLR", "XDC"]);

/**
 * Normalize an input address string into:
 *  - checksum: EIP-55 checksummed 0x...
 *  - lower: lowercase 0x...
 *
 * Accepts:
 *  - 0x...
 *  - xdc... (common user-facing format on XDC)
 *
 * Throws if invalid.
 */
function normalizeEvmAddress(chainId, input) {
  if (!chainId) {
    throw new Error("normalizeEvmAddress: missing chainId");
  }

  const chain = String(chainId).toUpperCase();
  if (!SUPPORTED_CHAINS.has(chain)) {
    throw new Error(`normalizeEvmAddress: unsupported chain "${chain}"`);
  }

  if (input == null) {
    throw new Error("normalizeEvmAddress: missing address");
  }

  let s = String(input).trim();

  // XDC user format: xdc + 40 hex
  // Convert to 0x for ethers validation
  if (/^xdc/i.test(s)) {
    s = "0x" + s.slice(3);
  }

  let checksum;
  try {
    // ethers v6: validates + returns EIP-55 checksummed address
    checksum = ethers.getAddress(s);
  } catch {
    throw new Error(`Invalid EVM address for ${chain}: ${input}`);
  }

  return {
    checksum,                    // "0xAbC..."
    lower: checksum.toLowerCase(), // "0xabc..."
  };
}

/**
 * Normalize an EVM contract address for storage.
 * (Validates first, then returns lowercase form.)
 */
function normalizeContractAddress(chainId, input) {
  return normalizeEvmAddress(chainId, input).lower;
}

module.exports = {
  normalizeEvmAddress,
  normalizeContractAddress,
  SUPPORTED_CHAINS,
};
