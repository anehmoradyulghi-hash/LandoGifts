import db from './db.js';
import { adjustToman } from './db.js';
import { grantAvatar } from './rank-db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  reward_type TEXT NOT NULL DEFAULT 'toman', -- toman | avatar | card
  reward_value TEXT,
  is_seasonal INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS album_requirements (
  album_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  PRIMARY KEY (album_id, category_id)
);

CREATE TABLE IF NOT EXISTS user_album_claims (
  tg_id INTEGER NOT NULL,
  album_id INTEGER NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tg_id, album_id)
);
`);

export function listAlbums(onlyActive = false) {
  const rows = onlyActive
    ? db.prepare('SELECT * FROM albums WHERE active = 1 ORDER BY id DESC').all()
    : db.prepare('SELECT * FROM albums ORDER BY id DESC').all();
  const now = Date.now();
  return rows.filter(a => {
    if (!onlyActive) return true;
    if (a.is_seasonal && a.ends_at && new Date(a.ends_at.replace(' ', 'T') + 'Z').getTime() < now) return false;
    return true;
  });
}
export function getAlbum(id) { return db.prepare('SELECT * FROM albums WHERE id = ?').get(id); }
export function upsertAlbum(a) {
  let id = a.id;
  if (id) {
    db.prepare(`UPDATE albums SET name=?, reward_type=?, reward_value=?, is_seasonal=?, starts_at=?, ends_at=?, active=? WHERE id=?`)
      .run(a.name, a.reward_type, a.reward_value, a.is_seasonal ? 1 : 0, a.starts_at || null, a.ends_at || null, a.active ? 1 : 0, id);
  } else {
    id = db.prepare(`INSERT INTO albums (name, reward_type, reward_value, is_seasonal, starts_at, ends_at, active) VALUES (?,?,?,?,?,?,?)`)
      .run(a.name, a.reward_type, a.reward_value, a.is_seasonal ? 1 : 0, a.starts_at || null, a.ends_at || null, a.active ? 1 : 0).lastInsertRowid;
  }
  if (Array.isArray(a.category_ids)) {
    db.prepare('DELETE FROM album_requirements WHERE album_id = ?').run(id);
    for (const catId of a.category_ids) db.prepare('INSERT INTO album_requirements (album_id, category_id) VALUES (?,?)').run(id, catId);
  }
  return id;
}
export function deleteAlbum(id) {
  db.prepare('DELETE FROM album_requirements WHERE album_id = ?').run(id);
  db.prepare('DELETE FROM albums WHERE id = ?').run(id);
}
export function getAlbumRequirements(albumId) {
  return db.prepare(`
    SELECT ar.category_id, c.name, c.icon FROM album_requirements ar JOIN card_categories c ON c.id = ar.category_id
    WHERE ar.album_id = ?
  `).all(albumId);
}

export function getAlbumProgress(tgId, albumId) {
  const reqs = getAlbumRequirements(albumId);
  const progress = reqs.map(r => {
    const owns = db.prepare(`
      SELECT 1 FROM user_cards uc JOIN game_cards c ON c.id = uc.card_id
      WHERE uc.tg_id = ? AND c.category_id = ? LIMIT 1
    `).get(tgId, r.category_id);
    return { ...r, owned: !!owns };
  });
  const complete = reqs.length > 0 && progress.every(p => p.owned);
  const claimed = !!db.prepare('SELECT 1 FROM user_album_claims WHERE tg_id = ? AND album_id = ?').get(tgId, albumId);
  return { progress, complete, claimed };
}

export function claimAlbumReward(tgId, albumId) {
  const album = getAlbum(albumId);
  if (!album || !album.active) throw new Error('این آلبوم در دسترس نیست');
  if (album.is_seasonal && album.ends_at && new Date(album.ends_at.replace(' ', 'T') + 'Z').getTime() < Date.now()) {
    throw new Error('مهلت این آلبوم فصلی تموم شده');
  }
  const { complete, claimed } = getAlbumProgress(tgId, albumId);
  if (!complete) throw new Error('هنوز آلبوم کامل نشده');
  if (claimed) throw new Error('جایزه این آلبوم رو قبلا گرفتی');

  const tx = db.transaction(() => {
    if (album.reward_type === 'toman' && Number(album.reward_value) > 0) {
      adjustToman(tgId, Number(album.reward_value), `جایزه تکمیل آلبوم «${album.name}»`);
    } else if (album.reward_type === 'avatar' && album.reward_value) {
      grantAvatar(tgId, Number(album.reward_value));
    } else if (album.reward_type === 'card' && album.reward_value) {
      db.prepare('INSERT INTO user_cards (tg_id, card_id) VALUES (?,?)').run(tgId, Number(album.reward_value));
    }
    db.prepare('INSERT INTO user_album_claims (tg_id, album_id) VALUES (?,?)').run(tgId, albumId);
  });
  tx();
  return { rewardType: album.reward_type, rewardValue: album.reward_value };
}
