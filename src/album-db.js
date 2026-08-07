import db from './db.js';
import { adjustToman } from './db.js';
import { grantAvatar } from './rank-db.js';
import { grantCardInstance } from './game-db.js';

export async function listAlbums(onlyActive = false) {
  const rows = onlyActive
    ? await db.prepare('SELECT * FROM albums WHERE active = 1 ORDER BY id DESC').all()
    : await db.prepare('SELECT * FROM albums ORDER BY id DESC').all();
  const now = Date.now();
  return rows.filter(a => {
    if (!onlyActive) return true;
    if (a.is_seasonal && a.ends_at && new Date(a.ends_at.replace(' ', 'T') + 'Z').getTime() < now) return false;
    return true;
  });
}
export async function getAlbum(id) { return await db.prepare('SELECT * FROM albums WHERE id = ?').get(id); }
export async function upsertAlbum(a) {
  let id = a.id;
  if (id) {
    await db.prepare(`UPDATE albums SET name=?, reward_type=?, reward_value=?, is_seasonal=?, starts_at=?, ends_at=?, active=? WHERE id=?`)
      .run(a.name, a.reward_type, a.reward_value, a.is_seasonal ? 1 : 0, a.starts_at || null, a.ends_at || null, a.active ? 1 : 0, id);
  } else {
    id = (await db.prepare(`INSERT INTO albums (name, reward_type, reward_value, is_seasonal, starts_at, ends_at, active) VALUES (?,?,?,?,?,?,?)`)
      .run(a.name, a.reward_type, a.reward_value, a.is_seasonal ? 1 : 0, a.starts_at || null, a.ends_at || null, a.active ? 1 : 0)).lastInsertRowid;
  }
  if (Array.isArray(a.category_ids)) {
    await db.prepare('DELETE FROM album_requirements WHERE album_id = ?').run(id);
    for (const catId of a.category_ids) await db.prepare('INSERT INTO album_requirements (album_id, category_id) VALUES (?,?)').run(id, catId);
  }
  return id;
}
export async function deleteAlbum(id) {
  await db.prepare('DELETE FROM album_requirements WHERE album_id = ?').run(id);
  await db.prepare('DELETE FROM albums WHERE id = ?').run(id);
}
export async function getAlbumRequirements(albumId) {
  return await db.prepare(`
    SELECT ar.category_id, c.name, c.icon FROM album_requirements ar JOIN card_categories c ON c.id = ar.category_id
    WHERE ar.album_id = ?
  `).all(albumId);
}

export async function getAlbumProgress(tgId, albumId) {
  const reqs = await getAlbumRequirements(albumId);
  const progress = await Promise.all(reqs.map(async r => {
    const owns = await db.prepare(`
      SELECT 1 FROM user_cards uc JOIN game_cards c ON c.id = uc.card_id
      WHERE uc.tg_id = ? AND c.category_id = ? LIMIT 1
    `).get(tgId, r.category_id);
    return { ...r, owned: !!owns };
  }));
  const complete = reqs.length > 0 && progress.every(p => p.owned);
  const claimed = !!await db.prepare('SELECT 1 FROM user_album_claims WHERE tg_id = ? AND album_id = ?').get(tgId, albumId);
  return { progress, complete, claimed };
}

export async function claimAlbumReward(tgId, albumId) {
  const album = await getAlbum(albumId);
  if (!album || !album.active) throw new Error('This album is not available');
  if (album.is_seasonal && album.ends_at && new Date(album.ends_at.replace(' ', 'T') + 'Z').getTime() < Date.now()) {
    throw new Error('This seasonal album deadline has passed');
  }
  const { complete, claimed } = await getAlbumProgress(tgId, albumId);
  if (!complete) throw new Error('The album is not complete yet');
  if (claimed) throw new Error('You have already claimed this album reward');

  const tx = db.transaction(async () => {
    if (album.reward_type === 'toman' && Number(album.reward_value) > 0) {
      await adjustToman(tgId, Number(album.reward_value), `Album completion reward «${album.name}»`);
    } else if (album.reward_type === 'avatar' && album.reward_value) {
      await grantAvatar(tgId, Number(album.reward_value));
    } else if (album.reward_type === 'card' && album.reward_value) {
      await grantCardInstance(tgId, Number(album.reward_value));
    }
    await db.prepare('INSERT INTO user_album_claims (tg_id, album_id) VALUES (?,?)').run(tgId, albumId);
  });
  await tx();
  return { rewardType: album.reward_type, rewardValue: album.reward_value };
}
