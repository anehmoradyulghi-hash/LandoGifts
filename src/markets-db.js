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
  is_meme INTEGER NOT NULL DEFAULT 0,   -- flagged for the Meme Radar section
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
  market_cap_usd REAL,
  market_cap_rank INTEGER,
  ath_usd REAL,
  atl_usd REAL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ticks_symbol_time ON market_price_ticks(symbol, fetched_at);

CREATE TABLE IF NOT EXISTS market_watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  list_name TEXT NOT NULL DEFAULT 'Default', -- lets a person keep more than one named watchlist
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tg_id, symbol, list_name)
);

CREATE TABLE IF NOT EXISTS market_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  metric TEXT NOT NULL DEFAULT 'price' CHECK(metric IN ('price','rsi','macd_histogram','volume_spike')),
  direction TEXT NOT NULL CHECK(direction IN ('above','below')),
  target_value REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,     -- flips to 0 once triggered (one-shot alert, like a kitchen timer)
  triggered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON market_alerts(active, symbol);
`);

// Older installs created market_watchlist/market_alerts before list_name / metric existed —
// add them the same safe, idempotent way the rest of the app migrates existing tables.
function safeAddColumn(table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); } catch (e) { /* already exists */ }
}
safeAddColumn('market_watchlist', `list_name TEXT NOT NULL DEFAULT 'Default'`);
safeAddColumn('market_symbols', 'is_meme INTEGER NOT NULL DEFAULT 0');
safeAddColumn('market_price_ticks', 'market_cap_usd REAL');
safeAddColumn('market_price_ticks', 'market_cap_rank INTEGER');
safeAddColumn('market_price_ticks', 'ath_usd REAL');
safeAddColumn('market_price_ticks', 'atl_usd REAL');
// The old market_alerts had `target_price` instead of the more general `target_value` + `metric` —
// carry any existing rows over rather than silently dropping people's alerts on upgrade.
try {
  db.exec(`ALTER TABLE market_alerts ADD COLUMN target_value REAL`);
  db.exec(`UPDATE market_alerts SET target_value = target_price WHERE target_value IS NULL AND target_price IS NOT NULL`);
} catch (e) { /* column already existed, or target_price never existed on a fresh install */ }
safeAddColumn('market_alerts', `metric TEXT NOT NULL DEFAULT 'price'`);

// Seed a small default watchable list on first run only — admin can add/remove more later.
const seedCount = db.prepare('SELECT COUNT(*) c FROM market_symbols').get().c;
if (seedCount === 0) {
  const seed = db.prepare('INSERT INTO market_symbols (symbol, display_name, sort_order, is_meme) VALUES (?,?,?,?)');
  [['bitcoin', 'Bitcoin (BTC)', 1, 0], ['ethereum', 'Ethereum (ETH)', 2, 0], ['the-open-network', 'Toncoin (TON)', 3, 0],
   ['tether', 'Tether (USDT)', 4, 0], ['binancecoin', 'BNB', 5, 0], ['solana', 'Solana (SOL)', 6, 0],
   ['dogecoin', 'Dogecoin (DOGE)', 7, 1], ['shiba-inu', 'Shiba Inu (SHIB)', 8, 1], ['pepe', 'Pepe (PEPE)', 9, 1]]
    .forEach(([symbol, display_name, sort_order, is_meme]) => seed.run(symbol, display_name, sort_order, is_meme));
}

export function listActiveSymbols() {
  return db.prepare('SELECT * FROM market_symbols WHERE active = 1 ORDER BY sort_order ASC').all();
}
export function listAllSymbolsAdmin() {
  return db.prepare('SELECT * FROM market_symbols ORDER BY sort_order ASC').all();
}
export function upsertSymbol({ id, symbol, display_name, active, is_meme, sort_order }) {
  if (id) {
    db.prepare('UPDATE market_symbols SET symbol=?, display_name=?, active=?, is_meme=?, sort_order=? WHERE id=?')
      .run(symbol, display_name, active ? 1 : 0, is_meme ? 1 : 0, Number(sort_order) || 0, id);
    return id;
  }
  return db.prepare('INSERT INTO market_symbols (symbol, display_name, active, is_meme, sort_order) VALUES (?,?,?,?,?)')
    .run(symbol, display_name, active ? 1 : 0, is_meme ? 1 : 0, Number(sort_order) || 0).lastInsertRowid;
}
export function deleteSymbol(id) { db.prepare('DELETE FROM market_symbols WHERE id = ?').run(id); }

// Records one price tick per symbol. Called by the periodic fetch job in server.js — this
// function itself does no network I/O, it just persists what was already fetched. Market cap,
// rank, ATH/ATL are all optional (come from CoinGecko's richer /coins/markets endpoint) — a
// simple-price-only fetch still works fine and just leaves those columns null.
export function recordPriceTick(symbol, priceUsd, change24hPct, volume24hUsd, marketCapUsd, marketCapRank, athUsd, atlUsd) {
  db.prepare(`INSERT INTO market_price_ticks
    (symbol, price_usd, change_24h_pct, volume_24h_usd, market_cap_usd, market_cap_rank, ath_usd, atl_usd)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(symbol, priceUsd, change24hPct ?? null, volume24hUsd ?? null, marketCapUsd ?? null, marketCapRank ?? null, athUsd ?? null, atlUsd ?? null);
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
export function getRecentVolumes(symbol, limit = 60) {
  return db.prepare('SELECT volume_24h_usd FROM market_price_ticks WHERE symbol = ? AND volume_24h_usd IS NOT NULL ORDER BY fetched_at DESC LIMIT ?')
    .all(symbol, limit).reverse().map(r => r.volume_24h_usd);
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

/* ---------------- Structure, volatility, volume, divergence ----------------
   All derived purely from the recorded price/volume series — no external data, nothing invented.
   Every function below returns null/empty when there isn't enough history, same discipline as
   the indicators above. */

// Finds local peaks/troughs in the price series (a simple swing-point detector: a point higher
// than its neighbors on both sides is a swing high, lower is a swing low) — the basis for
// support/resistance, trend structure, and higher-high/lower-low classification.
export function findSwingPoints(prices, window = 2) {
  const highs = [], lows = [];
  for (let i = window; i < prices.length - window; i++) {
    const left = prices.slice(i - window, i), right = prices.slice(i + 1, i + 1 + window);
    if (prices[i] > Math.max(...left) && prices[i] > Math.max(...right)) highs.push({ index: i, price: prices[i] });
    if (prices[i] < Math.min(...left) && prices[i] < Math.min(...right)) lows.push({ index: i, price: prices[i] });
  }
  return { highs, lows };
}

// Naive support/resistance: the lowest swing-low and highest swing-high seen in the window —
// simple and honest about what it is (recent range extremes), not a claim of a "real" S/R zone
// derived from order-book depth, which free public APIs don't expose.
export function findSupportResistance(prices) {
  if (prices.length < 6) return { support: null, resistance: null };
  const { highs, lows } = findSwingPoints(prices);
  const support = lows.length ? Math.min(...lows.map(l => l.price)) : Math.min(...prices);
  const resistance = highs.length ? Math.max(...highs.map(h => h.price)) : Math.max(...prices);
  return { support, resistance };
}

// Classifies short-term market structure from the last two swing highs and two swing lows:
// higher-high/higher-low = uptrend structure, lower-high/lower-low = downtrend structure,
// anything mixed = sideways/unclear. This is the textbook Dow-theory structure read, not a guess.
export function classifyMarketStructure(prices) {
  const { highs, lows } = findSwingPoints(prices);
  if (highs.length < 2 || lows.length < 2) return { structure: 'insufficient_data', detail: null };
  const lastTwoHighs = highs.slice(-2), lastTwoLows = lows.slice(-2);
  const higherHigh = lastTwoHighs[1].price > lastTwoHighs[0].price;
  const higherLow = lastTwoLows[1].price > lastTwoLows[0].price;
  if (higherHigh && higherLow) return { structure: 'uptrend', detail: 'Higher High + Higher Low' };
  if (!higherHigh && !higherLow) return { structure: 'downtrend', detail: 'Lower High + Lower Low' };
  return { structure: 'sideways', detail: 'Mixed swing structure' };
}

// Bullish/bearish divergence: price makes a new swing low/high but RSI does NOT confirm it —
// a well-known warning sign that momentum disagrees with price. Needs at least two RSI readings
// at the two most recent swing points to say anything at all.
export function detectDivergence(prices) {
  const { highs, lows } = findSwingPoints(prices);
  if (lows.length >= 2) {
    const [a, b] = lows.slice(-2);
    const rsiA = rsi(prices.slice(0, a.index + 1)), rsiB = rsi(prices.slice(0, b.index + 1));
    if (rsiA !== null && rsiB !== null && b.price < a.price && rsiB > rsiA) {
      return { type: 'bullish', detail: 'Price made a lower low but RSI made a higher low' };
    }
  }
  if (highs.length >= 2) {
    const [a, b] = highs.slice(-2);
    const rsiA = rsi(prices.slice(0, a.index + 1)), rsiB = rsi(prices.slice(0, b.index + 1));
    if (rsiA !== null && rsiB !== null && b.price > a.price && rsiB < rsiA) {
      return { type: 'bearish', detail: 'Price made a higher high but RSI made a lower high' };
    }
  }
  return { type: 'none', detail: null };
}

// Realized volatility as the standard deviation of period-over-period % returns — a standard,
// model-free volatility measure (this is literally what "volatility" means statistically, not
// an approximation of something fancier).
export function volatility(prices) {
  if (prices.length < 3) return null;
  const returns = [];
  for (let i = 1; i < prices.length; i++) returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100; // as a percentage
}

// Compares the most recent volume reading against the average of the preceding readings —
// "unusual volume" is honestly just "how many times bigger than its own recent average."
// Returns null when there isn't a real baseline yet rather than a misleading 1.0x.
export function volumeSpikeRatio(volumes) {
  if (volumes.length < 4) return null;
  const latest = volumes[volumes.length - 1];
  const baseline = volumes.slice(0, -1);
  const avgBaseline = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  if (!avgBaseline) return null;
  return latest / avgBaseline;
}

// Momentum as simple rate-of-change over the available window — how much price moved as a % of
// where it started, over whatever history exists (caller decides which slice to pass in for
// "short/medium/long term").
export function rateOfChange(prices) {
  if (prices.length < 2) return null;
  const first = prices[0], last = prices[prices.length - 1];
  if (!first) return null;
  return ((last - first) / first) * 100;
}

// The Signal Engine: combines every factor above into one 0-100 score with an explicit list of
// which factors pushed it up or down. This is a transparent weighted checklist, not a black box —
// every point added or subtracted is named in `factors`, and confidence reflects how much real
// history backs the read (more data points = higher confidence), not how "sure" the score looks.
// Deliberately hedged: never returns a buy/sell instruction, and returns NO_CLEAR_SIGNAL when
// there isn't enough data for any factor to fire.
export function computeSignalScore(prices, volumes) {
  let score = 50; // neutral midpoint
  const factors = []; // { text, weight } — weight sign shows bullish(+)/bearish(-)

  const r = prices.length >= 4 ? rsi(prices, prices.length >= 15 ? 14 : Math.max(3, prices.length - 1)) : null;
  if (r !== null) {
    if (r <= 30) { score += 12; factors.push({ text: 'RSI Momentum (oversold, room to bounce)', weight: 12 }); }
    else if (r >= 70) { score -= 12; factors.push({ text: 'RSI Momentum (overbought, room to cool)', weight: -12 }); }
    else if (r > 55) { score += 4; factors.push({ text: 'RSI leaning bullish', weight: 4 }); }
    else if (r < 45) { score -= 4; factors.push({ text: 'RSI leaning bearish', weight: -4 }); }
  }

  const m = macd(prices, Math.min(12, Math.floor(prices.length / 3) || 1), Math.min(26, Math.floor(prices.length * 0.7) || 2), Math.min(9, Math.floor(prices.length / 4) || 1));
  if (m) {
    if (m.histogram > 0) { score += 10; factors.push({ text: 'MACD Bullish Cross (histogram positive)', weight: 10 }); }
    else { score -= 10; factors.push({ text: 'MACD Bearish Cross (histogram negative)', weight: -10 }); }
  }

  const smaShort = prices.length >= 20 ? sma(prices, 20) : sma(prices, Math.max(2, Math.floor(prices.length / 2)));
  const smaLong = prices.length >= 50 ? sma(prices, 50) : (prices.length >= 6 ? sma(prices, prices.length) : null);
  const latestPrice = prices[prices.length - 1];
  if (smaShort !== null && latestPrice) {
    if (latestPrice > smaShort) { score += 8; factors.push({ text: 'Price Above Short-Term Average', weight: 8 }); }
    else { score -= 8; factors.push({ text: 'Price Below Short-Term Average', weight: -8 }); }
  }
  if (smaShort !== null && smaLong !== null) {
    if (smaShort > smaLong) { score += 6; factors.push({ text: 'Short-Term Trend Above Long-Term Trend', weight: 6 }); }
    else { score -= 6; factors.push({ text: 'Short-Term Trend Below Long-Term Trend', weight: -6 }); }
  }

  const structure = classifyMarketStructure(prices);
  if (structure.structure === 'uptrend') { score += 10; factors.push({ text: `Market Structure: ${structure.detail}`, weight: 10 }); }
  else if (structure.structure === 'downtrend') { score -= 10; factors.push({ text: `Market Structure: ${structure.detail}`, weight: -10 }); }

  const div = detectDivergence(prices);
  if (div.type === 'bullish') { score += 9; factors.push({ text: `Bullish Divergence — ${div.detail}`, weight: 9 }); }
  else if (div.type === 'bearish') { score -= 9; factors.push({ text: `Bearish Divergence — ${div.detail}`, weight: -9 }); }

  const { support, resistance } = findSupportResistance(prices);
  if (support !== null && resistance !== null && latestPrice) {
    const range = resistance - support;
    if (range > 0) {
      const posInRange = (latestPrice - support) / range; // 0 = at support, 1 = at resistance
      if (posInRange > 0.9) { score -= 5; factors.push({ text: 'Resistance Nearby', weight: -5 }); }
      else if (posInRange < 0.1) { score += 5; factors.push({ text: 'Support Nearby', weight: 5 }); }
    }
  }

  const volRatio = volumes && volumes.length ? volumeSpikeRatio(volumes) : null;
  if (volRatio !== null && volRatio >= 2) {
    const roc = rateOfChange(prices.slice(-5));
    const bullishVolume = roc !== null && roc > 0;
    score += bullishVolume ? 7 : -7;
    factors.push({ text: `Strong Volume (${volRatio.toFixed(1)}x recent average)`, weight: bullishVolume ? 7 : -7 });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let bias, emoji;
  if (score >= 80) { bias = 'Very Bullish'; emoji = '🟢'; }
  else if (score >= 60) { bias = 'Bullish'; emoji = '🟢'; }
  else if (score >= 40) { bias = 'Neutral'; emoji = '🟡'; }
  else if (score >= 20) { bias = 'Bearish'; emoji = '🔴'; }
  else { bias = 'Very Bearish'; emoji = '🔴'; }

  // Confidence is about how much real data backs this, not how extreme the score looks — a
  // score of 95 built on 5 data points is a weak read, however dramatic the number seems.
  const confidence = prices.length >= 60 ? 'High' : prices.length >= 20 ? 'Medium' : 'Low';
  const hasNoRealSignal = factors.length === 0;

  return {
    score, bias, emoji, confidence,
    noClearSignal: hasNoRealSignal,
    factors: factors.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)),
    volatilityPct: volatility(prices),
    structure: structure.structure,
    support, resistance,
    divergence: div.type,
  };
}

