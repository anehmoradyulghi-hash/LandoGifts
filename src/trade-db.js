import db from './db.js';
import { adjustToman, getUser } from './db.js';
import { getUserRankInfo } from './rank-db.js';

export async function getTradeConfig() { return await db.prepare('SELECT * FROM trade_config WHERE id = 1').get(); }
export async function setTradeConfig(c) {
  await db.prepare(`
    UPDATE trade_config SET enabled=?, max_tradable_level=?, max_trades_per_month=?, min_user_level=?, trade_fee_toman=?
    WHERE id = 1
  `).run(c.enabled ? 1 : 0, c.max_tradable_level, c.max_trades_per_month, c.min_user_level, c.trade_fee_toman);
}

async function monthlyAcceptedCount(tgId) {
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  return (await db.prepare(`
    SELECT COUNT(*) c FROM trade_offers
    WHERE status = 'accepted' AND resolved_at >= ? AND (from_tg_id = ? OR to_tg_id = ?)
  `).get(monthAgo, tgId, tgId)).c;
}

async function findUserCard(tgId, userCardId) {
  return await db.prepare(`
    SELECT uc.*, c.name, c.max_level FROM user_cards uc JOIN game_cards c ON c.id = uc.card_id
    WHERE uc.id = ? AND uc.tg_id = ?
  `).get(userCardId, tgId);
}

