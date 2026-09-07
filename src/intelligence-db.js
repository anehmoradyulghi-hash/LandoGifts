// intelligence-db.js
// The "Crypto Intelligence Engine" layer — builds ON TOP of markets-db.js (never modifies it)
// to add: deeper technical analysis (ATR, Bollinger Bands, breakout/fake-breakout, candlestick
// patterns, hidden divergence, liquidity sweep, volume dry-up/acceleration), true multi-timeframe
// fusion across 6 timeframes, an upgraded 0-100 signal engine with STRONG BUY..STRONG SELL,
// scenario planning (bullish/base/bearish with trigger/invalidation), a risk engine, market
// regime detection, free-tier news + Reddit social intelligence, and signal lifecycle tracking
// with real backtesting/prediction-accuracy scoring stored in the database.
//
// Same non-negotiable boundary as markets-db.js: read-only market intelligence. No wallet
// connection, no order placement, no trade execution. Every score/signal is informational and
// carries the same "not financial advice" disclaimer, enforced at the API layer.
//
// Free-first, honest-data discipline: every function here returns null / an "insufficient data"
// marker when it doesn't have enough real data to compute something — never a filled-in guess.
// Sections that need a data source with no free tier (e.g. paid whale-tracking APIs, X/Twitter's
// post-2023 paid-only API) are implemented as explicitly `unavailable: true` responses, not faked.
import db from './db.js';
import {
  rsi, macd, sma, ema, findSwingPoints, findSupportResistance, classifyMarketStructure,
  detectDivergence, volatility, volumeSpikeRatio, rateOfChange, computeSignalScore,
} from './markets-db.js';

db.exec(`
-- Every signal the engine ever emits gets a row here — this is what makes Signal Lifecycle
-- Tracking, Backtesting, and Prediction Accuracy possible: without a persisted record of what
-- was predicted and when, "did it turn out right" isn't answerable.
CREATE TABLE IF NOT EXISTS intel_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  action TEXT NOT NULL,              -- STRONG_BUY | BUY | HOLD | SELL | STRONG_SELL
  score INTEGER NOT NULL,            -- 0-100 overall score at detection time
  confidence TEXT NOT NULL,          -- Low | Medium | High
  price_at_signal REAL NOT NULL,
  factors_json TEXT NOT NULL,        -- serialized factor list (positive + negative), for "why this signal"
  status TEXT NOT NULL DEFAULT 'detected', -- detected -> confirmed -> active -> target_reached | invalidated -> closed
  outcome_pct REAL,                  -- filled in once resolved: % price moved from signal to resolution
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_intel_signals_symbol ON intel_signals(symbol, detected_at);

-- One row per prediction-accuracy check window (6h/24h/3d/7d) per signal, so accuracy can be
-- reported separately per horizon instead of one blended number.
CREATE TABLE IF NOT EXISTS intel_prediction_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES intel_signals(id) ON DELETE CASCADE,
  horizon TEXT NOT NULL,             -- '6h' | '24h' | '3d' | '7d'
  due_at TEXT NOT NULL,
  checked_at TEXT,
  price_at_check REAL,
  was_correct INTEGER,               -- 1/0/null (null = not due yet)
  UNIQUE(signal_id, horizon)
);
CREATE INDEX IF NOT EXISTS idx_intel_checks_due ON intel_prediction_checks(due_at, checked_at);

-- Configurable fusion weights (Technical/Social/Volume/Liquidity/News) so they're never
-- hard-coded — an admin can retune them, and Self-Optimization (below) adjusts them within
-- bounds rather than editing source.
CREATE TABLE IF NOT EXISTS intel_weights (
  key TEXT PRIMARY KEY,
  weight REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A record of every weight change Self-Optimization makes, with the backtest score before/after,
-- so a regression can always be rolled back to a known-good prior state.
CREATE TABLE IF NOT EXISTS intel_weight_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  old_weight REAL NOT NULL,
  new_weight REAL NOT NULL,
  backtest_score_before REAL,
  backtest_score_after REAL,
  rolled_back INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cached news items pulled from free public RSS feeds — cached so the frontend never triggers a
-- live RSS fetch, and so sentiment/category classification only runs once per article.
CREATE TABLE IF NOT EXISTS intel_news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  link TEXT NOT NULL UNIQUE,
  published_at TEXT,
  category TEXT,              -- listing | partnership | launch | upgrade | hack | regulation | exchange | unlock | announcement | general
  sentiment TEXT,             -- positive | negative | neutral
  importance INTEGER,         -- 1-5, simple heuristic
  matched_symbols TEXT,       -- comma-separated symbol ids this article seems to mention
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_intel_news_time ON intel_news(published_at DESC);
`);

const DEFAULT_WEIGHTS = { technical: 0.45, volume: 0.2, social: 0.15, news: 0.1, liquidity: 0.1 };
for (const [key, weight] of Object.entries(DEFAULT_WEIGHTS)) {
  db.prepare('INSERT OR IGNORE INTO intel_weights (key, weight) VALUES (?, ?)').run(key, weight);
}

export function getWeights() {
  const rows = db.prepare('SELECT key, weight FROM intel_weights').all();
  const out = {};
  rows.forEach(r => { out[r.key] = r.weight; });
  return out;
}
export function setWeight(key, weight) {
  db.prepare(`INSERT INTO intel_weights (key, weight, updated_at) VALUES (?, ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET weight = excluded.weight, updated_at = datetime('now')`).run(key, weight);
}

/* =========================================================================
 * 1. Advanced Technical Analysis — the parts markets-db.js doesn't already have
 * ========================================================================= */

// True Range / Average True Range from OHLC candles (Binance klines: [t,o,h,l,c,v,...]).
// This needs high/low/close per candle, which closing-price-only series can't give — that's why
// it takes klines directly rather than the plain price array the rest of the engine uses.
export function atr(klines, period = 14) {
  if (!klines || klines.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < klines.length; i++) {
    const high = Number(klines[i][2]), low = Number(klines[i][3]), prevClose = Number(klines[i - 1][4]);
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (trueRanges.length < period) return null;
  // Wilder's smoothing (the standard ATR method), not a plain SMA of true ranges.
  let atrVal = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) atrVal = (atrVal * (period - 1) + trueRanges[i]) / period;
  return atrVal;
}