// A plain-language read of the indicators — deliberately hedged, never a "buy"/"sell" instruction.
// Periods scale down when there isn't full history yet (e.g. right after the tracker starts, or
// for a symbol just added) so a real, honestly-labeled reading shows up within a couple of minutes
// instead of a wall of "—" for the ~9 minutes a full RSI(14)/MACD(12,26,9) needs to fill in.
export function summarizeSignal(prices, volumes) {
  const rsiPeriod = prices.length >= 15 ? 14 : Math.max(3, prices.length - 1);
  const r = prices.length >= 4 ? rsi(prices, rsiPeriod) : null;
  const m = macd(prices, Math.min(12, Math.floor(prices.length / 3) || 1), Math.min(26, Math.floor(prices.length * 0.7) || 2), Math.min(9, Math.floor(prices.length / 4) || 1));
  const smaShort = prices.length >= 20 ? sma(prices, 20) : sma(prices, Math.max(2, Math.floor(prices.length / 2)));
  const smaLong = prices.length >= 50 ? sma(prices, 50) : (prices.length >= 6 ? sma(prices, prices.length) : null);
  const notes = [];
  if (r !== null) {
    if (r >= 70) notes.push('RSI suggests the market may be overbought');
    else if (r <= 30) notes.push('RSI suggests the market may be oversold');
  }
  if (m) notes.push(m.histogram > 0 ? 'MACD histogram is positive (upward momentum)' : 'MACD histogram is negative (downward momentum)');
  if (smaShort !== null && smaLong !== null) notes.push(smaShort > smaLong ? 'Short-term average is above the long-term average' : 'Short-term average is below the long-term average');
  if (prices.length < 35) notes.push(`Still building up price history (${prices.length} data point${prices.length === 1 ? '' : 's'} so far) — indicators will sharpen over the next few minutes.`);
  const structure = classifyMarketStructure(prices);
  const div = detectDivergence(prices);
  const { support, resistance } = findSupportResistance(prices);
  const vol = volatility(prices);
  const engine = computeSignalScore(prices, volumes);
  return {
    rsi: r, macd: m, sma20: smaShort, sma50: smaLong, notes,
    structure: structure.structure, structureDetail: structure.detail,
    divergence: div.type, divergenceDetail: div.detail,
    support, resistance, volatilityPct: vol,
    engine,
  };
}

