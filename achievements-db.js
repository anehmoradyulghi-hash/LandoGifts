import db from './db.js';

/* =========================================================================
 * ACHIEVEMENTS — admin-defined badges unlocked automatically when a player
 * crosses a threshold on one of a fixed set of trackable metrics. Unlocking
 * one also drops an entry in the public activity feed (see below).
 *
 * PINNED BADGES — a player picks up to 3 of their unlocked achievements to
 * show next to their name around the app (clan chat, leaderboard).
 *
 * ACTIVITY FEED — a lightweight, app-wide "things just happened" log (rare
 * chest wins, raffle wins, gifts sold, achievements unlocked) shown on the
 * home hub so the app feels alive even when a given player isn't the one
 * currently winning something.
 * ========================================================================= */
db.exec(`
CREATE TABLE IF NOT EXISTS achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  icon TEXT DEFAULT '🏅',
  metric TEXT NOT NULL,     -- battle_wins | legendary_cards | nft_sold | checkin_streak | chests_opened
  threshold INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_achievements (
  tg_id INTEGER NOT NULL,
  achievement_id INTEGER NOT NULL,
  unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tg_id, achievement_id)
);
CREATE TABLE IF NOT EXISTS user_pinned_achievements (
  tg_id INTEGER PRIMARY KEY,
  achievement_ids TEXT NOT NULL DEFAULT '[]' -- JSON array, max 3
);
CREATE TABLE IF NOT EXISTS activity_feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  icon TEXT DEFAULT '⚡',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_feed_created ON activity_feed(id);
`);

// "Alex Johnson" -> "Al***on" — same masking used elsewhere (raffle leaderboards etc.) so no
// individual player's full identity is broadcast app-wide by the feed.
function maskName(name) {
  const s = String(name || '').trim();
  if (s.length <= 4) return s ? s[0] + '***' : 'Player';
  return s.slice(0, 2) + '***' + s.slice(-2);
}

export function logActivity(text, icon = '⚡') {
  db.prepare('INSERT INTO activity_feed (text, icon) VALUES (?,?)').run(text, icon);
  // Keep the table small — this is a rolling recent-events log, not a permanent record
  db.prepare(`DELETE FROM activity_feed WHERE id NOT IN (SELECT id FROM activity_feed ORDER BY id DESC LIMIT 200)`).run();
}
export function getActivityFeed(limit = 20) {
  return db.prepare('SELECT * FROM activity_feed ORDER BY id DESC LIMIT ?').all(limit);
}
export function logPlayerActivity(displayName, text, icon) {
  logActivity(`${maskName(displayName)} ${text}`, icon);
}

/* ---------- Admin CRUD ---------- */
export function listAchievementsAdmin() { return db.prepare('SELECT * FROM achievements ORDER BY sort_order ASC, id ASC').all(); }
export function upsertAchievement(a) {
  if (a.id) {
    db.prepare('UPDATE achievements SET key=?, title=?, description=?, icon=?, metric=?, threshold=?, active=?, sort_order=? WHERE id=?')
      .run(a.key, a.title, a.description || null, a.icon || '🏅', a.metric, Number(a.threshold) || 1, a.active ? 1 : 0, Number(a.sort_order) || 0, a.id);
    return a.id;
  }
  return db.prepare('INSERT INTO achievements (key, title, description, icon, metric, threshold, active, sort_order) VALUES (?,?,?,?,?,?,?,?)')
    .run(a.key, a.title, a.description || null, a.icon || '🏅', a.metric, Number(a.threshold) || 1, a.active ? 1 : 0, Number(a.sort_order) || 0).lastInsertRowid;
}
export function deleteAchievement(id) {
  db.prepare('DELETE FROM user_achievements WHERE achievement_id = ?').run(id);
  db.prepare('DELETE FROM achievements WHERE id = ?').run(id);
}

/* ---------- Player-facing ---------- */
export function listAchievementsForUser(tgId) {
  const unlocked = new Set(db.prepare('SELECT achievement_id FROM user_achievements WHERE tg_id = ?').all(tgId).map(r => r.achievement_id));
  const pinnedRow = db.prepare('SELECT achievement_ids FROM user_pinned_achievements WHERE tg_id = ?').get(tgId);
  const pinned = new Set(pinnedRow ? JSON.parse(pinnedRow.achievement_ids) : []);
  return db.prepare('SELECT * FROM achievements WHERE active = 1 ORDER BY sort_order ASC, id ASC').all()
    .map(a => ({ ...a, unlocked: unlocked.has(a.id), pinned: pinned.has(a.id) }));
}
export function getPinnedBadges(tgId) {
  const row = db.prepare('SELECT achievement_ids FROM user_pinned_achievements WHERE tg_id = ?').get(tgId);
  if (!row) return [];
  const ids = JSON.parse(row.achievement_ids);
  if (!ids.length) return [];
  return db.prepare(`SELECT id, icon, title FROM achievements WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
}
export function setPinnedBadges(tgId, achievementIds) {
  const unlockedIds = new Set(db.prepare('SELECT achievement_id FROM user_achievements WHERE tg_id = ?').all(tgId).map(r => r.achievement_id));
  const ids = [...new Set((achievementIds || []).map(Number))].filter(id => unlockedIds.has(id)).slice(0, 3);
  db.prepare(`
    INSERT INTO user_pinned_achievements (tg_id, achievement_ids) VALUES (?, ?)
    ON CONFLICT(tg_id) DO UPDATE SET achievement_ids = excluded.achievement_ids
  `).run(tgId, JSON.stringify(ids));
}

// Called from wherever a metric changes (battle win, card level-up, gift sold, checkin, chest open,
// referral). Unlocks any not-yet-unlocked achievement on that metric whose threshold is now met, logs
// it to the activity feed, and returns the list of newly unlocked achievements (so the caller can also
// send a congratulatory Telegram DM if it wants to).
export function checkAchievements(tgId, metric, currentValue, displayName) {
  const candidates = db.prepare(`
    SELECT a.* FROM achievements a
    WHERE a.metric = ? AND a.active = 1 AND a.threshold <= ?
      AND a.id NOT IN (SELECT achievement_id FROM user_achievements WHERE tg_id = ?)
  `).all(metric, currentValue, tgId);
  for (const a of candidates) {
    db.prepare('INSERT OR IGNORE INTO user_achievements (tg_id, achievement_id) VALUES (?,?)').run(tgId, a.id);
    logPlayerActivity(displayName, `unlocked the achievement "${a.title}" ${a.icon}`, '🏅');
  }
  return candidates;
}
