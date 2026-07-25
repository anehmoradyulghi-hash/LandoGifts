import db from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  theme TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

function safeAddColumn(table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
safeAddColumn('game_cards', 'season_id INTEGER'); // خالی = کارت همیشگی، نه فصلی

export function listSeasons() { return db.prepare('SELECT * FROM seasons ORDER BY created_at DESC').all(); }
export function getSeason(id) { return db.prepare('SELECT * FROM seasons WHERE id = ?').get(id); }
export function createSeason(s) {
  return db.prepare(`INSERT INTO seasons (name, theme, starts_at, ends_at, active) VALUES (?,?,?,?,?)`)
    .run(s.name, s.theme || '', s.starts_at, s.ends_at, s.active !== false ? 1 : 0).lastInsertRowid;
}
export function deleteSeason(id) { db.prepare('DELETE FROM seasons WHERE id = ?').run(id); }
export function listSeasonCards(seasonId) {
  return db.prepare('SELECT * FROM game_cards WHERE season_id = ?').all(seasonId);
}
export function setCardSeason(cardId, seasonId) {
  db.prepare('UPDATE game_cards SET season_id = ? WHERE id = ?').run(seasonId || null, cardId);
}

// فصل‌های تموم‌شده رو می‌بنده و کارت‌های داخلشون رو از فروش خارج می‌کنه (کارت‌های قبلا خریده‌شده دست‌نخورده می‌مونن)
export function checkExpiredSeasons() {
  const expired = db.prepare(`SELECT * FROM seasons WHERE active = 1 AND ends_at <= datetime('now')`).all();
  for (const s of expired) {
    db.prepare('UPDATE seasons SET active = 0 WHERE id = ?').run(s.id);
    db.prepare('UPDATE game_cards SET active = 0 WHERE season_id = ?').run(s.id);
  }
}
export function getActiveSeason() {
  return db.prepare(`SELECT * FROM seasons WHERE active = 1 AND starts_at <= datetime('now') AND ends_at > datetime('now') ORDER BY starts_at DESC LIMIT 1`).get();
}