/* ---------------- Watchlist (Advanced: multiple named lists per user) ---------------- */
export function listWatchlistNames(tgId) {
  const rows = db.prepare('SELECT DISTINCT list_name FROM market_watchlist WHERE tg_id = ? ORDER BY list_name ASC').all(tgId);
  return rows.length ? rows.map(r => r.list_name) : ['Default'];
}
export function getWatchlist(tgId, listName = 'Default') {
  return db.prepare(`
    SELECT w.id, w.symbol, w.list_name, s.display_name
    FROM market_watchlist w JOIN market_symbols s ON s.symbol = w.symbol
    WHERE w.tg_id = ? AND w.list_name = ? ORDER BY w.created_at ASC
  `).all(tgId, listName);
}
export function getAllWatchlistEntries(tgId) {
  return db.prepare(`
    SELECT w.id, w.symbol, w.list_name, s.display_name
    FROM market_watchlist w JOIN market_symbols s ON s.symbol = w.symbol
    WHERE w.tg_id = ? ORDER BY w.list_name ASC, w.created_at ASC
  `).all(tgId);
}
export function addToWatchlist(tgId, symbol, listName = 'Default') {
  db.prepare('INSERT OR IGNORE INTO market_watchlist (tg_id, symbol, list_name) VALUES (?,?,?)').run(tgId, symbol, listName);
}
export function removeFromWatchlist(tgId, symbol, listName = 'Default') {
  db.prepare('DELETE FROM market_watchlist WHERE tg_id = ? AND symbol = ? AND list_name = ?').run(tgId, symbol, listName);
}
export function renameWatchlist(tgId, oldName, newName) {
  db.prepare('UPDATE market_watchlist SET list_name = ? WHERE tg_id = ? AND list_name = ?').run(newName, tgId, oldName);
}
export function deleteWatchlist(tgId, listName) {
  db.prepare('DELETE FROM market_watchlist WHERE tg_id = ? AND list_name = ?').run(tgId, listName);
}

