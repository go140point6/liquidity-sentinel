// utils/priceCache.js
const https = require("https");
const logger = require("./logger");

const LIQ_PRICE_KEY_BY_SYMBOL = {
  FLR: "FLR",
  WFLR: "FLR",
  XRP: "XRP",
  FXRP: "XRP",
  STXRP: "XRP",
  APS: "APS",
  CDP: "CDP",
};

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode} when fetching ${url}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

function normalizeSymbol(sym) {
  const raw = String(sym || "").trim();
  if (!raw) return "";
  // Normalize common stable symbols with special characters
  const replaced = raw.replace(/USD₮/gi, "USDT");
  return replaced.toUpperCase();
}

function isStableUsd(chainId, symbol) {
  const sym = normalizeSymbol(symbol);
  const chain = String(chainId || "").toUpperCase();
  if (chain === "FLR") return sym === "USDT0";
  if (chain === "XDC") return sym === "USDC";
  return false;
}

async function fetchLiquityPrices(url) {
  if (!url) return {};
  const json = await fetchJson(url);
  const prices = json?.prices || {};
  const out = {};
  for (const [k, v] of Object.entries(prices)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[k.toUpperCase()] = n;
  }
  return out;
}

async function fetchCryptoCompareXdc() {
  const url = "https://min-api.cryptocompare.com/data/price?fsym=XDC&tsyms=USDT";
  const json = await fetchJson(url);
  const n = Number(json?.USDT);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getSparkdexPriceApiBase() {
  const raw = String(process.env.SPARKDEX_PRICE_API_BASE || "").trim();
  if (!raw) return "https://api.sparkdex.ai/price/latest";
  return raw;
}

async function fetchSparkdexPrices(symbols) {
  const uniq = [...new Set((symbols || []).map((s) => String(s || "").trim()).filter(Boolean))];
  if (!uniq.length) return {};

  const base = getSparkdexPriceApiBase();
  const qs = new URLSearchParams({ symbols: uniq.join(",") });
  const url = `${base}?${qs.toString()}`;
  const json = await fetchJson(url);

  const out = {};
  for (const [rawSym, rawPrice] of Object.entries(json || {})) {
    const sym = normalizeSymbol(rawSym);
    const price = Number(rawPrice);
    if (!sym || !Number.isFinite(price) || price <= 0) continue;
    out[sym] = price;
  }
  return out;
}

function upsertPrice(db, chainId, symbol, priceUsd, source) {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return;
  db.prepare(
    `
    INSERT INTO price_cache (chain_id, symbol, price_usd, source, fetched_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(chain_id, symbol) DO UPDATE SET
      price_usd = excluded.price_usd,
      source = excluded.source,
      fetched_at = datetime('now')
  `
  ).run(chainId, symbol, priceUsd, source);

  db.prepare(
    `
    INSERT INTO price_cache_history (chain_id, symbol, price_usd, source, fetched_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `
  ).run(chainId, symbol, priceUsd, source);
}

async function refreshPriceCache(db, symbolsByChain) {
  const wanted = new Map();
  for (const [chainId, symbols] of symbolsByChain.entries()) {
    for (const sym of symbols) {
      const key = `${chainId}|${sym}`;
      wanted.set(key, { chainId, symbol: sym });
    }
  }

  const resolved = new Set();
  const stableEntries = [];
  const liqTargets = [];
  const xdcTargets = [];
  const sparkdexTargets = [];

  for (const { chainId, symbol } of wanted.values()) {
    if (!symbol) continue;
    const norm = normalizeSymbol(symbol);
    if (!norm) continue;

    if (isStableUsd(chainId, norm)) {
      stableEntries.push({ chainId, symbol: norm });
      continue;
    }

    const liqKey = LIQ_PRICE_KEY_BY_SYMBOL[norm];
    if (liqKey) {
      liqTargets.push({ chainId, symbol: norm, liqKey });
      continue;
    }

    if (norm === "XDC" || norm === "WXDC") {
      xdcTargets.push({ chainId, symbol: norm });
      continue;
    }

    if (String(chainId || "").toUpperCase() === "FLR") {
      sparkdexTargets.push({ chainId, symbol: norm });
    }
  }

  for (const entry of stableEntries) {
    upsertPrice(db, entry.chainId, entry.symbol, 1.0, "stable");
    resolved.add(`${entry.chainId}|${entry.symbol}`);
  }

  if (liqTargets.length) {
    try {
      const liqUrl = process.env.GLOBAL_IR_URL;
      const priceByKey = await fetchLiquityPrices(liqUrl);
      const pairs = Object.entries(priceByKey)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      logger.debug(`[priceCache] liquity-json prices: ${pairs}`);
      for (const t of liqTargets) {
        const price = priceByKey[t.liqKey];
        if (Number.isFinite(price) && price > 0) {
          upsertPrice(db, t.chainId, t.symbol, price, "liquity-json");
          resolved.add(`${t.chainId}|${t.symbol}`);
        }
      }
    } catch (err) {
      logger.warn(`[priceCache] liquity price fetch failed: ${err.message || err}`);
    }
  }

  if (xdcTargets.length) {
    try {
      const xdcPrice = await fetchCryptoCompareXdc();
      if (Number.isFinite(xdcPrice)) {
        logger.debug(`[priceCache] cryptocompare XDC price: ${xdcPrice}`);
      }
      if (Number.isFinite(xdcPrice) && xdcPrice > 0) {
        for (const t of xdcTargets) {
          upsertPrice(db, t.chainId, t.symbol, xdcPrice, "cryptocompare");
          resolved.add(`${t.chainId}|${t.symbol}`);
        }
      }
    } catch (err) {
      logger.warn(`[priceCache] cryptocompare fetch failed: ${err.message || err}`);
    }
  }

  if (sparkdexTargets.length) {
    const unresolved = sparkdexTargets.filter((t) => !resolved.has(`${t.chainId}|${t.symbol}`));
    if (unresolved.length) {
      try {
        const symbols = unresolved.map((t) => t.symbol);
        const sparkPrices = await fetchSparkdexPrices(symbols);
        const pairs = Object.entries(sparkPrices)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        logger.debug(`[priceCache] sparkdex prices: ${pairs}`);

        for (const t of unresolved) {
          const price = sparkPrices[t.symbol];
          if (Number.isFinite(price) && price > 0) {
            upsertPrice(db, t.chainId, t.symbol, price, "sparkdex-api");
            resolved.add(`${t.chainId}|${t.symbol}`);
          }
        }
      } catch (err) {
        logger.warn(`[priceCache] sparkdex price fetch failed: ${err.message || err}`);
      }
    }
  }
}

function buildSymbolsFromLpSnapshots(db) {
  const rows = db.prepare(`SELECT snapshot_json FROM lp_position_snapshots`).all();
  const map = new Map();
  for (const r of rows) {
    try {
      const obj = JSON.parse(r.snapshot_json);
      if (!obj || typeof obj !== "object") continue;
      if ((obj.status || "").toString().toUpperCase() === "INACTIVE") continue;
      const chainId = String(obj.chainId || "").toUpperCase();
      if (!chainId) continue;
      if (!map.has(chainId)) map.set(chainId, new Set());
      const set = map.get(chainId);
      if (obj.token0Symbol) set.add(normalizeSymbol(obj.token0Symbol));
      if (obj.token1Symbol) set.add(normalizeSymbol(obj.token1Symbol));
      if (obj.priceBaseSymbol) set.add(normalizeSymbol(obj.priceBaseSymbol));
      if (obj.priceQuoteSymbol) set.add(normalizeSymbol(obj.priceQuoteSymbol));
    } catch (_) {}
  }
  return map;
}

function loadPriceCache(db) {
  const rows = db.prepare(`SELECT chain_id, symbol, price_usd FROM price_cache`).all();
  const map = new Map();
  for (const r of rows) {
    const chainId = String(r.chain_id || "").toUpperCase();
    const symbol = normalizeSymbol(r.symbol);
    if (!chainId || !symbol) continue;
    if (!map.has(chainId)) map.set(chainId, new Map());
    map.get(chainId).set(symbol, Number(r.price_usd));
  }
  return map;
}

module.exports = {
  buildSymbolsFromLpSnapshots,
  refreshPriceCache,
  loadPriceCache,
  isStableUsd,
  normalizeSymbol,
};
