-- =========================================================================
-- Migration 007: big wheel raffles — converted from src/raffle-db.js.
-- =========================================================================

CREATE TABLE IF NOT EXISTS raffles (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  prize_description TEXT,
  capacity INTEGER NOT NULL DEFAULT 100,
  winners_count INTEGER NOT NULL DEFAULT 10,
  required_task_id INTEGER,
  ticket_price_toman INTEGER NOT NULL DEFAULT 0,
  max_tickets_per_user INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open', -- open | finished | cancelled
  created_at TEXT NOT NULL DEFAULT now_text(),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS raffle_entries (
  id SERIAL PRIMARY KEY,
  raffle_id INTEGER NOT NULL,
  tg_id BIGINT NOT NULL,
  tickets INTEGER NOT NULL DEFAULT 1,
  is_winner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT now_text(),
  UNIQUE(raffle_id, tg_id)
);

CREATE INDEX IF NOT EXISTS idx_raffle_entries_raffle ON raffle_entries (raffle_id);
