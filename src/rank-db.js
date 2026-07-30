import db from './db.js';
import { adjustToman, getUser } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS rank_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  xp_per_level INTEGER NOT NULL DEFAULT 100,
  xp_per_1k_purchase INTEGER NOT NULL DEFAULT 10,
  xp_per_win INTEGER NOT NULL DEFAULT 50,
  xp_per_quest INTEGER NOT NULL DEFAULT 30,
  xp_per_referral INTEGER NOT NULL DEFAULT 100,
  xp_per_checkin INTEGER NOT NULL DEFAULT 5
);
INSERT OR IGNORE INTO rank_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS rank_titles (
  level_threshold INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  icon TEXT
);
INSERT OR IGNORE INTO rank_titles (level_threshold, title, icon) VALUES
  (1,'تازه‌کار','🌱'), (10,'بازیکن','⭐'), (25,'جنگجو','⚔️'),
  (50,'قهرمان','🏆'), (75,'افسانه‌ای','🔥'), (100,'خدای بازی','👑');

CREATE TABLE IF NOT EXISTS avatars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  image_url TEXT,
  price_toman INTEGER NOT NULL DEFAULT 0,
  quantity INTEGER,          -- خالی = نامحدود
  sold_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'shop', -- shop | battlepass | event
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_rank (
  tg_id INTEGER PRIMARY KEY,
  xp INTEGER NOT NULL DEFAULT 0,
  equipped_avatar_id INTEGER
);

CREATE TABLE IF NOT EXISTS user_avatars (
  tg_id INTEGER NOT NULL,
  avatar_id INTEGER NOT NULL,
  obtained_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tg_id, avatar_id)
);

CREATE TABLE IF NOT EXISTS daily_checkins (
  tg_id INTEGER NOT NULL,
  checkin_date TEXT NOT NULL DEFAULT (date('now')),
  PRIMARY KEY (tg_id, checkin_date)
);
`);

export function getRankConfig() { return db.prepare('SELECT * FROM rank_config WHERE id = 1').get(); }
export function setRankConfig(c) {
  db.prepare(`
    UPDATE rank_config SET enabled=?, xp_per_level=?, xp_per_1k_purchase=?, xp_per_win=?, xp_per_quest=?, xp_per_referral=?, xp_per_checkin=?
    WHERE id = 1
  `).run(c.enabled ? 1 : 0, c.xp_per_level, c.xp_per_1k_purchase, c.xp_per_win, c.xp_per_quest, c.xp_per_referral, c.xp_per_checkin);
}

export function listRankTitles() { return db.prepare('SELECT * FROM rank_titles ORDER BY level_threshold ASC').all(); }
export function upsertRankTitle(t) {
  db.prepare(`
    INSERT INTO rank_titles (level_threshold, title, icon) VALUES (?,?,?)
    ON CONFLICT(level_threshold) DO UPDATE SET title=excluded.title, icon=excluded.icon
  `).run(t.level_threshold, t.title, t.icon || '');
}
export function deleteRankTitle(threshold) { db.prepare('DELETE FROM rank_titles WHERE level_threshold = ?').run(threshold); }
function getTitleForLevel(level) {
  const titles = listRankTitles();
  let best = titles[0] || { title: '', icon: '' };
  for (const t of titles) if (level >= t.level_threshold) best = t;
  return best;
}

function getOrCreateUserRank(tgId) {
  db.prepare('INSERT OR IGNORE INTO user_rank (tg_id) VALUES (?)').run(tgId);
  return db.prepare('SELECT * FROM user_rank WHERE tg_id = ?').get(tgId);
}
export function addUserXp(tgId, amount) {
  const cfg = getRankConfig();
  if (!cfg.enabled || !amount) return;
  getOrCreateUserRank(tgId);
  db.prepare('UPDATE user_rank SET xp = xp + ? WHERE tg_id = ?').run(amount, tgId);
}
export function getUserRankInfo(tgId) {
  const cfg = getRankConfig();
  const ur = getOrCreateUserRank(tgId);
  const level = Math.max(1, Math.floor(ur.xp / cfg.xp_per_level) + 1);
  const titleInfo = getTitleForLevel(level);
  const xpIntoLevel = ur.xp % cfg.xp_per_level;
  const avatarImage = ur.equipped_avatar_id ? (getAvatar(ur.equipped_avatar_id)?.image_url || null) : null;
  return { xp: ur.xp, level, title: titleInfo.title, icon: titleInfo.icon, xpIntoLevel, xpPerLevel: cfg.xp_per_level, equippedAvatarId: ur.equipped_avatar_id, avatarImage };
}

// جدول امتیازات لول: بر اساس بیشترین XP (که مستقیم معادل بالاترین لوله)
export function getLevelLeaderboard(limit = 10) {
  const cfg = getRankConfig();
  const rows = db.prepare(`
    SELECT ur.tg_id, ur.xp, ur.equipped_avatar_id, u.first_name, u.username, av.image_url AS avatar_image
    FROM user_rank ur JOIN users u ON u.tg_id = ur.tg_id
    LEFT JOIN avatars av ON av.id = ur.equipped_avatar_id
    ORDER BY ur.xp DESC LIMIT ?
  `).all(limit);
  return rows.map(r => {
    const level = Math.max(1, Math.floor(r.xp / cfg.xp_per_level) + 1);
    const titleInfo = getTitleForLevel(level);
    return { tg_id: r.tg_id, xp: r.xp, level, title: titleInfo.title, icon: titleInfo.icon, first_name: r.first_name, username: r.username, avatarImage: r.avatar_image || null };
  });
}
export function getUserLevelRank(tgId) {
  const row = db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM user_rank
    WHERE xp > (SELECT COALESCE(xp,0) FROM user_rank WHERE tg_id = ?)
  `).get(tgId);
  return row.rank;
}
// ردیف خود کاربر تو جدول لول (حتی اگه تو ۱۰ نفر برتر نباشه)
export function getUserLevelRow(tgId) {
  const info = getUserRankInfo(tgId);
  const user = getUser(tgId);
  return { tg_id: tgId, xp: info.xp, level: info.level, title: info.title, icon: info.icon, first_name: user?.first_name, username: user?.username, avatarImage: info.avatarImage };
}

