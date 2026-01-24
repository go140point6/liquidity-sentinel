// commands/test-alerts.js
const { SlashCommandBuilder } = require("discord.js");
const { getDb } = require("../db");
const { MessageFlags } = require("discord-api-types/v10");
const {
  adjustGlobalIrOffsetPp,
  adjustLiqPriceMultiplier,
  adjustLpRangeShiftPct,
  adjustDebtAheadOffsetPp,
  resetTestOffsets,
  getTestOffsets,
  getLastSeenBases,
  getIrOffsetPpForProtocol,
  getLiqPriceMultiplierForProtocol,
  getDebtAheadOffsetPpForProtocol,
  setDebtAheadBase,
  setPriceBase,
} = require("../monitoring/testOffsets");
const logger = require("../utils/logger");

function loadLoanProtocolChoices() {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `
        SELECT DISTINCT protocol
        FROM contracts
        WHERE kind = 'LOAN_NFT' AND is_enabled = 1
        ORDER BY protocol
      `
      )
      .all();
    return rows
      .map((r) => String(r.protocol || "").trim())
      .filter(Boolean)
      .slice(0, 25)
      .map((p) => ({ name: p, value: p }));
  } catch (err) {
    logger.warn(`[test-alerts] Failed to load loan protocols for choices: ${err?.message || err}`);
    return [];
  }
}

const loanProtocolChoices = loadLoanProtocolChoices();

const REDEMP_DEBT_AHEAD_LOW_PCT = Number(process.env.REDEMP_DEBT_AHEAD_LOW_PCT);
const REDEMP_DEBT_AHEAD_MED_PCT = Number(process.env.REDEMP_DEBT_AHEAD_MED_PCT);
const REDEMP_DEBT_AHEAD_HIGH_PCT = Number(process.env.REDEMP_DEBT_AHEAD_HIGH_PCT);

function normalizeProtocol(protocol) {
  if (!protocol) return null;
  return String(protocol).trim().toUpperCase();
}

function requirePositiveNumber(name, v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return n;
}

function signedDelta(direction, amount) {
  const n = requirePositiveNumber("amount", amount);
  return direction === "down" ? -n : n;
}

function formatProtocolOffsets(label, map, unit) {
  const entries = Object.entries(map || {})
    .filter(([, v]) => Number(v) !== 0)
    .map(([k, v]) => `${k}: ${Number(v).toFixed(4)}${unit}`);
  if (!entries.length) return null;
  return `${label} (${entries.join(", ")})`;
}

function formatProtocolMultipliers(label, map) {
  const entries = Object.entries(map || {})
    .filter(([, v]) => Number(v) !== 1)
    .map(([k, v]) => `${k}: ${Number(v).toFixed(6)}x`);
  if (!entries.length) return null;
  return `${label} (${entries.join(", ")})`;
}

function classifyDebtAheadTier(pct) {
  const v = Number(pct);
  if (!Number.isFinite(v)) return "UNKNOWN";
  if (!Number.isFinite(REDEMP_DEBT_AHEAD_LOW_PCT)) return "UNKNOWN";
  if (v >= REDEMP_DEBT_AHEAD_LOW_PCT) return "LOW";
  if (!Number.isFinite(REDEMP_DEBT_AHEAD_MED_PCT)) return "UNKNOWN";
  if (v >= REDEMP_DEBT_AHEAD_MED_PCT) return "MEDIUM";
  if (!Number.isFinite(REDEMP_DEBT_AHEAD_HIGH_PCT)) return "UNKNOWN";
  if (v >= REDEMP_DEBT_AHEAD_HIGH_PCT) return "HIGH";
  return "CRITICAL";
}

function fmtDebt(n) {
  return typeof n === "number" && Number.isFinite(n)
    ? new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
    : "n/a";
}

function formatState() {
  const s = getTestOffsets();
  const lines = [
    `IR offset: ${s.irOffsetPp.toFixed(4)} pp`,
    formatProtocolOffsets("IR overrides", s.irOffsetByProtocol, " pp"),
    `Debt-ahead offset: ${s.debtAheadOffsetPp.toFixed(4)} pp`,
    formatProtocolOffsets("Debt overrides", s.debtAheadOffsetByProtocol, " pp"),
    `Price multiplier: ${s.liqPriceMultiplier.toFixed(6)}x`,
    formatProtocolMultipliers("Price overrides", s.liqPriceMultiplierByProtocol),
    `LP range shift: ${(s.lpRangeShiftPct * 100).toFixed(2)}% of width`,
  ].filter(Boolean);
  return lines.join("\n");
}