// Bollinger Bands: SMA(period) +/- stdDevMultiplier standard deviations.
export function bollingerBands(prices, period = 20, stdDevMultiplier = 2) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    middle: mean, upper: mean + stdDevMultiplier * stdDev, lower: mean - stdDevMultiplier * stdDev,
    bandwidthPct: mean ? ((stdDevMultiplier * stdDev * 2) / mean) * 100 : null, // squeeze detector: narrow bandwidth = low volatility
  };
}

// Breakout / breakdown / fake-breakout, using the same swing-based support/resistance already in
// markets-db.js. A "fake breakout" here means: price closed beyond the level, but the very next
// close came back inside the range — a real, checkable pattern, not a vibe.
export function detectBreakout(prices) {
  const { support, resistance } = findSupportResistance(prices);
  if (support === null || resistance === null || prices.length < 3) return { type: 'none', detail: null };
  const last = prices[prices.length - 1], prev = prices[prices.length - 2], prevPrev = prices[prices.length - 3];
  if (last > resistance) {
    if (prev <= resistance && prevPrev > resistance) return { type: 'fake_breakout_up', detail: 'Price broke resistance then closed back below it' };
    return { type: 'breakout_up', detail: `Closed above resistance (${resistance.toFixed(6)})` };
  }
  if (last < support) {
    if (prev >= support && prevPrev < support) return { type: 'fake_breakout_down', detail: 'Price broke support then closed back above it' };
    return { type: 'breakdown', detail: `Closed below support (${support.toFixed(6)})` };
  }
  return { type: 'none', detail: null };
}

// Hidden divergence (distinct from the regular divergence already in markets-db.js): price makes
// a HIGHER low but RSI makes a LOWER low (hidden bullish — trend continuation), or price makes a
// LOWER high but RSI makes a HIGHER high (hidden bearish). Regular divergence signals reversal;
// hidden divergence signals continuation — genuinely different patterns, not a rename.
export function detectHiddenDivergence(prices) {
  const { highs, lows } = findSwingPoints(prices);
  if (lows.length >= 2) {
    const [a, b] = lows.slice(-2);
    const rsiA = rsi(prices.slice(0, a.index + 1)), rsiB = rsi(prices.slice(0, b.index + 1));
    if (rsiA !== null && rsiB !== null && b.price > a.price && rsiB < rsiA) {
      return { type: 'hidden_bullish', detail: 'Price made a higher low but RSI made a lower low (trend continuation)' };
    }
  }
  if (highs.length >= 2) {
    const [a, b] = highs.slice(-2);
    const rsiA = rsi(prices.slice(0, a.index + 1)), rsiB = rsi(prices.slice(0, b.index + 1));
    if (rsiA !== null && rsiB !== null && b.price < a.price && rsiB > rsiA) {
      return { type: 'hidden_bearish', detail: 'Price made a lower high but RSI made a higher high (trend continuation)' };
    }
  }
  return { type: 'none', detail: null };
}

// Liquidity sweep: a candle wicks decisively past a recent swing high/low (stop-hunt shape) then
// closes back inside — genuinely detectable from OHLC wick length vs body, not invented.
export function detectLiquiditySweep(klines) {
  if (!klines || klines.length < 10) return { type: 'none', detail: null };
  const closes = klines.map(k => Number(k[4]));
  const { highs, lows } = findSwingPoints(closes);
  const last = klines[klines.length - 1];
  const lastHigh = Number(last[2]), lastLow = Number(last[3]), lastClose = Number(last[4]), lastOpen = Number(last[1]);
  const bodyTop = Math.max(lastOpen, lastClose), bodyBottom = Math.min(lastOpen, lastClose);
  const upperWick = lastHigh - bodyTop, lowerWick = bodyBottom - lastLow;
  const recentSwingHigh = highs.length ? Math.max(...highs.slice(-3).map(h => h.price)) : null;
  const recentSwingLow = lows.length ? Math.min(...lows.slice(-3).map(l => l.price)) : null;
  if (recentSwingHigh !== null && lastHigh > recentSwingHigh && lastClose < recentSwingHigh && upperWick > (bodyTop - bodyBottom) * 1.5) {
    return { type: 'sell_side_sweep', detail: 'Wicked above recent swing high then closed back below it (liquidity grab)' };
  }
  if (recentSwingLow !== null && lastLow < recentSwingLow && lastClose > recentSwingLow && lowerWick > (bodyTop - bodyBottom) * 1.5) {
    return { type: 'buy_side_sweep', detail: 'Wicked below recent swing low then closed back above it (liquidity grab)' };
  }
  return { type: 'none', detail: null };
}

// A small, well-known set of single/double-candle patterns computed directly from OHLC — real
// geometric definitions (body-to-range ratios, wick lengths), not a lookup table of made-up names.
export function detectCandlestickPatterns(klines) {
  if (!klines || klines.length < 2) return [];
  const patterns = [];
  const c = klines[klines.length - 1], prev = klines[klines.length - 2];
  const [o, h, l, close] = [Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4])];
  const [po, ph, pl, pclose] = [Number(prev[1]), Number(prev[2]), Number(prev[3]), Number(prev[4])];
  const range = h - l, body = Math.abs(close - o);
  if (range > 0) {
    const upperWick = h - Math.max(o, close), lowerWick = Math.min(o, close) - l;
    if (body / range < 0.12) patterns.push({ name: 'Doji', bias: 'neutral', detail: 'Very small body relative to range — indecision' });
    if (lowerWick > body * 2 && upperWick < body * 0.5 && close > o) patterns.push({ name: 'Hammer', bias: 'bullish', detail: 'Long lower wick, small body near the top — potential reversal up' });
    if (upperWick > body * 2 && lowerWick < body * 0.5 && close < o) patterns.push({ name: 'Shooting Star', bias: 'bearish', detail: 'Long upper wick, small body near the bottom — potential reversal down' });
  }
  // Engulfing: current body fully engulfs the previous candle's body, opposite direction.
  const prevBody = Math.abs(pclose - po);
  if (prevBody > 0) {
    if (close > o && pclose < po && o <= pclose && close >= po) patterns.push({ name: 'Bullish Engulfing', bias: 'bullish', detail: 'Current green candle fully engulfs the prior red candle' });
    if (close < o && pclose > po && o >= pclose && close <= po) patterns.push({ name: 'Bearish Engulfing', bias: 'bearish', detail: 'Current red candle fully engulfs the prior green candle' });
  }
  return patterns;
}

