import db from './db.js';
import { adjustToman, getUser } from './db.js';

export async function getRankConfig() { return await db.prepare('SELECT * FROM rank_config WHERE id = 1').get(); }
export async function setRankConfig(c) {
  await db.prepare(`
    UPDATE rank_config SET enabled=?, xp_per_level=?, xp_per_1k_purchase=?, xp_per_win=?, xp_per_quest=?, xp_per_referral=?, xp_per_checkin=?
    WHERE id = 1
  `).run(c.enabled ? 1 : 0, c.xp_per_level, c.xp_per_1k_purchase, c.xp_per_win, c.xp_per_quest, c.xp_per_referral, c.xp_per_checkin);
}

export async function listRankTitles() { return await db.prepare('SELECT * FROM rank_titles ORDER BY level_threshold ASC').all(); }
export async function upsertRankTitle(t) {
  await db.prepare(`
    INSERT INTO rank_titles (level_threshold, title, icon) VALUES (?,?,?)
    ON CONFLICT(level_threshold) DO UPDATE SET title=excluded.title, icon=excluded.icon
  `).run(t.level_threshold, t.title, t.icon || '');
}
export async function deleteRankTitle(threshold) { await db.prepare('DELETE FROM rank_titles WHERE level_threshold = ?').run(threshold); }
async function getTitleForLevel(level) {
  const titles = await listRankTitles();
  let best = titles[0] || { title: '', icon: '' };
  for (const t of titles) if (level >= t.level_threshold) best = t;
  return best;
}

async function getOrCreateUserRank(tgId) {
  await db.prepare('INSERT INTO user_rank (tg_id) VALUES (?) ON CONFLICT (tg_id) DO NOTHING').run(tgId);
  return await db.prepare('SELECT * FROM user_rank WHERE tg_id = ?').get(tgId);
}
export async function addUserXp(tgId, amount) {
  const cfg = await getRankConfig();
  if (!cfg.enabled || !amount) return;
  await getOrCreateUserRank(tgId);
  await db.prepare('UPDATE user_rank SET xp = xp + ? WHERE tg_id = ?').run(amount, tgId);
}
export async function getUserRankInfo(tgId) {
  const cfg = await getRankConfig();
  const ur = await getOrCreateUserRank(tgId);
  const level = Math.max(1, Math.floor(ur.xp / cfg.xp_per_level) + 1);
  const titleInfo = await getTitleForLevel(level);
  const xpIntoLevel = ur.xp % cfg.xp_per_level;
  const avatarImage = ur.equipped_avatar_id ? ((await getAvatar(ur.equipped_avatar_id))?.image_url || null) : null;
  return { xp: ur.xp, level, title: titleInfo.title, icon: titleInfo.icon, xpIntoLevel, xpPerLevel: cfg.xp_per_level, equippedAvatarId: ur.equipped_avatar_id, avatarImage };
}

