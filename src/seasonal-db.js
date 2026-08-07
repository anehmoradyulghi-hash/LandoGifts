import db from './db.js';

// Table creation lives in migrations/011_seasonal_cards.sql now.

export async function listSeasons() { return await db.prepare('SELECT * FROM seasons ORDER BY created_at DESC').all(); }
export async function getSeason(id) { return await db.prepare('SELECT * FROM seasons WHERE id = ?').get(id); }
export async function createSeason(s) {
  return (await db.prepare(`INSERT INTO seasons (name, theme, starts_at, ends_at, active) VALUES (?,?,?,?,?)`)
    .run(s.name, s.theme || '', s.starts_at, s.ends_at, s.active !== false ? 1 : 0)).lastInsertRowid;
}
export async function deleteSeason(id) { await db.prepare('DELETE FROM seasons WHERE id = ?').run(id); }
export async function listSeasonCards(seasonId) {
  return await db.prepare('SELECT * FROM game_cards WHERE season_id = ?').all(seasonId);
}
export async function setCardSeason(cardId, seasonId) {
  await db.prepare('UPDATE game_cards SET season_id = ? WHERE id = ?').run(seasonId || null, cardId);
}

// Closes finished seasons and pulls their cards from sale (previously purchased cards remain untouched)
export async function checkExpiredSeasons() {
  const expired = await db.prepare(`SELECT * FROM seasons WHERE active = 1 AND ends_at <= now_text()`).all();
  for (const s of expired) {
    await db.prepare('UPDATE seasons SET active = 0 WHERE id = ?').run(s.id);
    await db.prepare('UPDATE game_cards SET active = 0 WHERE season_id = ?').run(s.id);
  }
}
export async function getActiveSeason() {
  return await db.prepare(`SELECT * FROM seasons WHERE active = 1 AND starts_at <= now_text() AND ends_at > now_text() ORDER BY starts_at DESC LIMIT 1`).get();
}
