import db from './db.js';
import { adjustToman } from './db.js';
import { grantCardInstance } from './game-db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,
  reward_type TEXT NOT NULL,   -- toman | card | bp_discount | lootbox_discount
  reward_value TEXT,
  max_uses INTEGER,            -- خالی = نامحدود
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,             -- خالی = بدون انقضا
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  code TEXT NOT NULL,
  tg_id INTEGER NOT NULL,
  redeemed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (code, tg_id)
);
`);

export function listPromoCodes() { return db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC').all(); }
export function getPromoCode(code) { return db.prepare('SELECT * FROM promo_codes WHERE code = ?').get(code); }
export function createPromoCode(c) {
  db.prepare(`
    INSERT INTO promo_codes (code, reward_type, reward_value, max_uses, expires_at, active) VALUES (?,?,?,?,?,?)
  `).run(c.code.trim().toUpperCase(), c.reward_type, c.reward_value, c.max_uses || null, c.expires_at || null, c.active !== false ? 1 : 0);
}
export function deletePromoCode(code) { db.prepare('DELETE FROM promo_codes WHERE code = ?').run(code); }
export function listRedemptions(code) {
  return db.prepare(`
    SELECT pr.*, u.first_name, u.username FROM promo_redemptions pr JOIN users u ON u.tg_id = pr.tg_id
    WHERE pr.code = ? ORDER BY pr.redeemed_at DESC
  `).all(code);
}

export function redeemPromoCode(tgId, codeInput) {
  const code = String(codeInput || '').trim().toUpperCase();
  const promo = getPromoCode(code);
  if (!promo || !promo.active) throw new Error('این کد معتبر نیست');
  if (promo.expires_at && new Date(promo.expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now()) throw new Error('این کد منقضی شده');
  if (promo.max_uses != null && promo.used_count >= promo.max_uses) throw new Error('ظرفیت این کد تموم شده');
  const already = db.prepare('SELECT 1 FROM promo_redemptions WHERE code = ? AND tg_id = ?').get(code, tgId);
  if (already) throw new Error('این کد رو قبلا استفاده کردی');

  const tx = db.transaction(() => {
    if (promo.reward_type === 'toman' && Number(promo.reward_value) > 0) {
      adjustToman(tgId, Number(promo.reward_value), `کد هدیه: ${code}`);
    } else if (promo.reward_type === 'card' && promo.reward_value) {
      grantCardInstance(tgId, Number(promo.reward_value));
    }
    db.prepare('INSERT INTO promo_redemptions (code, tg_id) VALUES (?,?)').run(code, tgId);
    db.prepare('UPDATE promo_codes SET used_count = used_count + 1 WHERE code = ?').run(code);
  });
  tx();
  return { rewardType: promo.reward_type, rewardValue: promo.reward_value };
}