/* ---------------- Smart Alerts: price, RSI, MACD histogram, or volume-spike ratio ---------------- */
export function listAlerts(tgId) {
  return db.prepare(`
    SELECT a.*, s.display_name FROM market_alerts a JOIN market_symbols s ON s.symbol = a.symbol
    WHERE a.tg_id = ? ORDER BY a.created_at DESC
  `).all(tgId);
}
export function createAlert(tgId, symbol, metric, direction, targetValue) {
  const MAX_ACTIVE_ALERTS = 20; // a sane per-user cap so this can't be used to spam the price-check loop
  const activeCount = db.prepare('SELECT COUNT(*) c FROM market_alerts WHERE tg_id = ? AND active = 1').get(tgId).c;
  if (activeCount >= MAX_ACTIVE_ALERTS) throw new Error(`You can have at most ${MAX_ACTIVE_ALERTS} active alerts`);
  return db.prepare('INSERT INTO market_alerts (tg_id, symbol, metric, direction, target_value) VALUES (?,?,?,?,?)')
    .run(tgId, symbol, metric, direction, targetValue).lastInsertRowid;
}
export function updateAlert(tgId, id, { direction, target_value, active }) {
  const sets = [], params = [];
  if (direction !== undefined) { sets.push('direction = ?'); params.push(direction); }
  if (target_value !== undefined) { sets.push('target_value = ?'); params.push(target_value); }
  if (active !== undefined) { sets.push('active = ?'); params.push(active ? 1 : 0); }
  if (!sets.length) return;
  params.push(tgId, id);
  db.prepare(`UPDATE market_alerts SET ${sets.join(', ')} WHERE tg_id = ? AND id = ?`).run(...params);
}
export function deleteAlert(tgId, id) {
  db.prepare('DELETE FROM market_alerts WHERE tg_id = ? AND id = ?').run(tgId, id);
}

