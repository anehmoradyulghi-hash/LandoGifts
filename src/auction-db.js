import db from './db.js';
import { adjustToman, getUser, getProduct } from './db.js';
import { getGameCard, grantCardInstance } from './game-db.js';

export async function getAuctionConfig() { return await db.prepare('SELECT * FROM auction_config WHERE id = 1').get(); }
export async function setAuctionConfig(c) {
  await db.prepare(`
    UPDATE auction_config SET enabled=?, discount_percent=?, duration_minutes=?, bid_step=?, anti_snipe_enabled=?, min_wallet_balance=?
    WHERE id = 1
  `).run(c.enabled ? 1 : 0, c.discount_percent, c.duration_minutes, c.bid_step, c.anti_snipe_enabled ? 1 : 0, c.min_wallet_balance);
}

export async function listActiveAuctions() {
  return await db.prepare(`
    SELECT a.*, u.first_name AS bidder_first_name, u.username AS bidder_username
    FROM auctions a LEFT JOIN users u ON u.tg_id = a.winner_tg_id
    WHERE a.status = 'active' ORDER BY a.ends_at ASC
  `).all();
}
export async function listAllAuctionsAdmin() {
  return await db.prepare(`SELECT * FROM auctions ORDER BY created_at DESC LIMIT 100`).all();
}
export async function getAuction(id) { return await db.prepare('SELECT * FROM auctions WHERE id = ?').get(id); }

// The admin picks a shop product and creates an auction with it
export async function createAuctionFromProduct(productId) {
  const product = await getProduct(productId);
  if (!product) throw new Error('Product not found');
  const cfg = await getAuctionConfig();
  const startPrice = Math.round(product.price_toman * (1 - cfg.discount_percent / 100));
  const endsAt = new Date(Date.now() + cfg.duration_minutes * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  return (await db.prepare(`
    INSERT INTO auctions (product_id, item_type, title, image_url, start_price, current_price, bid_step, anti_snipe, min_wallet_balance, ends_at)
    VALUES (?,'product',?,?,?,?,?,?,?,?)
  `).run(productId, product.title, product.image_url, startPrice, startPrice, cfg.bid_step, cfg.anti_snipe_enabled, cfg.min_wallet_balance, endsAt)).lastInsertRowid;
}
// The admin puts a game card up for auction; once it ends it's added directly to the winner's cards
export async function createAuctionFromCard(cardId) {
  const card = await getGameCard(cardId);
  if (!card) throw new Error('Card not found');
  const cfg = await getAuctionConfig();
  const startPrice = Math.round(card.price_toman * (1 - cfg.discount_percent / 100));
  const endsAt = new Date(Date.now() + cfg.duration_minutes * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  return (await db.prepare(`
    INSERT INTO auctions (product_id, item_type, card_id, title, image_url, start_price, current_price, bid_step, anti_snipe, min_wallet_balance, ends_at)
    VALUES (0,'card',?,?,?,?,?,?,?,?,?)
  `).run(cardId, card.name, card.image_url, startPrice, startPrice, cfg.bid_step, cfg.anti_snipe_enabled, cfg.min_wallet_balance, endsAt)).lastInsertRowid;
}
export async function cancelAuction(id) {
  await db.prepare(`UPDATE auctions SET status = 'cancelled' WHERE id = ? AND status = 'active'`).run(id);
}

export async function listAuctionBids(auctionId, limit = 20) {
  return await db.prepare('SELECT * FROM auction_bids WHERE auction_id = ? ORDER BY created_at DESC LIMIT ?').all(auctionId, limit);
}

// Placing a bid: the price automatically goes up by one step (bid_step); if within the last 10 seconds and anti-snipe is enabled, 30 seconds are added to the timer
export async function placeBid(tgId, auctionId) {
  const auction = await getAuction(auctionId);
  if (!auction || auction.status !== 'active') throw new Error('This auction is not active');
  const endsAtMs = new Date(auction.ends_at.replace(' ', 'T') + 'Z').getTime();
  if (Date.now() >= endsAtMs) throw new Error('This auction time has ended');

  const user = await getUser(tgId);
  if (!user || user.balance_toman < auction.min_wallet_balance) {
    throw new Error(`You need at least ${auction.min_wallet_balance.toLocaleString()} LNDC balance to participate`);
  }
  const newPrice = auction.current_price + auction.bid_step;
  if (user.balance_toman < newPrice) throw new Error('Insufficient wallet balance for this bid');

  let newEndsAtMs = endsAtMs;
  if (auction.anti_snipe && endsAtMs - Date.now() <= 10000) newEndsAtMs = Date.now() + 30000;
  const newEndsAt = new Date(newEndsAtMs).toISOString().replace('T', ' ').slice(0, 19);

  const tx = db.transaction(async () => {
    await db.prepare('UPDATE auctions SET current_price = ?, winner_tg_id = ?, ends_at = ? WHERE id = ?').run(newPrice, tgId, newEndsAt, auctionId);
    await db.prepare('INSERT INTO auction_bids (auction_id, tg_id, amount) VALUES (?,?,?)').run(auctionId, tgId, newPrice);
  });
  await tx();
  return { newPrice, newEndsAt, extended: newEndsAtMs !== endsAtMs };
}

// Closes finished auctions: if there's a winner with enough funds, payment and order are recorded automatically;
// otherwise it stays with status "unpaid" until the admin handles it manually
export async function finalizeExpiredAuctions(notifyFn) {
  const expired = await db.prepare(`SELECT * FROM auctions WHERE status = 'active' AND ends_at <= now_text()`).all();
  for (const a of expired) {
    if (!a.winner_tg_id) {
      await db.prepare(`UPDATE auctions SET status = 'ended' WHERE id = ?`).run(a.id);
      continue;
    }
    const user = await getUser(a.winner_tg_id);
    if (user && user.balance_toman >= a.current_price) {
      await adjustToman(a.winner_tg_id, -a.current_price, `Auction win «${a.title}»`);
      if (a.item_type === 'card') {
        await grantCardInstance(a.winner_tg_id, a.card_id);
      } else {
        await db.prepare(`INSERT INTO orders (tg_id, product_id, qty, total_toman, note) VALUES (?,?,1,?, 'Auction win')`).run(a.winner_tg_id, a.product_id, a.current_price);
      }
      await db.prepare(`UPDATE auctions SET status = 'ended' WHERE id = ?`).run(a.id);
      if (notifyFn) notifyFn(a.winner_tg_id, a, 'won');
    } else {
      await db.prepare(`UPDATE auctions SET status = 'unpaid' WHERE id = ?`).run(a.id);
      if (notifyFn) notifyFn(a.winner_tg_id, a, 'unpaid');
    }
  }
}

export async function getMyAuctionHistory(tgId, limit = 20) {
  return await db.prepare(`
    SELECT DISTINCT a.* FROM auctions a JOIN auction_bids b ON b.auction_id = a.id
    WHERE b.tg_id = ? ORDER BY a.created_at DESC LIMIT ?
  `).all(tgId, limit);
}