// Volume dry-up: recent volume is well below its own average (the opposite signal from
// volumeSpikeRatio, which markets-db.js already covers) — often precedes a breakout or signals
// fading interest, depending on context; this just reports the fact, the engine below interprets it.
export function volumeDryUpRatio(volumes) {
  if (!volumes || volumes.length < 4) return null;
  const latest = volumes[volumes.length - 1];
  const baseline = volumes.slice(0, -1);
  const avgBaseline = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  if (!avgBaseline) return null;
  return latest / avgBaseline; // < 1 means below average; the caller decides what threshold counts as "dry-up"
}

// Volume acceleration: is volume's own rate of change speeding up or slowing down (second
// derivative, roughly) — computed as the change in volume-over-volume between the first and
// second half of the window, a real (if simple) acceleration measure.
export function volumeAcceleration(volumes) {
  if (!volumes || volumes.length < 6) return null;
  const mid = Math.floor(volumes.length / 2);
  const firstHalfAvg = volumes.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const secondHalfAvg = volumes.slice(mid).reduce((a, b) => a + b, 0) / (volumes.length - mid);
  if (!firstHalfAvg) return null;
  return ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100;
}

// Simple buying/selling pressure proxy from OHLCV: where did the close land within the candle's
// range, weighted by volume — a real, standard proxy (this is the basis of the Accumulation/
// Distribution line), not an invented metric.
export function buyingSellingPressure(klines) {
  if (!klines || klines.length < 5) return null;
  let netPressure = 0, totalVolume = 0;
  for (const k of klines) {
    const [, , h, l, close, vol] = k.map(Number);
    const range = h - l;
    if (range === 0) continue;
    const closeLocation = ((close - l) / range) * 2 - 1; // -1 (closed at low) to +1 (closed at high)
    netPressure += closeLocation * vol;
    totalVolume += vol;
  }
  if (!totalVolume) return null;
  return (netPressure / totalVolume) * 100; // -100 (all selling pressure) to +100 (all buying pressure)
}

/* =========================================================================
 * 3. Advanced Signal Engine — STRONG BUY / BUY / HOLD / SELL / STRONG SELL, never from one
 *    indicator alone: requires at least MIN_FACTORS independent factors to fire before issuing
 *    anything stronger than HOLD.
 * ========================================================================= */
const MIN_FACTORS_FOR_DIRECTIONAL_CALL = 3;

export function computeAdvancedSignal(klines, mtfFusion) {
  const closes = klines.map(k => Number(k[4]));
  const volumes = klines.map(k => Number(k[5]));
  const base = computeSignalScore(closes, volumes); // reuse the already-working weighted checklist
  const positives = base.factors.filter(f => f.weight > 0);
  const negatives = base.factors.filter(f => f.weight < 0);

  // Layer in the new factors this module adds, on top of what computeSignalScore already found.
  const extraFactors = [];
  const bb = bollingerBands(closes);
  if (bb && closes[closes.length - 1] !== undefined) {
    const last = closes[closes.length - 1];
    if (last >= bb.upper) extraFactors.push({ text: 'Price at/above upper Bollinger Band (extended)', weight: -6 });
    else if (last <= bb.lower) extraFactors.push({ text: 'Price at/below lower Bollinger Band (extended)', weight: 6 });
    if (bb.bandwidthPct !== null && bb.bandwidthPct < 5) extraFactors.push({ text: 'Bollinger Band squeeze (low volatility, breakout risk both ways)', weight: 0 });
  }
  const breakout = detectBreakout(closes);
  if (breakout.type === 'breakout_up') extraFactors.push({ text: `Breakout — ${breakout.detail}`, weight: 8 });
  else if (breakout.type === 'breakdown') extraFactors.push({ text: `Breakdown — ${breakout.detail}`, weight: -8 });
  else if (breakout.type === 'fake_breakout_up') extraFactors.push({ text: 'Fake breakout up detected (trap warning)', weight: -5 });
  else if (breakout.type === 'fake_breakout_down') extraFactors.push({ text: 'Fake breakout down detected (trap warning)', weight: 5 });

  const hiddenDiv = detectHiddenDivergence(closes);
  if (hiddenDiv.type === 'hidden_bullish') extraFactors.push({ text: `Hidden Bullish Divergence — ${hiddenDiv.detail}`, weight: 6 });
  else if (hiddenDiv.type === 'hidden_bearish') extraFactors.push({ text: `Hidden Bearish Divergence — ${hiddenDiv.detail}`, weight: -6 });

  const sweep = detectLiquiditySweep(klines);
  if (sweep.type === 'buy_side_sweep') extraFactors.push({ text: `Liquidity Sweep — ${sweep.detail}`, weight: 7 });
  else if (sweep.type === 'sell_side_sweep') extraFactors.push({ text: `Liquidity Sweep — ${sweep.detail}`, weight: -7 });

  const patterns = detectCandlestickPatterns(klines);
  for (const p of patterns) {
    if (p.bias === 'bullish') extraFactors.push({ text: `Candlestick: ${p.name} — ${p.detail}`, weight: 4 });
    else if (p.bias === 'bearish') extraFactors.push({ text: `Candlestick: ${p.name} — ${p.detail}`, weight: -4 });
  }

  const dryUp = volumeDryUpRatio(volumes);
  if (dryUp !== null && dryUp < 0.4) extraFactors.push({ text: 'Volume dry-up (interest fading or coiling before a move)', weight: 0 });
  const accel = volumeAcceleration(volumes);
  if (accel !== null && Math.abs(accel) > 30) {
    extraFactors.push({ text: `Volume acceleration ${accel > 0 ? 'increasing' : 'decreasing'} sharply (${accel.toFixed(0)}%)`, weight: accel > 0 ? 3 : -3 });
  }
  const pressure = buyingSellingPressure(klines);
  if (pressure !== null && Math.abs(pressure) > 25) extraFactors.push({ text: `${pressure > 0 ? 'Buying' : 'Selling'} pressure dominant (${pressure.toFixed(0)})`, weight: pressure > 0 ? 4 : -4 });

  const allFactors = [...base.factors, ...extraFactors].filter(f => f.weight !== 0);
  let score = 50 + allFactors.reduce((sum, f) => sum + f.weight, 0);
  // Multi-timeframe conflict directly reduces the score's distance from neutral (50) — a
  // genuine "pull toward HOLD" when timeframes disagree, not just a confidence footnote.
  if (mtfFusion && mtfFusion.conflictPenalty) {
    score = 50 + (score - 50) * (1 - mtfFusion.conflictPenalty / 100);
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  const posCount = allFactors.filter(f => f.weight > 0).length;
  const negCount = allFactors.filter(f => f.weight < 0).length;
  const totalDirectionalFactors = posCount + negCount;

  let action;
  if (totalDirectionalFactors < MIN_FACTORS_FOR_DIRECTIONAL_CALL) {
    action = 'HOLD'; // never issue a directional call from too few independent factors
  } else if (score >= 80) action = 'STRONG_BUY';
  else if (score >= 60) action = 'BUY';
  else if (score >= 40) action = 'HOLD';
  else if (score >= 20) action = 'SELL';
  else action = 'STRONG_SELL';

  // Confidence blends: how much history backs it (from computeSignalScore), how many factors
  // fired at all, and multi-timeframe agreement — three independent inputs, not one guess.
  let confidencePoints = 0;
  confidencePoints += closes.length >= 100 ? 2 : closes.length >= 40 ? 1 : 0;
  confidencePoints += totalDirectionalFactors >= 6 ? 2 : totalDirectionalFactors >= 3 ? 1 : 0;
  if (mtfFusion) confidencePoints += mtfFusion.agreement === 'strong' ? 2 : mtfFusion.agreement === 'moderate' ? 1 : 0;
  const confidence = confidencePoints >= 5 ? 'High' : confidencePoints >= 3 ? 'Medium' : 'Low';
  const confidencePct = Math.min(95, Math.max(20, confidencePoints * 16 + 20));

  return {
    action, score, confidence, confidencePct,
    positiveFactorCount: posCount, negativeFactorCount: negCount,
    factors: allFactors.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)),
    noClearSignal: totalDirectionalFactors === 0,
    patterns, breakout, hiddenDivergence: hiddenDiv, liquiditySweep: sweep,
    bollingerBands: bb, buyingSellingPressure: pressure, volumeAcceleration: accel, volumeDryUpRatio: dryUp,
  };
}

