import db from './db.js';
import { adjustToman } from './db.js';
import { grantCardInstance } from './game-db.js';

export async function listPromoCodes() { return await db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC').all(); }
export async function getPromoCode(code) { return await db.prepare('SELECT * FROM promo_codes WHERE code = ?').get(code); }
export async function createPromoCode(c) {
  await db.prepare(`
    INSERT INTO promo_codes (code, reward_type, reward_value, max_uses, expires_at, active) VALUES (?,?,?,?,?,?)
  `).run(c.code.trim().toUpperCase(), c.reward_type, c.reward_value, c.max_uses || null, c.expires_at || null, c.active !== false ? 1 : 0);
}
export async function deletePromoCode(code) { await db.prepare('DELETE FROM promo_codes WHERE code = ?').run(code); }
export async function listRedemptions(code) {
  return await db.prepare(`
    SELECT pr.*, u.first_name, u.username FROM promo_redemptions pr JOIN users u ON u.tg_id = pr.tg_id
    WHERE pr.code = ? ORDER BY pr.redeemed_at DESC
  `).all(code);
}

export async function redeemPromoCode(tgId, codeInput) {
  const code = String(codeInput || '').trim().toUpperCase();
  const promo = await getPromoCode(code);
  if (!promo || !promo.active) throw new Error('This code is not valid');
  if (promo.expires_at && new Date(promo.expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now()) throw new Error('This code has expired');
  if (promo.max_uses != null && promo.used_count >= promo.max_uses) throw new Error('This code is out of uses');
  const already = await db.prepare('SELECT 1 FROM promo_redemptions WHERE code = ? AND tg_id = ?').get(code, tgId);
  if (already) throw new Error('You have already used this code');

  const tx = db.transaction(async () => {
    if (promo.reward_type === 'toman' && Number(promo.reward_value) > 0) {
      await adjustToman(tgId, Number(promo.reward_value), `Gift code: ${code}`);
    } else if (promo.reward_type === 'card' && promo.reward_value) {
      await grantCardInstance(tgId, Number(promo.reward_value));
    }
    await db.prepare('INSERT INTO promo_redemptions (code, tg_id) VALUES (?,?)').run(code, tgId);
    await db.prepare('UPDATE promo_codes SET used_count = used_count + 1 WHERE code = ?').run(code);
  });
  await tx();
  return { rewardType: promo.reward_type, rewardValue: promo.reward_value };
}
