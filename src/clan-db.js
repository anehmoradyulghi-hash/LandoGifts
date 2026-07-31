import db from './db.js';
import { adjustToman, getUser } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS clan_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  creation_cost_toman INTEGER NOT NULL DEFAULT 50000,
  max_members INTEGER NOT NULL DEFAULT 20,
  score_per_1k_purchase INTEGER NOT NULL DEFAULT 10,
  score_per_win INTEGER NOT NULL DEFAULT 5,
  score_per_1k_donation INTEGER NOT NULL DEFAULT 20,
  reward_toman INTEGER NOT NULL DEFAULT 0,
  winners_count INTEGER NOT NULL DEFAULT 1,     -- 1 یا 3
  distribution_method TEXT NOT NULL DEFAULT 'equal', -- equal | donation_share
  min_score_threshold INTEGER NOT NULL DEFAULT 0,
  reset_days INTEGER NOT NULL DEFAULT 7
);
INSERT OR IGNORE INTO clan_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS clans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  tag TEXT NOT NULL UNIQUE,
  avatar_url TEXT,
  owner_tg_id INTEGER NOT NULL,
  bank_balance INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clan_members (
  tg_id INTEGER PRIMARY KEY,
  clan_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', -- owner | admin | member
  donated_total INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clan_donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clan_id INTEGER NOT NULL,
  tg_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  period_started_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO clan_state (id) VALUES (1);
`);

function safeAddColumn(table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
// چقدر از سهم اهدایی خودش رو تا الان برداشت/هدیه داده — برای اینکه بیشتر از مشارکت خودش نتونه برداره
safeAddColumn('clan_members', 'withdrawn_total INTEGER NOT NULL DEFAULT 0');

export function getClanConfig() { return db.prepare('SELECT * FROM clan_config WHERE id = 1').get(); }
export function setClanConfig(c) {
  db.prepare(`
    UPDATE clan_config SET enabled=?, creation_cost_toman=?, max_members=?, score_per_1k_purchase=?, score_per_win=?,
      score_per_1k_donation=?, reward_toman=?, winners_count=?, distribution_method=?, min_score_threshold=?, reset_days=?
    WHERE id = 1
  `).run(c.enabled ? 1 : 0, c.creation_cost_toman, c.max_members, c.score_per_1k_purchase, c.score_per_win,
    c.score_per_1k_donation, c.reward_toman, c.winners_count, c.distribution_method, c.min_score_threshold, c.reset_days);
}

export function getMyClan(tgId) {
  const member = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(tgId);
  if (!member) return null;
  const clan = db.prepare('SELECT * FROM clans WHERE id = ?').get(member.clan_id);
  return clan ? { ...clan, myRole: member.role, myDonatedTotal: member.donated_total, myWithdrawnTotal: member.withdrawn_total, myWithdrawableRemaining: clan.bank_balance } : null;
}
export function getClanById(id) { return db.prepare('SELECT * FROM clans WHERE id = ?').get(id); }
export function getClanMembers(clanId) {
  return db.prepare(`
    SELECT cm.*, u.first_name, u.username FROM clan_members cm JOIN users u ON u.tg_id = cm.tg_id
    WHERE cm.clan_id = ? ORDER BY cm.donated_total DESC
  `).all(clanId);
}
export function searchClans(query) {
  const like = `%${query || ''}%`;
  return db.prepare('SELECT * FROM clans WHERE name LIKE ? OR tag LIKE ? ORDER BY score DESC LIMIT 30').all(like, like);
}
export function getClanLeaderboard(limit = 10) {
  return db.prepare('SELECT * FROM clans ORDER BY score DESC LIMIT ?').all(limit);
}
export function getClanRank(clanId) {
  const row = db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM clans
    WHERE score > (SELECT COALESCE(score,0) FROM clans WHERE id = ?)
  `).get(clanId);
  return row.rank;
}

export function createClan(tgId, name, tag, avatarUrl) {
  const cfg = getClanConfig();
  if (!cfg.enabled) throw new Error('سیستم کلن فعلا غیرفعاله');
  if (getMyClan(tgId)) throw new Error('قبلا عضو یه کلن هستی');
  if (!name || !tag) throw new Error('اسم و تگ کلن لازمه');
  const exists = db.prepare('SELECT 1 FROM clans WHERE tag = ?').get(tag);
  if (exists) throw new Error('این تگ قبلا استفاده شده');
  const user = getUser(tgId);
  if (!user || user.balance_toman < cfg.creation_cost_toman) throw new Error(`برای ساخت کلن ${cfg.creation_cost_toman.toLocaleString()} تومان لازمه`);

  let clanId;
  const tx = db.transaction(() => {
    adjustToman(tgId, -cfg.creation_cost_toman, `ساخت کلن «${name}»`);
    clanId = db.prepare('INSERT INTO clans (name, tag, avatar_url, owner_tg_id) VALUES (?,?,?,?)').run(name, tag, avatarUrl || null, tgId).lastInsertRowid;
    db.prepare(`INSERT INTO clan_members (tg_id, clan_id, role) VALUES (?,?,'owner')`).run(tgId, clanId);
  });
  tx();
  return clanId;
}

