import db from './db.js';
import { adjustToman, getUser, round2 } from './db.js';

/* =========================================================================
 * Plinko — a ball is dropped through a fixed 12-row peg board; at each peg it
 * bounces left or right with equal (50/50) probability, landing in one of 13
 * buckets at the bottom. Which bucket it lands in follows a binomial
 * distribution (center buckets are far more likely than the edges), so the
 * per-risk multiplier tables are shaped accordingly: small/near-1x in the
 * middle, large payouts only in the rare edge buckets. Nothing here is client
 * -controlled — the whole bounce sequence and payout are generated and
 * resolved server-side in one request.
 * ========================================================================= */
const ROWS = 12;
const BUCKETS = ROWS + 1;

const DEFAULT_MULTIPLIERS = {
  low: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
  medium: [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
  high: [120, 17, 5, 2.5, 1, 0.3, 0.07, 0.3, 1, 2.5, 5, 17, 120],
};

db.exec(`
CREATE TABLE IF NOT EXISTS plinko_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  min_bet_toman REAL NOT NULL DEFAULT 1,
  max_bet_toman REAL NOT NULL DEFAULT 500,
  multipliers_json TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_MULTIPLIERS)}'
);
INSERT OR IGNORE INTO plinko_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS plinko_bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  risk TEXT NOT NULL,
  bet_toman REAL NOT NULL,
  bucket INTEGER NOT NULL,
  multiplier REAL NOT NULL,
  payout_toman REAL NOT NULL,
  path_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_plinko_bets_tg ON plinko_bets(tg_id, created_at DESC);
`);

function rawConfig() { return db.prepare('SELECT * FROM plinko_config WHERE id = 1').get(); }

export function getPlinkoConfig() {
  const c = rawConfig();
  let multipliers;
  try { multipliers = JSON.parse(c.multipliers_json); } catch (e) { multipliers = DEFAULT_MULTIPLIERS; }
  return {
    enabled: !!c.enabled,
    minBet: c.min_bet_toman,
    maxBet: c.max_bet_toman,
    rows: ROWS,
    multipliers,
  };
}

export function setPlinkoConfig({ enabled, minBet, maxBet, multipliers }) {
  const current = getPlinkoConfig();
  const merged = { ...current.multipliers, ...(multipliers || {}) };
  for (const risk of ['low', 'medium', 'high']) {
    const arr = merged[risk];
    if (!Array.isArray(arr) || arr.length !== BUCKETS || arr.some(x => typeof x !== 'number' || x < 0)) {
      throw new Error(`${risk} multiplier table must have exactly ${BUCKETS} non-negative numbers`);
    }
  }
  // Any field the caller didn't send falls back to what's already saved, not a hardcoded default —
  // e.g. saving just the multiplier tables must never silently flip `enabled` off.
  const nextEnabled = enabled === undefined ? current.enabled : !!enabled;
  const nextMinBet = minBet === undefined ? current.minBet : Math.max(0.01, Number(minBet) || current.minBet);
  const nextMaxBet = maxBet === undefined ? current.maxBet : Math.max(0.01, Number(maxBet) || current.maxBet);
  db.prepare(`UPDATE plinko_config SET enabled=?, min_bet_toman=?, max_bet_toman=?, multipliers_json=? WHERE id=1`)
    .run(nextEnabled ? 1 : 0, nextMinBet, nextMaxBet, JSON.stringify(merged));
}

// Simulates ROWS independent 50/50 bounces and returns both the resulting bucket index (0..ROWS,
// how many times the ball went right) and the exact left/right path, so the frontend can animate
// the same drop the server actually resolved rather than a made-up one.
function dropBall() {
  const path = [];
  let bucket = 0;
  for (let i = 0; i < ROWS; i++) {
    const right = Math.random() < 0.5;
    path.push(right ? 'R' : 'L');
    if (right) bucket++;
  }
  return { bucket, path };
}

export function playPlinko(tgId, risk, betAmount) {
  const cfg = getPlinkoConfig();
  if (!cfg.enabled) throw new Error('Plinko is currently unavailable');
  if (!['low', 'medium', 'high'].includes(risk)) throw new Error('Invalid risk level');
  const bet = round2(Number(betAmount));
  if (!bet || bet <= 0) throw new Error('Invalid bet amount');
  if (bet < cfg.minBet) throw new Error(`Minimum bet is ${cfg.minBet} LNDC`);
  if (bet > cfg.maxBet) throw new Error(`Maximum bet is ${cfg.maxBet} LNDC`);
  const user = getUser(tgId);
  if (!user || user.balance_toman < bet) throw new Error('Insufficient balance');

  const { bucket, path } = dropBall();
  const multiplier = cfg.multipliers[risk][bucket];
  const payout = round2(bet * multiplier);

  const tx = db.transaction(() => {
    adjustToman(tgId, -bet, `Plinko bet (${risk})`);
    if (payout > 0) adjustToman(tgId, payout, `Plinko payout (${risk}, ${multiplier}x)`);
    db.prepare(`INSERT INTO plinko_bets (tg_id, risk, bet_toman, bucket, multiplier, payout_toman, path_json) VALUES (?,?,?,?,?,?,?)`)
      .run(tgId, risk, bet, bucket, multiplier, payout, JSON.stringify(path));
  });
  tx();

  const newBalance = getUser(tgId).balance_toman;
  return { bucket, path, multiplier, payout, bet, newBalance };
}

export function getPlinkoHistory(tgId, limit = 20) {
  return db.prepare('SELECT risk, bet_toman, bucket, multiplier, payout_toman, created_at FROM plinko_bets WHERE tg_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(tgId, limit);
}
