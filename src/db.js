import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DB_PATH || path.join(__dirname, '../landogifts.db');
export const db = new Database(dbPath);

export function initDb() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            score INTEGER DEFAULT 0,
            level INTEGER DEFAULT 1,
            coins INTEGER DEFAULT 0,
            clan_id INTEGER DEFAULT NULL,
            bp_level INTEGER DEFAULT 1,
            bp_exp INTEGER DEFAULT 0,
            bp_is_premium INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            level INTEGER DEFAULT 1,
            power INTEGER DEFAULT 10,
            image_url TEXT,
            price INTEGER DEFAULT 0,
            is_shop_item INTEGER DEFAULT 0,
            is_special INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS user_cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            card_id INTEGER,
            acquired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(card_id) REFERENCES cards(id)
        );

        CREATE TABLE IF NOT EXISTS clans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            logo TEXT,
            score INTEGER DEFAULT 0,
            owner_id INTEGER,
            total_donated INTEGER DEFAULT 0,
            vault_balance INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            type TEXT,
            amount INTEGER,
            description TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS leaderboard_rewards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT,
            rank_position INTEGER,
            reward_type TEXT,
            reward_value TEXT,
            UNIQUE(category, rank_position)
        );

        CREATE TABLE IF NOT EXISTS battlepass_levels (
            level INTEGER PRIMARY KEY,
            required_exp INTEGER,
            reward_type TEXT,
            reward_amount INTEGER DEFAULT 0,
            reward_item_id INTEGER DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS auctions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id INTEGER,
            current_bid INTEGER DEFAULT 0,
            highest_bidder_id INTEGER DEFAULT NULL,
            status TEXT DEFAULT 'ACTIVE',
            ends_at DATETIME
        );

        CREATE TABLE IF NOT EXISTS user_avatars (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            avatar_id TEXT,
            acquired_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log("Database initialized successfully.");
}
