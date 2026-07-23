import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');

// Users
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    tg_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    balance_toman INTEGER NOT NULL DEFAULT 0,
    is_banned INTEGER NOT NULL DEFAULT 0,
    ban_reason TEXT,
    referred_by INTEGER,
    ref_code TEXT UNIQUE,
    joined_at TEXT DEFAULT (datetime('now')),
    last_active TEXT DEFAULT (datetime('now'))
  );
`);

// Wallets (multi-currency)
db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER NOT NULL,
    currency_code TEXT NOT NULL DEFAULT 'TOMAN',
    balance REAL NOT NULL DEFAULT 0,
    UNIQUE(tg_id, currency_code)
  );
`);

// Ledger
db.exec(`
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER NOT NULL,
    currency_code TEXT NOT NULL DEFAULT 'TOMAN',
    amount REAL NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('in','out')),
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Products
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    image_url TEXT,
    price_toman INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Orders
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    total_toman INTEGER NOT NULL,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'paid' CHECK(status IN ('paid','delivered','cancelled')),
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Currencies
db.exec(`
  CREATE TABLE IF NOT EXISTS currencies (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rate_toman REAL,
    min_deposit REAL DEFAULT 0,
    min_withdraw REAL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );
`);

// Currency requests
db.exec(`
  CREATE TABLE IF NOT EXISTS currency_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('deposit','withdraw')),
    currency_code TEXT NOT NULL,
    amount REAL NOT NULL,
    tx_hash TEXT,
    address TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Toman topups
db.exec(`
  CREATE TABLE IF NOT EXISTS toman_topups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    tracking_code TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Toman withdrawals
db.exec(`
  CREATE TABLE IF NOT EXISTS toman_withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    card_number TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Gift offers
db.exec(`
  CREATE TABLE IF NOT EXISTS gift_offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_tg_id INTEGER NOT NULL,
    buyer_tg_id INTEGER,
    title TEXT NOT NULL,
    image_url TEXT,
    price_toman INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','reserved','completed','cancelled')),
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Tasks
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'join_channel' CHECK(kind IN ('join_channel','custom')),
    channel_username TEXT,
    reward_toman INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );
`);

// Task completions
db.exec(`
  CREATE TABLE IF NOT EXISTS task_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(tg_id, task_id)
  );
`);

// Game config
db.exec(`
  CREATE TABLE IF NOT EXISTS game_config (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    min_deck_size INTEGER NOT NULL DEFAULT 1,
    max_deck_size INTEGER NOT NULL DEFAULT 5,
    daily_play_limit INTEGER NOT NULL DEFAULT 3,
    extra_play_price_toman INTEGER NOT NULL DEFAULT 5000,
    extra_play_count INTEGER NOT NULL DEFAULT 3,
    upgrade_base_cost_toman INTEGER NOT NULL DEFAULT 1000,
    leaderboard_reset_days INTEGER NOT NULL DEFAULT 7,
    period_started_at TEXT DEFAULT (datetime('now'))
  );
`);

// Game cards (updated rarities)
db.exec(`
  CREATE TABLE IF NOT EXISTS game_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    image_url TEXT,
    rarity TEXT NOT NULL DEFAULT 'common' CHECK(rarity IN ('common','uncommon','rare','epic','legendary','mythic','god')),
    base_power INTEGER NOT NULL DEFAULT 10,
    price_toman INTEGER NOT NULL DEFAULT 0,
    max_level INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1
  );
`);

// User cards
db.exec(`
  CREATE TABLE IF NOT EXISTS user_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER NOT NULL,
    card_id INTEGER NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,
    power INTEGER NOT NULL DEFAULT 10,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Game matches
db.exec(`
  CREATE TABLE IF NOT EXISTS game_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_a INTEGER NOT NULL,
    player_b INTEGER NOT NULL,
    power_a INTEGER NOT NULL,
    power_b INTEGER NOT NULL,
    winner_tg_id INTEGER,
    played_at TEXT DEFAULT (datetime('now'))
  );
`);

// Leaderboard prizes
db.exec(`
  CREATE TABLE IF NOT EXISTS leaderboard_prizes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rank_from INTEGER NOT NULL,
    rank_to INTEGER NOT NULL,
    reward_toman INTEGER NOT NULL DEFAULT 0
  );
`);

// Card tasks
db.exec(`
  CREATE TABLE IF NOT EXISTS card_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'join_channel' CHECK(kind IN ('join_channel','custom')),
    channel_username TEXT,
    reward_card_id INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );
`);

// Card task completions
db.exec(`
  CREATE TABLE IF NOT EXISTS card_task_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER NOT NULL,
    card_task_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(tg_id, card_task_id)
  );
`);

// Support tickets
db.exec(`
  CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
    last_message TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Support messages
db.exec(`
  CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    sender TEXT NOT NULL CHECK(sender IN ('user','admin')),
    body TEXT,
    image_url TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Config
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ZarinPal payments
db.exec(`
  CREATE TABLE IF NOT EXISTS zarinpal_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    authority TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed')),
    ref_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Broadcast logs
db.exec(`
  CREATE TABLE IF NOT EXISTS broadcast_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_tg_id INTEGER,
    message TEXT NOT NULL,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Ensure default game config
const defaultGameConfig = db.prepare(`SELECT 1 FROM game_config WHERE id = 1`).get();
if (!defaultGameConfig) {
  db.prepare(`INSERT INTO game_config (id, min_deck_size, max_deck_size, daily_play_limit, extra_play_price_toman, extra_play_count, upgrade_base_cost_toman, leaderboard_reset_days) VALUES (1, 1, 5, 3, 5000, 3, 1000, 7)`).run();
}

// Ensure default config values
const ensureConfig = (key, value) => {
  const exists = db.prepare(`SELECT 1 FROM config WHERE key = ?`).get(key);
  if (!exists) db.prepare(`INSERT INTO config (key, value) VALUES (?, ?)`).run(key, value);
};
ensureConfig('referral_percent', '5');
ensureConfig('gift_market_fee_percent', '5');
ensureConfig('swap_fee_percent', '1');
ensureConfig('welcome_message', 'سلام! خوش اومدی 🎁');
ensureConfig('required_channel', '');
ensureConfig('card_number', '');
ensureConfig('card_owner', '');
ensureConfig('zarinpal_merchant_id', '');


// User extra plays
 db.exec(`
  CREATE TABLE IF NOT EXISTS user_game_extra (
    tg_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    extra_plays INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tg_id, date)
  );
`);

// Game leaderboard
 db.exec(`
  CREATE TABLE IF NOT EXISTS game_leaderboard (
    tg_id INTEGER PRIMARY KEY,
    score INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0
  );
`);

export default db;
