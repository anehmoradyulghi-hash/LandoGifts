import db from './db.js';
import { adjustToman, getUser } from './db.js';
import { isCardListedForSale } from './card-market-db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS gift_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  card_gift_min_referrals INTEGER NOT NULL DEFAULT 3,
  card_gift_max_per_month INTEGER NOT NULL DEFAULT 1,
  card_gift_max_level INTEGER NOT NULL DEFAULT 3,
  toman_gift_fee_percent INTEGER NOT NULL DEFAULT 2
);
INSERT OR IGNORE INTO gift_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS card_gifts_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_tg_id INTEGER NOT NULL,
  receiver_tg_id INTEGER NOT NULL,
  user_card_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function getGiftConfig() { return db.prepare('SELECT * FROM gift_config WHERE id = 1').get(); }
export function setGiftConfig(c) {
  db.prepare(`
    UPDATE gift_config SET enabled=?, card_gift_min_referrals=?, card_gift_max_per_month=?, card_gift_max_level=?, toman_gift_fee_percent=?
    WHERE id = 1
  `).run(c.enabled ? 1 : 0, c.card_gift_min_referrals, c.card_gift_max_per_month, c.card_gift_max_level, c.toman_gift_fee_percent);
}

function findReceiver(usernameOrId) {
  const raw = String(usernameOrId || '').trim().replace(/^@/, '');
  if (/^\d+$/.test(raw)) return getUser(Number(raw));
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(raw);
}

export function giftToman(senderTgId, receiverInput, amount) {
  const cfg = getGiftConfig();
  if (!cfg.enabled) throw new Error('The gift system is currently disabled');
  if (!amount || amount <= 0) throw new Error('Invalid amount');
  const receiver = findReceiver(receiverInput);
  if (!receiver) throw new Error('Recipient user not found — they must have already opened the bot');
  if (receiver.tg_id === senderTgId) throw new Error('You cannot gift yourself');
  const sender = getUser(senderTgId);
  if (!sender || sender.balance_toman < amount) throw new Error('Insufficient balance');

  const fee = Math.floor((amount * cfg.toman_gift_fee_percent) / 100);
  const receiverGets = amount - fee;
  const tx = db.transaction(() => {
    adjustToman(senderTgId, -amount, `LNDC gift to ${receiver.first_name || receiver.tg_id}`);
    adjustToman(receiver.tg_id, receiverGets, `LNDC gift from ${sender.first_name || sender.tg_id}`);
  });
  tx();
  return { receiverGets, fee, receiverTgId: receiver.tg_id, receiverName: receiver.first_name };
}

export function giftCard(senderTgId, receiverInput, userCardId) {
  const cfg = getGiftConfig();
  if (!cfg.enabled) throw new Error('The gift system is currently disabled');
  const receiver = findReceiver(receiverInput);
  if (!receiver) throw new Error('Recipient user not found — they must have already opened the bot');
  if (receiver.tg_id === senderTgId) throw new Error('You cannot gift yourself');

  const invitedCount = db.prepare('SELECT COUNT(*) c FROM users WHERE referred_by = ?').get(senderTgId).c;
  if (invitedCount < cfg.card_gift_min_referrals) {
    throw new Error(`You need to have invited at least ${cfg.card_gift_min_referrals} people to gift a card`);
  }
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const usedThisMonth = db.prepare('SELECT COUNT(*) c FROM card_gifts_log WHERE sender_tg_id = ? AND sent_at >= ?').get(senderTgId, monthAgo).c;
  if (usedThisMonth >= cfg.card_gift_max_per_month) throw new Error('You have used up your card gift quota for this month');

  const card = db.prepare(`
    SELECT uc.*, c.name, c.max_level FROM user_cards uc JOIN game_cards c ON c.id = uc.card_id
    WHERE uc.id = ? AND uc.tg_id = ?
  `).get(userCardId, senderTgId);
  if (!card) throw new Error('This card was not found');
  if (card.level > cfg.card_gift_max_level) throw new Error(`Only level 1 to ${cfg.card_gift_max_level} cards can be gifted`);
  if (isCardListedForSale(userCardId)) throw new Error('This card is currently listed on the marketplace — cancel that listing first');

  const tx = db.transaction(() => {
    db.prepare('UPDATE user_cards SET tg_id = ? WHERE id = ?').run(receiver.tg_id, userCardId);
    db.prepare('INSERT INTO card_gifts_log (sender_tg_id, receiver_tg_id, user_card_id) VALUES (?,?,?)').run(senderTgId, receiver.tg_id, userCardId);
  });
  tx();
  return { receiverTgId: receiver.tg_id, receiverName: receiver.first_name, cardName: card.name };
}

export function getRemainingCardGifts(tgId) {
  const cfg = getGiftConfig();
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const used = db.prepare('SELECT COUNT(*) c FROM card_gifts_log WHERE sender_tg_id = ? AND sent_at >= ?').get(tgId, monthAgo).c;
  const invitedCount = db.prepare('SELECT COUNT(*) c FROM users WHERE referred_by = ?').get(tgId).c;
  return { remaining: Math.max(0, cfg.card_gift_max_per_month - used), invitedCount, minReferrals: cfg.card_gift_min_referrals, maxLevel: cfg.card_gift_max_level };
}