// Trade board: instead of needing to know the other party's ID, you list your card on the board
// and others make offers with one of their own cards
export async function createTradeListing(tgId, userCardId, note) {
  const cfg = await getTradeConfig();
  if (!cfg.enabled) throw new Error('The trade system is currently disabled');
  const info = await getUserRankInfo(tgId);
  if (info.level < cfg.min_user_level) throw new Error(`You must be at least level ${cfg.min_user_level}`);
  const card = await findUserCard(tgId, userCardId);
  if (!card) throw new Error('This card was not found');
  if (card.level > cfg.max_tradable_level) throw new Error(`Only level 1 to ${cfg.max_tradable_level} cards are tradeable`);
  const already = await db.prepare(`SELECT 1 FROM trade_listings WHERE user_card_id = ? AND status = 'open'`).get(userCardId);
  if (already) throw new Error('This card is already on the board right now');
  return (await db.prepare('INSERT INTO trade_listings (tg_id, user_card_id, note) VALUES (?,?,?)').run(tgId, userCardId, note || null)).lastInsertRowid;
}
export async function cancelTradeListing(tgId, id) {
  const listing = await db.prepare('SELECT * FROM trade_listings WHERE id = ?').get(id);
  if (!listing || listing.status !== 'open') throw new Error('This listing is no longer valid');
  if (listing.tg_id !== tgId) throw new Error('This listing does not belong to you');
  await db.prepare(`UPDATE trade_listings SET status = 'cancelled' WHERE id = ?`).run(id);
  await db.prepare(`UPDATE trade_offers SET status='cancelled', resolved_at=now_text() WHERE listing_id=? AND status='pending'`).run(id);
}
export async function listOpenTradeListings(excludeTgId) {
  return await db.prepare(`
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
export async function getMyTradeListings(tgId) {
  return await db.prepare(`
    SELECT tl.*, c.name, c.image_url FROM trade_listings tl
    JOIN user_cards uc ON uc.id = tl.user_card_id JOIN game_cards c ON c.id = uc.card_id
    WHERE tl.tg_id = ? ORDER BY tl.id DESC
  `).all(tgId);
}
export async function getTradeListing(id) { return await db.prepare('SELECT * FROM trade_listings WHERE id = ?').get(id); }

// Someone picks a listing from the board and offers one of their own cards
export async function createTradeOfferFromListing(fromTgId, listingId, fromUserCardId) {
  const listing = await getTradeListing(listingId);
  if (!listing || listing.status !== 'open') throw new Error('This listing is no longer available');
  if (listing.tg_id === fromTgId) throw new Error('You cannot make an offer on your own listing');
  return await createTradeOffer(fromTgId, listing.tg_id, fromUserCardId, listing.user_card_id, listingId);
}

export async function createTradeOffer(fromTgId, toTgId, fromUserCardId, toUserCardId, listingId = null) {
  const cfg = await getTradeConfig();
  if (!cfg.enabled) throw new Error('The trade system is currently disabled');
  if (fromTgId === toTgId) throw new Error('You cannot trade with yourself');

  const fromInfo = await getUserRankInfo(fromTgId), toInfo = await getUserRankInfo(toTgId);
  if (fromInfo.level < cfg.min_user_level) throw new Error(`You must be at least level ${cfg.min_user_level}`);
  if (toInfo.level < cfg.min_user_level) throw new Error('The other party level is not high enough yet');
  if (await monthlyAcceptedCount(fromTgId) >= cfg.max_trades_per_month) throw new Error('You have used up your trade quota for this month');

  const fromCard = await findUserCard(fromTgId, fromUserCardId);
  const toCard = await findUserCard(toTgId, toUserCardId);
  if (!fromCard || !toCard) throw new Error('One of the cards was not found');
  if (fromCard.level > cfg.max_tradable_level || toCard.level > cfg.max_tradable_level) {
    throw new Error(`Only level 1 to ${cfg.max_tradable_level} cards are tradeable`);
  }
  const user = await getUser(fromTgId);
  if (!user || user.balance_toman < cfg.trade_fee_toman) throw new Error(`A ${cfg.trade_fee_toman.toLocaleString()} LNDC fee is required to make a trade offer`);

  return (await db.prepare(`
    INSERT INTO trade_offers (from_tg_id, to_tg_id, from_user_card_id, to_user_card_id, listing_id) VALUES (?,?,?,?,?)
  `).run(fromTgId, toTgId, fromUserCardId, toUserCardId, listingId)).lastInsertRowid;
}

export async function respondTradeOffer(tgId, offerId, accept) {
  const offer = await db.prepare('SELECT * FROM trade_offers WHERE id = ?').get(offerId);
  if (!offer || offer.status !== 'pending') throw new Error('This offer is no longer valid');
  if (offer.to_tg_id !== tgId) throw new Error('This offer is not for you');

  if (!accept) {
    await db.prepare(`UPDATE trade_offers SET status = 'declined', resolved_at = now_text() WHERE id = ?`).run(offerId);
    return { accepted: false };
  }

  const cfg = await getTradeConfig();
  const fromCard = await findUserCard(offer.from_tg_id, offer.from_user_card_id);
  const toCard = await findUserCard(offer.to_tg_id, offer.to_user_card_id);
  if (!fromCard || !toCard) throw new Error('One of the cards is no longer available');
  const fromUser = await getUser(offer.from_tg_id), toUser = await getUser(offer.to_tg_id);
  if (fromUser.balance_toman < cfg.trade_fee_toman || toUser.balance_toman < cfg.trade_fee_toman) {
    throw new Error('One of the parties does not have enough balance for the fee');
  }

  const tx = db.transaction(async () => {
    await adjustToman(offer.from_tg_id, -cfg.trade_fee_toman, 'Card trade fee');
    await adjustToman(offer.to_tg_id, -cfg.trade_fee_toman, 'Card trade fee');
    await db.prepare('UPDATE user_cards SET tg_id = ? WHERE id = ?').run(offer.to_tg_id, offer.from_user_card_id);
    await db.prepare('UPDATE user_cards SET tg_id = ? WHERE id = ?').run(offer.from_tg_id, offer.to_user_card_id);
    await db.prepare(`UPDATE trade_offers SET status = 'accepted', resolved_at = now_text() WHERE id = ?`).run(offerId);
    if (offer.listing_id) {
      await db.prepare(`UPDATE trade_listings SET status = 'completed' WHERE id = ?`).run(offer.listing_id);
      // if several people had made offers on this listing, the rest become meaningless since the card is gone
      await db.prepare(`UPDATE trade_offers SET status='declined', resolved_at=now_text() WHERE listing_id=? AND status='pending' AND id != ?`).run(offer.listing_id, offerId);
    }
  });
  await tx();
  return { accepted: true };
}

export async function cancelTradeOffer(tgId, offerId) {
  const offer = await db.prepare('SELECT * FROM trade_offers WHERE id = ?').get(offerId);
  if (!offer || offer.status !== 'pending') throw new Error('This offer is no longer valid');
  if (offer.from_tg_id !== tgId) throw new Error('This offer does not belong to you');
  await db.prepare(`UPDATE trade_offers SET status = 'cancelled', resolved_at = now_text() WHERE id = ?`).run(offerId);
}

async function enrichOffers(rows) {
  return Promise.all(rows.map(async o => {
    const fromCard = await db.prepare('SELECT uc.level, c.name FROM user_cards uc JOIN game_cards c ON c.id=uc.card_id WHERE uc.id=?').get(o.from_user_card_id);
    const toCard = await db.prepare('SELECT uc.level, c.name FROM user_cards uc JOIN game_cards c ON c.id=uc.card_id WHERE uc.id=?').get(o.to_user_card_id);
    const fromUser = await db.prepare('SELECT first_name, username FROM users WHERE tg_id=?').get(o.from_tg_id);
    const toUser = await db.prepare('SELECT first_name, username FROM users WHERE tg_id=?').get(o.to_tg_id);
    return { ...o, fromCardName: fromCard ? `${fromCard.name} (Lv${fromCard.level})` : '—', toCardName: toCard ? `${toCard.name} (Lv${toCard.level})` : '—', fromUserName: fromUser?.first_name || '', toUserName: toUser?.first_name || '' };
  }));
}
export async function listMyTradeOffers(tgId) {
  const incoming = await db.prepare(`SELECT * FROM trade_offers WHERE to_tg_id = ? AND status = 'pending' ORDER BY created_at DESC`).all(tgId);
  const outgoing = await db.prepare(`SELECT * FROM trade_offers WHERE from_tg_id = ? AND status = 'pending' ORDER BY created_at DESC`).all(tgId);
  return { incoming: await enrichOffers(incoming), outgoing: await enrichOffers(outgoing) };
}