// Checks every active alert against the latest known value for its metric+symbol and returns the
// ones that just triggered (marking them inactive so they only fire once) — called by the
// periodic job in server.js right after a fresh price fetch, so it always compares against
// current data. Non-price metrics (RSI/MACD histogram/volume ratio) are recomputed from the same
// recent-price/volume history the rest of the app uses — no separate code path, no separate truth.
export function checkTriggeredAlerts() {
  const active = db.prepare('SELECT * FROM market_alerts WHERE active = 1').all();
  const triggered = [];
  const currentValueCache = {};
  for (const a of active) {
    const cacheKey = a.symbol + ':' + a.metric;
    if (!(cacheKey in currentValueCache)) {
      if (a.metric === 'price') {
        currentValueCache[cacheKey] = getLatestTick(a.symbol)?.price_usd ?? null;
      } else if (a.metric === 'rsi') {
        const prices = getRecentPrices(a.symbol, 60);
        currentValueCache[cacheKey] = prices.length >= 4 ? rsi(prices, prices.length >= 15 ? 14 : Math.max(3, prices.length - 1)) : null;
      } else if (a.metric === 'macd_histogram') {
        const prices = getRecentPrices(a.symbol, 60);
        const m = macd(prices, Math.min(12, Math.floor(prices.length / 3) || 1), Math.min(26, Math.floor(prices.length * 0.7) || 2), Math.min(9, Math.floor(prices.length / 4) || 1));
        currentValueCache[cacheKey] = m ? m.histogram : null;
      } else if (a.metric === 'volume_spike') {
        currentValueCache[cacheKey] = volumeSpikeRatio(getRecentVolumes(a.symbol, 60));
      }
    }
    const value = currentValueCache[cacheKey];
    if (value === null || value === undefined) continue;
    const hit = a.direction === 'above' ? value >= a.target_value : value <= a.target_value;
    if (hit) {
      db.prepare(`UPDATE market_alerts SET active = 0, triggered_at = datetime('now') WHERE id = ?`).run(a.id);
      triggered.push({ ...a, currentValue: value });
    }
  }
  return triggered;
}

