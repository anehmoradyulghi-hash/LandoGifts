-- =========================================================================
-- Migration 012: gift system (LNDC gifts + card gifts) — converted from
-- src/gift-db.js.
-- =========================================================================

CREATE TABLE IF NOT EXISTS gift_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  card_gift_min_referrals INTEGER NOT NULL DEFAULT 3,
  card_gift_max_per_month INTEGER NOT NULL DEFAULT 1,
  card_gift_max_level INTEGER NOT NULL DEFAULT 3,
  toman_gift_fee_percent INTEGER NOT NULL DEFAULT 2
);
INSERT INTO gift_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS card_gifts_log (
  id SERIAL PRIMARY KEY,
  sender_tg_id BIGINT NOT NULL,
  receiver_tg_id BIGINT NOT NULL,
  user_card_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT now_text()
);
