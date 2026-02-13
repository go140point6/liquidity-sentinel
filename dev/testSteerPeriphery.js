#!/usr/bin/env node
"use strict";

const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

const { ethers } = require("ethers");

const DEFAULT_USER = "0x15F53EFCD406EC4a57b1fda89136Fc3b1abFf33E";
const DEFAULT_VAULT = "0x9f627706a6EFD7BC65707FFE601c68e64a802504";

const PERIPHERY = process.argv[2] || process.env.STEER_PERIPHERY || "";
const VAULT = process.argv[3] || process.env.STEER_VAULT || DEFAULT_VAULT;
const USER = process.argv[4] || process.env.STEER_USER || DEFAULT_USER;
const RPC_URL =
  process.env.FLR_MAINNET_SCAN ||
  process.env.FLR_RPC_URL ||
  process.env.RPC_URL ||
  "";

const peripheryAbi = [
  "function algebraVaultDetailsByAddress(address vault) view returns ((string vaultType,address token0,address token1,string name,string symbol,uint256 decimals,string token0Name,string token1Name,string token0Symbol,string token1Symbol,uint256 token0Decimals,uint256 token1Decimals,uint256 totalLPTokensIssued,uint256 token0Balance,uint256 token1Balance,address vaultCreator) details)",
  "function vaultDetailsByAddress(address vault) view returns ((string vaultType,address token0,address token1,string name,string symbol,uint256 decimals,string token0Name,string token1Name,string token0Symbol,string token1Symbol,uint256 token0Decimals,uint256 token1Decimals,uint256 feeTier,uint256 totalLPTokensIssued,uint256 token0Balance,uint256 token1Balance,address vaultCreator) details)",
  "function vaultBalancesByAddressWithFees(address vault) returns ((uint256 amountToken0,uint256 amountToken1) balances)",
];

const erc20Abi = [
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

function fmtPct(n) {
  if (!Number.isFinite(n)) return "n/a";
  return `${n.toFixed(4)}%`;
}

function fmtUnits(raw, decimals) {
  try {
    return ethers.formatUnits(raw, Number(decimals));
  } catch {
    return null;
  }
}

function asNum(s) {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  if (!RPC_URL) {
    throw new Error("Missing RPC URL. Set FLR_MAINNET_SCAN or FLR_RPC_URL or RPC_URL.");
  }
  if (!PERIPHERY) {
    throw new Error("Missing SteerPeriphery address. Pass as arg1 or set STEER_PERIPHERY.");
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const periphery = new ethers.Contract(PERIPHERY, peripheryAbi, provider);
  const vaultToken = new ethers.Contract(VAULT, erc20Abi, provider);

  console.log("Steer Periphery probe");
  console.log(`RPC:        ${RPC_URL}`);
  console.log(`Periphery:  ${PERIPHERY}`);
  console.log(`Vault:      ${VAULT}`);
  console.log(`User:       ${USER}`);

  let details = null;
  let detailSource = null;

  try {
    details = await periphery.algebraVaultDetailsByAddress(VAULT);
    detailSource = "algebraVaultDetailsByAddress";
  } catch (e1) {
    try {
      details = await periphery.vaultDetailsByAddress(VAULT);
      detailSource = "vaultDetailsByAddress";
    } catch (e2) {
      throw new Error(
        `Both detail calls failed. algebra=${e1?.shortMessage || e1?.message || e1}; ` +
          `v3=${e2?.shortMessage || e2?.message || e2}`
      );
    }
  }

  const userShares = await vaultToken.balanceOf(USER);
  const totalSupply = await vaultToken.totalSupply();

  let withFees = null;
  try {
    withFees = await periphery.vaultBalancesByAddressWithFees.staticCall(VAULT);
  } catch (_) {}

  const sharePct =
    totalSupply > 0n ? (Number((userShares * 1000000n) / totalSupply) / 10000) : null;

  const token0NoFees = details.token0Balance;
  const token1NoFees = details.token1Balance;
  const token0WithFees = withFees?.amountToken0 ?? null;
  const token1WithFees = withFees?.amountToken1 ?? null;

  const estUser0NoFees =
    totalSupply > 0n ? (userShares * token0NoFees) / totalSupply : null;
  const estUser1NoFees =
    totalSupply > 0n ? (userShares * token1NoFees) / totalSupply : null;
  const estUser0WithFees =
    totalSupply > 0n && token0WithFees != null ? (userShares * token0WithFees) / totalSupply : null;
  const estUser1WithFees =
    totalSupply > 0n && token1WithFees != null ? (userShares * token1WithFees) / totalSupply : null;

  const shareDecimals = Number(details.decimals);
  const t0Decimals = Number(details.token0Decimals);
  const t1Decimals = Number(details.token1Decimals);

  console.log("\n[Vault details]");
  console.log(`Source:            ${detailSource}`);
  console.log(`Vault type:        ${details.vaultType}`);
  console.log(`Vault name/symbol: ${details.name} (${details.symbol})`);
  console.log(`Token0:            ${details.token0Symbol} (${details.token0})`);
  console.log(`Token1:            ${details.token1Symbol} (${details.token1})`);
  console.log(`Creator:           ${details.vaultCreator}`);

  console.log("\n[Shares]");
  console.log(`User shares raw:   ${userShares}`);
  console.log(`Total shares raw:  ${totalSupply}`);
  console.log(`User shares:       ${fmtUnits(userShares, shareDecimals) ?? "n/a"} ${details.symbol}`);
  console.log(`Total supply:      ${fmtUnits(totalSupply, shareDecimals) ?? "n/a"} ${details.symbol}`);
  console.log(`Share %:           ${fmtPct(sharePct)}`);

  console.log("\n[Underlying totals]");
  console.log(
    `No-fees totals:    ${fmtUnits(token0NoFees, t0Decimals) ?? "n/a"} ${details.token0Symbol} + ` +
      `${fmtUnits(token1NoFees, t1Decimals) ?? "n/a"} ${details.token1Symbol}`
  );
  if (token0WithFees != null && token1WithFees != null) {
    console.log(
      `With-fees totals:  ${fmtUnits(token0WithFees, t0Decimals) ?? "n/a"} ${details.token0Symbol} + ` +
        `${fmtUnits(token1WithFees, t1Decimals) ?? "n/a"} ${details.token1Symbol}`
    );
  } else {
    console.log("With-fees totals:  n/a (vaultBalancesByAddressWithFees not available)");
  }

  console.log("\n[Estimated user underlying]");
  console.log(
    `No-fees estimate:  ${fmtUnits(estUser0NoFees ?? 0n, t0Decimals) ?? "n/a"} ${details.token0Symbol} + ` +
      `${fmtUnits(estUser1NoFees ?? 0n, t1Decimals) ?? "n/a"} ${details.token1Symbol}`
  );
  if (estUser0WithFees != null && estUser1WithFees != null) {
    console.log(
      `With-fees estimate:${fmtUnits(estUser0WithFees, t0Decimals) ?? "n/a"} ${details.token0Symbol} + ` +
        `${fmtUnits(estUser1WithFees, t1Decimals) ?? "n/a"} ${details.token1Symbol}`
    );
  } else {
    console.log("With-fees estimate:n/a");
  }

  const shareAsNum = asNum(fmtUnits(userShares, shareDecimals));
  const supplyAsNum = asNum(fmtUnits(totalSupply, shareDecimals));
  if (shareAsNum != null && supplyAsNum != null && supplyAsNum > 0) {
    const recon = (shareAsNum / supplyAsNum) * 100;
    console.log(`\n[Sanity] share% from formatted units: ${fmtPct(recon)}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exitCode = 1;
});