function loadLatestDebtAheadBasesByProtocol() {
  const rows = getDb()
    .prepare(
      `
      SELECT protocol, snapshot_json, snapshot_at
      FROM loan_position_snapshots
      ORDER BY snapshot_at DESC
    `
    )
    .all();
  const latest = new Map();
  for (const row of rows) {
    const protocol = normalizeProtocol(row.protocol);
    if (!protocol || latest.has(protocol)) continue;
    try {
      const snap = JSON.parse(row.snapshot_json);
      const pct = Number(snap.redemptionDebtAheadPct);
      const td = Number(snap.redemptionTotalDebt);
      if (Number.isFinite(pct) && Number.isFinite(td)) {
        latest.set(protocol, { pct, totalDebt: td });
      }
    } catch (_) {}
  }
  return latest;
}

function loadLatestLoanPriceByProtocol() {
  const rows = getDb()
    .prepare(
      `
      SELECT protocol, snapshot_json, snapshot_at
      FROM loan_position_snapshots
      ORDER BY snapshot_at DESC
    `
    )
    .all();
  const latest = new Map();
  for (const row of rows) {
    const protocol = normalizeProtocol(row.protocol);
    if (!protocol || latest.has(protocol)) continue;
    try {
      const snap = JSON.parse(row.snapshot_json);
      const price = Number(snap.price);
      if (Number.isFinite(price)) {
        latest.set(protocol, { price });
      }
    } catch (_) {}
  }
  return latest;
}

