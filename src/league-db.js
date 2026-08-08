import db from './db.js';

/* =========================================================================
 * Three-tier weekly league (Bronze/Silver/Gold) — separate from the overall game score, XP, or clan score.
 * based only on this week's wins/losses in PvP card battles. Every Sunday night, promotion/demotion
 * happens automatically and counters reset. Opponents are picked from the same league whenever possible.
 * ========================================================================= */
db.exec(`
CREATE TABLE IF NOT EXISTS league_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  reset_days INTEGER NOT NULL DEFAULT 7
);
INSERT OR IGNORE INTO league_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS league_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  period_started_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO league_state (id) VALUES (1);

CREATE TABLE IF NOT EXISTS user_league (
  tg_id INTEGER PRIMARY KEY,
  league TEXT NOT NULL DEFAULT 'bronze', -- bronze | silver | gold
  weekly_wins INTEGER NOT NULL DEFAULT 0,
  weekly_losses INTEGER NOT NULL DEFAULT 0
);

-- How many players move up (promote_count) and down (relegate_count) each week, set independently
-- for every league tier — e.g. 8 promote from Bronze but only 3 from Silver. promote_count has no
-- effect on the top league (Gold — nowhere to promote to) and relegate_count has no effect on the
-- bottom league (Bronze — nowhere to relegate to).
CREATE TABLE IF NOT EXISTS league_tier_config (
  league TEXT PRIMARY KEY,
  promote_count INTEGER NOT NULL DEFAULT 5,
  relegate_count INTEGER NOT NULL DEFAULT 5
);
`);
const seedTierCfg = db.prepare('INSERT OR IGNORE INTO league_tier_config (league, promote_count, relegate_count) VALUES (?,?,?)');
['bronze', 'silver', 'gold'].forEach(l => seedTierCfg.run(l, 5, 5));

// The old global promote_count/relegate_count on league_config are fully replaced by the per-league
// table above — drop them so no stale global value can ever be read again.
try {
  const cols = db.prepare("PRAGMA table_info(league_config)").all().map(c => c.name);
  if (cols.includes('promote_count')) db.exec('ALTER TABLE league_config DROP COLUMN promote_count');
  if (cols.includes('relegate_count')) db.exec('ALTER TABLE league_config DROP COLUMN relegate_count');
} catch (e) { /* SQLite too old to support DROP COLUMN — harmless: nothing reads these columns anymore */ }

const LEAGUES = ['bronze', 'silver', 'gold'];
const LEAGUE_LABELS = { bronze: '🥉 Bronze', silver: '🥈 Silver', gold: '🥇 Gold' };

export function getLeagueConfig() { return db.prepare('SELECT * FROM league_config WHERE id = 1').get(); }
export function setLeagueConfig(c) {
  db.prepare(`UPDATE league_config SET enabled=?, reset_days=? WHERE id = 1`).run(c.enabled ? 1 : 0, Number(c.reset_days) || 7);
}
export function getLeagueTierConfig() {
  const rows = db.prepare('SELECT * FROM league_tier_config').all();
  const byLeague = Object.fromEntries(rows.map(r => [r.league, r]));
  return LEAGUES.map(l => byLeague[l] || { league: l, promote_count: 0, relegate_count: 0 }); // bronze, silver, gold — in that fixed order
}
export function setLeagueTierConfig(league, promoteCount, relegateCount) {
  if (!LEAGUES.includes(league)) throw new Error('Invalid league');
  db.prepare(`UPDATE league_tier_config SET promote_count=?, relegate_count=? WHERE league=?`)
    .run(Math.max(0, Number(promoteCount) || 0), Math.max(0, Number(relegateCount) || 0), league);
}
function getLeagueState() { return db.prepare('SELECT * FROM league_state WHERE id = 1').get(); }

export function getOrCreateUserLeague(tgId) {
  db.prepare('INSERT OR IGNORE INTO user_league (tg_id) VALUES (?)').run(tgId);
  return db.prepare('SELECT * FROM user_league WHERE tg_id = ?').get(tgId);
}
function scoreOf(row) { return row.weekly_wins * 3 - row.weekly_losses; }