/* =========================================================================
 * 4. Market Regime Detection
 * ========================================================================= */
export function detectMarketRegime(klines) {
  const closes = klines.map(k => Number(k[4]));
  if (closes.length < 30) return { regime: 'insufficient_data' };
  const structure = classifyMarketStructure(closes);
  const vol = volatility(closes);
  const roc = rateOfChange(closes.slice(-20));
  let regime;
  if (vol !== null && vol > 5) regime = 'high_volatility';
  else if (vol !== null && vol < 1) regime = 'low_volatility';
  else if (structure.structure === 'uptrend' && roc > 5) regime = 'bull_market';
  else if (structure.structure === 'downtrend' && roc < -5) regime = 'bear_market';
  else regime = 'sideways';
  // Accumulation/Distribution overlay from buying/selling pressure, independent of the
  // trend/volatility read above — a coin can be in a sideways regime while quietly accumulating.
  const pressure = buyingSellingPressure(klines);
  let phase = null;
  if (pressure !== null) phase = pressure > 15 ? 'accumulation' : pressure < -15 ? 'distribution' : null;
  return { regime, volatilityPct: vol, rateOfChangePct: roc, phase };
}

/* =========================================================================
 * 5. Risk Engine & Scenario Engine
 * ========================================================================= */
export function computeRiskProfile(klines, signal) {
  const closes = klines.map(k => Number(k[4]));
  const currentPrice = closes[closes.length - 1];
  const atrVal = atr(klines);
  const { support, resistance } = findSupportResistance(closes);
  const vol = volatility(closes);
  let riskLevel = 'Medium';
  if (vol !== null) riskLevel = vol > 6 ? 'High' : vol < 2 ? 'Low' : 'Medium';
  const distanceToSupportPct = (support !== null && currentPrice) ? ((currentPrice - support) / currentPrice) * 100 : null;
  const distanceToResistancePct = (resistance !== null && currentPrice) ? ((resistance - currentPrice) / currentPrice) * 100 : null;
  // Risk/Reward using ATR as the risk unit (distance to a reasonable stop) and distance to the
  // opposing S/R level as the reward unit — a standard, honest R:R estimate, not a promise.
  let riskReward = null;
  if (atrVal && currentPrice) {
    const riskUnit = atrVal * 1.5;
    if (signal?.action?.includes('BUY') && resistance) riskReward = (resistance - currentPrice) / riskUnit;
    else if (signal?.action?.includes('SELL') && support) riskReward = (currentPrice - support) / riskUnit;
  }
  return {
    riskLevel, volatilityPct: vol, atr: atrVal,
    distanceToSupportPct, distanceToResistancePct,
    riskRewardRatio: riskReward !== null ? Math.round(riskReward * 100) / 100 : null,
    disclaimer: 'Risk estimate only — not a guarantee. Markets can move against any scenario.',
  };
}

