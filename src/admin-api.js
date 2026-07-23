import express from 'express';
import db from './db.js';
import { sendMessage } from './telegram.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

const router = express.Router();
const ADMIN_PW = process.env.ADMIN_PANEL_PASSWORD || '';

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : '';
}
function setConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
}

function adminAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  if (token !== req.app.locals.adminToken) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Login
router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PW) return res.status(401).json({ error: 'Invalid password' });
  const token = 'admin_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  req.app.locals.adminToken = token;
  res.json({ token });
});

// Upload
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = (process.env.PUBLIC_URL || '') + '/uploads/' + req.file.filename;
  res.json({ url });
});

// Stats
router.get('/stats', adminAuth, (req, res) => {
  const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const orders = db.prepare('SELECT COUNT(*) as c FROM orders').get().c;
  const totalToman = db.prepare('SELECT COALESCE(SUM(amount), 0) as s FROM toman_topups WHERE status = ?').get('approved').s || 0;
  const pendingTopups = db.prepare('SELECT COUNT(*) as c FROM toman_topups WHERE status = ?').get('pending').c;
  const pendingCurrency = db.prepare('SELECT COUNT(*) as c FROM currency_requests WHERE status = ?').get('pending').c;
  const openTickets = db.prepare('SELECT COUNT(*) as c FROM support_tickets WHERE status = ?').get('open').c;
  res.json({ users, orders, totalToman, pendingTopups, pendingCurrency, openTickets });
});

// Config
router.get('/config', adminAuth, (req, res) => {
  const keys = ['referral_percent', 'gift_market_fee_percent', 'swap_fee_percent', 'welcome_message', 'required_channel', 'card_number', 'card_owner', 'zarinpal_merchant_id'];
  const cfg = {};
  keys.forEach(k => cfg[k] = getConfig(k));
  res.json(cfg);
});

router.post('/config', adminAuth, (req, res) => {
  const { key, value } = req.body;
  setConfig(key, value);
  res.json({ ok: true });
});

// Currencies
router.get('/currencies', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM currencies').all());
});

router.post('/currencies', adminAuth, (req, res) => {
  const { code, name, rate_toman, min_deposit, min_withdraw, active } = req.body;
  db.prepare(`INSERT INTO currencies (code, name, rate_toman, min_deposit, min_withdraw, active)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, rate_toman=excluded.rate_toman, min_deposit=excluded.min_deposit, min_withdraw=excluded.min_withdraw, active=excluded.active`)
    .run(code, name, rate_toman || 0, min_deposit || 0, min_withdraw || 0, active ? 1 : 0);
  res.json({ ok: true });
});

// Toman topups
router.get('/toman-topups', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM toman_topups WHERE status = ? ORDER BY id DESC').all('pending'));
});

router.post('/toman-topups/:id/decide', adminAuth, (req, res) => {
  const { approve } = req.body;
  const row = db.prepare('SELECT * FROM toman_topups WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE toman_topups SET status = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', req.params.id);
  if (approve) {
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE tg_id = ? AND currency_code = ?').run(row.amount, row.tg_id, 'TOMAN');
    db.prepare('INSERT INTO ledger (tg_id, currency_code, amount, direction, reason) VALUES (?, ?, ?, ?, ?)')
      .run(row.tg_id, 'TOMAN', row.amount, 'in', 'شارژ کارت‌به‌کارت');
  }
  res.json({ ok: true });
});

// Toman withdrawals
router.get('/toman-withdrawals', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM toman_withdrawals WHERE status = ? ORDER BY id DESC').all('pending'));
});

router.post('/toman-withdrawals/:id/decide', adminAuth, (req, res) => {
  const { approve } = req.body;
  db.prepare('UPDATE toman_withdrawals SET status = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', req.params.id);
  res.json({ ok: true });
});

// Currency requests
router.get('/currency-requests', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM currency_requests WHERE status = ? ORDER BY id DESC').all('pending'));
});