export function getUserLeague(tgId) {
  return getOrCreateUserLeague(tgId).league;
}

export function recordLeagueResult(tgId, won) {
  const cfg = getLeagueConfig();
  if (!cfg.enabled) return;
  getOrCreateUserLeague(tgId);
  db.prepare(`UPDATE user_league SET ${won ? 'weekly_wins = weekly_wins + 1' : 'weekly_losses = weekly_losses + 1'} WHERE tg_id = ?`).run(tgId);
}

export function getUserLeagueInfo(tgId) {
  const row = getOrCreateUserLeague(tgId);
  const score = scoreOf(row);
  const rank = db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM user_league
    WHERE league = ? AND (weekly_wins * 3 - weekly_losses) > ?
  `).get(row.league, score).rank;
  return { league: row.league, leagueLabel: LEAGUE_LABELS[row.league], weeklyWins: row.weekly_wins, weeklyLosses: row.weekly_losses, score, rank };
}

export function getLeagueLeaderboard(league, limit = 10) {
  if (!LEAGUES.includes(league)) league = 'bronze';
  return db.prepare(`
    SELECT ul.tg_id, ul.weekly_wins, ul.weekly_losses, (ul.weekly_wins * 3 - ul.weekly_losses) AS score,
      u.first_name, u.username, av.image_url AS avatar_image
    FROM user_league ul JOIN users u ON u.tg_id = ul.tg_id
    LEFT JOIN user_rank ur ON ur.tg_id = ul.tg_id
    LEFT JOIN avatars av ON av.id = ur.equipped_avatar_id
    WHERE ul.league = ?
    ORDER BY score DESC LIMIT ?
  `).all(league, limit);
}

// When queuing a battle, it first looks for an opponent in the same league; if none, from the whole queue (no league filter)
export function pickQueueOpponentInLeague(league, excludeTgId) {
  const row = db.prepare(`
    SELECT gq.* FROM game_queue gq
    JOIN user_league ul ON ul.tg_id = gq.tg_id
    WHERE gq.tg_id != ? AND ul.league = ?
    ORDER BY gq.joined_at ASC LIMIT 1
  `).get(excludeTgId, league);
  return row || null;
}

function resolveWeeklyLeagues() {
  const tiers = Object.fromEntries(getLeagueTierConfig().map(t => [t.league, t]));
  const order = LEAGUES; // bronze -> silver -> gold
  const snapshot = {};
  for (const league of order) {
    snapshot[league] = db.prepare(`
      SELECT tg_id, (weekly_wins * 3 - weekly_losses) AS score FROM user_league WHERE league = ? ORDER BY score DESC
    `).all(league);
  }
  const moves = [];
  for (let i = 0; i < order.length; i++) {
    const members = snapshot[order[i]];
    const tier = tiers[order[i]] || { promote_count: 0, relegate_count: 0 };
    if (i < order.length - 1 && tier.promote_count > 0 && members.length > tier.promote_count) {
      members.slice(0, tier.promote_count).forEach(m => moves.push({ tg_id: m.tg_id, newLeague: order[i + 1] }));
    }
    if (i > 0 && tier.relegate_count > 0 && members.length > tier.relegate_count) {
      members.slice(-tier.relegate_count).forEach(m => moves.push({ tg_id: m.tg_id, newLeague: order[i - 1] }));
    }
  }
  const tx = db.transaction(() => {
    for (const mv of moves) db.prepare('UPDATE user_league SET league = ? WHERE tg_id = ?').run(mv.newLeague, mv.tg_id);
    db.prepare('UPDATE user_league SET weekly_wins = 0, weekly_losses = 0').run();
    db.prepare(`UPDATE league_state SET period_started_at = datetime('now') WHERE id = 1`).run();
  });
  tx();
}

export function checkAutoResetLeague() {
  const cfg = getLeagueConfig();
  if (!cfg.enabled) return;
  const state = getLeagueState();
  const startedAt = new Date(state.period_started_at.replace(' ', 'T') + 'Z').getTime();
  if (Date.now() >= startedAt + cfg.reset_days * 24 * 60 * 60 * 1000) resolveWeeklyLeagues();
}