/* ---------------- Meme Radar ---------------- */
export function listMemeSymbols() {
  return db.prepare('SELECT * FROM market_symbols WHERE active = 1 AND is_meme = 1 ORDER BY sort_order ASC').all();
}

// A momentum score built only from real, already-recorded data: 24h change, volume-spike ratio,
// and short-term rate of change. Weighted simply and transparently — this is not a claim of a
// "true" meme-coin ranking algorithm, just an honest composite of the numbers this app already has.
export function computeMemeMomentumScore(symbol) {
  const tick = getLatestTick(symbol);
  const prices = getRecentPrices(symbol, 60);
  const volumes = getRecentVolumes(symbol, 60);
  if (!tick) return null;
  let score = 50;
  if (tick.change_24h_pct !== null) score += Math.max(-20, Math.min(20, tick.change_24h_pct));
  const volRatio = volumeSpikeRatio(volumes);
  if (volRatio !== null) score += Math.max(-15, Math.min(15, (volRatio - 1) * 10));
  const roc = rateOfChange(prices.slice(-10));
  if (roc !== null) score += Math.max(-15, Math.min(15, roc));
  return Math.max(0, Math.min(100, Math.round(score)));
}

/* ---------------- Market Scanner: filter every tracked symbol by a set of conditions ---------------- */
// Each condition is { metric: 'rsi'|'macd_histogram'|'change_24h'|'volume_ratio'|'sma_cross', op: 'lt'|'gt', value }.
// Conditions combine with AND or OR, matching the "combine multiple conditions" requirement.
// A short list of named presets covers the common screens (Oversold, Overbought, High Volume,
// Strong Momentum) so the frontend doesn't need to hand-build condition objects for those.
export const SCANNER_PRESETS = {
  oversold: [{ metric: 'rsi', op: 'lt', value: 30 }],
  overbought: [{ metric: 'rsi', op: 'gt', value: 70 }],
  high_volume: [{ metric: 'volume_ratio', op: 'gt', value: 2 }],
  strong_momentum: [{ metric: 'macd_histogram', op: 'gt', value: 0 }, { metric: 'change_24h', op: 'gt', value: 3 }],
};