router.post('/currency-requests/:id/decide', adminAuth, (req, res) => {
  const { approve } = req.body;
  const row = db.prepare('SELECT * FROM currency_requests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE currency_requests SET status = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', req.params.id);
  if (approve) {
    if (row.kind === 'deposit') {
      db.prepare('UPDATE wallets SET balance = balance + ? WHERE tg_id = ? AND currency_code = ?').run(row.amount, row.tg_id, row.currency_code);
      db.prepare('INSERT INTO ledger (tg_id, currency_code, amount, direction, reason) VALUES (?, ?, ?, ?, ?)')
        .run(row.tg_id, row.currency_code, row.amount, 'in', 'واریز ارز');
    }
  }
  res.json({ ok: true });
});

// Products
router.get('/products', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY id DESC').all());
});

router.post('/products', adminAuth, (req, res) => {
  const { id, title, description, image_url, price_toman, active } = req.body;
  if (id) {
    db.prepare('UPDATE products SET title=?, description=?, image_url=?, price_toman=?, active=? WHERE id=?')
      .run(title, description || null, image_url || null, price_toman, active ? 1 : 0, id);
  } else {
    db.prepare('INSERT INTO products (title, description, image_url, price_toman, active) VALUES (?, ?, ?, ?, ?)')
      .run(title, description || null, image_url || null, price_toman, active ? 1 : 0);
  }
  res.json({ ok: true });
});

router.delete('/products/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Orders
router.get('/orders', adminAuth, (req, res) => {
  res.json(db.prepare(`SELECT o.*, p.title as product_title FROM orders o JOIN products p ON o.product_id = p.id ORDER BY o.id DESC`).all());
});

router.post('/orders/:id/status', adminAuth, (req, res) => {
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
  res.json({ ok: true });
});

// Gift offers
router.get('/gift-offers', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM gift_offers ORDER BY id DESC').all());
});

router.post('/gift-offers/:id/refund', adminAuth, (req, res) => {
  const offer = db.prepare('SELECT * FROM gift_offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE wallets SET balance = balance + ? WHERE tg_id = ? AND currency_code = ?').run(offer.price_toman, offer.buyer_tg_id, 'TOMAN');
  db.prepare('INSERT INTO ledger (tg_id, currency_code, amount, direction, reason) VALUES (?, ?, ?, ?, ?)')
    .run(offer.buyer_tg_id, 'TOMAN', offer.price_toman, 'in', 'بازگشت وجه گیفت');
  db.prepare('UPDATE gift_offers SET status = ? WHERE id = ?').run('cancelled', offer.id);
  res.json({ ok: true });
});

// Tasks
router.get('/tasks', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM tasks ORDER BY id DESC').all());
});

router.post('/tasks', adminAuth, (req, res) => {
  const { id, title, kind, channel_username, reward_toman, active } = req.body;
  if (id) {
    db.prepare('UPDATE tasks SET title=?, kind=?, channel_username=?, reward_toman=?, active=? WHERE id=?')
      .run(title, kind, channel_username || null, reward_toman, active ? 1 : 0, id);
  } else {
    db.prepare('INSERT INTO tasks (title, kind, channel_username, reward_toman, active) VALUES (?, ?, ?, ?, ?)')
      .run(title, kind, channel_username || null, reward_toman, active ? 1 : 0);
  }
  res.json({ ok: true });
});

router.delete('/tasks/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Game cards
router.get('/game/cards', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM game_cards ORDER BY id DESC').all());
});

