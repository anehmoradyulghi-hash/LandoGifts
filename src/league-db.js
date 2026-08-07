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
  promote_count INTEGER NOT NULL DEFAULT 5,
  relegate_count INTEGER NOT NULL DEFAULT 5,
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
`);

const LEAGUES = ['bronze', 'silver', 'gold'];
const LEAGUE_LABELS = { bronze: '🥉 Bronze', silver: '🥈 Silver', gold: '🥇 Gold' };

export function getLeagueConfig() { return db.prepare('SELECT * FROM league_config WHERE id = 1').get(); }
export function setLeagueConfig(c) {
  db.prepare(`
    UPDATE league_config SET enabled=?, promote_count=?, relegate_count=?, reset_days=? WHERE id = 1
  `).run(c.enabled ? 1 : 0, Number(c.promote_count) || 5, Number(c.relegate_count) || 5, Number(c.reset_days) || 7);
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
  const cfg = getLeagueConfig();
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
    if (i < order.length - 1 && cfg.promote_count > 0 && members.length > cfg.promote_count) {
      members.slice(0, cfg.promote_count).forEach(m => moves.push({ tg_id: m.tg_id, newLeague: order[i + 1] }));
    }
    if (i > 0 && cfg.relegate_count > 0 && members.length > cfg.relegate_count) {
      members.slice(-cfg.relegate_count).forEach(m => moves.push({ tg_id: m.tg_id, newLeague: order[i - 1] }));
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
