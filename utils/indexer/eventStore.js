function prepareEventStore(db) {
  const insJob = db.prepare(`
    INSERT INTO backfill_jobs (
      stream_id, mode, from_block, to_block, status, started_at
    ) VALUES (?, ?, ?, ?, 'RUNNING', datetime('now'))
  `);

  const updJobDone = db.prepare(`
    UPDATE backfill_jobs
    SET status = 'DONE', finished_at = datetime('now'), error_text = NULL
    WHERE id = ?
  `);

  const updJobFail = db.prepare(`
    UPDATE backfill_jobs
    SET status = 'FAILED', finished_at = datetime('now'), error_text = ?
    WHERE id = ?
  `);

  const updCursor = db.prepare(`
    UPDATE index_cursors
    SET
      last_scanned_block = ?,
      last_scanned_log_index = ?,
      last_scanned_tx_hash = ?,
      last_scanned_at = datetime('now')
    WHERE stream_id = ?
  `);

  const insWindow = db.prepare(`
    INSERT INTO backfill_windows (
      job_id, from_block, to_block, attempt_no, logs_found, status, error_text, elapsed_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insEvent = db.prepare(`
    INSERT INTO chain_events (
      chain_id, contract_id, stream_id, block_number, block_hash, tx_hash, tx_index,
      log_index, topic0, topics_json, data_hex, event_name, decoded_json, removed, ingested_at
    ) VALUES (
      @chain_id, @contract_id, @stream_id, @block_number, @block_hash, @tx_hash, @tx_index,
      @log_index, @topic0, @topics_json, @data_hex, @event_name, @decoded_json, @removed, datetime('now')
    )
    ON CONFLICT(chain_id, tx_hash, log_index) DO UPDATE SET
      contract_id = excluded.contract_id,
      stream_id = excluded.stream_id,
      block_number = excluded.block_number,
      block_hash = excluded.block_hash,
      tx_index = excluded.tx_index,
      topic0 = excluded.topic0,
      topics_json = excluded.topics_json,
      data_hex = excluded.data_hex,
      event_name = excluded.event_name,
      decoded_json = excluded.decoded_json,
      removed = excluded.removed,
      ingested_at = datetime('now')
  `);

  const insEventsTx = db.transaction((events) => {
    let writes = 0;
    for (const e of events) {
      const res = insEvent.run(e);
      writes += Number(res?.changes || 0);
    }
    return writes;
  });

  const getCursor = db.prepare(`
    SELECT
      s.id,
      s.stream_key,
      s.start_block,
      cur.last_scanned_block,
      cur.last_scanned_log_index,
      cur.last_scanned_tx_hash,
      cur.last_scanned_at
    FROM index_streams s
    JOIN index_cursors cur ON cur.stream_id = s.id
    WHERE s.id = ?
    LIMIT 1
  `);

  return {
    createJob(streamId, { mode, fromBlock, toBlock = null }) {
      const res = insJob.run(streamId, mode, fromBlock, toBlock);
      return Number(res.lastInsertRowid);
    },

    markJobDone(jobId) {
      updJobDone.run(jobId);
    },

    markJobFailed(jobId, errorText) {
      updJobFail.run(String(errorText || "unknown error"), jobId);
    },

    recordWindow({ jobId, fromBlock, toBlock, attemptNo, logsFound, status, errorText, elapsedMs }) {
      insWindow.run(
        jobId,
        fromBlock,
        toBlock,
        attemptNo,
        Math.max(0, Number(logsFound) || 0),
        status,
        errorText || null,
        Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs)) : null
      );
    },

    upsertEvents(events) {
      if (!Array.isArray(events) || !events.length) return 0;
      return insEventsTx(events);
    },

    updateCursor(streamId, { blockNumber, logIndex = null, txHash = null }) {
      updCursor.run(
        Math.max(0, Number(blockNumber) || 0),
        logIndex == null ? null : Number(logIndex),
        txHash || null,
        streamId
      );
    },

    getCursor(streamId) {
      return getCursor.get(streamId);
    },
  };
}

module.exports = {
  prepareEventStore,
};
