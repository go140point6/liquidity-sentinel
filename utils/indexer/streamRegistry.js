const { ethers } = require("ethers");

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

function selectContracts(db, { chainId = null, kind = null, contractKey = null } = {}) {
  const where = ["c.is_enabled = 1", "c.kind IN ('LP_NFT','LOAN_NFT')"];
  const args = [];

  if (chainId) {
    where.push("c.chain_id = ?");
    args.push(String(chainId).toUpperCase());
  }
  if (kind) {
    where.push("c.kind = ?");
    args.push(String(kind).toUpperCase());
  }
  if (contractKey) {
    where.push("c.contract_key = ?");
    args.push(String(contractKey));
  }

  const sql = `
    SELECT
      c.id,
      c.chain_id,
      c.kind,
      c.contract_key,
      c.protocol,
      c.address_eip55,
      c.default_start_block
    FROM contracts c
    WHERE ${where.join(" AND ")}
    ORDER BY c.chain_id, c.kind, c.contract_key
  `;

  return db.prepare(sql).all(...args);
}

function syncTransferStreams(
  db,
  { chainId = null, kind = null, contractKey = null, startBlockOverride = null } = {}
) {
  const contracts = selectContracts(db, { chainId, kind, contractKey });

  const upsertStream = db.prepare(`
    INSERT INTO index_streams (
      chain_id, contract_id, stream_key, event_name, topic0, start_block, is_enabled
    )
    VALUES (?, ?, ?, 'Transfer', ?, ?, 1)
    ON CONFLICT(stream_key) DO UPDATE SET
      chain_id = excluded.chain_id,
      contract_id = excluded.contract_id,
      event_name = excluded.event_name,
      topic0 = excluded.topic0,
      start_block = MIN(index_streams.start_block, excluded.start_block),
      is_enabled = 1
  `);

  const ensureCursor = db.prepare(`
    INSERT INTO index_cursors (
      stream_id, last_scanned_block, last_scanned_log_index, last_scanned_tx_hash, last_scanned_at
    ) VALUES (?, ?, NULL, NULL, NULL)
    ON CONFLICT(stream_id) DO NOTHING
  `);

  const readStream = db.prepare(`
    SELECT
      s.id,
      s.chain_id,
      s.contract_id,
      s.stream_key,
      s.event_name,
      s.topic0,
      s.start_block,
      s.is_enabled,
      c.contract_key,
      c.kind,
      c.protocol,
      c.address_eip55,
      cur.last_scanned_block,
      cur.last_scanned_log_index,
      cur.last_scanned_tx_hash,
      cur.last_scanned_at
    FROM index_streams s
    JOIN contracts c ON c.id = s.contract_id
    LEFT JOIN index_cursors cur ON cur.stream_id = s.id
    WHERE s.stream_key = ?
    LIMIT 1
  `);

  const tx = db.transaction(() => {
    const out = [];
    for (const c of contracts) {
      const startBlock = Number.isInteger(startBlockOverride)
        ? Math.max(0, startBlockOverride)
        : Math.max(0, Number(c.default_start_block) || 0);
      const streamKey = `${c.chain_id}:${c.contract_key}:Transfer`;

      upsertStream.run(c.chain_id, c.id, streamKey, TRANSFER_TOPIC, startBlock);
      const stream = readStream.get(streamKey);
      if (!stream) continue;

      const seedCursor = Math.max(0, startBlock - 1);
      ensureCursor.run(stream.id, seedCursor);

      out.push(readStream.get(streamKey));
    }
    return out;
  });

  return tx();
}

function listStreams(db, { chainId = null, streamKey = null, isEnabled = null } = {}) {
  const where = ["1=1"];
  const args = [];

  if (chainId) {
    where.push("s.chain_id = ?");
    args.push(String(chainId).toUpperCase());
  }
  if (streamKey) {
    where.push("s.stream_key = ?");
    args.push(String(streamKey));
  }
  if (isEnabled != null) {
    where.push("s.is_enabled = ?");
    args.push(Number(isEnabled) ? 1 : 0);
  }

  const sql = `
    SELECT
      s.id,
      s.chain_id,
      s.contract_id,
      s.stream_key,
      s.event_name,
      s.topic0,
      s.start_block,
      s.is_enabled,
      c.contract_key,
      c.kind,
      c.protocol,
      c.address_eip55,
      cur.last_scanned_block,
      cur.last_scanned_log_index,
      cur.last_scanned_tx_hash,
      cur.last_scanned_at
    FROM index_streams s
    JOIN contracts c ON c.id = s.contract_id
    LEFT JOIN index_cursors cur ON cur.stream_id = s.id
    WHERE ${where.join(" AND ")}
    ORDER BY s.chain_id, c.kind, c.contract_key, s.event_name
  `;

  return db.prepare(sql).all(...args);
}

module.exports = {
  TRANSFER_TOPIC,
  syncTransferStreams,
  listStreams,
};
