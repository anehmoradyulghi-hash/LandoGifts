import db from './db.js';

/* =========================================================================
 * Performance indexes
 * None of these tables had any index beyond their primary key. For a bot
 * where nearly every request is "give me this one user's rows" or "give me
 * the open/active rows", that means a full table scan on every single query
 * once a table grows past a trivial size — the ledger, user_cards, and
 * game_matches tables in particular only ever grow. This file is imported
 * last (see server.js), after every other module has already created its
 * tables, so every index below is guaranteed to apply to a table that
 * exists. IF NOT EXISTS makes this safe to run on every boot.
 * Every table/column name here was checked against its actual CREATE TABLE
 * definition; tables whose lookup column is already the primary key (or the
 * leftmost column of a composite primary key / UNIQUE constraint) are
 * intentionally skipped since SQLite already has an index for that case.
 * ========================================================================= */
db.exec(`
  -- Card game
  CREATE INDEX IF NOT EXISTS idx_user_cards_tg_id ON user_cards(tg_id);
  CREATE INDEX IF NOT EXISTS idx_user_cards_card_id ON user_cards(card_id);
  CREATE INDEX IF NOT EXISTS idx_game_cards_category_id ON game_cards(category_id);
  CREATE INDEX IF NOT EXISTS idx_game_matches_player_a ON game_matches(player_a);
  CREATE INDEX IF NOT EXISTS idx_game_matches_player_b ON game_matches(player_b);
  CREATE INDEX IF NOT EXISTS idx_game_play_log_tg_id ON game_play_log(tg_id);

  -- Card Marketplace
  CREATE INDEX IF NOT EXISTS idx_card_market_listings_status ON card_market_listings(status);
  CREATE INDEX IF NOT EXISTS idx_card_market_listings_seller ON card_market_listings(seller_tg_id);
  CREATE INDEX IF NOT EXISTS idx_card_market_listings_user_card_id ON card_market_listings(user_card_id);

  -- Wallet / ledger / currencies
  CREATE INDEX IF NOT EXISTS idx_ledger_tg_id ON ledger(tg_id);
  CREATE INDEX IF NOT EXISTS idx_currency_requests_tg_id ON currency_requests(tg_id);
  CREATE INDEX IF NOT EXISTS idx_currency_requests_status ON currency_requests(status);
  CREATE INDEX IF NOT EXISTS idx_toman_topups_tg_id ON toman_topups(tg_id);
  CREATE INDEX IF NOT EXISTS idx_toman_topups_status ON toman_topups(status);
  CREATE INDEX IF NOT EXISTS idx_toman_withdrawals_tg_id ON toman_withdrawals(tg_id);
  CREATE INDEX IF NOT EXISTS idx_toman_withdrawals_status ON toman_withdrawals(status);
  CREATE INDEX IF NOT EXISTS idx_star_payments_tg_id ON star_payments(tg_id);

  -- Shop / gifts
  CREATE INDEX IF NOT EXISTS idx_orders_tg_id ON orders(tg_id);
  CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
  CREATE INDEX IF NOT EXISTS idx_gift_offers_status ON gift_offers(status);
  CREATE INDEX IF NOT EXISTS idx_gift_offers_seller_tg_id ON gift_offers(seller_tg_id);
  CREATE INDEX IF NOT EXISTS idx_gift_offers_buyer_tg_id ON gift_offers(buyer_tg_id);
  CREATE INDEX IF NOT EXISTS idx_card_gifts_log_sender ON card_gifts_log(sender_tg_id);
  CREATE INDEX IF NOT EXISTS idx_card_gifts_log_receiver ON card_gifts_log(receiver_tg_id);

  -- Users / referrals
  CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);
  CREATE INDEX IF NOT EXISTS idx_users_ref_code ON users(ref_code);
  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

  -- Clans
  CREATE INDEX IF NOT EXISTS idx_clan_members_clan_id ON clan_members(clan_id);
  CREATE INDEX IF NOT EXISTS idx_clan_donations_clan_id ON clan_donations(clan_id);
  CREATE INDEX IF NOT EXISTS idx_clan_donations_tg_id ON clan_donations(tg_id);
  CREATE INDEX IF NOT EXISTS idx_clan_wars_status ON clan_wars(status);

  -- Ranks / quests / albums / promo
  CREATE INDEX IF NOT EXISTS idx_promo_redemptions_tg_id ON promo_redemptions(tg_id);
  CREATE INDEX IF NOT EXISTS idx_user_album_claims_tg_id ON user_album_claims(tg_id);
  CREATE INDEX IF NOT EXISTS idx_user_avatars_tg_id ON user_avatars(tg_id);

  -- Raffles / auctions
  CREATE INDEX IF NOT EXISTS idx_raffle_entries_tg_id ON raffle_entries(tg_id);
  CREATE INDEX IF NOT EXISTS idx_auction_bids_auction_id ON auction_bids(auction_id);
  CREATE INDEX IF NOT EXISTS idx_auction_bids_tg_id ON auction_bids(tg_id);

  -- Support tickets
  CREATE INDEX IF NOT EXISTS idx_tickets_tg_id ON tickets(tg_id);
  CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket_id ON ticket_messages(ticket_id);
`);