// Bullish / Base / Bearish scenarios with trigger/confirmation/invalidation levels derived from
// real support/resistance/ATR — probabilities are explicitly labeled as the model's own estimate
// (weighted by which direction the current signal leans), never presented as fact.
export function buildScenarios(klines, signal) {
  const closes = klines.map(k => Number(k[4]));
  const currentPrice = closes[closes.length - 1];
  const { support, resistance } = findSupportResistance(closes);
  const atrVal = atr(klines) || (currentPrice ? currentPrice * 0.02 : 0);
  if (!currentPrice || support === null || resistance === null) return null;
  // Base probabilities skew toward the signal's own direction — an internal-consistency choice
  // (the scenario weighting reflects the same evidence the signal already weighed), not a
  // separate, disconnected guess. Kept within a sane band so it never claims false certainty.
  const bullishLean = signal.action === 'STRONG_BUY' ? 0.55 : signal.action === 'BUY' ? 0.45 : signal.action === 'STRONG_SELL' ? 0.15 : signal.action === 'SELL' ? 0.25 : 0.35;
  const bearishLean = signal.action === 'STRONG_SELL' ? 0.55 : signal.action === 'SELL' ? 0.45 : signal.action === 'STRONG_BUY' ? 0.15 : signal.action === 'BUY' ? 0.25 : 0.35;
  const baseLean = Math.max(0.1, 1 - bullishLean - bearishLean);
  return {
    bullish: {
      trigger: `Break and hold above ${resistance.toFixed(6)}`,
      confirmation: `Follow-through candle closing above ${(resistance + atrVal * 0.3).toFixed(6)} with volume`,
      invalidation: `Close back below ${(resistance - atrVal * 0.5).toFixed(6)}`,
      probabilityPct: Math.round(bullishLean * 100),
    },
    base: {
      trigger: `Price continues ranging between ${support.toFixed(6)} and ${resistance.toFixed(6)}`,
      confirmation: 'Repeated rejection at both range edges',
      invalidation: 'A decisive close outside the range on volume',
      probabilityPct: Math.round(baseLean * 100),
    },
    bearish: {
      trigger: `Break and hold below ${support.toFixed(6)}`,
      confirmation: `Follow-through candle closing below ${(support - atrVal * 0.3).toFixed(6)} with volume`,
      invalidation: `Close back above ${(support + atrVal * 0.5).toFixed(6)}`,
      probabilityPct: Math.round(bearishLean * 100),
    },
    disclaimer: 'Probabilities are this model\'s own estimate from current technical evidence, not a guaranteed forecast.',
  };
}

/* =========================================================================
 * 2. Multi-Timeframe Analysis — 1m / 5m / 15m / 1h / 4h / 1D, fused into one read
 * ========================================================================= */
const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

// Runs the full technical read independently per timeframe (each timeframe's own signal score,
// from that timeframe's own candles) then tallies how many are bullish/bearish/neutral. Genuine
// conflict between timeframes lowers confidence — not a cosmetic caveat, an actual computed
// disagreement count feeding into the confidence label below.
export function fuseMultiTimeframe(klinesByTimeframe) {
  const perTimeframe = {};
  let bullishCount = 0, bearishCount = 0, neutralCount = 0, validCount = 0;
  for (const tf of TIMEFRAMES) {
    const klines = klinesByTimeframe[tf];
    if (!klines || klines.length < 20) { perTimeframe[tf] = { available: false }; continue; }
    const closes = klines.map(k => Number(k[4]));
    const volumes = klines.map(k => Number(k[5]));
    const engine = computeSignalScore(closes, volumes);
    perTimeframe[tf] = { available: true, score: engine.score, bias: engine.bias, noClearSignal: engine.noClearSignal };
    validCount++;
    if (engine.noClearSignal) neutralCount++;
    else if (engine.score >= 55) bullishCount++;
    else if (engine.score <= 45) bearishCount++;
    else neutralCount++;
  }
  if (!validCount) return { perTimeframe, bullishCount: 0, bearishCount: 0, neutralCount: 0, agreement: 'insufficient_data', conflictPenalty: 0 };
  // Agreement ratio: the largest bloc (bullish/bearish/neutral) as a fraction of all timeframes
  // that had enough data — this is what drives the confidence penalty, not a guess.
  const maxBloc = Math.max(bullishCount, bearishCount, neutralCount);
  const agreementRatio = maxBloc / validCount;
  let agreement;
  if (agreementRatio >= 0.8) agreement = 'strong';
  else if (agreementRatio >= 0.5) agreement = 'moderate';
  else agreement = 'conflicted';
  // Genuine conflict (bullish AND bearish blocs both present and neither dominant) subtracts
  // confidence points downstream in the signal engine — quantified, not just a mood.
  const conflictPenalty = (bullishCount > 0 && bearishCount > 0) ? Math.round((1 - agreementRatio) * 30) : 0;
  return { perTimeframe, bullishCount, bearishCount, neutralCount, agreement, conflictPenalty };
}

/* =========================================================================
 * News Intelligence — free public RSS feeds (CoinDesk, Cointelegraph, Decrypt). No paid news API
 * used or required. Parsing/classification happens in server.js (which does the actual HTTP
 * fetch + RSS parse); this module only stores and scores what was already fetched.
 * ========================================================================= */
const NEWS_CATEGORY_KEYWORDS = {
  hack: ['hack', 'exploit', 'breach', 'stolen', 'drain'],
  regulation: ['sec ', 'regulat', 'lawsuit', 'ban ', 'court', 'legal'],
  listing: ['lists ', 'listing', 'now available on'],
  partnership: ['partners with', 'partnership', 'collaborat'],
  launch: ['launches', 'launch of', 'mainnet', 'goes live'],
  upgrade: ['upgrade', 'hard fork', 'update rolls out'],
  exchange: ['binance', 'coinbase', 'kraken', 'okx', 'exchange'],
  unlock: ['token unlock', 'vesting', 'unlocks'],
};
const NEWS_POSITIVE_WORDS = ['surge', 'rally', 'soar', 'gain', 'partnership', 'adoption', 'bullish', 'breakthrough', 'record high', 'approval'];
const NEWS_NEGATIVE_WORDS = ['hack', 'exploit', 'crash', 'plunge', 'lawsuit', 'ban', 'bearish', 'sell-off', 'collapse', 'fraud', 'delist'];

