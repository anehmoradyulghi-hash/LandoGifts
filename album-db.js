import db from './db.js';
import { adjustToman } from './db.js';
import { grantAvatar } from './rank-db.js';
import { grantCardInstance, getGameCard } from './game-db.js';

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

CREATE TABLE IF NOT EXISTS album_reward_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  level INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS user_album_claims (
  tg_id INTEGER NOT NULL,
  album_id INTEGER NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tg_id, album_id)
);
`);

// Minimum card level required within each required category — added after album_requirements
// already shipped without it, so existing installs need this migration to pick it up.
function safeAddColumn(table, columnDef) {
  const col = columnDef.split(' ')[0];
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
}
safeAddColumn('album_requirements', 'min_level INTEGER NOT NULL DEFAULT 1');

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
  // Requirements: [{ category_id, min_level }] — replaces the whole set each save
  if (Array.isArray(a.requirements)) {
    db.prepare('DELETE FROM album_requirements WHERE album_id = ?').run(id);
    for (const r of a.requirements) {
      if (!r.category_id) continue;
      db.prepare('INSERT INTO album_requirements (album_id, category_id, min_level) VALUES (?,?,?)')
        .run(id, Number(r.category_id), Math.max(1, Number(r.min_level) || 1));
    }
  }
  // Reward cards: [{ card_id, level }] — only meaningful when reward_type === 'card', but harmless
  // to store regardless (simply unused unless the album is set to give cards).
  if (Array.isArray(a.reward_cards)) {
    db.prepare('DELETE FROM album_reward_cards WHERE album_id = ?').run(id);
    for (const rc of a.reward_cards) {
      if (!rc.card_id) continue;
      db.prepare('INSERT INTO album_reward_cards (album_id, card_id, level) VALUES (?,?,?)')
        .run(id, Number(rc.card_id), Math.max(1, Number(rc.level) || 1));
    }
  }
  return id;
}
export function deleteAlbum(id) {
  db.prepare('DELETE FROM album_requirements WHERE album_id = ?').run(id);
  db.prepare('DELETE FROM album_reward_cards WHERE album_id = ?').run(id);
  db.prepare('DELETE FROM albums WHERE id = ?').run(id);
}
export function getAlbumRequirements(albumId) {
  return db.prepare(`
    SELECT ar.category_id, ar.min_level, c.name, c.icon FROM album_requirements ar JOIN card_categories c ON c.id = ar.category_id
    WHERE ar.album_id = ?
  `).all(albumId);
}
export function getAlbumRewardCards(albumId) {
  return db.prepare('SELECT * FROM album_reward_cards WHERE album_id = ?').all(albumId).map(rc => {
    const card = getGameCard(rc.card_id);
    return { ...rc, name: card?.name || 'Deleted card', image_url: card?.image_url || null };
  });
}

export function getAlbumProgress(tgId, albumId) {
  const reqs = getAlbumRequirements(albumId);
  const progress = reqs.map(r => {
    const owns = db.prepare(`
      SELECT 1 FROM user_cards uc JOIN game_cards c ON c.id = uc.card_id
      WHERE uc.tg_id = ? AND c.category_id = ? AND uc.level >= ? LIMIT 1
    `).get(tgId, r.category_id, r.min_level || 1);
    return { ...r, owned: !!owns };
  });
  const complete = reqs.length > 0 && progress.every(p => p.owned);
  const claimed = !!db.prepare('SELECT 1 FROM user_album_claims WHERE tg_id = ? AND album_id = ?').get(tgId, albumId);
  return { progress, complete, claimed };
}

export function claimAlbumReward(tgId, albumId) {
  const album = getAlbum(albumId);
  if (!album || !album.active) throw new Error('This album is not available');
  if (album.is_seasonal && album.ends_at && new Date(album.ends_at.replace(' ', 'T') + 'Z').getTime() < Date.now()) {
    throw new Error('This seasonal album deadline has passed');
  }
  const { complete, claimed } = getAlbumProgress(tgId, albumId);
  if (!complete) throw new Error('The album is not complete yet');
  if (claimed) throw new Error('You have already claimed this album reward');

  const tx = db.transaction(() => {
    if (album.reward_type === 'toman' && Number(album.reward_value) > 0) {
      adjustToman(tgId, Number(album.reward_value), `Album completion reward «${album.name}»`);
    } else if (album.reward_type === 'avatar' && album.reward_value) {
      grantAvatar(tgId, Number(album.reward_value));
    } else if (album.reward_type === 'card') {
      const rewardCards = getAlbumRewardCards(albumId);
      for (const rc of rewardCards) grantCardInstance(tgId, rc.card_id, rc.level);
    }
    db.prepare('INSERT INTO user_album_claims (tg_id, album_id) VALUES (?,?)').run(tgId, albumId);
  });
  tx();
  return { rewardType: album.reward_type, rewardValue: album.reward_value, rewardCards: album.reward_type === 'card' ? getAlbumRewardCards(albumId) : [] };
}
