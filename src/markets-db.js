// markets-db.js
// A read-only market-signals feature: live prices, a personal watchlist, price alerts, and
// basic technical indicators (SMA/EMA/RSI/MACD) computed from public market data.
//
// Explicitly NOT in scope, by design: no wallet connection, no order placement, no execution of
// any trade, no custody of funds. This module only ever reads public price data and stores the
// user's own watchlist/alert preferences — the "signal" is informational, the person still has to
// go act on it themselves outside this app. Every place a signal is shown to a user must carry a
// plain "not financial advice" disclaimer (enforced in the API layer, not here).
import db from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS market_symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL UNIQUE,          -- e.g. 'BTC', 'ETH', 'TON' — the coin id used by the price source
  display_name TEXT NOT NULL,           -- e.g. 'Bitcoin'
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Rolling price history per symbol, one row per fetch tick. Old rows are pruned periodically
-- (see pruneOldCandles) so this never grows unbounded — we only need enough history for the
-- longest indicator window (MACD's slow EMA needs ~26+ points), not a full trading-grade archive.
CREATE TABLE IF NOT EXISTS market_price_ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  price_usd REAL NOT NULL,
  change_24h_pct REAL,
  volume_24h_usd REAL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ticks_symbol_time ON market_price_ticks(symbol, fetched_at);

CREATE TABLE IF NOT EXISTS market_watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tg_id, symbol)
);

CREATE TABLE IF NOT EXISTS market_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('above','below')),
  target_price REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,     -- flips to 0 once triggered (one-shot alert, like a kitchen timer)
  triggered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON market_alerts(active, symbol);