router.post('/game/cards', adminAuth, (req, res) => {
  const { id, name, image_url, rarity, base_power, price_toman, max_level, active } = req.body;
  if (id) {
    db.prepare('UPDATE game_cards SET name=?, image_url=?, rarity=?, base_power=?, price_toman=?, max_level=?, active=? WHERE id=?')
      .run(name, image_url || null, rarity, base_power, price_toman, max_level, active ? 1 : 0, id);
  } else {
    db.prepare('INSERT INTO game_cards (name, image_url, rarity, base_power, price_toman, max_level, active) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, image_url || null, rarity, base_power, price_toman, max_level, active ? 1 : 0);
  }
  res.json({ ok: true });
});

router.delete('/game/cards/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM game_cards WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Game config
router.get('/game/config', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM game_config WHERE id = 1').get());
});

router.post('/game/config', adminAuth, (req, res) => {
  const { min_deck_size, max_deck_size, daily_play_limit, extra_play_price_toman, extra_play_count, upgrade_base_cost_toman, leaderboard_reset_days } = req.body;
  db.prepare(`UPDATE game_config SET min_deck_size=?, max_deck_size=?, daily_play_limit=?, extra_play_price_toman=?, extra_play_count=?, upgrade_base_cost_toman=?, leaderboard_reset_days=? WHERE id=1`)
    .run(min_deck_size, max_deck_size, daily_play_limit, extra_play_price_toman, extra_play_count, upgrade_base_cost_toman, leaderboard_reset_days);
  res.json({ ok: true });
});

// Leaderboard prizes
router.get('/game/leaderboard-prizes', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM leaderboard_prizes ORDER BY rank_from ASC').all());
});

router.post('/game/leaderboard-prizes', adminAuth, (req, res) => {
  const { id, rank_from, rank_to, reward_toman } = req.body;
  if (id) {
    db.prepare('UPDATE leaderboard_prizes SET rank_from=?, rank_to=?, reward_toman=? WHERE id=?').run(rank_from, rank_to, reward_toman, id);
  } else {
    db.prepare('INSERT INTO leaderboard_prizes (rank_from, rank_to, reward_toman) VALUES (?, ?, ?)').run(rank_from, rank_to, reward_toman);
  }
  res.json({ ok: true });
});

router.delete('/game/leaderboard-prizes/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM leaderboard_prizes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Leaderboard reset
router.post('/game/leaderboard-reset', adminAuth, (req, res) => {
  const prizes = db.prepare('SELECT * FROM leaderboard_prizes ORDER BY rank_from ASC').all();
  const leaderboard = db.prepare('SELECT tg_id, score FROM game_leaderboard ORDER BY score DESC').all();
  leaderboard.forEach((entry, idx) => {
    const rank = idx + 1;
    const prize = prizes.find(p => rank >= p.rank_from && rank <= p.rank_to);
    if (prize && prize.reward_toman > 0) {
      db.prepare('UPDATE wallets SET balance = balance + ? WHERE tg_id = ? AND currency_code = ?').run(prize.reward_toman, entry.tg_id, 'TOMAN');
      db.prepare('INSERT INTO ledger (tg_id, currency_code, amount, direction, reason) VALUES (?, ?, ?, ?, ?)')
        .run(entry.tg_id, 'TOMAN', prize.reward_toman, 'in', 'جایزه لیدربورد رتبه ' + rank);
      sendMessage(entry.tg_id, '🏆 تبریک! جایزه لیدربورد رتبه ' + rank + ': ' + prize.reward_toman.toLocaleString() + ' تومان به حسابت اضافه شد.');
    }
  });
  db.prepare('DELETE FROM game_leaderboard').run();
  db.prepare('UPDATE game_config SET period_started_at = datetime("now") WHERE id = 1').run();
  res.json({ ok: true });
});

// Card tasks
router.get('/card-tasks', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM card_tasks ORDER BY id DESC').all());
});

router.post('/card-tasks', adminAuth, (req, res) => {
  const { id, title, kind, channel_username, reward_card_id, active } = req.body;
  if (id) {
    db.prepare('UPDATE card_tasks SET title=?, kind=?, channel_username=?, reward_card_id=?, active=? WHERE id=?')
      .run(title, kind, channel_username || null, reward_card_id, active ? 1 : 0, id);
  } else {
    db.prepare('INSERT INTO card_tasks (title, kind, channel_username, reward_card_id, active) VALUES (?, ?, ?, ?, ?)')
      .run(title, kind, channel_username || null, reward_card_id, active ? 1 : 0);
  }
  res.json({ ok: true });
});

