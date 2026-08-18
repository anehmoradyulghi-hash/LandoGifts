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
  listing_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined | cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS trade_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  user_card_id INTEGER NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | completed | cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

function safeAddColumn(table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
safeAddColumn('trade_offers', 'listing_id INTEGER');

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

// Trade board: instead of needing to know the other party's ID, you list your card on the board
// and others make offers with one of their own cards
export function createTradeListing(tgId, userCardId, note) {
  const cfg = getTradeConfig();
  if (!cfg.enabled) throw new Error('The trade system is currently disabled');
  const info = getUserRankInfo(tgId);
  if (info.level < cfg.min_user_level) throw new Error(`You must be at least level ${cfg.min_user_level}`);
  const card = findUserCard(tgId, userCardId);
  if (!card) throw new Error('This card was not found');
  if (card.level > cfg.max_tradable_level) throw new Error(`Only level 1 to ${cfg.max_tradable_level} cards are tradeable`);
  const already = db.prepare(`SELECT 1 FROM trade_listings WHERE user_card_id = ? AND status = 'open'`).get(userCardId);
  if (already) throw new Error('This card is already on the board right now');
  return db.prepare('INSERT INTO trade_listings (tg_id, user_card_id, note) VALUES (?,?,?)').run(tgId, userCardId, note || null).lastInsertRowid;
}
export function cancelTradeListing(tgId, id) {
  const listing = db.prepare('SELECT * FROM trade_listings WHERE id = ?').get(id);
  if (!listing || listing.status !== 'open') throw new Error('This listing is no longer valid');
  if (listing.tg_id !== tgId) throw new Error('This listing does not belong to you');
  db.prepare(`UPDATE trade_listings SET status = 'cancelled' WHERE id = ?`).run(id);
  db.prepare(`UPDATE trade_offers SET status='cancelled', resolved_at=datetime('now') WHERE listing_id=? AND status='pending'`).run(id);
}
export function listOpenTradeListings(excludeTgId) {
  return db.prepare(`
    SELECT tl.id, tl.tg_id, tl.note, tl.created_at, uc.id AS user_card_id, uc.level, uc.bonus_power, uc.rolled_power,
      c.name, c.image_url, c.level_images, c.base_power, c.fixed_power, u.first_name, u.username
    FROM trade_listings tl
    JOIN user_cards uc ON uc.id = tl.user_card_id
    JOIN game_cards c ON c.id = uc.card_id
    JOIN users u ON u.tg_id = tl.tg_id
    WHERE tl.status = 'open' AND tl.tg_id != ?
    ORDER BY tl.id DESC
  `).all(excludeTgId || 0);
}
export function getMyTradeListings(tgId) {
  return db.prepare(`
    SELECT tl.*, c.name, c.image_url FROM trade_listings tl
    JOIN user_cards uc ON uc.id = tl.user_card_id JOIN game_cards c ON c.id = uc.card_id
    WHERE tl.tg_id = ? ORDER BY tl.id DESC
  `).all(tgId);
}
export function getTradeListing(id) { return db.prepare('SELECT * FROM trade_listings WHERE id = ?').get(id); }

// Someone picks a listing from the board and offers one of their own cards
export function createTradeOfferFromListing(fromTgId, listingId, fromUserCardId) {
  const listing = getTradeListing(listingId);
  if (!listing || listing.status !== 'open') throw new Error('This listing is no longer available');
  if (listing.tg_id === fromTgId) throw new Error('You cannot make an offer on your own listing');
  return createTradeOffer(fromTgId, listing.tg_id, fromUserCardId, listing.user_card_id, listingId);
}

export function createTradeOffer(fromTgId, toTgId, fromUserCardId, toUserCardId, listingId = null) {
  const cfg = getTradeConfig();
  if (!cfg.enabled) throw new Error('The trade system is currently disabled');
  if (fromTgId === toTgId) throw new Error('You cannot trade with yourself');

  const fromInfo = getUserRankInfo(fromTgId), toInfo = getUserRankInfo(toTgId);
  if (fromInfo.level < cfg.min_user_level) throw new Error(`You must be at least level ${cfg.min_user_level}`);
  if (toInfo.level < cfg.min_user_level) throw new Error('The other party level is not high enough yet');
  if (monthlyAcceptedCount(fromTgId) >= cfg.max_trades_per_month) throw new Error('You have used up your trade quota for this month');

  const fromCard = findUserCard(fromTgId, fromUserCardId);
  const toCard = findUserCard(toTgId, toUserCardId);
  if (!fromCard || !toCard) throw new Error('One of the cards was not found');
  if (fromCard.level > cfg.max_tradable_level || toCard.level > cfg.max_tradable_level) {
    throw new Error(`Only level 1 to ${cfg.max_tradable_level} cards are tradeable`);
  }
  const user = getUser(fromTgId);
  if (!user || user.balance_toman < cfg.trade_fee_toman) throw new Error(`A ${cfg.trade_fee_toman.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} LNDC fee is required to make a trade offer`);

  return db.prepare(`
    INSERT INTO trade_offers (from_tg_id, to_tg_id, from_user_card_id, to_user_card_id, listing_id) VALUES (?,?,?,?,?)
  `).run(fromTgId, toTgId, fromUserCardId, toUserCardId, listingId).lastInsertRowid;
}

export function respondTradeOffer(tgId, offerId, accept) {
  const offer = db.prepare('SELECT * FROM trade_offers WHERE id = ?').get(offerId);
  if (!offer || offer.status !== 'pending') throw new Error('This offer is no longer valid');
  if (offer.to_tg_id !== tgId) throw new Error('This offer is not for you');

  if (!accept) {
    db.prepare(`UPDATE trade_offers SET status = 'declined', resolved_at = datetime('now') WHERE id = ?`).run(offerId);
    return { accepted: false };
  }

  const cfg = getTradeConfig();
  const fromCard = findUserCard(offer.from_tg_id, offer.from_user_card_id);
  const toCard = findUserCard(offer.to_tg_id, offer.to_user_card_id);
  if (!fromCard || !toCard) throw new Error('One of the cards is no longer available');
  const fromUser = getUser(offer.from_tg_id), toUser = getUser(offer.to_tg_id);
  if (fromUser.balance_toman < cfg.trade_fee_toman || toUser.balance_toman < cfg.trade_fee_toman) {
    throw new Error('One of the parties does not have enough balance for the fee');
  }

  const tx = db.transaction(() => {
    adjustToman(offer.from_tg_id, -cfg.trade_fee_toman, 'Card trade fee');
    adjustToman(offer.to_tg_id, -cfg.trade_fee_toman, 'Card trade fee');
    db.prepare('UPDATE user_cards SET tg_id = ? WHERE id = ?').run(offer.to_tg_id, offer.from_user_card_id);
    db.prepare('UPDATE user_cards SET tg_id = ? WHERE id = ?').run(offer.from_tg_id, offer.to_user_card_id);
    db.prepare(`UPDATE trade_offers SET status = 'accepted', resolved_at = datetime('now') WHERE id = ?`).run(offerId);
    if (offer.listing_id) {
      db.prepare(`UPDATE trade_listings SET status = 'completed' WHERE id = ?`).run(offer.listing_id);
      // if several people had made offers on this listing, the rest become meaningless since the card is gone
      db.prepare(`UPDATE trade_offers SET status='declined', resolved_at=datetime('now') WHERE listing_id=? AND status='pending' AND id != ?`).run(offer.listing_id, offerId);
    }
  });
  tx();
  return { accepted: true };
}

export function cancelTradeOffer(tgId, offerId) {
  const offer = db.prepare('SELECT * FROM trade_offers WHERE id = ?').get(offerId);
  if (!offer || offer.status !== 'pending') throw new Error('This offer is no longer valid');
  if (offer.from_tg_id !== tgId) throw new Error('This offer does not belong to you');
  db.prepare(`UPDATE trade_offers SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?`).run(offerId);
}

export function listMyTradeOffers(tgId) {
  const enrich = (rows) => rows.map(o => {
    const fromCard = db.prepare('SELECT uc.level, c.name FROM user_cards uc JOIN game_cards c ON c.id=uc.card_id WHERE uc.id=?').get(o.from_user_card_id);
    const toCard = db.prepare('SELECT uc.level, c.name FROM user_cards uc JOIN game_cards c ON c.id=uc.card_id WHERE uc.id=?').get(o.to_user_card_id);
    const fromUser = db.prepare('SELECT first_name, username FROM users WHERE tg_id=?').get(o.from_tg_id);
    const toUser = db.prepare('SELECT first_name, username FROM users WHERE tg_id=?').get(o.to_tg_id);
    return { ...o, fromCardName: fromCard ? `${fromCard.name} (Lv${fromCard.level})` : '—', toCardName: toCard ? `${toCard.name} (Lv${toCard.level})` : '—', fromUserName: fromUser?.first_name || '', toUserName: toUser?.first_name || '' };
  });
  const incoming = db.prepare(`SELECT * FROM trade_offers WHERE to_tg_id = ? AND status = 'pending' ORDER BY created_at DESC`).all(tgId);
  const outgoing = db.prepare(`SELECT * FROM trade_offers WHERE from_tg_id = ? AND status = 'pending' ORDER BY created_at DESC`).all(tgId);
  return { incoming: enrich(incoming), outgoing: enrich(outgoing) };
}