module.exports = {
  devOnly: true,
  data: new SlashCommandBuilder()
    .setName("test-alerts")
    .setDescription("Adjust in-memory offsets for alert testing (admin/testing only)")
    .addSubcommand((sc) =>
      sc
        .setName("ir")
        .setDescription("Adjust global IR by percentage points")
        .addStringOption((o) =>
          o
            .setName("direction")
            .setDescription("up = safer, down = riskier")
            .setRequired(true)
            .addChoices(
              { name: "up", value: "up" },
              { name: "down", value: "down" }
            )
        )
        .addNumberOption((o) =>
          o.setName("amount").setDescription("Delta in percentage points").setRequired(true)
        )
        .addStringOption((o) =>
          loanProtocolChoices.length
            ? o
                .setName("protocol")
                .setDescription("Optional protocol")
                .setRequired(false)
                .addChoices(...loanProtocolChoices)
            : o
                .setName("protocol")
                .setDescription("Optional protocol (e.g., ENOSYS_LOAN_FXRP)")
                .setRequired(false)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("debt-ahead")
        .setDescription("Adjust debt-ahead percentage points (redemption risk)")
        .addStringOption((o) =>
          o
            .setName("direction")
            .setDescription("up or down")
            .setRequired(true)
            .addChoices(
              { name: "up", value: "up" },
              { name: "down", value: "down" }
            )
        )
        .addNumberOption((o) =>
          o
            .setName("amount")
            .setDescription("Delta in percentage points of total debt")
            .setRequired(true)
        )
        .addStringOption((o) =>
          loanProtocolChoices.length
            ? o
                .setName("protocol")
                .setDescription("Optional protocol")
                .setRequired(false)
                .addChoices(...loanProtocolChoices)
            : o
                .setName("protocol")
                .setDescription("Optional protocol (e.g., ENOSYS_LOAN_FXRP)")
                .setRequired(false)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("liq")
        .setDescription("Adjust loan price by percent (affects liquidation risk)")
        .addStringOption((o) =>
          o
            .setName("direction")
            .setDescription("up or down")
            .setRequired(true)
            .addChoices(
              { name: "up", value: "up" },
              { name: "down", value: "down" }
            )
        )
        .addNumberOption((o) =>
          o.setName("amount").setDescription("Percent change (e.g., 2 = 2%)").setRequired(true)
        )
        .addStringOption((o) =>
          loanProtocolChoices.length
            ? o
                .setName("protocol")
                .setDescription("Optional protocol")
                .setRequired(false)
                .addChoices(...loanProtocolChoices)
            : o
                .setName("protocol")
                .setDescription("Optional protocol (e.g., ENOSYS_LOAN_FXRP)")
                .setRequired(false)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("lp")
        .setDescription("Shift LP tick by percent of position width")
        .addStringOption((o) =>
          o
            .setName("direction")
            .setDescription("up or down")
            .setRequired(true)
            .addChoices(
              { name: "up", value: "up" },
              { name: "down", value: "down" }
            )
        )
        .addNumberOption((o) =>
          o.setName("amount").setDescription("Percent of width (e.g., 25 = 25%)").setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc.setName("status").setDescription("Show current in-memory test offsets")
    )
    .addSubcommand((sc) =>
      sc.setName("reset").setDescription("Clear all in-memory test offsets")
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const sub = interaction.options.getSubcommand();

      if (sub === "ir") {
        const direction = interaction.options.getString("direction");
        const amount = interaction.options.getNumber("amount");
        const protocol = normalizeProtocol(interaction.options.getString("protocol"));
        const delta = signedDelta(direction, amount);
        const { globalIrPp, globalIrPpByProtocol } = getLastSeenBases();
        const base = protocol ? globalIrPpByProtocol?.[protocol] : globalIrPp;
        const currentOffset = getIrOffsetPpForProtocol(protocol);
        adjustGlobalIrOffsetPp(delta, protocol);
        const before = base != null ? base + currentOffset : null;
        const after = base != null ? base + currentOffset + delta : null;
        const liveMsg =
          before != null && after != null
            ? ` (live: ${before.toFixed(2)}pp -> ${after.toFixed(2)}pp)`
            : " (live: unknown -> unknown)";
        const label = delta >= 0 ? "up" : "down";
        const amountAbs = Math.abs(delta);
        const scope = protocol ? ` ${protocol}` : "";
        const msg = `[test-alerts] IR bump ${label} ${amountAbs}pp${scope}${liveMsg}`;
        logger.debug(msg);
        await interaction.editReply(`✅ Global IR offset adjusted by ${delta} pp\n${formatState()}`);
        return;
      }

      if (sub === "debt-ahead") {
        const direction = interaction.options.getString("direction");
        const amount = interaction.options.getNumber("amount");
        const protocol = normalizeProtocol(interaction.options.getString("protocol"));
        const delta = signedDelta(direction, amount);
        let { debtAheadPctByProtocol, debtTotalByProtocol } = getLastSeenBases();
        let basePct = protocol ? debtAheadPctByProtocol?.[protocol] : null;
        let totalDebt = protocol ? debtTotalByProtocol?.[protocol] : null;
        if (protocol && (basePct == null || totalDebt == null)) {
          try {
            const row = getDb()
              .prepare(
                `
                SELECT snapshot_json
                FROM loan_position_snapshots
                WHERE protocol = ?
                ORDER BY snapshot_at DESC
                LIMIT 1
              `
              )
              .get(protocol);
            if (row?.snapshot_json) {
              const snap = JSON.parse(row.snapshot_json);
              const pct = Number(snap.redemptionDebtAheadPct);
              const td = Number(snap.redemptionTotalDebt);
              if (Number.isFinite(pct) && Number.isFinite(td)) {
                setDebtAheadBase(protocol, pct, td);
                ({ debtAheadPctByProtocol, debtTotalByProtocol } = getLastSeenBases());
                basePct = debtAheadPctByProtocol?.[protocol] ?? null;
                totalDebt = debtTotalByProtocol?.[protocol] ?? null;
              }
            }
          } catch (err) {
            logger.warn(
              `[test-alerts] Failed to load debt-ahead base from snapshots for ${protocol}: ${err?.message || err}`
            );
          }
        }
        const currentOffset = getDebtAheadOffsetPpForProtocol(protocol);
        adjustDebtAheadOffsetPp(delta, protocol);
        const label = delta >= 0 ? "up" : "down";
        const amountAbs = Math.abs(delta);
        if (!protocol) {
          const latest = loadLatestDebtAheadBasesByProtocol();
          for (const [proto, base] of latest.entries()) {
            setDebtAheadBase(proto, base.pct, base.totalDebt);
            const beforeOffset = getDebtAheadOffsetPpForProtocol(proto) - delta;
            const beforePct = base.pct + beforeOffset / 100;
            const afterPct = base.pct + (beforeOffset + delta) / 100;
            const beforeDebt = beforePct * base.totalDebt;
            const afterDebt = afterPct * base.totalDebt;
            const beforeTier = classifyDebtAheadTier(beforePct);
            const afterTier = classifyDebtAheadTier(afterPct);
            logger.debug(
              `[test-alerts] Debt-ahead bump ${label} ${amountAbs}pp ${proto} ` +
                `(live: ${(beforePct * 100).toFixed(2)}% (${beforeTier}) -> ${(afterPct * 100).toFixed(2)}% (${afterTier}), ` +
                `debt ${fmtDebt(beforeDebt)} -> ${fmtDebt(afterDebt)})`
            );
          }
        } else {
          const beforePct = basePct != null ? basePct + currentOffset / 100 : null;
          const afterPct = basePct != null ? basePct + (currentOffset + delta) / 100 : null;
          const beforeDebt =
            beforePct != null && totalDebt != null ? beforePct * totalDebt : null;
          const afterDebt = afterPct != null && totalDebt != null ? afterPct * totalDebt : null;
          const beforeTier = classifyDebtAheadTier(beforePct);
          const afterTier = classifyDebtAheadTier(afterPct);
          const liveMsg =
            beforePct != null && afterPct != null
              ? ` (live: ${(beforePct * 100).toFixed(2)}% (${beforeTier}) -> ${(afterPct * 100).toFixed(2)}% (${afterTier}), ` +
                `debt ${fmtDebt(beforeDebt)} -> ${fmtDebt(afterDebt)})`
              : " (live: unknown -> unknown)";
          const scope = protocol ? ` ${protocol}` : "";
          const msg = `[test-alerts] Debt-ahead bump ${label} ${amountAbs}pp${scope}${liveMsg}`;
          logger.debug(msg);
        }
        await interaction.editReply(
          `✅ Debt-ahead offset adjusted by ${delta} pp\n${formatState()}`
        );
        return;
      }

      if (sub === "liq") {
        const direction = interaction.options.getString("direction");
        const amount = interaction.options.getNumber("amount");
        const protocol = normalizeProtocol(interaction.options.getString("protocol"));
        const deltaPct = signedDelta(direction, amount);
        const factor = 1 + deltaPct / 100;
        if (factor <= 0) throw new Error("price multiplier would be <= 0");
        const { price, priceByProtocol } = getLastSeenBases();
        let basePrice = protocol ? priceByProtocol?.[protocol] : price;
        if (protocol && (basePrice == null || !Number.isFinite(basePrice))) {
          const latest = loadLatestLoanPriceByProtocol();
          const entry = latest.get(protocol);
          if (entry?.price != null && Number.isFinite(entry.price)) {
            setPriceBase(protocol, entry.price);
            basePrice = entry.price;
          }
        }
        const beforeMult = getLiqPriceMultiplierForProtocol(protocol);
        adjustLiqPriceMultiplier(factor, protocol);
        const before =
          basePrice != null && Number.isFinite(basePrice) ? basePrice * beforeMult : null;
        const after =
          basePrice != null && Number.isFinite(basePrice) ? basePrice * beforeMult * factor : null;
        const label = deltaPct >= 0 ? "up" : "down";
        const amountAbs = Math.abs(deltaPct);
        if (!protocol) {
          const latest = loadLatestLoanPriceByProtocol();
          for (const [proto, entry] of latest.entries()) {
            setPriceBase(proto, entry.price);
            const beforeP = entry.price * getLiqPriceMultiplierForProtocol(proto) / factor;
            const afterP = entry.price * getLiqPriceMultiplierForProtocol(proto);
            logger.debug(
              `[test-alerts] Price bump ${label} ${amountAbs.toFixed(2)}% ${proto} (live: ${beforeP.toFixed(4)} -> ${afterP.toFixed(4)})`
            );
          }
        } else {
          const liveMsg =
            before != null && after != null
              ? ` (live: ${before.toFixed(4)} -> ${after.toFixed(4)})`
              : " (live: unknown -> unknown)";
          const msg = `[test-alerts] Price bump ${label} ${amountAbs.toFixed(2)}% ${protocol}${liveMsg}`;
          logger.debug(msg);
        }
        await interaction.editReply(
          `✅ Price multiplier adjusted by ${factor.toFixed(6)}x\n${formatState()}`
        );
        return;
      }

      if (sub === "lp") {
        const direction = interaction.options.getString("direction");
        const amount = interaction.options.getNumber("amount");
        const deltaPct = signedDelta(direction, amount) / 100;
        const { lpRangeShiftPct } = getTestOffsets();
        const { lpTick, lpWidth } = getLastSeenBases();
        adjustLpRangeShiftPct(deltaPct);
        const before = lpTick != null && lpWidth != null ? lpTick + Math.round(lpWidth * lpRangeShiftPct) : null;
        const after =
          lpTick != null && lpWidth != null
            ? lpTick + Math.round(lpWidth * (lpRangeShiftPct + deltaPct))
            : null;
        const label = deltaPct >= 0 ? "up" : "down";
        const amountAbs = Math.abs(deltaPct * 100);
        const liveMsg =
          before != null && after != null
            ? ` (live: ${before} -> ${after})`
            : " (live: unknown -> unknown)";
        const msg = `[test-alerts] LP bump ${label} ${amountAbs.toFixed(2)}% of width${liveMsg}`;
        logger.debug(msg);
        await interaction.editReply(
          `✅ LP range shift adjusted by ${(deltaPct * 100).toFixed(2)}%\n${formatState()}`
        );
        return;
      }

      if (sub === "status") {
        await interaction.editReply(`Current test offsets:\n${formatState()}`);
        return;
      }

      if (sub === "reset") {
        resetTestOffsets();
        await interaction.editReply(`🧹 Cleared all test offsets\n${formatState()}`);
        return;
      }
    } catch (err) {
      await interaction.editReply(`❌ ${err.message}`);
    }
  },
};