`);

// Seed a small default watchable list on first run only — admin can add/remove more later.
const seedCount = db.prepare('SELECT COUNT(*) c FROM market_symbols').get().c;
if (seedCount === 0) {
  const seed = db.prepare('INSERT INTO market_symbols (symbol, display_name, sort_order) VALUES (?,?,?)');
  [['bitcoin', 'Bitcoin (BTC)', 1], ['ethereum', 'Ethereum (ETH)', 2], ['the-open-network', 'Toncoin (TON)', 3],
   ['tether', 'Tether (USDT)', 4], ['binancecoin', 'BNB', 5], ['solana', 'Solana (SOL)', 6]]
    .forEach(([symbol, display_name, sort_order]) => seed.run(symbol, display_name, sort_order));
}

export function listActiveSymbols() {
  return db.prepare('SELECT * FROM market_symbols WHERE active = 1 ORDER BY sort_order ASC').all();
}
export function listAllSymbolsAdmin() {
  return db.prepare('SELECT * FROM market_symbols ORDER BY sort_order ASC').all();
}
export function upsertSymbol({ id, symbol, display_name, active, sort_order }) {
  if (id) {
    db.prepare('UPDATE market_symbols SET symbol=?, display_name=?, active=?, sort_order=? WHERE id=?')
      .run(symbol, display_name, active ? 1 : 0, Number(sort_order) || 0, id);
    return id;
  }
  return db.prepare('INSERT INTO market_symbols (symbol, display_name, active, sort_order) VALUES (?,?,?,?)')
    .run(symbol, display_name, active ? 1 : 0, Number(sort_order) || 0).lastInsertRowid;
}
export function deleteSymbol(id) { db.prepare('DELETE FROM market_symbols WHERE id = ?').run(id); }

// Records one price tick per symbol. Called by the periodic fetch job in server.js — this
// function itself does no network I/O, it just persists what was already fetched.
export function recordPriceTick(symbol, priceUsd, change24hPct, volume24hUsd) {
  db.prepare('INSERT INTO market_price_ticks (symbol, price_usd, change_24h_pct, volume_24h_usd) VALUES (?,?,?,?)')
    .run(symbol, priceUsd, change24hPct ?? null, volume24hUsd ?? null);
}

// Keeps at most `keep` most-recent ticks per symbol so the table stays small forever regardless
// of how long the bot has been running — called once per fetch cycle, cheap even at scale since
// it's bounded by symbol count, not total row count.
export function pruneOldCandles(keepPerSymbol = 300) {
  const symbols = db.prepare('SELECT DISTINCT symbol FROM market_price_ticks').all();
  const del = db.prepare(`
    DELETE FROM market_price_ticks WHERE symbol = ? AND id NOT IN (
      SELECT id FROM market_price_ticks WHERE symbol = ? ORDER BY fetched_at DESC LIMIT ?
    )
  `);
  symbols.forEach(({ symbol }) => del.run(symbol, symbol, keepPerSymbol));
}

export function getLatestTick(symbol) {
  return db.prepare('SELECT * FROM market_price_ticks WHERE symbol = ? ORDER BY fetched_at DESC LIMIT 1').get(symbol);
}
export function getRecentPrices(symbol, limit = 60) {
  return db.prepare('SELECT price_usd, fetched_at FROM market_price_ticks WHERE symbol = ? ORDER BY fetched_at DESC LIMIT ?')
    .all(symbol, limit).reverse().map(r => r.price_usd);
}

/* ---------------- Technical indicators ----------------
   Plain, well-known formulas, computed from recorded price ticks. These are informational
   statistics about publicly available price history — not predictions, not trade instructions.
   Every function returns null when there isn't enough history yet rather than a misleading
   half-computed number. */

export function sma(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) emaVal = prices[i] * k + emaVal * (1 - k);
  return emaVal;
}

export function rsi(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const delta = prices[i] - prices[i - 1];
    if (delta >= 0) gains += delta; else losses -= delta;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export function macd(prices, fast = 12, slow = 26, signalPeriod = 9) {
  if (prices.length < slow + signalPeriod) return null;
  // Build the MACD line as a full series so we can EMA it for the signal line, not just a
  // single point — a single fast/slow EMA snapshot alone can't produce a signal-line crossover.
  const emaSeries = (period) => {
    const k = 2 / (period + 1);
    const out = [];
    let val = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    out[period - 1] = val;
    for (let i = period; i < prices.length; i++) { val = prices[i] * k + val * (1 - k); out[i] = val; }
    return out;
  };
  const fastSeries = emaSeries(fast), slowSeries = emaSeries(slow);
  const macdLine = [];
  for (let i = slow - 1; i < prices.length; i++) macdLine.push(fastSeries[i] - slowSeries[i]);
  if (macdLine.length < signalPeriod) return null;
  const k = 2 / (signalPeriod + 1);
  let signal = macdLine.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;
  for (let i = signalPeriod; i < macdLine.length; i++) signal = macdLine[i] * k + signal * (1 - k);
  const macdValue = macdLine[macdLine.length - 1];
  return { macd: macdValue, signal, histogram: macdValue - signal };
}

// A plain-language read of the indicators — deliberately hedged, never a "buy"/"sell" instruction.
export function summarizeSignal(prices) {
  const r = rsi(prices);
  const m = macd(prices);
  const sma20 = sma(prices, 20);
  const sma50 = sma(prices, 50);
  const notes = [];
  if (r !== null) {
    if (r >= 70) notes.push('RSI suggests the market may be overbought');
    else if (r <= 30) notes.push('RSI suggests the market may be oversold');
  }
  if (m) notes.push(m.histogram > 0 ? 'MACD histogram is positive (upward momentum)' : 'MACD histogram is negative (downward momentum)');
  if (sma20 !== null && sma50 !== null) notes.push(sma20 > sma50 ? 'Short-term average is above the long-term average' : 'Short-term average is below the long-term average');
  return { rsi: r, macd: m, sma20, sma50, notes };
}

/* ---------------- Watchlist ---------------- */
export function getWatchlist(tgId) {
  return db.prepare(`
    SELECT w.id, w.symbol, s.display_name
    FROM market_watchlist w JOIN market_symbols s ON s.symbol = w.symbol
    WHERE w.tg_id = ? ORDER BY w.created_at ASC
  `).all(tgId);
}
export function addToWatchlist(tgId, symbol) {
  db.prepare('INSERT OR IGNORE INTO market_watchlist (tg_id, symbol) VALUES (?,?)').run(tgId, symbol);
}
export function removeFromWatchlist(tgId, symbol) {
  db.prepare('DELETE FROM market_watchlist WHERE tg_id = ? AND symbol = ?').run(tgId, symbol);
}

/* ---------------- Price alerts ---------------- */
export function listAlerts(tgId) {
  return db.prepare(`
    SELECT a.*, s.display_name FROM market_alerts a JOIN market_symbols s ON s.symbol = a.symbol
    WHERE a.tg_id = ? ORDER BY a.created_at DESC
  `).all(tgId);
}
export function createAlert(tgId, symbol, direction, targetPrice) {
  const MAX_ACTIVE_ALERTS = 20; // a sane per-user cap so this can't be used to spam the price-check loop
  const activeCount = db.prepare('SELECT COUNT(*) c FROM market_alerts WHERE tg_id = ? AND active = 1').get(tgId).c;
  if (activeCount >= MAX_ACTIVE_ALERTS) throw new Error(`You can have at most ${MAX_ACTIVE_ALERTS} active alerts`);
  return db.prepare('INSERT INTO market_alerts (tg_id, symbol, direction, target_price) VALUES (?,?,?,?)')
    .run(tgId, symbol, direction, targetPrice).lastInsertRowid;
}
export function deleteAlert(tgId, id) {
  db.prepare('DELETE FROM market_alerts WHERE tg_id = ? AND id = ?').run(tgId, id);
}

// Checks every active alert against the latest known price for its symbol and returns the ones
// that just triggered (marking them inactive so they only fire once) — called by the periodic
// job in server.js right after a fresh price fetch, so it always compares against current data.
export function checkTriggeredAlerts() {
  const active = db.prepare('SELECT * FROM market_alerts WHERE active = 1').all();
  const triggered = [];
  const bySymbol = {};
  for (const a of active) {
    if (!(a.symbol in bySymbol)) bySymbol[a.symbol] = getLatestTick(a.symbol);
    const tick = bySymbol[a.symbol];
    if (!tick) continue;
    const hit = a.direction === 'above' ? tick.price_usd >= a.target_price : tick.price_usd <= a.target_price;
    if (hit) {
      db.prepare(`UPDATE market_alerts SET active = 0, triggered_at = datetime('now') WHERE id = ?`).run(a.id);
      triggered.push({ ...a, currentPrice: tick.price_usd });
    }
  }
  return triggered;
}

export default db;