function getScannerMetricValue(symbol, metric) {
  const tick = getLatestTick(symbol);
  if (!tick) return null;
  if (metric === 'change_24h') return tick.change_24h_pct;
  if (metric === 'market_cap') return tick.market_cap_usd;
  if (metric === 'volume_ratio') return volumeSpikeRatio(getRecentVolumes(symbol, 60));
  const prices = getRecentPrices(symbol, 60);
  if (metric === 'rsi') return prices.length >= 4 ? rsi(prices, prices.length >= 15 ? 14 : Math.max(3, prices.length - 1)) : null;
  if (metric === 'macd_histogram') {
    const m = macd(prices, Math.min(12, Math.floor(prices.length / 3) || 1), Math.min(26, Math.floor(prices.length * 0.7) || 2), Math.min(9, Math.floor(prices.length / 4) || 1));
    return m ? m.histogram : null;
  }
  if (metric === 'sma_cross') {
    const smaShort = prices.length >= 20 ? sma(prices, 20) : sma(prices, Math.max(2, Math.floor(prices.length / 2)));
    const smaLong = prices.length >= 50 ? sma(prices, 50) : (prices.length >= 6 ? sma(prices, prices.length) : null);
    return (smaShort !== null && smaLong !== null) ? smaShort - smaLong : null;
  }
  return null;
}

export function runMarketScanner(conditions, combinator = 'AND') {
  const symbols = listActiveSymbols();
  const results = [];
  for (const s of symbols) {
    const checks = conditions.map(c => {
      const value = getScannerMetricValue(s.symbol, c.metric);
      if (value === null || value === undefined) return false;
      return c.op === 'lt' ? value < c.value : value > c.value;
    });
    const passes = combinator === 'OR' ? checks.some(Boolean) : checks.every(Boolean);
    if (passes) {
      const tick = getLatestTick(s.symbol);
      results.push({ symbol: s.symbol, name: s.display_name, price_usd: tick?.price_usd ?? null, change_24h_pct: tick?.change_24h_pct ?? null });
    }
  }
  return results;
}

/* ---------------- Unusual Volume Detector & Momentum Ranking ---------------- */
export function findUnusualVolume(minRatio = 2) {
  return listActiveSymbols()
    .map(s => ({ symbol: s.symbol, name: s.display_name, ratio: volumeSpikeRatio(getRecentVolumes(s.symbol, 60)) }))
    .filter(r => r.ratio !== null && r.ratio >= minRatio)
    .sort((a, b) => b.ratio - a.ratio);
}

