import db from './db.js';
import { adjustToman } from './db.js';
import { grantCardInstance } from './game-db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,
  reward_type TEXT NOT NULL,   -- toman | card | bp_discount | lootbox_discount
  reward_value TEXT,
  max_uses INTEGER,            -- empty = unlimited
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,             -- empty = no expiry
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
function safeAddColumn(table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
// Only used when reward_type = 'card' — lets a gift code hand out a card at a SPECIFIC level
// (e.g. a promo tied to a launch event granting a Level 5 card), not just its default level.
safeAddColumn('promo_codes', 'reward_card_level INTEGER');

export function listPromoCodes() { return db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC').all(); }
export function getPromoCode(code) { return db.prepare('SELECT * FROM promo_codes WHERE code = ?').get(code); }
export function createPromoCode(c) {
  db.prepare(`
    INSERT INTO promo_codes (code, reward_type, reward_value, reward_card_level, max_uses, expires_at, active) VALUES (?,?,?,?,?,?,?)
  `).run(c.code.trim().toUpperCase(), c.reward_type, c.reward_value, c.reward_card_level ? Number(c.reward_card_level) : null, c.max_uses || null, c.expires_at || null, c.active !== false ? 1 : 0);
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
  if (!promo || !promo.active) throw new Error('This code is not valid');
  if (promo.expires_at && new Date(promo.expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now()) throw new Error('This code has expired');
  if (promo.max_uses != null && promo.used_count >= promo.max_uses) throw new Error('This code is out of uses');
  const already = db.prepare('SELECT 1 FROM promo_redemptions WHERE code = ? AND tg_id = ?').get(code, tgId);
  if (already) throw new Error('You have already used this code');

  const tx = db.transaction(() => {
    if (promo.reward_type === 'toman' && Number(promo.reward_value) > 0) {
      adjustToman(tgId, Number(promo.reward_value), `Gift code: ${code}`);
    } else if (promo.reward_type === 'card' && promo.reward_value) {
      grantCardInstance(tgId, Number(promo.reward_value), promo.reward_card_level || null);
    }
    db.prepare('INSERT INTO promo_redemptions (code, tg_id) VALUES (?,?)').run(code, tgId);
    db.prepare('UPDATE promo_codes SET used_count = used_count + 1 WHERE code = ?').run(code);
  });
  tx();
  return { rewardType: promo.reward_type, rewardValue: promo.reward_value };
}
