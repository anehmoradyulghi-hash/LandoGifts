import db from './db.js';
import { adjustToman, getUser } from './db.js';

/* =========================================================================
 * Card Marketplace — players list a card they own for a price in LNDC; any other
 * player can buy it. Replaces the old direct card-to-card Exchange (removed).
 * Fee follows the same percent-of-price pattern already used by the Gift Market
 * and the old Card Exchange fee, just with its own dedicated setting.
 * ========================================================================= */
db.exec(`
CREATE TABLE IF NOT EXISTS card_market_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  fee_percent INTEGER NOT NULL DEFAULT 5
);
INSERT OR IGNORE INTO card_market_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS card_market_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_tg_id INTEGER NOT NULL,
  user_card_id INTEGER NOT NULL,
  price_toman INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | sold | cancelled
  buyer_tg_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
`);

export function getCardMarketConfig() { return db.prepare('SELECT * FROM card_market_config WHERE id = 1').get(); }
export function setCardMarketConfig(c) {
  db.prepare('UPDATE card_market_config SET enabled=?, fee_percent=? WHERE id=1')
    .run(c.enabled ? 1 : 0, Number(c.fee_percent) || 0);
}

function findOwnedUserCard(tgId, userCardId) {
  return db.prepare(`
    SELECT uc.*, c.name FROM user_cards uc JOIN game_cards c ON c.id = uc.card_id
    WHERE uc.id = ? AND uc.tg_id = ?
  `).get(userCardId, tgId);
}

// A card is "locked" the moment it has an open marketplace listing. Every other place in the app
// that can use or move a card (joining a battle deck, mutation/level-up, sacrifice/boost, gifting a
// card to a friend, listing it again) must check this and refuse — otherwise the same card could be
// used to fight, be destroyed by mutation, or be gifted away while someone else is mid-purchase of it.
export function isCardListedForSale(userCardId) {
  return !!db.prepare(`SELECT 1 FROM card_market_listings WHERE user_card_id = ? AND status = 'open'`).get(userCardId);
}

export function createCardMarketListing(tgId, userCardId, priceToman) {
  const cfg = getCardMarketConfig();
  if (!cfg.enabled) throw new Error('The card marketplace is currently disabled');
  const price = Math.round(Number(priceToman));
  if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid price');
  const card = findOwnedUserCard(tgId, userCardId);
  if (!card) throw new Error('This card was not found in your collection');
  if (isCardListedForSale(userCardId)) throw new Error('This card is already listed on the marketplace');
  return db.prepare(`
    INSERT INTO card_market_listings (seller_tg_id, user_card_id, price_toman) VALUES (?,?,?)
  `).run(tgId, userCardId, price).lastInsertRowid;
}

export function cancelCardMarketListing(tgId, id) {
  const listing = db.prepare('SELECT * FROM card_market_listings WHERE id = ?').get(id);
  if (!listing || listing.status !== 'open') throw new Error('This listing is no longer valid');
  if (listing.seller_tg_id !== tgId) throw new Error('This listing does not belong to you');
  db.prepare(`UPDATE card_market_listings SET status='cancelled', resolved_at=datetime('now') WHERE id=?`).run(id);
}

export function listCardMarketOffers(excludeTgId) {
  return db.prepare(`
    SELECT ml.id, ml.seller_tg_id, ml.price_toman, ml.created_at,
      uc.id AS user_card_id, uc.level, uc.bonus_power, uc.rolled_power,
      c.name, c.image_url, c.level_images, c.base_power, c.fixed_power,
      u.first_name, u.username
    FROM card_market_listings ml
    JOIN user_cards uc ON uc.id = ml.user_card_id
    JOIN game_cards c ON c.id = uc.card_id
    JOIN users u ON u.tg_id = ml.seller_tg_id
    WHERE ml.status = 'open' AND ml.seller_tg_id != ?
    ORDER BY ml.id DESC
  `).all(excludeTgId || 0);
}
export function getMyCardMarketListings(tgId) {
  return db.prepare(`
    SELECT ml.*, c.name, c.image_url, uc.level FROM card_market_listings ml
    JOIN user_cards uc ON uc.id = ml.user_card_id JOIN game_cards c ON c.id = uc.card_id
    WHERE ml.seller_tg_id = ? ORDER BY ml.id DESC LIMIT 50
  `).all(tgId);
}
export function getCardMarketListing(id) { return db.prepare('SELECT * FROM card_market_listings WHERE id = ?').get(id); }

// Atomic purchase. The UPDATE ... WHERE status='open' is the concurrency guard: if two buyers race
// the same listing, only the first UPDATE actually flips a row (changes === 1); the second gets
// changes === 0 and throws immediately, before touching any balance or card ownership — so a losing
// race never leaves anyone's wallet or the card in a half-finished state. Everything else (fee split,
// balance transfer, ownership transfer) happens in the same transaction, so if any step throws, the
// whole purchase rolls back together.
export function buyCardMarketListing(buyerTgId, listingId) {
  const cfg = getCardMarketConfig();
  if (!cfg.enabled) throw new Error('The card marketplace is currently disabled');
  const listing = getCardMarketListing(listingId);
  if (!listing || listing.status !== 'open') throw new Error('This listing is no longer available');
  if (listing.seller_tg_id === buyerTgId) throw new Error('You cannot buy your own listing');
  const buyer = getUser(buyerTgId);
  if (!buyer || buyer.balance_toman < listing.price_toman) throw new Error('Insufficient wallet balance');

  const tx = db.transaction(() => {
    const claim = db.prepare(`
      UPDATE card_market_listings SET status='sold', buyer_tg_id=?, resolved_at=datetime('now')
      WHERE id = ? AND status = 'open'
    `).run(buyerTgId, listingId);
    if (claim.changes === 0) throw new Error('This listing was just bought by someone else');

    // Defensive re-check: the card should always still belong to the seller, since a listed card is
    // locked out of every other transfer path for as long as its listing stays open.
    const card = db.prepare('SELECT * FROM user_cards WHERE id = ? AND tg_id = ?').get(listing.user_card_id, listing.seller_tg_id);
    if (!card) throw new Error('The card is no longer with the seller');

    const fee = Math.floor((listing.price_toman * cfg.fee_percent) / 100);
    const sellerProceeds = listing.price_toman - fee;
    adjustToman(buyerTgId, -listing.price_toman, `Bought card on marketplace (listing #${listingId})`);
    adjustToman(listing.seller_tg_id, sellerProceeds, `Card sold on marketplace (listing #${listingId})${fee > 0 ? ` — ${fee} LNDC fee` : ''}`);
    db.prepare('UPDATE user_cards SET tg_id = ? WHERE id = ?').run(buyerTgId, listing.user_card_id);
  });
  tx();
  return { ok: true };
}