export function canCheckinToday(tgId) {
  return !db.prepare(`SELECT 1 FROM daily_checkins WHERE tg_id = ? AND checkin_date = date('now')`).get(tgId);
}
export function doCheckin(tgId) {
  if (!canCheckinToday(tgId)) throw new Error('امروز قبلا چک‌این کردی');
  const cfg = getRankConfig();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO daily_checkins (tg_id) VALUES (?)').run(tgId);
    addUserXp(tgId, cfg.xp_per_checkin);
  });
  tx();
  return { xpGained: cfg.xp_per_checkin };
}

/* ---------- آواتارها ---------- */
export function listAvatars(onlyActive = false) {
  return onlyActive
    ? db.prepare('SELECT * FROM avatars WHERE active = 1 ORDER BY price_toman ASC').all()
    : db.prepare('SELECT * FROM avatars ORDER BY id DESC').all();
}
export function getAvatar(id) { return db.prepare('SELECT * FROM avatars WHERE id = ?').get(id); }
export function upsertAvatar(a) {
  if (a.id) {
    db.prepare(`UPDATE avatars SET name=?, image_url=?, price_toman=?, quantity=?, source=?, active=? WHERE id=?`)
      .run(a.name, a.image_url || null, a.price_toman, a.quantity, a.source || 'shop', a.active ? 1 : 0, a.id);
    return a.id;
  }
  return db.prepare(`INSERT INTO avatars (name, image_url, price_toman, quantity, source, active) VALUES (?,?,?,?,?,?)`)
    .run(a.name, a.image_url || null, a.price_toman, a.quantity, a.source || 'shop', a.active ? 1 : 0).lastInsertRowid;
}
export function deleteAvatar(id) { db.prepare('DELETE FROM avatars WHERE id = ?').run(id); }

export function getMyAvatars(tgId) {
  return db.prepare(`
    SELECT ua.*, av.name, av.image_url, av.source FROM user_avatars ua JOIN avatars av ON av.id = ua.avatar_id
    WHERE ua.tg_id = ? ORDER BY ua.obtained_at DESC
  `).all(tgId);
}
export function buyAvatar(tgId, avatarId) {
  const avatar = getAvatar(avatarId);
  if (!avatar || !avatar.active) throw new Error('این آواتار در دسترس نیست');
  const already = db.prepare('SELECT 1 FROM user_avatars WHERE tg_id = ? AND avatar_id = ?').get(tgId, avatarId);
  if (already) throw new Error('این آواتار رو قبلا داری');
  if (avatar.quantity != null && avatar.sold_count >= avatar.quantity) throw new Error('موجودی این آواتار تموم شده');
  const user = getUser(tgId);
  if (!user || user.balance_toman < avatar.price_toman) throw new Error('موجودی کیف‌پول کافی نیست');

  const tx = db.transaction(() => {
    if (avatar.price_toman > 0) adjustToman(tgId, -avatar.price_toman, `خرید آواتار «${avatar.name}»`);
    db.prepare('INSERT INTO user_avatars (tg_id, avatar_id) VALUES (?,?)').run(tgId, avatarId);
    db.prepare('UPDATE avatars SET sold_count = sold_count + 1 WHERE id = ?').run(avatarId);
  });
  tx();
}
// برای دادن آواتار رایگان از منابع دیگه (بتل‌پس، ایونت) — بدون پرداخت
export function grantAvatar(tgId, avatarId) {
  const already = db.prepare('SELECT 1 FROM user_avatars WHERE tg_id = ? AND avatar_id = ?').get(tgId, avatarId);
  if (already) return;
  db.prepare('INSERT INTO user_avatars (tg_id, avatar_id) VALUES (?,?)').run(tgId, avatarId);
  db.prepare('UPDATE avatars SET sold_count = sold_count + 1 WHERE id = ?').run(avatarId);
}
export function equipAvatar(tgId, avatarId) {
  const owned = db.prepare('SELECT 1 FROM user_avatars WHERE tg_id = ? AND avatar_id = ?').get(tgId, avatarId);
  if (!owned) throw new Error('این آواتار رو نداری');
  getOrCreateUserRank(tgId);
  db.prepare('UPDATE user_rank SET equipped_avatar_id = ? WHERE tg_id = ?').run(avatarId, tgId);
}