export function rankMarketMomentum() {
  return listActiveSymbols()
    .map(s => {
      const prices = getRecentPrices(s.symbol, 60);
      const volumes = getRecentVolumes(s.symbol, 60);
      const tick = getLatestTick(s.symbol);
      const volRatio = volumeSpikeRatio(volumes) || 1;
      const roc = rateOfChange(prices) || 0;
      const change24h = tick?.change_24h_pct || 0;
      // Simple, transparent composite: recent rate-of-change + 24h change + a volume-spike bonus.
      const momentumScore = roc + change24h + (volRatio - 1) * 10;
      return { symbol: s.symbol, name: s.display_name, momentumScore: Math.round(momentumScore * 100) / 100, change_24h_pct: tick?.change_24h_pct ?? null, price_usd: tick?.price_usd ?? null };
    })
    .sort((a, b) => b.momentumScore - a.momentumScore);
}

/* ---------------- Strategy Backtester ---------------- */
// Replays a simple RSI or MACD-crossover strategy over the price history this app has actually
// recorded (not synthetic candles) and reports how it would have performed. Honest limitation:
// since this app only stores a rolling window of ticks (pruneOldCandles keeps ~300 per symbol),
// backtests are bounded by however much real history has accumulated since tracking started —
// this is not a multi-year backtest, it's a real one over the data actually on hand.
export function backtestStrategy(symbol, strategy = 'rsi', params = {}) {
  const prices = getRecentPrices(symbol, 300);
  if (prices.length < 20) return { error: 'Not enough recorded history yet for a meaningful backtest.' };
  const rsiBuyBelow = params.rsiBuyBelow ?? 30, rsiSellAbove = params.rsiSellAbove ?? 70;
  const trades = [];
  let position = null; // { entryPrice, entryIndex }
  const minWindow = strategy === 'macd' ? 35 : 15;
  for (let i = minWindow; i < prices.length; i++) {
    const window = prices.slice(0, i + 1);
    let buySignal = false, sellSignal = false;
    if (strategy === 'rsi') {
      const r = rsi(window, 14);
      if (r !== null) { buySignal = r < rsiBuyBelow; sellSignal = r > rsiSellAbove; }
    } else if (strategy === 'macd') {
      const m = macd(window);
      const mPrev = macd(window.slice(0, -1));
      if (m && mPrev) { buySignal = mPrev.histogram <= 0 && m.histogram > 0; sellSignal = mPrev.histogram >= 0 && m.histogram < 0; }
    }
    if (!position && buySignal) position = { entryPrice: prices[i], entryIndex: i };
    else if (position && sellSignal) {
      const exitPrice = prices[i];
      trades.push({ entryPrice: position.entryPrice, exitPrice, pnlPct: ((exitPrice - position.entryPrice) / position.entryPrice) * 100 });
      position = null;
    }
  }
  if (!trades.length) return { symbol, strategy, totalTrades: 0, winRate: null, totalPnlPct: 0, maxDrawdownPct: 0, bestTrade: null, worstTrade: null, trades: [] };
  const wins = trades.filter(t => t.pnlPct > 0);
  const totalPnlPct = trades.reduce((a, t) => a + t.pnlPct, 0);
  // Equity curve as a running product of (1 + pnl%) per trade, then max drawdown off that curve.
  let equity = 100, peak = 100, maxDrawdown = 0;
  const equityCurve = [equity];
  for (const t of trades) {
    equity *= (1 + t.pnlPct / 100);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);
    equityCurve.push(Math.round(equity * 100) / 100);
  }
  const best = trades.reduce((a, b) => (b.pnlPct > a.pnlPct ? b : a));
  const worst = trades.reduce((a, b) => (b.pnlPct < a.pnlPct ? b : a));
  return {
    symbol, strategy, totalTrades: trades.length,
    winRate: Math.round((wins.length / trades.length) * 1000) / 10,
    totalPnlPct: Math.round(totalPnlPct * 100) / 100,
    maxDrawdownPct: Math.round(maxDrawdown * 100) / 100,
    bestTrade: best, worstTrade: worst,
    equityCurve, trades,
  };
}

export default db;