router.delete('/card-tasks/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM card_tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Tickets
router.get('/tickets', adminAuth, (req, res) => {
  const rows = db.prepare(`SELECT t.*, u.first_name, u.username FROM support_tickets t JOIN users u ON t.tg_id = u.tg_id ORDER BY t.updated_at DESC`).all();
  res.json(rows);
});

router.get('/tickets/:id/messages', adminAuth, (req, res) => {
  const messages = db.prepare('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY id ASC').all(req.params.id);
  res.json({ messages });
});

router.post('/tickets/:id/reply', adminAuth, (req, res) => {
  const { text } = req.body;
  db.prepare('INSERT INTO support_messages (ticket_id, sender, body) VALUES (?, ?, ?)').run(req.params.id, 'admin', text);
  db.prepare('UPDATE support_tickets SET last_message = ?, updated_at = datetime("now") WHERE id = ?').run(text, req.params.id);
  const ticket = db.prepare('SELECT tg_id FROM support_tickets WHERE id = ?').get(req.params.id);
  sendMessage(ticket.tg_id, '🛠 پاسخ پشتیبانی:\n' + text);
  res.json({ ok: true });
});

router.post('/tickets/:id/close', adminAuth, (req, res) => {
  db.prepare('UPDATE support_tickets SET status = ? WHERE id = ?').run('closed', req.params.id);
  res.json({ ok: true });
});

// Users
router.get('/users', adminAuth, (req, res) => {
  const q = req.query.q || '';
  let sql = 'SELECT * FROM users WHERE 1=1';
  const params = [];
  if (q) {
    sql += ' AND (tg_id LIKE ? OR username LIKE ? OR first_name LIKE ?)';
    params.push('%' + q + '%', '%' + q + '%', '%' + q + '%');
  }
  sql += ' ORDER BY joined_at DESC LIMIT 200';
  res.json(db.prepare(sql).all(...params));
});

router.post('/users/:tgId/adjust-balance', adminAuth, (req, res) => {
  const { amount } = req.body;
  const code = amount >= 0 ? 'TOMAN' : 'TOMAN';
  db.prepare('UPDATE wallets SET balance = balance + ? WHERE tg_id = ? AND currency_code = ?').run(amount, req.params.tgId, code);
  db.prepare('INSERT INTO ledger (tg_id, currency_code, amount, direction, reason) VALUES (?, ?, ?, ?, ?)')
    .run(req.params.tgId, code, Math.abs(amount), amount >= 0 ? 'in' : 'out', 'اصلاح دستی ادمین');
  res.json({ ok: true });
});

router.post('/users/:tgId/ban', adminAuth, (req, res) => {
  db.prepare('UPDATE users SET is_banned = 1, ban_reason = ? WHERE tg_id = ?').run(req.body.reason || '', req.params.tgId);
  res.json({ ok: true });
});

router.post('/users/:tgId/unban', adminAuth, (req, res) => {
  db.prepare('UPDATE users SET is_banned = 0, ban_reason = NULL WHERE tg_id = ?').run(req.params.tgId);
  res.json({ ok: true });
});

// BROADCAST
router.post('/broadcast', adminAuth, (req, res) => {
  const { message, targetTgId } = req.body;
  if (!message) return res.status(400).json({ error: 'پیام خالیه' });

  let users;
  if (targetTgId) {
    users = [{ tg_id: Number(targetTgId) }];
  } else {
    users = db.prepare('SELECT tg_id FROM users WHERE is_banned = 0').all();
  }

  let sent = 0, failed = 0;
  users.forEach(u => {
    try {
      sendMessage(u.tg_id, message);
      sent++;
    } catch (e) { failed++; }
  });

  db.prepare('INSERT INTO broadcast_logs (message, sent_count, failed_count) VALUES (?, ?, ?)').run(message, sent, failed);
  res.json({ sent, failed });
});

export default router;
