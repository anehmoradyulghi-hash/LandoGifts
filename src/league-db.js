import db from './db.js';

/* =========================================================================
 * Weekly league (an admin-configurable set of tiers, e.g. Bronze/Silver/Gold,
 * or any number of custom tiers) — separate from the overall game score, XP,
 * or clan score, based only on this week's wins/losses in PvP card battles.
 * Every reset period, promotion/demotion happens automatically and counters
 * reset. Opponents are picked from the same league whenever possible.
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
  league TEXT NOT NULL DEFAULT 'bronze',
  weekly_wins INTEGER NOT NULL DEFAULT 0,
  weekly_losses INTEGER NOT NULL DEFAULT 0
);

-- Admin-defined league tiers, in promotion order (sort_order ascending = lowest to highest tier).
-- promote_count has no effect on the top tier (nowhere to promote to) and relegate_count has no
-- effect on the bottom tier (nowhere to relegate to).
CREATE TABLE IF NOT EXISTS leagues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  icon TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  promote_count INTEGER NOT NULL DEFAULT 5,
  relegate_count INTEGER NOT NULL DEFAULT 5
);
`);
// Seed the classic three tiers once, on a fresh install only — an admin who deletes all leagues
// later is left with zero (not silently reseeded), same as any other admin-managed list.
if (!db.prepare('SELECT 1 FROM leagues LIMIT 1').get()) {
  const seed = db.prepare('INSERT INTO leagues (key, label, icon, sort_order, promote_count, relegate_count) VALUES (?,?,?,?,?,?)');
  seed.run('bronze', 'Bronze', '🥉', 0, 5, 5);
  seed.run('silver', 'Silver', '🥈', 1, 5, 5);
  seed.run('gold', 'Gold', '🥇', 2, 5, 5);
}

export function listLeagues() { return db.prepare('SELECT * FROM leagues ORDER BY sort_order ASC, id ASC').all(); }
export function getLeague(key) { return db.prepare('SELECT * FROM leagues WHERE key = ?').get(key); }
export function upsertLeagueTier(l) {
  const existing = l.originalKey ? getLeague(l.originalKey) : (l.key ? getLeague(l.key) : null);
  if (existing) {
    db.prepare('UPDATE leagues SET key=?, label=?, icon=?, sort_order=?, promote_count=?, relegate_count=? WHERE id=?')
      .run(l.key, l.label, l.icon || null, Number(l.sort_order) || 0, Math.max(0, Number(l.promote_count) || 0), Math.max(0, Number(l.relegate_count) || 0), existing.id);
    if (existing.key !== l.key) db.prepare('UPDATE user_league SET league = ? WHERE league = ?').run(l.key, existing.key);
    return existing.id;
  }
  return db.prepare('INSERT INTO leagues (key, label, icon, sort_order, promote_count, relegate_count) VALUES (?,?,?,?,?,?)')
    .run(l.key, l.label, l.icon || null, Number(l.sort_order) || 0, Math.max(0, Number(l.promote_count) || 0), Math.max(0, Number(l.relegate_count) || 0)).lastInsertRowid;
}
export function deleteLeagueTier(key) {
  const all = listLeagues();
  if (all.length <= 1) throw new Error('At least one league tier must remain');
  // Move any players currently in the deleted tier to the nearest remaining tier (prefer the one
  // just below it, so nobody is silently "promoted" past tiers they haven't earned).
  const removed = all.find(l => l.key === key);
  if (!removed) return;
  const remaining = all.filter(l => l.key !== key);
  const fallback = [...remaining].reverse().find(l => l.sort_order <= removed.sort_order) || remaining[0];
  db.prepare('UPDATE user_league SET league = ? WHERE league = ?').run(fallback.key, key);
  db.prepare('DELETE FROM leagues WHERE key = ?').run(key);
}

export function getLeagueConfig() { return db.prepare('SELECT * FROM league_config WHERE id = 1').get(); }
export function setLeagueConfig(c) {
  db.prepare(`UPDATE league_config SET enabled=?, reset_days=? WHERE id = 1`).run(c.enabled ? 1 : 0, Number(c.reset_days) || 7);
}
function getLeagueState() { return db.prepare('SELECT * FROM league_state WHERE id = 1').get(); }

function firstLeagueKey() { return listLeagues()[0]?.key || 'bronze'; }

export function getOrCreateUserLeague(tgId) {
  db.prepare('INSERT OR IGNORE INTO user_league (tg_id, league) VALUES (?, ?)').run(tgId, firstLeagueKey());
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
  const tier = getLeague(row.league);
  return {
    league: row.league, leagueLabel: tier ? `${tier.icon || ''} ${tier.label}`.trim() : row.league,
    weeklyWins: row.weekly_wins, weeklyLosses: row.weekly_losses, score, rank,
  };
}

export function getLeagueLeaderboard(league, limit = 10) {
  if (!getLeague(league)) league = firstLeagueKey();
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
  const order = listLeagues(); // lowest to highest tier, in admin-defined order
  const snapshot = {};
  for (const tier of order) {
    snapshot[tier.key] = db.prepare(`
      SELECT tg_id, (weekly_wins * 3 - weekly_losses) AS score FROM user_league WHERE league = ? ORDER BY score DESC
    `).all(tier.key);
  }
  const moves = [];
  for (let i = 0; i < order.length; i++) {
    const tier = order[i];
    const members = snapshot[tier.key];
    if (i < order.length - 1 && tier.promote_count > 0 && members.length > tier.promote_count) {
      members.slice(0, tier.promote_count).forEach(m => moves.push({ tg_id: m.tg_id, newLeague: order[i + 1].key }));
    }
    if (i > 0 && tier.relegate_count > 0 && members.length > tier.relegate_count) {
      members.slice(-tier.relegate_count).forEach(m => moves.push({ tg_id: m.tg_id, newLeague: order[i - 1].key }));
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