// Level leaderboard: based on highest XP (which directly equals the highest level)
export async function getLevelLeaderboard(limit = 10) {
  const cfg = await getRankConfig();
  const rows = await db.prepare(`
    SELECT ur.tg_id, ur.xp, ur.equipped_avatar_id, u.first_name, u.username, av.image_url AS avatar_image
    FROM user_rank ur JOIN users u ON u.tg_id = ur.tg_id
    LEFT JOIN avatars av ON av.id = ur.equipped_avatar_id
    ORDER BY ur.xp DESC LIMIT ?
  `).all(limit);
  return Promise.all(rows.map(async r => {
    const level = Math.max(1, Math.floor(r.xp / cfg.xp_per_level) + 1);
    const titleInfo = await getTitleForLevel(level);
    return { tg_id: r.tg_id, xp: r.xp, level, title: titleInfo.title, icon: titleInfo.icon, first_name: r.first_name, username: r.username, avatarImage: r.avatar_image || null };
  }));
}
export async function getUserLevelRank(tgId) {
  const row = await db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM user_rank
    WHERE xp > (SELECT COALESCE(xp,0) FROM user_rank WHERE tg_id = ?)
  `).get(tgId);
  return row.rank;
}
// The user's own row in the level leaderboard (even if not in the top 10)
export async function getUserLevelRow(tgId) {
  const info = await getUserRankInfo(tgId);
  const user = await getUser(tgId);
  return { tg_id: tgId, xp: info.xp, level: info.level, title: info.title, icon: info.icon, first_name: user?.first_name, username: user?.username, avatarImage: info.avatarImage };
}

export async function canCheckinToday(tgId) {
  return !await db.prepare(`SELECT 1 FROM daily_checkins WHERE tg_id = ? AND checkin_date = today_text()`).get(tgId);
}
export async function doCheckin(tgId) {
  if (!await canCheckinToday(tgId)) throw new Error('You have already checked in today');
  const cfg = await getRankConfig();
  const tx = db.transaction(async () => {
    await db.prepare('INSERT INTO daily_checkins (tg_id) VALUES (?)').run(tgId);
    await addUserXp(tgId, cfg.xp_per_checkin);
  });
  await tx();
  return { xpGained: cfg.xp_per_checkin };
}

/* ---------- Avatars ---------- */
export async function listAvatars(onlyActive = false) {
  return onlyActive
    ? await db.prepare('SELECT * FROM avatars WHERE active = 1 ORDER BY price_toman ASC').all()
    : await db.prepare('SELECT * FROM avatars ORDER BY id DESC').all();
}
export async function getAvatar(id) { return await db.prepare('SELECT * FROM avatars WHERE id = ?').get(id); }
export async function upsertAvatar(a) {
  if (a.id) {
    await db.prepare(`UPDATE avatars SET name=?, image_url=?, price_toman=?, quantity=?, source=?, active=? WHERE id=?`)
      .run(a.name, a.image_url || null, a.price_toman, a.quantity, a.source || 'shop', a.active ? 1 : 0, a.id);
    return a.id;
  }
  return (await db.prepare(`INSERT INTO avatars (name, image_url, price_toman, quantity, source, active) VALUES (?,?,?,?,?,?)`)
    .run(a.name, a.image_url || null, a.price_toman, a.quantity, a.source || 'shop', a.active ? 1 : 0)).lastInsertRowid;
}
export async function deleteAvatar(id) { await db.prepare('DELETE FROM avatars WHERE id = ?').run(id); }

export async function getMyAvatars(tgId) {
  return await db.prepare(`
    SELECT ua.*, av.name, av.image_url, av.source FROM user_avatars ua JOIN avatars av ON av.id = ua.avatar_id
    WHERE ua.tg_id = ? ORDER BY ua.obtained_at DESC
  `).all(tgId);
}
export async function buyAvatar(tgId, avatarId) {
  const avatar = await getAvatar(avatarId);
  if (!avatar || !avatar.active) throw new Error('This avatar is not available');
  const already = await db.prepare('SELECT 1 FROM user_avatars WHERE tg_id = ? AND avatar_id = ?').get(tgId, avatarId);
  if (already) throw new Error('You already have this avatar');
  if (avatar.quantity != null && avatar.sold_count >= avatar.quantity) throw new Error('This avatar is out of stock');
  const user = await getUser(tgId);
  if (!user || user.balance_toman < avatar.price_toman) throw new Error('Insufficient wallet balance');

  const tx = db.transaction(async () => {
    if (avatar.price_toman > 0) await adjustToman(tgId, -avatar.price_toman, `Avatar purchase «${avatar.name}»`);
    await db.prepare('INSERT INTO user_avatars (tg_id, avatar_id) VALUES (?,?)').run(tgId, avatarId);
    await db.prepare('UPDATE avatars SET sold_count = sold_count + 1 WHERE id = ?').run(avatarId);
  });
  await tx();
}
// For giving a free avatar from other sources (battle pass, event) — without payment
export async function grantAvatar(tgId, avatarId) {
  const already = await db.prepare('SELECT 1 FROM user_avatars WHERE tg_id = ? AND avatar_id = ?').get(tgId, avatarId);
  if (already) return;
  await db.prepare('INSERT INTO user_avatars (tg_id, avatar_id) VALUES (?,?)').run(tgId, avatarId);
  await db.prepare('UPDATE avatars SET sold_count = sold_count + 1 WHERE id = ?').run(avatarId);
}
export async function equipAvatar(tgId, avatarId) {
  const owned = await db.prepare('SELECT 1 FROM user_avatars WHERE tg_id = ? AND avatar_id = ?').get(tgId, avatarId);
  if (!owned) throw new Error('You do not have this avatar');
  await getOrCreateUserRank(tgId);
  await db.prepare('UPDATE user_rank SET equipped_avatar_id = ? WHERE tg_id = ?').run(avatarId, tgId);
}