export function joinClan(tgId, clanId) {
  const cfg = getClanConfig();
  if (!cfg.enabled) throw new Error('سیستم کلن فعلا غیرفعاله');
  if (getMyClan(tgId)) throw new Error('قبلا عضو یه کلن هستی');
  const clan = getClanById(clanId);
  if (!clan) throw new Error('کلن پیدا نشد');
  const memberCount = db.prepare('SELECT COUNT(*) c FROM clan_members WHERE clan_id = ?').get(clanId).c;
  if (memberCount >= cfg.max_members) throw new Error('این کلن پره');
  db.prepare(`INSERT INTO clan_members (tg_id, clan_id, role) VALUES (?,?,'member')`).run(tgId, clanId);
}

// اگه رهبر بره، کلن کامل منحل می‌شه؛ عضو عادی فقط خارج می‌شه
export function leaveClan(tgId) {
  const member = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(tgId);
  if (!member) throw new Error('تو هیچ کلنی نیستی');
  if (member.role === 'owner') {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM clan_members WHERE clan_id = ?').run(member.clan_id);
      db.prepare('DELETE FROM clans WHERE id = ?').run(member.clan_id);
    });
    tx();
    return { disbanded: true };
  }
  db.prepare('DELETE FROM clan_members WHERE tg_id = ?').run(tgId);
  return { disbanded: false };
}

export function kickMember(ownerTgId, targetTgId) {
  const owner = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(ownerTgId);
  if (!owner || owner.role !== 'owner') throw new Error('فقط رهبر کلن می‌تونه اخراج کنه');
  const target = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(targetTgId);
  if (!target || target.clan_id !== owner.clan_id) throw new Error('این کاربر تو کلن تو نیست');
  if (target.role === 'owner') throw new Error('نمی‌تونی خودتو اخراج کنی');
  db.prepare('DELETE FROM clan_members WHERE tg_id = ?').run(targetTgId);
}
export function setMemberRole(ownerTgId, targetTgId, role) {
  const owner = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(ownerTgId);
  if (!owner || owner.role !== 'owner') throw new Error('فقط رهبر کلن می‌تونه نقش بده');
  const target = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(targetTgId);
  if (!target || target.clan_id !== owner.clan_id) throw new Error('این کاربر تو کلن تو نیست');
  db.prepare(`UPDATE clan_members SET role = ? WHERE tg_id = ?`).run(role === 'admin' ? 'admin' : 'member', targetTgId);
}

export function donateToClan(tgId, amount) {
  const member = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(tgId);
  if (!member) throw new Error('تو هیچ کلنی نیستی');
  if (!amount || amount <= 0) throw new Error('مبلغ نامعتبره');
  const user = getUser(tgId);
  if (!user || user.balance_toman < amount) throw new Error('موجودی کافی نیست');
  const cfg = getClanConfig();
  const scoreGain = Math.floor(amount / 1000) * cfg.score_per_1k_donation;

  const tx = db.transaction(() => {
    adjustToman(tgId, -amount, 'اهدا به بانک کلن');
    db.prepare('UPDATE clans SET bank_balance = bank_balance + ?, score = score + ? WHERE id = ?').run(amount, scoreGain, member.clan_id);
    db.prepare('UPDATE clan_members SET donated_total = donated_total + ? WHERE tg_id = ?').run(amount, tgId);
    db.prepare('INSERT INTO clan_donations (clan_id, tg_id, amount) VALUES (?,?,?)').run(member.clan_id, tgId, amount);
  });
  tx();
}