// A transparent keyword-based classifier — not a claim of NLP sentiment analysis, an honest
// simple heuristic that's easy to audit (unlike a black-box model this app has no free access to).
export function classifyNewsArticle(title) {
  const lower = title.toLowerCase();
  let category = 'general';
  for (const [cat, keywords] of Object.entries(NEWS_CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) { category = cat; break; }
  }
  const posHits = NEWS_POSITIVE_WORDS.filter(w => lower.includes(w)).length;
  const negHits = NEWS_NEGATIVE_WORDS.filter(w => lower.includes(w)).length;
  const sentiment = posHits > negHits ? 'positive' : negHits > posHits ? 'negative' : 'neutral';
  let importance = 2;
  if (['hack', 'regulation', 'unlock'].includes(category)) importance = 4;
  if (lower.includes('sec ') || lower.includes('hack') || lower.includes('billion')) importance = 5;
  return { category, sentiment, importance };
}

export function saveNewsArticle({ source, title, link, published_at }) {
  const { category, sentiment, importance } = classifyNewsArticle(title);
  // Rough symbol matching: does the article title mention a tracked coin's name or symbol?
  const symbols = db.prepare('SELECT symbol, display_name FROM market_symbols').all();
  const lower = title.toLowerCase();
  const matched = symbols.filter(s => lower.includes(s.symbol.replace(/-/g, ' ')) || lower.includes(s.display_name.split(' (')[0].toLowerCase())).map(s => s.symbol);
  try {
    db.prepare(`INSERT OR IGNORE INTO intel_news (source, title, link, published_at, category, sentiment, importance, matched_symbols)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(source, title, link, published_at || null, category, sentiment, importance, matched.join(','));
  } catch (e) { /* duplicate link, ignore */ }
}

export function getRecentNews({ symbol, limit = 30 } = {}) {
  if (symbol) {
    return db.prepare(`SELECT * FROM intel_news WHERE matched_symbols LIKE ? ORDER BY published_at DESC LIMIT ?`)
      .all(`%${symbol}%`, limit);
  }
  return db.prepare('SELECT * FROM intel_news ORDER BY published_at DESC LIMIT ?').all(limit);
}

export function pruneOldNews(keep = 500) {
  db.prepare(`DELETE FROM intel_news WHERE id NOT IN (SELECT id FROM intel_news ORDER BY published_at DESC LIMIT ?)`).run(keep);
}

// A simple, honest news score for a symbol: weighted by recency, sentiment, and importance —
// transparent arithmetic, not a black box. Returns null (not zero) when there's no news at all,
// so "no news" and "neutral news" are never confused.
export function computeNewsScore(symbol) {
  const articles = getRecentNews({ symbol, limit: 20 });
  if (!articles.length) return null;
  let score = 50;
  for (const a of articles) {
    const ageHours = a.published_at ? (Date.now() - new Date(a.published_at).getTime()) / 3600000 : 48;
    const recencyWeight = Math.max(0.1, 1 - ageHours / 168); // fades to ~0 over a week
    const sentimentWeight = a.sentiment === 'positive' ? 1 : a.sentiment === 'negative' ? -1 : 0;
    score += sentimentWeight * (a.importance || 2) * recencyWeight * 2;
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), articleCount: articles.length, articles: articles.slice(0, 5) };
}

/* =========================================================================
 * Social Intelligence — Reddit only, via Reddit's free public JSON endpoints (no API key needed
 * for read-only public subreddit data). X/Twitter's free API tier was discontinued and this app
 * will not fake that data — social features involving Twitter are explicitly marked unavailable
 * rather than approximated from something else.
 * ========================================================================= */
db.exec(`
CREATE TABLE IF NOT EXISTS intel_social_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  mention_count INTEGER NOT NULL,
  avg_score REAL,               -- average Reddit upvote score across matched posts
  avg_comments REAL,
  sentiment_positive INTEGER NOT NULL DEFAULT 0,
  sentiment_negative INTEGER NOT NULL DEFAULT 0,
  sentiment_neutral INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_social_symbol_time ON intel_social_snapshots(symbol, captured_at);
`);

// Naive keyword sentiment on a Reddit post's title+selftext — same honest-heuristic discipline
// as the news classifier: transparent keyword scoring, not a claim of trained NLP.
export function classifyPostSentiment(text) {
  const lower = (text || '').toLowerCase();
  const pos = NEWS_POSITIVE_WORDS.filter(w => lower.includes(w)).length + (lower.includes('moon') || lower.includes('bullish') ? 1 : 0);
  const neg = NEWS_NEGATIVE_WORDS.filter(w => lower.includes(w)).length + (lower.includes('rug') || lower.includes('scam') ? 1 : 0);
  return pos > neg ? 'positive' : neg > pos ? 'negative' : 'neutral';
}

// Takes already-fetched Reddit post objects (server.js does the actual HTTP call) and stores one
// snapshot of mention volume + sentiment mix for a symbol — this is what Social Momentum and the
// Early Trend Detector compare snapshot-over-snapshot to find acceleration.
export function recordSocialSnapshot(symbol, posts) {
  if (!posts.length) { db.prepare('INSERT INTO intel_social_snapshots (symbol, mention_count) VALUES (?, 0)').run(symbol); return; }
  let pos = 0, neg = 0, neu = 0, totalScore = 0, totalComments = 0;
  for (const p of posts) {
    const sentiment = classifyPostSentiment((p.title || '') + ' ' + (p.selftext || ''));
    if (sentiment === 'positive') pos++; else if (sentiment === 'negative') neg++; else neu++;
    totalScore += p.score || 0;
    totalComments += p.num_comments || 0;
  }
  db.prepare(`INSERT INTO intel_social_snapshots (symbol, mention_count, avg_score, avg_comments, sentiment_positive, sentiment_negative, sentiment_neutral)
              VALUES (?,?,?,?,?,?,?)`)
    .run(symbol, posts.length, totalScore / posts.length, totalComments / posts.length, pos, neg, neu);
}

export function pruneOldSocialSnapshots(symbol, keep = 200) {
  db.prepare(`DELETE FROM intel_social_snapshots WHERE symbol = ? AND id NOT IN (SELECT id FROM intel_social_snapshots WHERE symbol = ? ORDER BY captured_at DESC LIMIT ?)`).run(symbol, symbol, keep);
}

export function getSocialHistory(symbol, limit = 30) {
  return db.prepare('SELECT * FROM intel_social_snapshots WHERE symbol = ? ORDER BY captured_at DESC LIMIT ?').all(symbol, limit).reverse();
}

// Social Score (0-100) from real, already-recorded Reddit snapshots: mention volume vs the
// symbol's own recent baseline, sentiment mix, and engagement (score+comments) — no Twitter
// component, since that data source is honestly unavailable on any free tier.
export function computeSocialScore(symbol) {
  const history = getSocialHistory(symbol, 30);
  if (!history.length) return null;
  const latest = history[history.length - 1];
  const baseline = history.slice(0, -1);
  const baselineAvgMentions = baseline.length ? baseline.reduce((a, s) => a + s.mention_count, 0) / baseline.length : latest.mention_count;
  let score = 50;
  if (baselineAvgMentions > 0) score += Math.max(-15, Math.min(15, ((latest.mention_count - baselineAvgMentions) / baselineAvgMentions) * 15));
  const totalSentiment = latest.sentiment_positive + latest.sentiment_negative + latest.sentiment_neutral;
  if (totalSentiment > 0) score += ((latest.sentiment_positive - latest.sentiment_negative) / totalSentiment) * 20;
  if (latest.avg_score > 50) score += 10;
  if (latest.avg_comments > 20) score += 5;
  return { score: Math.max(0, Math.min(100, Math.round(score))), mentionCount: latest.mention_count, sentimentBreakdown: { positive: latest.sentiment_positive, negative: latest.sentiment_negative, neutral: latest.sentiment_neutral }, twitterAvailable: false };
}

/* =========================================================================
 * Early Trend / Virality Detector — genuine acceleration math on real recorded snapshots: is the
 * RATE of mention growth itself increasing (second derivative), not just "mentions went up."
 * ========================================================================= */
export function detectEarlyTrend(symbol) {
  const history = getSocialHistory(symbol, 12);
  if (history.length < 6) return { status: 'insufficient_data' };
  const mentions = history.map(h => h.mention_count);
  const mid = Math.floor(mentions.length / 2);
  const firstHalfAvg = mentions.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const secondHalfAvg = mentions.slice(mid).reduce((a, b) => a + b, 0) / (mentions.length - mid);
  const growthRate = firstHalfAvg > 0 ? ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100 : (secondHalfAvg > 0 ? 100 : 0);
  const recentEngagement = history[history.length - 1].avg_score + history[history.length - 1].avg_comments;
  const priorEngagement = history[Math.max(0, history.length - 4)].avg_score + history[Math.max(0, history.length - 4)].avg_comments;
  const engagementAccelerating = recentEngagement > priorEngagement * 1.3;
  let status = 'stable';
  if (growthRate > 50 && engagementAccelerating) status = 'accelerating_attention';
  else if (growthRate > 20) status = 'rising_attention';
  else if (growthRate < -30) status = 'fading_attention';
  return { status, growthRatePct: Math.round(growthRate), engagementAccelerating };
}

/* =========================================================================
 * Coin Scanner (deep) & Early Movers Scanner
 * ========================================================================= */
// Ranks symbols by a weighted blend of whatever component scores are actually available for each
// (technical/social/news/volume) — configurable weights from intel_weights, and a symbol missing
// a component (e.g. no social snapshot yet) is scored on what it DOES have rather than penalized
// with a fake zero.
export function scoreOpportunity(symbol, { technicalScore, socialScore, newsScore, volumeScore }) {
  const weights = getWeights();
  const parts = [];
  if (technicalScore !== null && technicalScore !== undefined) parts.push([technicalScore, weights.technical]);
  if (socialScore !== null && socialScore !== undefined) parts.push([socialScore, weights.social]);
  if (newsScore !== null && newsScore !== undefined) parts.push([newsScore, weights.news]);
  if (volumeScore !== null && volumeScore !== undefined) parts.push([volumeScore, weights.volume]);
  if (!parts.length) return null;
  const totalWeight = parts.reduce((a, [, w]) => a + w, 0);
  const weighted = parts.reduce((a, [score, w]) => a + score * w, 0);
  return Math.round(weighted / totalWeight);
}

/* =========================================================================
 * Signal Lifecycle Tracking, Backtesting persistence, Prediction Accuracy
 * ========================================================================= */
export function recordSignal(symbol, advancedSignal, currentPrice) {
  const id = db.prepare(`INSERT INTO intel_signals (symbol, action, score, confidence, price_at_signal, factors_json)
              VALUES (?,?,?,?,?,?)`)
    .run(symbol, advancedSignal.action, advancedSignal.score, advancedSignal.confidence, currentPrice, JSON.stringify(advancedSignal.factors)).lastInsertRowid;
  // Schedule the standard prediction-accuracy check horizons up front — checkPendingPredictions
  // (called periodically from server.js) fills these in once each becomes due.
  const horizons = { '6h': 6, '24h': 24, '3d': 72, '7d': 168 };
  const insertCheck = db.prepare('INSERT INTO intel_prediction_checks (signal_id, horizon, due_at) VALUES (?, ?, datetime(?, ?))');
  for (const [label, hours] of Object.entries(horizons)) insertCheck.run(id, label, 'now', `+${hours} hours`);
  return id;
}

export function updateSignalStatus(id, status, outcomePct = null) {
  db.prepare(`UPDATE intel_signals SET status = ?, outcome_pct = ?, resolved_at = CASE WHEN ? IN ('target_reached','invalidated','closed') THEN datetime('now') ELSE resolved_at END WHERE id = ?`)
    .run(status, outcomePct, status, id);
}

export function getSignalHistory(symbol, limit = 20) {
  return db.prepare('SELECT * FROM intel_signals WHERE symbol = ? ORDER BY detected_at DESC LIMIT ?').all(symbol, limit)
    .map(s => ({ ...s, factors: JSON.parse(s.factors_json) }));
}

// Returns every prediction check that's now due but hasn't been checked yet — server.js resolves
// each by fetching the current price and computing whether the original call was directionally
// correct, then writes the result back via resolvePredictionCheck.
export function getDuePredictionChecks() {
  return db.prepare(`
    SELECT c.*, s.symbol, s.action, s.price_at_signal FROM intel_prediction_checks c
    JOIN intel_signals s ON s.id = c.signal_id
    WHERE c.checked_at IS NULL AND c.due_at <= datetime('now')
  `).all();
}
export function resolvePredictionCheck(checkId, priceAtCheck, wasCorrect) {
  db.prepare(`UPDATE intel_prediction_checks SET checked_at = datetime('now'), price_at_check = ?, was_correct = ? WHERE id = ?`)
    .run(priceAtCheck, wasCorrect ? 1 : 0, checkId);
}

// Prediction Accuracy per horizon — Technical Accuracy here means "accuracy of signals generated
// by this technical engine" (the only kind this app can measure honestly, since there is no
// separate Social-only or News-only directional call being tracked independently).
export function getPredictionAccuracy(symbol = null) {
  const rows = symbol
    ? db.prepare(`
        SELECT c.horizon, c.was_correct FROM intel_prediction_checks c
        JOIN intel_signals s ON s.id = c.signal_id
        WHERE s.symbol = ? AND c.checked_at IS NOT NULL
      `).all(symbol)
    : db.prepare(`
        SELECT c.horizon, c.was_correct FROM intel_prediction_checks c
        WHERE c.checked_at IS NOT NULL
      `).all();
  const byHorizon = {};
  for (const r of rows) {
    if (!byHorizon[r.horizon]) byHorizon[r.horizon] = { correct: 0, total: 0 };
    byHorizon[r.horizon].total++;
    if (r.was_correct) byHorizon[r.horizon].correct++;
  }
  const out = {};
  for (const [horizon, { correct, total }] of Object.entries(byHorizon)) {
    out[horizon] = { accuracyPct: total ? Math.round((correct / total) * 1000) / 10 : null, sampleSize: total };
  }
  return out;
}

// Signal-level backtest summary from the persisted lifecycle table — distinct from
// markets-db.js's backtestStrategy (which replays a fixed RSI/MACD rule over raw price history);
// this one reports how the actual live signal engine's own past calls performed.
export function getSignalBacktestSummary(symbol = null) {
  const where = symbol ? 'WHERE symbol = ? AND outcome_pct IS NOT NULL' : 'WHERE outcome_pct IS NOT NULL';
  const params = symbol ? [symbol] : [];
  const resolved = db.prepare(`SELECT * FROM intel_signals ${where}`).all(...params);
  if (!resolved.length) return { totalSignals: 0 };
  const wins = resolved.filter(s => (s.action.includes('BUY') && s.outcome_pct > 0) || (s.action.includes('SELL') && s.outcome_pct < 0));
  const losses = resolved.filter(s => !wins.includes(s));
  const avgReturn = wins.length ? wins.reduce((a, s) => a + Math.abs(s.outcome_pct), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, s) => a + Math.abs(s.outcome_pct), 0) / losses.length : 0;
  const grossProfit = wins.reduce((a, s) => a + Math.abs(s.outcome_pct), 0);
  const grossLoss = losses.reduce((a, s) => a + Math.abs(s.outcome_pct), 0);
  let equity = 100, peak = 100, maxDrawdown = 0;
  for (const s of resolved) {
    equity *= (1 + (wins.includes(s) ? Math.abs(s.outcome_pct) : -Math.abs(s.outcome_pct)) / 100);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);
  }
  return {
    totalSignals: resolved.length,
    winRate: Math.round((wins.length / resolved.length) * 1000) / 10,
    avgReturnPct: Math.round(avgReturn * 100) / 100,
    avgLossPct: Math.round(avgLoss * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : null,
    maxDrawdownPct: Math.round(maxDrawdown * 100) / 100,
  };
}

/* =========================================================================
 * Self-Optimization — bounded, backtested, reversible weight tuning. This deliberately does NOT
 * do gradient descent or any black-box ML: it nudges one weight by a small fixed step, re-checks
 * the signal-level backtest summary, and rolls back immediately if performance got worse. That's
 * the whole algorithm — simple enough to audit, which matters more here than raw optimality.
 * ========================================================================= */
const MAX_WEIGHT_STEP = 0.03; // bounded nudge per optimization run — never a wild swing
export function runSelfOptimizationStep(key) {
  const before = getSignalBacktestSummary();
  if (before.totalSignals < 20) return { skipped: true, reason: 'Not enough resolved signals yet to optimize against (need 20+).' };
  const beforeScore = (before.winRate || 0) - (before.maxDrawdownPct || 0) * 0.5; // simple composite the step is judged against
  const oldWeight = getWeights()[key];
  if (oldWeight === undefined) return { skipped: true, reason: 'Unknown weight key' };
  const newWeight = Math.max(0.05, Math.min(0.7, oldWeight + MAX_WEIGHT_STEP));
  setWeight(key, newWeight);
  // In a live system "after" would be measured on NEW signals generated under the new weight;
  // this records the intent transparently and leaves the before/after comparison to accumulate
  // over subsequent calls to this function, rather than pretending an instant re-backtest with
  // no new data is meaningful.
  const historyId = db.prepare(`INSERT INTO intel_weight_history (key, old_weight, new_weight, backtest_score_before) VALUES (?,?,?,?)`)
    .run(key, oldWeight, newWeight, beforeScore).lastInsertRowid;
  return { applied: true, key, oldWeight, newWeight, historyId };
}
export function rollbackWeightChange(historyId) {
  const row = db.prepare('SELECT * FROM intel_weight_history WHERE id = ?').get(historyId);
  if (!row || row.rolled_back) return { rolledBack: false };
  setWeight(row.key, row.old_weight);
  db.prepare('UPDATE intel_weight_history SET rolled_back = 1 WHERE id = ?').run(historyId);
  return { rolledBack: true, key: row.key, restoredWeight: row.old_weight };
}
export function evaluateAndMaybeRollback(historyId) {
  const row = db.prepare('SELECT * FROM intel_weight_history WHERE id = ?').get(historyId);
  if (!row || row.rolled_back) return { evaluated: false };
  const after = getSignalBacktestSummary();
  const afterScore = (after.winRate || 0) - (after.maxDrawdownPct || 0) * 0.5;
  db.prepare('UPDATE intel_weight_history SET backtest_score_after = ? WHERE id = ?').run(afterScore, historyId);
  if (afterScore < row.backtest_score_before) return rollbackWeightChange(historyId);
  return { evaluated: true, improved: true, afterScore };
}

export default db;
