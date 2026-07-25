import db from './db.js';
import { adjustToman, getUser } from './db.js';
import { getUserRankInfo } from './rank-db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS trade_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  max_tradable_level INTEGER NOT NULL DEFAULT 3,
  max_trades_per_month INTEGER NOT NULL DEFAULT 3,
  min_user_level INTEGER NOT NULL DEFAULT 10,
  trade_fee_toman INTEGER NOT NULL DEFAULT 1000
);
INSERT OR IGNORE INTO trade_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS trade_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_tg_id INTEGER NOT NULL,
  to_tg_id INTEGER NOT NULL,
  from_user_card_id INTEGER NOT NULL,
  to_user_card_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined | cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
`);

export function getTradeConfig() { return db.prepare('SELECT * FROM trade_config WHERE id = 1').get(); }
export function setTradeConfig(c) {
  db.prepare(`
    UPDATE trade_config SET enabled=?, max_tradable_level=?, max_trades_per_month=?, min_user_level=?, trade_fee_toman=?
    WHERE id = 1
  `).run(c.enabled ? 1 : 0, c.max_tradable_level, c.max_trades_per_month, c.min_user_level, c.trade_fee_toman);
}

function monthlyAcceptedCount(tgId) {
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  return db.prepare(`
    SELECT COUNT(*) c FROM trade_offers
    WHERE status = 'accepted' AND resolved_at >= ? AND (from_tg_id = ? OR to_tg_id = ?)
  `).get(monthAgo, tgId, tgId).c;
}

function findUserCard(tgId, userCardId) {
  return db.prepare(`
    SELECT uc.*, c.name, c.max_level FROM user_cards uc JOIN game_cards c ON c.id = uc.card_id
    WHERE uc.id = ? AND uc.tg_id = ?
  `).get(userCardId, tgId);
}

export function createTradeOffer(fromTgId, toTgId, fromUserCardId, toUserCardId) {
  const cfg = getTradeConfig();
  if (!cfg.enabled) throw new Error('سیستم تبادل فعلا غیرفعاله');
  if (fromTgId === toTgId) throw new Error('نمی‌تونی با خودت تبادل کنی');

  const fromInfo = getUserRankInfo(fromTgId), toInfo = getUserRankInfo(toTgId);
  if (fromInfo.level < cfg.min_user_level) throw new Error(`باید حداقل لول ${cfg.min_user_level} باشی`);
  if (toInfo.level < cfg.min_user_level) throw new Error('طرف مقابل هنوز لولش کافی نیست');
  if (monthlyAcceptedCount(fromTgId) >= cfg.max_trades_per_month) throw new Error('سهمیه تبادل این ماهت تموم شده');

  const fromCard = findUserCard(fromTgId, fromUserCardId);
  const toCard = findUserCard(toTgId, toUserCardId);
  if (!fromCard || !toCard) throw new Error('یکی از کارت‌ها پیدا نشد');
  if (fromCard.level > cfg.max_tradable_level || toCard.level > cfg.max_tradable_level) {
    throw new Error(`فقط کارت‌های سطح ۱ تا ${cfg.max_tradable_level} قابل تبادلن`);
  }
  const user = getUser(fromTgId);
  if (!user || user.balance_toman < cfg.trade_fee_toman) throw new Error(`برای پیشنهاد تبادل ${cfg.trade_fee_toman.toLocaleString()} تومان کارمزد لازمه`);

  return db.prepare(`
    INSERT INTO trade_offers (from_tg_id, to_tg_id, from_user_card_id, to_user_card_id) VALUES (?,?,?,?)
  `).run(fromTgId, toTgId, fromUserCardId, toUserCardId).lastInsertRowid;
}

export function respondTradeOffer(tgId, offerId, accept) {
  const offer = db.prepare('SELECT * FROM trade_offers WHERE id = ?').get(offerId);
  if (!offer || offer.status !== 'pending') throw new Error('این پیشنهاد دیگه معتبر نیست');
  if (offer.to_tg_id !== tgId) throw new Error('این پیشنهاد برای تو نیست');

  if (!accept) {
    db.prepare(`UPDATE trade_offers SET status = 'declined', resolved_at = datetime('now') WHERE id = ?`).run(offerId);
    return { accepted: false };
  }

  const cfg = getTradeConfig();
  const fromCard = findUserCard(offer.from_tg_id, offer.from_user_card_id);
  const toCard = findUserCard(offer.to_tg_id, offer.to_user_card_id);
  if (!fromCard || !toCard) throw new Error('یکی از کارت‌ها دیگه در دسترس نیست');
  const fromUser = getUser(offer.from_tg_id), toUser = getUser(offer.to_tg_id);
  if (fromUser.balance_toman < cfg.trade_fee_toman || toUser.balance_toman < cfg.trade_fee_toman) {
    throw new Error('یکی از طرفین موجودی کافی برای کارمزد نداره');
  }

  const tx = db.transaction(() => {
    adjustToman(offer.from_tg_id, -cfg.trade_fee_toman, 'کارمزد تبادل کارت');
    adjustToman(offer.to_tg_id, -cfg.trade_fee_toman, 'کارمزد تبادل کارت');
    db.prepare('UPDATE user_cards SET tg_id = ? WHERE id = ?').run(offer.to_tg_id, offer.from_user_card_id);
    db.prepare('UPDATE user_cards SET tg_id = ? WHERE id = ?').run(offer.from_tg_id, offer.to_user_card_id);
    db.prepare(`UPDATE trade_offers SET status = 'accepted', resolved_at = datetime('now') WHERE id = ?`).run(offerId);
  });
  tx();
  return { accepted: true };
}

export function cancelTradeOffer(tgId, offerId) {
  const offer = db.prepare('SELECT * FROM trade_offers WHERE id = ?').get(offerId);
  if (!offer || offer.status !== 'pending') throw new Error('این پیشنهاد دیگه معتبر نیست');
  if (offer.from_tg_id !== tgId) throw new Error('این پیشنهاد مال تو نیست');
  db.prepare(`UPDATE trade_offers SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?`).run(offerId);
}

export function listMyTradeOffers(tgId) {
  const incoming = db.prepare(`SELECT * FROM trade_offers WHERE to_tg_id = ? AND status = 'pending' ORDER BY created_at DESC`).all(tgId);
  const outgoing = db.prepare(`SELECT * FROM trade_offers WHERE from_tg_id = ? AND status = 'pending' ORDER BY created_at DESC`).all(tgId);
  return { incoming, outgoing };
}