// رهبر کلن می‌تونه از بانک کلن (پول‌هایی که اعضا اهدا کردن) برداشت کنه به کیف‌پول خودش
export function withdrawFromClanBank(ownerTgId, amount) {
  const owner = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(ownerTgId);
  if (!owner || owner.role !== 'owner') throw new Error('فقط رهبر کلن می‌تونه از بانک کلن برداشت کنه');
  if (!amount || amount <= 0) throw new Error('مبلغ نامعتبره');
  const clan = getClanById(owner.clan_id);
  if (!clan || clan.bank_balance < amount) throw new Error('موجودی بانک کلن کافی نیست');
  const tx = db.transaction(() => {
    db.prepare('UPDATE clans SET bank_balance = bank_balance - ? WHERE id = ?').run(amount, clan.id);
    db.prepare('UPDATE clan_members SET withdrawn_total = withdrawn_total + ? WHERE tg_id = ?').run(amount, ownerTgId);
    adjustToman(ownerTgId, amount, `برداشت از بانک کلن «${clan.name}»`);
  });
  tx();
}
// رهبر کلن می‌تونه از بانک کلن مستقیم به یکی از اعضا هدیه بده
export function giftFromClanBank(ownerTgId, targetTgId, amount) {
  const owner = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(ownerTgId);
  if (!owner || owner.role !== 'owner') throw new Error('فقط رهبر کلن می‌تونه از بانک کلن هدیه بده');
  if (!amount || amount <= 0) throw new Error('مبلغ نامعتبره');
  const target = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(targetTgId);
  if (!target || target.clan_id !== owner.clan_id) throw new Error('این کاربر تو کلن تو نیست');
  const clan = getClanById(owner.clan_id);
  if (!clan || clan.bank_balance < amount) throw new Error('موجودی بانک کلن کافی نیست');
  const tx = db.transaction(() => {
    db.prepare('UPDATE clans SET bank_balance = bank_balance - ? WHERE id = ?').run(amount, clan.id);
    db.prepare('UPDATE clan_members SET withdrawn_total = withdrawn_total + ? WHERE tg_id = ?').run(amount, ownerTgId);
    adjustToman(targetTgId, amount, `هدیه از بانک کلن «${clan.name}»`);
  });
  tx();
}

// هوک‌هایی که از بخش‌های دیگه صدا زده می‌شن (خرید از فروشگاه، برد بازی)
export function addClanPurchaseScore(tgId, amountToman) {
  const member = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(tgId);
  if (!member) return;
  const cfg = getClanConfig();
  const scoreGain = Math.floor(amountToman / 1000) * cfg.score_per_1k_purchase;
  if (scoreGain > 0) db.prepare('UPDATE clans SET score = score + ? WHERE id = ?').run(scoreGain, member.clan_id);
}
export function addClanWinScore(tgId) {
  const member = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(tgId);
  if (!member) return;
  const cfg = getClanConfig();
  if (cfg.score_per_win > 0) db.prepare('UPDATE clans SET score = score + ? WHERE id = ?').run(cfg.score_per_win, member.clan_id);
}

export function getClanState() { return db.prepare('SELECT * FROM clan_state WHERE id = 1').get(); }

// جوایز کلن‌های برتر رو پخش و امتیازها رو صفر می‌کنه (بانک دست‌نخورده می‌مونه)
export function resetClanSeason(notifyFn) {
  const cfg = getClanConfig();
  const top = db.prepare('SELECT * FROM clans WHERE score >= ? ORDER BY score DESC LIMIT ?').all(cfg.min_score_threshold, cfg.winners_count);
  for (const clan of top) {
    const members = getClanMembers(clan.id);
    if (!members.length || cfg.reward_toman <= 0) continue;
    if (cfg.distribution_method === 'donation_share') {
      const totalDonated = members.reduce((s, m) => s + m.donated_total, 0);
      for (const m of members) {
        const share = totalDonated > 0 ? Math.floor((cfg.reward_toman * m.donated_total) / totalDonated) : Math.floor(cfg.reward_toman / members.length);
        if (share > 0) { adjustToman(m.tg_id, share, `جایزه کلن «${clan.name}» (بر اساس سهم اهدا)`); if (notifyFn) notifyFn(m.tg_id, clan, share); }
      }
    } else {
      const share = Math.floor(cfg.reward_toman / members.length);
      for (const m of members) {
        if (share > 0) { adjustToman(m.tg_id, share, `جایزه کلن «${clan.name}»`); if (notifyFn) notifyFn(m.tg_id, clan, share); }
      }
    }
  }
  db.prepare('UPDATE clans SET score = 0').run();
  db.prepare(`UPDATE clan_state SET period_started_at = datetime('now') WHERE id = 1`).run();
}
export function checkAutoResetClanSeason(notifyFn) {
  const cfg = getClanConfig();
  if (!cfg.enabled) return;
  const state = getClanState();
  const startedAt = new Date(state.period_started_at.replace(' ', 'T') + 'Z').getTime();
  if (Date.now() >= startedAt + cfg.reset_days * 24 * 60 * 60 * 1000) resetClanSeason(notifyFn);
}
