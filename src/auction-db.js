import db from './db.js';
import { adjustToman, getUser, getProduct } from './db.js';

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

export function getAuctionConfig() { return db.prepare('SELECT * FROM auction_config WHERE id = 1').get(); }
export function setAuctionConfig(c) {
  db.prepare(`
    UPDATE auction_config SET enabled=?, discount_percent=?, duration_minutes=?, bid_step=?, anti_snipe_enabled=?, min_wallet_balance=?
    WHERE id = 1
  `).run(c.enabled ? 1 : 0, c.discount_percent, c.duration_minutes, c.bid_step, c.anti_snipe_enabled ? 1 : 0, c.min_wallet_balance);
}

export function listActiveAuctions() {
  return db.prepare(`SELECT * FROM auctions WHERE status = 'active' ORDER BY ends_at ASC`).all();
}
export function listAllAuctionsAdmin() {
  return db.prepare(`SELECT * FROM auctions ORDER BY created_at DESC LIMIT 100`).all();
}
export function getAuction(id) { return db.prepare('SELECT * FROM auctions WHERE id = ?').get(id); }

// ادمین یه محصول از فروشگاه رو انتخاب می‌کنه و باهاش یه مزایده می‌سازه
export function createAuctionFromProduct(productId) {
  const product = getProduct(productId);
  if (!product) throw new Error('محصول پیدا نشد');
  const cfg = getAuctionConfig();
  const startPrice = Math.round(product.price_toman * (1 - cfg.discount_percent / 100));
  const endsAt = new Date(Date.now() + cfg.duration_minutes * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  return db.prepare(`
    INSERT INTO auctions (product_id, title, image_url, start_price, current_price, bid_step, anti_snipe, min_wallet_balance, ends_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(productId, product.title, product.image_url, startPrice, startPrice, cfg.bid_step, cfg.anti_snipe_enabled, cfg.min_wallet_balance, endsAt).lastInsertRowid;
}
export function cancelAuction(id) {
  db.prepare(`UPDATE auctions SET status = 'cancelled' WHERE id = ? AND status = 'active'`).run(id);
}

export function listAuctionBids(auctionId, limit = 20) {
  return db.prepare('SELECT * FROM auction_bids WHERE auction_id = ? ORDER BY created_at DESC LIMIT ?').all(auctionId, limit);
}

// ثبت پیشنهاد: قیمت خودکار یه پله (bid_step) بالاتر میره؛ اگه تو ۱۰ ثانیه آخر باشه و anti-snipe فعال باشه، ۳۰ ثانیه به وقت اضافه می‌شه
export function placeBid(tgId, auctionId) {
  const auction = getAuction(auctionId);
  if (!auction || auction.status !== 'active') throw new Error('این مزایده فعال نیست');
  const endsAtMs = new Date(auction.ends_at.replace(' ', 'T') + 'Z').getTime();
  if (Date.now() >= endsAtMs) throw new Error('زمان این مزایده تموم شده');

  const user = getUser(tgId);
  if (!user || user.balance_toman < auction.min_wallet_balance) {
    throw new Error(`برای شرکت باید حداقل ${auction.min_wallet_balance.toLocaleString()} تومان موجودی داشته باشی`);
  }
  const newPrice = auction.current_price + auction.bid_step;
  if (user.balance_toman < newPrice) throw new Error('موجودی کیف‌پول برای این پیشنهاد کافی نیست');

  let newEndsAtMs = endsAtMs;
  if (auction.anti_snipe && endsAtMs - Date.now() <= 10000) newEndsAtMs = Date.now() + 30000;
  const newEndsAt = new Date(newEndsAtMs).toISOString().replace('T', ' ').slice(0, 19);

  const tx = db.transaction(() => {
    db.prepare('UPDATE auctions SET current_price = ?, winner_tg_id = ?, ends_at = ? WHERE id = ?').run(newPrice, tgId, newEndsAt, auctionId);
    db.prepare('INSERT INTO auction_bids (auction_id, tg_id, amount) VALUES (?,?,?)').run(auctionId, tgId, newPrice);
  });
  tx();
  return { newPrice, newEndsAt, extended: newEndsAtMs !== endsAtMs };
}

// مزایده‌های تموم‌شده رو می‌بنده: اگه برنده داشته و پول کافی داشته باشه، خودکار پرداخت و سفارش ثبت می‌شه؛
// وگرنه با وضعیت «unpaid» می‌مونه تا ادمین دستی رسیدگی کنه
export function finalizeExpiredAuctions(notifyFn) {
  const expired = db.prepare(`SELECT * FROM auctions WHERE status = 'active' AND ends_at <= datetime('now')`).all();
  for (const a of expired) {
    if (!a.winner_tg_id) {
      db.prepare(`UPDATE auctions SET status = 'ended' WHERE id = ?`).run(a.id);
      continue;
    }
    const user = getUser(a.winner_tg_id);
    if (user && user.balance_toman >= a.current_price) {
      adjustToman(a.winner_tg_id, -a.current_price, `برد مزایده «${a.title}»`);
      db.prepare(`INSERT INTO orders (tg_id, product_id, qty, total_toman, note) VALUES (?,?,1,?, 'برد مزایده')`).run(a.winner_tg_id, a.product_id, a.current_price);
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
