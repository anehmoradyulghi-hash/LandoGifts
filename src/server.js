import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { db, initDb } from './db.js';
import { setupTelegramBot } from './telegram.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/admin', express.static(path.join(__dirname, '../admin')));

// Initialize Database
initDb();

// CONFIG & SUPPORT DIRECT ID
app.get('/api/config', (req, res) => {
    res.json({
        supportUsername: process.env.SUPPORT_USERNAME || "YourSupportHandle",
        botUsername: process.env.BOT_USERNAME || "LandoGiftsBot"
    });
});

// 1. LEADERBOARD (Game Points, Clan, Level + User Rank + Top 10)
app.get('/api/leaderboard', (req, res) => {
    const userId = req.query.user_id;

    const topScore = db.prepare(`
        SELECT id, username, first_name, score, level 
        FROM users 
        ORDER BY score DESC LIMIT 10
    `).all();

    const topLevel = db.prepare(`
        SELECT id, username, first_name, level, score 
        FROM users 
        ORDER BY level DESC, score DESC LIMIT 10
    `).all();

    const topClans = db.prepare(`
        SELECT id, name, logo, score, total_donated, vault_balance 
        FROM clans 
        ORDER BY score DESC LIMIT 10
    `).all();

    const rewards = db.prepare(`SELECT * FROM leaderboard_rewards`).all();

    let userRanks = { scoreRank: null, levelRank: null, clanRank: null };
    if (userId) {
        const u = db.prepare(`SELECT id, score, level, clan_id FROM users WHERE id = ?`).get(userId);
        if (u) {
            const sRank = db.prepare(`SELECT COUNT(*) + 1 as rank FROM users WHERE score > ?`).get(u.score);
            const lRank = db.prepare(`SELECT COUNT(*) + 1 as rank FROM users WHERE level > ?`).get(u.level);
            userRanks.scoreRank = sRank.rank;
            userRanks.levelRank = lRank.rank;

            if (u.clan_id) {
                const clan = db.prepare(`SELECT score FROM clans WHERE id = ?`).get(u.clan_id);
                if (clan) {
                    const cRank = db.prepare(`SELECT COUNT(*) + 1 as rank FROM clans WHERE score > ?`).get(clan.score);
                    userRanks.clanRank = cRank.rank;
                }
            }
        }
    }

    res.json({
        topScore,
        topLevel,
        topClans,
        userRanks,
        rewards
    });
});

app.post('/api/admin/leaderboard-rewards', (req, res) => {
    const { category, rank_position, reward_type, reward_value } = req.body;
    db.prepare(`
        INSERT INTO leaderboard_rewards (category, rank_position, reward_type, reward_value)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(category, rank_position) DO UPDATE SET
            reward_type=excluded.reward_type,
            reward_value=excluded.reward_value
    `).run(category, rank_position, reward_type, reward_value);

    res.json({ success: true, message: "Leaderboard reward updated." });
});

// 2. RECENT TRANSACTIONS (PAGINATED / LIMITED TO LAST 20)
app.get('/api/transactions/:userId', (req, res) => {
    const { userId } = req.params;
    const txs = db.prepare(`
        SELECT * FROM transactions 
        WHERE user_id = ? 
        ORDER BY created_at DESC LIMIT 20
    `).all(userId);

    res.json(txs);
});

// 3. ADVANCED BATTLE PASS
app.get('/api/battlepass', (req, res) => {
    const userId = req.query.user_id;

    const passConfig = db.prepare(`SELECT * FROM battlepass_levels ORDER BY level ASC`).all();
    let userProgress = null;

    if (userId) {
        userProgress = db.prepare(`SELECT bp_level, bp_exp, bp_is_premium FROM users WHERE id = ?`).get(userId);
    }

    res.json({
        levels: passConfig,
        userProgress
    });
});

app.post('/api/battlepass/claim', (req, res) => {
    const { userId, level } = req.body;
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
    const reward = db.prepare(`SELECT * FROM battlepass_levels WHERE level = ?`).get(level);

    if (!user || !reward) return res.status(400).json({ error: "Invalid request" });
    if (user.bp_level < level) return res.status(400).json({ error: "Level not unlocked yet" });

    if (reward.reward_type === 'coins') {
        db.prepare(`UPDATE users SET coins = coins + ? WHERE id = ?`).run(reward.reward_amount, userId);
    } else if (reward.reward_type === 'card') {
        db.prepare(`INSERT INTO user_cards (user_id, card_id) VALUES (?, ?)`).run(userId, reward.reward_item_id);
    } else if (reward.reward_type === 'avatar') {
        db.prepare(`INSERT INTO user_avatars (user_id, avatar_id) VALUES (?, ?)`).run(userId, reward.reward_item_id);
    }

    res.json({ success: true, message: `Reward claimed for Level ${level}` });
});

