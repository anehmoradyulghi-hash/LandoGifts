-- =========================================================================
-- Migration 016: promo/gift codes — converted from src/promo-db.js.
-- =========================================================================

CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,
  reward_type TEXT NOT NULL,   -- toman | card | bp_discount | lootbox_discount
  reward_value TEXT,
  max_uses INTEGER,            -- empty = unlimited
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,             -- empty = no expiry
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  code TEXT NOT NULL,
  tg_id BIGINT NOT NULL,
  redeemed_at TEXT NOT NULL DEFAULT now_text(),
  PRIMARY KEY (code, tg_id)
);
