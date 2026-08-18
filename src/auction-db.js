import db, { round2 } from './db.js';
import { adjustToman, getUser, getProduct } from './db.js';
import { getGameCard, grantCardInstance } from './game-db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS auction_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  discount_percent INTEGER NOT NULL DEFAULT 50,
  duration_minutes INTEGER NOT NULL DEFAULT 5,
  bid_step INTEGER NOT NULL DEFAULT 1000,
  anti_snipe_enabled INTEGER NOT NULL DEFAULT 1,
  min_wallet_balance INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO auction_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS auctions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  image_url TEXT,
  start_price INTEGER NOT NULL,
  current_price INTEGER NOT NULL,
  bid_step INTEGER NOT NULL,
  winner_tg_id INTEGER,
  anti_snipe INTEGER NOT NULL DEFAULT 1,
  min_wallet_balance INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active | ended | cancelled | unpaid
  ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auction_bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER NOT NULL,
  tg_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

function safeAddColumn(table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
safeAddColumn('auctions', `item_type TEXT NOT NULL DEFAULT 'product'`);
safeAddColumn('auctions', 'card_id INTEGER');
// Bids used to go up by a fixed toman amount regardless of the current price, which made no sense
// across cheap vs expensive items (a 1,000 LNDC step is huge on a 2,000 LNDC item and meaningless on
// a 500,000 LNDC one) — bidding now goes up by a percentage of the current price instead.
safeAddColumn('auction_config', 'bid_step_percent INTEGER NOT NULL DEFAULT 5');
safeAddColumn('auctions', 'bid_step_percent INTEGER NOT NULL DEFAULT 5');

export function getAuctionConfig() { return db.prepare('SELECT * FROM auction_config WHERE id = 1').get(); }
export function setAuctionConfig(c) {
  db.prepare(`
    UPDATE auction_config SET enabled=?, discount_percent=?, duration_minutes=?, bid_step_percent=?, anti_snipe_enabled=?, min_wallet_balance=?
    WHERE id = 1
  `).run(c.enabled ? 1 : 0, c.discount_percent, c.duration_minutes, c.bid_step_percent, c.anti_snipe_enabled ? 1 : 0, c.min_wallet_balance);
}

export function listActiveAuctions() {
  return db.prepare(`
    SELECT a.*, u.first_name AS bidder_first_name, u.username AS bidder_username
    FROM auctions a LEFT JOIN users u ON u.tg_id = a.winner_tg_id
    WHERE a.status = 'active' ORDER BY a.ends_at ASC
  `).all();
}
export function listAllAuctionsAdmin() {
  return db.prepare(`SELECT * FROM auctions ORDER BY created_at DESC LIMIT 100`).all();
}
export function getAuction(id) { return db.prepare('SELECT * FROM auctions WHERE id = ?').get(id); }

// The admin picks a shop product and creates an auction with it
export function createAuctionFromProduct(productId) {
  const product = getProduct(productId);
  if (!product) throw new Error('Product not found');
  const cfg = getAuctionConfig();
  const startPrice = round2(product.price_toman * (1 - cfg.discount_percent / 100));
  const endsAt = new Date(Date.now() + cfg.duration_minutes * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  return db.prepare(`
    INSERT INTO auctions (product_id, item_type, title, image_url, start_price, current_price, bid_step, bid_step_percent, anti_snipe, min_wallet_balance, ends_at)
    VALUES (?,'product',?,?,?,?,0,?,?,?,?)
  `).run(productId, product.title, product.image_url, startPrice, startPrice, cfg.bid_step_percent, cfg.anti_snipe_enabled, cfg.min_wallet_balance, endsAt).lastInsertRowid;
}
// The admin puts a game card up for auction; once it ends it's added directly to the winner's cards
export function createAuctionFromCard(cardId) {
  const card = getGameCard(cardId);
  if (!card) throw new Error('Card not found');
  const cfg = getAuctionConfig();
  const startPrice = round2(card.price_toman * (1 - cfg.discount_percent / 100));
  const endsAt = new Date(Date.now() + cfg.duration_minutes * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  return db.prepare(`
    INSERT INTO auctions (product_id, item_type, card_id, title, image_url, start_price, current_price, bid_step, bid_step_percent, anti_snipe, min_wallet_balance, ends_at)
    VALUES (0,'card',?,?,?,?,?,0,?,?,?,?)
  `).run(cardId, card.name, card.image_url, startPrice, startPrice, cfg.bid_step_percent, cfg.anti_snipe_enabled, cfg.min_wallet_balance, endsAt).lastInsertRowid;
}
export function cancelAuction(id) {
  db.prepare(`UPDATE auctions SET status = 'cancelled' WHERE id = ? AND status = 'active'`).run(id);
}

export function listAuctionBids(auctionId, limit = 20) {
  return db.prepare('SELECT * FROM auction_bids WHERE auction_id = ? ORDER BY created_at DESC LIMIT ?').all(auctionId, limit);
}

// Placing a bid: the price automatically goes up by one step (bid_step); if within the last 10 seconds and anti-snipe is enabled, 30 seconds are added to the timer
export function placeBid(tgId, auctionId) {
  const auction = getAuction(auctionId);
  if (!auction || auction.status !== 'active') throw new Error('This auction is not active');
  const endsAtMs = new Date(auction.ends_at.replace(' ', 'T') + 'Z').getTime();
  if (Date.now() >= endsAtMs) throw new Error('This auction time has ended');

  const user = getUser(tgId);
  if (!user || user.balance_toman < auction.min_wallet_balance) {
    throw new Error(`You need at least ${auction.min_wallet_balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} LNDC balance to participate`);
  }
  // The next bid is a percentage of the current price (not a flat amount) so the step scales
  // sensibly whether the item is currently worth 2,000 LNDC or 2,000,000 LNDC. Rounded up to the
  // nearest cent (not a whole unit) so the step is never zero for low-priced items now that the
  // wallet supports 2 decimal places.
  const step = Math.max(0.01, Math.ceil(auction.current_price * (auction.bid_step_percent || 5) / 100 * 100) / 100);
  const newPrice = round2(auction.current_price + step);
  if (user.balance_toman < newPrice) throw new Error('Insufficient wallet balance for this bid');

  // Whoever held the top bid before this one is about to be outbid — captured before the UPDATE
  // below overwrites winner_tg_id, so the caller can notify them.
  const outbidTgId = auction.winner_tg_id && auction.winner_tg_id !== tgId ? auction.winner_tg_id : null;

  let newEndsAtMs = endsAtMs;
  if (auction.anti_snipe && endsAtMs - Date.now() <= 10000) newEndsAtMs = Date.now() + 30000;
  const newEndsAt = new Date(newEndsAtMs).toISOString().replace('T', ' ').slice(0, 19);

  const tx = db.transaction(() => {
    db.prepare('UPDATE auctions SET current_price = ?, winner_tg_id = ?, ends_at = ? WHERE id = ?').run(newPrice, tgId, newEndsAt, auctionId);
    db.prepare('INSERT INTO auction_bids (auction_id, tg_id, amount) VALUES (?,?,?)').run(auctionId, tgId, newPrice);
  });
  tx();
  return { newPrice, newEndsAt, extended: newEndsAtMs !== endsAtMs, outbidTgId, title: auction.title };
}

// Closes finished auctions: if there's a winner with enough funds, payment and order are recorded automatically;
// otherwise it stays with status "unpaid" until the admin handles it manually
export function finalizeExpiredAuctions(notifyFn) {
  const expired = db.prepare(`SELECT * FROM auctions WHERE status = 'active' AND ends_at <= datetime('now')`).all();
  for (const a of expired) {
    if (!a.winner_tg_id) {
      db.prepare(`UPDATE auctions SET status = 'ended' WHERE id = ?`).run(a.id);
      continue;
    }
    const user = getUser(a.winner_tg_id);
    if (user && user.balance_toman >= a.current_price) {
      adjustToman(a.winner_tg_id, -a.current_price, `Auction win «${a.title}»`);
      if (a.item_type === 'card') {
        grantCardInstance(a.winner_tg_id, a.card_id);
      } else {
        db.prepare(`INSERT INTO orders (tg_id, product_id, qty, total_toman, note) VALUES (?,?,1,?, 'Auction win')`).run(a.winner_tg_id, a.product_id, a.current_price);
      }
      db.prepare(`UPDATE auctions SET status = 'ended' WHERE id = ?`).run(a.id);
      if (notifyFn) notifyFn(a.winner_tg_id, a, 'won');
    } else {
      db.prepare(`UPDATE auctions SET status = 'unpaid' WHERE id = ?`).run(a.id);
      if (notifyFn) notifyFn(a.winner_tg_id, a, 'unpaid');
    }
  }
}

export function getMyAuctionHistory(tgId, limit = 20) {
  return db.prepare(`
    SELECT DISTINCT a.* FROM auctions a JOIN auction_bids b ON b.auction_id = a.id
    WHERE b.tg_id = ? ORDER BY a.created_at DESC LIMIT ?
  `).all(tgId, limit);
}
