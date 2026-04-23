#!/usr/bin/env node
"use strict";

const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const { ethers } = require("ethers");

const XDC_RPC_URL =
  process.env.XDC_MAINNET_SCAN ||
  process.env.XDC_MAINNET ||
  process.env.RPC_URL ||
  "";

const DEFAULTS = {
  lendingPool: "0x8a619D8E3BfAb54F7C30Ef39Ce16c53429c739C3",
  dataProvider: "0x2E6bA568aaebadb4db3E018313ee34baD0328988",
  uiPoolDataProvider: "0x7b6218B77127367B6Df46c80F469D22845bd4B7d",
  collateralAsset: "0x951857744785E80e2De051c32EE7b25f9c458C42",
  debtAsset: "0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1",
  collateralPToken: "0x1fF5E0037B478547715a4CE337d9fcFF86A30401",
  debtVToken: "0xDBEd51F298901987651FaF1dAed8Bb575942d406",
};

const wallet = process.argv[2] || "";

const erc20Abi = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
];

const lendingPoolAbi = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralETH,uint256 totalDebtETH,uint256 availableBorrowsETH,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
];

const dataProviderAbi = [
  "function getUserReserveData(address asset,address user) view returns (uint256 currentATokenBalance,uint256 currentStableDebt,uint256 currentVariableDebt,uint256 principalStableDebt,uint256 scaledVariableDebt,uint256 stableBorrowRate,uint256 liquidityRate,uint40 stableRateLastUpdated,bool usageAsCollateralEnabled)",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,bool usageAsCollateralEnabled,bool borrowingEnabled,bool stableBorrowRateEnabled,bool isActive,bool isFrozen)",
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress)",
];

const uiPoolDataProviderAbi = [
  "function getUserReservesData(address provider,address user) view returns ((address underlyingAsset,uint256 scaledATokenBalance,bool usageAsCollateralEnabled,uint256 stableBorrowRate,uint256 scaledVariableDebt,uint256 principalStableDebt,uint256 stableBorrowLastUpdateTimestamp)[],uint8)",
];

function fmtUnits(raw, decimals, digits = 6) {
  try {
    const n = Number(ethers.formatUnits(raw, decimals));
    if (!Number.isFinite(n)) return "n/a";
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    }).format(n);
  } catch {
    return "n/a";
  }
}

function fmtPctBps(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "n/a";
  return `${(n / 100).toFixed(2)}%`;
}

function fmtRay(raw) {
  const n = Number(ethers.formatUnits(raw, 27));
  if (!Number.isFinite(n)) return "n/a";
  return n.toFixed(6);
}

function fmtWad(raw) {
  const n = Number(ethers.formatUnits(raw, 18));
  if (!Number.isFinite(n)) return "n/a";
  return n.toFixed(6);
}

async function loadTokenMeta(address, provider) {
  const token = new ethers.Contract(address, erc20Abi, provider);
  const [symbol, decimals] = await Promise.all([
    token.symbol().catch(() => "UNKNOWN"),
    token.decimals().catch(() => 18),
  ]);
  return { token, symbol, decimals: Number(decimals) };
}

