const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const Database = require("better-sqlite3");
const { ethers } = require("ethers");
const { initSchema } = require("../db");
const { TRANSFER_TOPIC } = require("../utils/indexer/streamRegistry");

const BURN_ADDRS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var ${name}`);
  return String(v).trim();
}

function strArg(name) {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  return raw == null ? null : String(raw);
}

function intArg(name) {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}

function decodeTransfer(topicsJson) {
  let topics;
  try {
    topics = JSON.parse(topicsJson || "[]");
  } catch {
    return null;
  }
  if (!Array.isArray(topics) || topics.length < 4) return null;
  try {
    const from = ethers.getAddress(`0x${topics[1].slice(26)}`);
    const to = ethers.getAddress(`0x${topics[2].slice(26)}`);
    const tokenId = BigInt(topics[3]).toString();
    return {
      fromLower: from.toLowerCase(),
      fromEip55: from,
      toLower: to.toLowerCase(),
      toEip55: to,
      tokenId,
      isBurned: BURN_ADDRS.has(to.toLowerCase()) ? 1 : 0,
    };
  } catch {
    return null;
  }
}

function makeInClause(values) {
  return values.map(() => "?").join(",");
}

function tokenKey(contractId, tokenId) {
  return `${contractId}:${tokenId}`;
}

function transferKey(contractId, txHash, logIndex) {
  return `${contractId}:${String(txHash).toLowerCase()}:${logIndex}`;
}

function sample(arr, n) {
  return arr.slice(0, Math.max(0, n));
}

function main() {
  const DB_PATH = requireEnv("DB_PATH");

  const chain = strArg("chain")?.toUpperCase() || null;
  const kind = strArg("kind")?.toUpperCase() || null;
  const contractKey = strArg("contract-key") || null;
  const contractId = intArg("contract-id");
  const maxPrint = intArg("max-print") ?? 15;

  const db = new Database(DB_PATH);
  initSchema(db);

  try {
    const where = ["c.kind IN ('LP_NFT','LOAN_NFT')"];
    const args = [];

    if (chain) {
      where.push("c.chain_id = ?");
      args.push(chain);
    }
    if (kind) {
      where.push("c.kind = ?");
      args.push(kind);
    }
    if (contractKey) {
      where.push("c.contract_key = ?");
      args.push(contractKey);
    }
    if (contractId != null) {
      where.push("c.id = ?");
      args.push(contractId);
    }

    const contracts = db
      .prepare(
        `
        SELECT c.id, c.chain_id, c.kind, c.contract_key, c.protocol
        FROM contracts c
        WHERE ${where.join(" AND ")}
        ORDER BY c.chain_id, c.contract_key
      `
      )
      .all(...args);

    if (!contracts.length) {
      console.log("[shadow:nft] no contracts selected");
      return;
    }

    const contractIds = contracts.map((c) => c.id);
    const contractSet = new Set(contractIds);

    console.log(
      `[shadow:nft] start contracts=${contracts.length} chain=${chain || "ALL"} kind=${kind || "ALL"} contractKey=${contractKey || "ALL"}`
    );

    const inIds = makeInClause(contractIds);

    const eventRows = db
      .prepare(
        `
        SELECT
          e.contract_id,
          e.block_number,
          e.tx_hash,
          e.log_index,
          e.topics_json
        FROM chain_events e
        JOIN index_streams s ON s.id = e.stream_id
        WHERE e.removed = 0
          AND e.topic0 = ?
          AND s.event_name = 'Transfer'
          AND e.contract_id IN (${inIds})
        ORDER BY e.contract_id, e.block_number, e.log_index, e.id
      `
      )
      .all(TRANSFER_TOPIC, ...contractIds);

    const expectedTokens = new Map();
    const expectedTransfers = new Set();
    const expectedTransfersByContract = new Map();

    for (const c of contracts) {
      expectedTransfersByContract.set(c.id, 0);
    }

    for (const row of eventRows) {
      const d = decodeTransfer(row.topics_json);
      if (!d) continue;

      const tKey = transferKey(row.contract_id, row.tx_hash, row.log_index);
      expectedTransfers.add(tKey);
      expectedTransfersByContract.set(
        row.contract_id,
        (expectedTransfersByContract.get(row.contract_id) || 0) + 1
      );

      const key = tokenKey(row.contract_id, d.tokenId);
      const cur = expectedTokens.get(key);
      const next = {
        contractId: row.contract_id,
        tokenId: d.tokenId,
        ownerLower: d.toLower,
        ownerEip55: d.toEip55,
        isBurned: d.isBurned,
        lastBlock: row.block_number,
        lastTxHash: row.tx_hash,
        lastLogIndex: row.log_index,
        firstSeenBlock: cur?.firstSeenBlock ?? row.block_number,
      };
      expectedTokens.set(key, next);
    }

    const actualTransfersRows = db
      .prepare(
        `
        SELECT contract_id, tx_hash, log_index
        FROM nft_transfers
        WHERE contract_id IN (${inIds})
      `
      )
      .all(...contractIds);
    const actualTransfers = new Set(
      actualTransfersRows.map((r) => transferKey(r.contract_id, r.tx_hash, r.log_index))
    );

    const actualTokensRows = db
      .prepare(
        `
        SELECT
          contract_id,
          token_id,
          owner_lower,
          owner_eip55,
          is_burned,
          last_block,
          last_tx_hash,
          last_log_index,
          first_seen_block
        FROM nft_tokens
        WHERE contract_id IN (${inIds})
      `
      )
      .all(...contractIds);

    const actualTokens = new Map();
    for (const r of actualTokensRows) {
      actualTokens.set(tokenKey(r.contract_id, r.token_id), {
        contractId: r.contract_id,
        tokenId: r.token_id,
        ownerLower: r.owner_lower,
        ownerEip55: r.owner_eip55,
        isBurned: Number(r.is_burned) ? 1 : 0,
        lastBlock: r.last_block,
        lastTxHash: r.last_tx_hash,
        lastLogIndex: r.last_log_index,
        firstSeenBlock: r.first_seen_block,
      });
    }

    const missingTransfers = [];
    const extraTransfers = [];

    for (const k of expectedTransfers) {
      if (!actualTransfers.has(k)) missingTransfers.push(k);
    }
    for (const k of actualTransfers) {
      if (!expectedTransfers.has(k)) extraTransfers.push(k);
    }

    const missingTokens = [];
    const extraTokens = [];
    const mismatchedTokens = [];

    for (const [k, exp] of expectedTokens.entries()) {
      const act = actualTokens.get(k);
      if (!act) {
        missingTokens.push(k);
        continue;
      }

      const diffs = [];
      if (String(exp.ownerLower) !== String(act.ownerLower)) diffs.push("owner_lower");
      if (Number(exp.isBurned) !== Number(act.isBurned)) diffs.push("is_burned");
      if (Number(exp.lastBlock) !== Number(act.lastBlock)) diffs.push("last_block");
      if (String(exp.lastTxHash || "").toLowerCase() !== String(act.lastTxHash || "").toLowerCase()) {
        diffs.push("last_tx_hash");
      }
      if (Number(exp.lastLogIndex) !== Number(act.lastLogIndex)) diffs.push("last_log_index");
      if (Number(exp.firstSeenBlock) !== Number(act.firstSeenBlock)) diffs.push("first_seen_block");

      if (diffs.length) {
        mismatchedTokens.push({ key: k, diffs, expected: exp, actual: act });
      }
    }

    for (const k of actualTokens.keys()) {
      if (!expectedTokens.has(k)) extraTokens.push(k);
    }

    const byContract = new Map();
    for (const c of contracts) {
      byContract.set(c.id, {
        contract: c,
        expectedTransfers: expectedTransfersByContract.get(c.id) || 0,
        expectedTokens: 0,
        actualTokens: 0,
        missingTokens: 0,
        extraTokens: 0,
        mismatchedTokens: 0,
      });
    }

    for (const v of expectedTokens.values()) {
      if (!contractSet.has(v.contractId)) continue;
      byContract.get(v.contractId).expectedTokens += 1;
    }
    for (const v of actualTokens.values()) {
      if (!contractSet.has(v.contractId)) continue;
      byContract.get(v.contractId).actualTokens += 1;
    }
    for (const key of missingTokens) {
      const cid = Number(String(key).split(":")[0]);
      if (byContract.has(cid)) byContract.get(cid).missingTokens += 1;
    }
    for (const key of extraTokens) {
      const cid = Number(String(key).split(":")[0]);
      if (byContract.has(cid)) byContract.get(cid).extraTokens += 1;
    }
    for (const item of mismatchedTokens) {
      const cid = Number(String(item.key).split(":")[0]);
      if (byContract.has(cid)) byContract.get(cid).mismatchedTokens += 1;
    }

    for (const v of byContract.values()) {
      const c = v.contract;
      console.log(
        `[shadow:nft] contract=${c.contract_key} chain=${c.chain_id} expected_transfers=${v.expectedTransfers} expected_tokens=${v.expectedTokens} actual_tokens=${v.actualTokens} missing_tokens=${v.missingTokens} extra_tokens=${v.extraTokens} mismatched_tokens=${v.mismatchedTokens}`
      );
    }

    const ok =
      missingTransfers.length === 0 &&
      extraTransfers.length === 0 &&
      missingTokens.length === 0 &&
      extraTokens.length === 0 &&
      mismatchedTokens.length === 0;

    console.log(
      `[shadow:nft] transfer_diff missing=${missingTransfers.length} extra=${extraTransfers.length}`
    );
    console.log(
      `[shadow:nft] token_diff missing=${missingTokens.length} extra=${extraTokens.length} mismatched=${mismatchedTokens.length}`
    );

    if (!ok) {
      for (const k of sample(missingTransfers, maxPrint)) {
        console.log(`[shadow:nft] missing_transfer ${k}`);
      }
      for (const k of sample(extraTransfers, maxPrint)) {
        console.log(`[shadow:nft] extra_transfer ${k}`);
      }
      for (const k of sample(missingTokens, maxPrint)) {
        console.log(`[shadow:nft] missing_token ${k}`);
      }
      for (const k of sample(extraTokens, maxPrint)) {
        console.log(`[shadow:nft] extra_token ${k}`);
      }
      for (const m of sample(mismatchedTokens, maxPrint)) {
        console.log(
          `[shadow:nft] mismatched_token ${m.key} diffs=${m.diffs.join(",")} expected=${JSON.stringify(
            m.expected
          )} actual=${JSON.stringify(m.actual)}`
        );
      }
      process.exitCode = 1;
    } else {
      console.log("[shadow:nft] OK");
    }
  } finally {
    db.close();
  }
}

main();