// 4. CLAN VAULT MANAGEMENT
app.post('/api/clan/vault/withdraw', (req, res) => {
    const { clanId, leaderId, amount, targetUserId } = req.body;

    const clan = db.prepare(`SELECT * FROM clans WHERE id = ?`).get(clanId);
    if (!clan || clan.owner_id != leaderId) {
        return res.status(403).json({ error: "Only clan owner can manage vault funds." });
    }

    if (clan.vault_balance < amount) {
        return res.status(400).json({ error: "Insufficient clan vault balance." });
    }

    db.prepare(`UPDATE clans SET vault_balance = vault_balance - ? WHERE id = ?`).run(amount, clanId);

    if (targetUserId) {
        db.prepare(`UPDATE users SET coins = coins + ? WHERE id = ?`).run(amount, targetUserId);
    } else {
        db.prepare(`UPDATE users SET coins = coins + ? WHERE id = ?`).run(amount, leaderId);
    }

    res.json({ success: true, message: "Vault action completed successfully." });
});

// 5. IN-BATTLE CARD SELECTION
app.get('/api/battle/available-cards/:userId', (req, res) => {
    const { userId } = req.params;
    const userCards = db.prepare(`
        SELECT uc.id as instance_id, c.* 
        FROM user_cards uc
        JOIN cards c ON uc.card_id = c.id
        WHERE uc.user_id = ?
    `).all(userId);

    res.json(userCards);
});

// 6. CARD AUCTION SYSTEM
app.get('/api/auctions', (req, res) => {
    const activeAuctions = db.prepare(`
        SELECT a.*, c.title, c.image_url, c.power 
        FROM auctions a
        JOIN cards c ON a.card_id = c.id
        WHERE a.status = 'ACTIVE'
    `).all();
    res.json(activeAuctions);
});

app.post('/api/admin/auctions/create', (req, res) => {
    const { cardId, startingBid, durationHours } = req.body;
    const endsAt = new Date(Date.now() + durationHours * 3600 * 1000).toISOString();

    db.prepare(`
        INSERT INTO auctions (card_id, current_bid, highest_bidder_id, status, ends_at)
        VALUES (?, ?, NULL, 'ACTIVE', ?)
    `).run(cardId, startingBid, endsAt);

    res.json({ success: true, message: "Auction created successfully." });
});

app.post('/api/auctions/place-bid', (req, res) => {
    const { auctionId, userId, bidAmount } = req.body;
    const auction = db.prepare(`SELECT * FROM auctions WHERE id = ? AND status = 'ACTIVE'`).get(auctionId);
    const user = db.prepare(`SELECT coins FROM users WHERE id = ?`).get(userId);

    if (!auction) return res.status(404).json({ error: "Auction expired or not found." });
    if (user.coins < bidAmount) return res.status(400).json({ error: "Insufficient coins." });
    if (bidAmount <= auction.current_bid) return res.status(400).json({ error: "Bid must be higher than current bid." });

    db.prepare(`UPDATE auctions SET current_bid = ?, highest_bidder_id = ? WHERE id = ?`)
      .run(bidAmount, userId, auctionId);

    res.json({ success: true, message: "Bid placed successfully!" });
});

app.post('/api/auctions/finalize', (req, res) => {
    const expiredAuctions = db.prepare(`
        SELECT * FROM auctions WHERE status = 'ACTIVE' AND ends_at <= DATETIME('now')
    `).all();

    for (let auc of expiredAuctions) {
        if (auc.highest_bidder_id) {
            db.prepare(`UPDATE users SET coins = coins - ? WHERE id = ?`).run(auc.current_bid, auc.highest_bidder_id);
            db.prepare(`INSERT INTO user_cards (user_id, card_id) VALUES (?, ?)`).run(auc.highest_bidder_id, auc.card_id);
            db.prepare(`UPDATE auctions SET status = 'CLOSED' WHERE id = ?`).run(auc.id);
        } else {
            db.prepare(`UPDATE auctions SET status = 'CANCELLED' WHERE id = ?`).run(auc.id);
        }
    }
    res.json({ success: true, processedCount: expiredAuctions.length });
});

// 7. LEVEL 7 SPECIAL CARDS & CARD SHOP
app.post('/api/admin/cards/create-level7', (req, res) => {
    const { title, power, imageUrl, price, isShopItem } = req.body;
    
    const result = db.prepare(`
        INSERT INTO cards (title, level, power, image_url, price, is_shop_item, is_special)
        VALUES (?, 7, ?, ?, ?, ?, 1)
    `).run(title, power, imageUrl, price || 0, isShopItem ? 1 : 0);

    res.json({ success: true, cardId: result.lastInsertRowid });
});

app.get('/api/shop/cards', (req, res) => {
    const shopCards = db.prepare(`SELECT * FROM cards WHERE is_shop_item = 1`).all();
    res.json(shopCards);
});

app.post('/api/shop/buy-card', (req, res) => {
    const { userId, cardId } = req.body;
    const card = db.prepare(`SELECT * FROM cards WHERE id = ? AND is_shop_item = 1`).get(cardId);
    const user = db.prepare(`SELECT coins FROM users WHERE id = ?`).get(userId);

    if (!card || !user) return res.status(400).json({ error: "Invalid item or user" });
    if (user.coins < card.price) return res.status(400).json({ error: "Insufficient balance" });

    db.transaction(() => {
        db.prepare(`UPDATE users SET coins = coins - ? WHERE id = ?`).run(card.price, userId);
        db.prepare(`INSERT INTO user_cards (user_id, card_id) VALUES (?, ?)`).run(userId, cardId);
    })();

    res.json({ success: true, message: `${card.title} added to your inventory!` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`LandoGifts Super MiniApp Server running on port ${PORT}`);
});

setupTelegramBot();