async function main() {
  if (!XDC_RPC_URL) {
    throw new Error("Missing XDC RPC URL. Set XDC_MAINNET_SCAN or XDC_MAINNET.");
  }
  if (!wallet) {
    throw new Error("Usage: node dev/testPrimefiLoan.js <walletAddress>");
  }

  const user = ethers.getAddress(wallet);
  const provider = new ethers.JsonRpcProvider(XDC_RPC_URL);

  const lendingPool = new ethers.Contract(DEFAULTS.lendingPool, lendingPoolAbi, provider);
  const dataProvider = new ethers.Contract(DEFAULTS.dataProvider, dataProviderAbi, provider);
  const uiPoolDataProvider = new ethers.Contract(
    DEFAULTS.uiPoolDataProvider,
    uiPoolDataProviderAbi,
    provider
  );

  const [collMeta, debtMeta, pTokenMeta, vTokenMeta] = await Promise.all([
    loadTokenMeta(DEFAULTS.collateralAsset, provider),
    loadTokenMeta(DEFAULTS.debtAsset, provider),
    loadTokenMeta(DEFAULTS.collateralPToken, provider),
    loadTokenMeta(DEFAULTS.debtVToken, provider),
  ]);

  const [
    accountData,
    collateralCfg,
    debtCfg,
    collateralUserReserve,
    debtUserReserve,
    reserveTokenAddrs,
    pTokenBal,
    vTokenBal,
  ] = await Promise.all([
    lendingPool.getUserAccountData(user),
    dataProvider.getReserveConfigurationData(DEFAULTS.collateralAsset),
    dataProvider.getReserveConfigurationData(DEFAULTS.debtAsset),
    dataProvider.getUserReserveData(DEFAULTS.collateralAsset, user),
    dataProvider.getUserReserveData(DEFAULTS.debtAsset, user),
    dataProvider.getReserveTokensAddresses(DEFAULTS.collateralAsset),
    pTokenMeta.token.balanceOf(user),
    vTokenMeta.token.balanceOf(user),
  ]);

  let uiReserves = [];
  try {
    const uiResp = await uiPoolDataProvider.getUserReservesData(DEFAULTS.dataProvider, user);
    uiReserves = Array.isArray(uiResp?.[0]) ? uiResp[0] : [];
  } catch (_) {}

  const uiCollateral = uiReserves.find(
    (r) => String(r.underlyingAsset || "").toLowerCase() === DEFAULTS.collateralAsset.toLowerCase()
  );
  const uiDebt = uiReserves.find(
    (r) => String(r.underlyingAsset || "").toLowerCase() === DEFAULTS.debtAsset.toLowerCase()
  );

  console.log("PrimeFi XDC loan probe");
  console.log(`RPC:                 ${XDC_RPC_URL}`);
  console.log(`User:                ${user}`);
  console.log(`lendingPool:         ${DEFAULTS.lendingPool}`);
  console.log(`dataProvider:        ${DEFAULTS.dataProvider}`);
  console.log(`uiPoolDataProvider:  ${DEFAULTS.uiPoolDataProvider}`);

  console.log("\n[Assets]");
  console.log(`Collateral asset:    ${collMeta.symbol} (${DEFAULTS.collateralAsset})`);
  console.log(`Debt asset:          ${debtMeta.symbol} (${DEFAULTS.debtAsset})`);
  console.log(`pToken:              ${pTokenMeta.symbol} (${DEFAULTS.collateralPToken})`);
  console.log(`vdToken:             ${vTokenMeta.symbol} (${DEFAULTS.debtVToken})`);

  console.log("\n[Reserve mapping]");
  console.log(`aToken from provider:${reserveTokenAddrs.aTokenAddress}`);
  console.log(`stable debt token:   ${reserveTokenAddrs.stableDebtTokenAddress}`);
  console.log(`variable debt token: ${reserveTokenAddrs.variableDebtTokenAddress}`);

  console.log("\n[Wallet token balances]");
  console.log(
    `pToken wallet bal:   ${fmtUnits(pTokenBal, pTokenMeta.decimals)} ${pTokenMeta.symbol}`
  );
  console.log(
    `vdToken wallet bal:  ${fmtUnits(vTokenBal, vTokenMeta.decimals)} ${vTokenMeta.symbol}`
  );

  console.log("\n[User reserve data]");
  console.log(
    `Collateral aToken:   ${fmtUnits(collateralUserReserve.currentATokenBalance, collMeta.decimals)} ${collMeta.symbol}`
  );
  console.log(
    `Debt var borrow:     ${fmtUnits(debtUserReserve.currentVariableDebt, debtMeta.decimals)} ${debtMeta.symbol}`
  );
  console.log(
    `Debt stable borrow:  ${fmtUnits(debtUserReserve.currentStableDebt, debtMeta.decimals)} ${debtMeta.symbol}`
  );
  console.log(
    `Collateral enabled:  ${collateralUserReserve.usageAsCollateralEnabled ? "yes" : "no"}`
  );
  console.log(
    `Debt stable rate:    ${fmtRay(debtUserReserve.stableBorrowRate)}`
  );
  console.log(
    `Collateral liq rate: ${fmtRay(collateralUserReserve.liquidityRate)}`
  );

  console.log("\n[Reserve configuration]");
  console.log(
    `Collateral decimals: ${collateralCfg.decimals} | LTV: ${fmtPctBps(collateralCfg.ltv)} | Liq threshold: ${fmtPctBps(collateralCfg.liquidationThreshold)}`
  );
  console.log(
    `Debt decimals:       ${debtCfg.decimals} | Borrowing enabled: ${debtCfg.borrowingEnabled ? "yes" : "no"} | Active: ${debtCfg.isActive ? "yes" : "no"}`
  );

  console.log("\n[Account data]");
  console.log(`Total collateralETH: ${accountData.totalCollateralETH}`);
  console.log(`Total debtETH:       ${accountData.totalDebtETH}`);
  console.log(`Available borrowETH: ${accountData.availableBorrowsETH}`);
  console.log(`Current liq thresh:  ${fmtPctBps(accountData.currentLiquidationThreshold)}`);
  console.log(`Current LTV:         ${fmtPctBps(accountData.ltv)}`);
  console.log(`Health factor:       ${fmtWad(accountData.healthFactor)}`);

  if (uiCollateral || uiDebt) {
    console.log("\n[UI provider reserve data]");
    if (uiCollateral) {
      console.log(
        `UI collateral scaled aToken: ${fmtUnits(uiCollateral.scaledATokenBalance, collMeta.decimals)} ${collMeta.symbol}`
      );
    }
    if (uiDebt) {
      console.log(
        `UI debt scaled var:         ${fmtUnits(uiDebt.scaledVariableDebt, debtMeta.decimals)} ${debtMeta.symbol}`
      );
      console.log(
        `UI debt principal stable:   ${fmtUnits(uiDebt.principalStableDebt, debtMeta.decimals)} ${debtMeta.symbol}`
      );
    }
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exitCode = 1;
});
