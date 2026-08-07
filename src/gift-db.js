import db from './db.js';
import { adjustToman, getUser } from './db.js';

export async function getGiftConfig() { return await db.prepare('SELECT * FROM gift_config WHERE id = 1').get(); }
export async function setGiftConfig(c) {
  await db.prepare(`
    UPDATE gift_config SET enabled=?, card_gift_min_referrals=?, card_gift_max_per_month=?, card_gift_max_level=?, toman_gift_fee_percent=?
    WHERE id = 1
  `).run(c.enabled ? 1 : 0, c.card_gift_min_referrals, c.card_gift_max_per_month, c.card_gift_max_level, c.toman_gift_fee_percent);
}

async function findReceiver(usernameOrId) {
  const raw = String(usernameOrId || '').trim().replace(/^@/, '');
  if (/^\d+$/.test(raw)) return await getUser(Number(raw));
  return await db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(raw);
}

export async function giftToman(senderTgId, receiverInput, amount) {
  const cfg = await getGiftConfig();
  if (!cfg.enabled) throw new Error('The gift system is currently disabled');
  if (!amount || amount <= 0) throw new Error('Invalid amount');
  const receiver = await findReceiver(receiverInput);
  if (!receiver) throw new Error('Recipient user not found — they must have already opened the bot');
  if (receiver.tg_id === senderTgId) throw new Error('You cannot gift yourself');
  const sender = await getUser(senderTgId);
  if (!sender || sender.balance_toman < amount) throw new Error('Insufficient balance');

  const fee = Math.floor((amount * cfg.toman_gift_fee_percent) / 100);
  const receiverGets = amount - fee;
  const tx = db.transaction(async () => {
    await adjustToman(senderTgId, -amount, `LNDC gift to ${receiver.first_name || receiver.tg_id}`);
    await adjustToman(receiver.tg_id, receiverGets, `LNDC gift from ${sender.first_name || sender.tg_id}`);
  });
  await tx();
  return { receiverGets, fee, receiverTgId: receiver.tg_id, receiverName: receiver.first_name };
}

export async function giftCard(senderTgId, receiverInput, userCardId) {
  const cfg = await getGiftConfig();
  if (!cfg.enabled) throw new Error('The gift system is currently disabled');
  const receiver = await findReceiver(receiverInput);
  if (!receiver) throw new Error('Recipient user not found — they must have already opened the bot');
  if (receiver.tg_id === senderTgId) throw new Error('You cannot gift yourself');

  const invitedCount = (await db.prepare('SELECT COUNT(*) c FROM users WHERE referred_by = ?').get(senderTgId)).c;
  if (invitedCount < cfg.card_gift_min_referrals) {
    throw new Error(`You need to have invited at least ${cfg.card_gift_min_referrals} people to gift a card`);
  }
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const usedThisMonth = (await db.prepare('SELECT COUNT(*) c FROM card_gifts_log WHERE sender_tg_id = ? AND sent_at >= ?').get(senderTgId, monthAgo)).c;
  if (usedThisMonth >= cfg.card_gift_max_per_month) throw new Error('You have used up your card gift quota for this month');

  const card = await db.prepare(`
    SELECT uc.*, c.name, c.max_level FROM user_cards uc JOIN game_cards c ON c.id = uc.card_id
    WHERE uc.id = ? AND uc.tg_id = ?
  `).get(userCardId, senderTgId);
  if (!card) throw new Error('This card was not found');
  if (card.level > cfg.card_gift_max_level) throw new Error(`Only level 1 to ${cfg.card_gift_max_level} cards can be gifted`);

  const tx = db.transaction(async () => {
    await db.prepare('UPDATE user_cards SET tg_id = ? WHERE id = ?').run(receiver.tg_id, userCardId);
    await db.prepare('INSERT INTO card_gifts_log (sender_tg_id, receiver_tg_id, user_card_id) VALUES (?,?,?)').run(senderTgId, receiver.tg_id, userCardId);
  });
  await tx();
  return { receiverTgId: receiver.tg_id, receiverName: receiver.first_name, cardName: card.name };
}

export async function getRemainingCardGifts(tgId) {
  const cfg = await getGiftConfig();
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const used = (await db.prepare('SELECT COUNT(*) c FROM card_gifts_log WHERE sender_tg_id = ? AND sent_at >= ?').get(tgId, monthAgo)).c;
  const invitedCount = (await db.prepare('SELECT COUNT(*) c FROM users WHERE referred_by = ?').get(tgId)).c;
  return { remaining: Math.max(0, cfg.card_gift_max_per_month - used), invitedCount, minReferrals: cfg.card_gift_min_referrals, maxLevel: cfg.card_gift_max_level };
}
