import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';
import { sendMessage, answerInlineQuery, getChatMember, setWebhook, deleteWebhook } from './telegram.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);
const PORT = process.env.PORT || 3000;

// ========================
// HELPERS
// ========================
function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : '';
}
function setConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
}
function getUser(tgId) {
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId);
}
function ensureUser(tgId, username, firstName, lastName) {
  let user = getUser(tgId);
  if (!user) {
    const refCode = 'ref' + tgId;
    db.prepare('INSERT INTO users (tg_id, username, first_name, last_name, ref_code) VALUES (?, ?, ?, ?, ?)')
      .run(tgId, username || null, firstName || null, lastName || null, refCode);
    user = getUser(tgId);
  } else {
    db.prepare('UPDATE users SET username = ?, first_name = ?, last_name = ?, last_active = datetime("now") WHERE tg_id = ?')
      .run(username || null, firstName || null, lastName || null, tgId);
  }
  return user;
}
function ensureWallet(tgId, currencyCode = 'TOMAN') {
  db.prepare('INSERT OR IGNORE INTO wallets (tg_id, currency_code, balance) VALUES (?, ?, 0)').run(tgId, currencyCode);
}
function getWalletBalance(tgId, currencyCode) {
  ensureWallet(tgId, currencyCode);
  const row = db.prepare('SELECT balance FROM wallets WHERE tg_id = ? AND currency_code = ?').get(tgId, currencyCode);
  return row ? row.balance : 0;
}
function changeBalance(tgId, currencyCode, amount, reason) {
  ensureWallet(tgId, currencyCode);
  db.prepare('UPDATE wallets SET balance = balance + ? WHERE tg_id = ? AND currency_code = ?').run(amount, tgId, currencyCode);
  db.prepare('INSERT INTO ledger (tg_id, currency_code, amount, direction, reason) VALUES (?, ?, ?, ?, ?)')
    .run(tgId, currencyCode, Math.abs(amount), amount >= 0 ? 'in' : 'out', reason);
}
function getGameConfig() {
  return db.prepare('SELECT * FROM game_config WHERE id = 1').get();
}
function getCardMaxLevel(rarity) {
  const map = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, mythic: 6, god: 7 };
  return map[rarity] || 1;
}
function auth(req, res, next) {
  const data = req.headers['x-init-data'] || '';
  if (!data) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const params = new URLSearchParams(data);
    const userJson = params.get('user');
    if (!userJson) return res.status(401).json({ error: 'No user' });
    const user = JSON.parse(userJson);
    req.tgId = user.id;
    req.tgUser = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid init data' });
  }
}

// ========================
// ZARINPAL
// ========================
app.post('/api/wallet/zarinpal-request', auth, async (req, res) => {
  const { amount } = req.body;
  const merchantId = getConfig('zarinpal_merchant_id');
  if (!merchantId) return res.status(400).json({ error: 'درگاه زرین‌پال تنظیم نشده' });
  if (!amount || amount < 1000) return res.status(400).json({ error: 'حداقل ۱,۰۰۰ تومان' });

  const result = db.prepare('INSERT INTO zarinpal_payments (tg_id, amount, status) VALUES (?, ?, ?)').run(req.tgId, amount, 'pending');
  const paymentId = result.lastInsertRowid;
  const desc = 'شارژ حساب Lando Gifts';
  const callback = PUBLIC_URL + '/api/wallet/zarinpal-verify?pid=' + paymentId;

  try {
    const response = await fetch('https://api.zarinpal.com/pg/v4/payment/request.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchant_id: merchantId, amount: amount * 10, description: desc, callback_url: callback })
    });
    const data = await response.json();
    if (data.data && data.data.code === 100) {
      const authority = data.data.authority;
      db.prepare('UPDATE zarinpal_payments SET authority = ? WHERE id = ?').run(authority, paymentId);
      return res.json({ url: 'https://www.zarinpal.com/pg/StartPay/' + authority });
    }
    return res.status(400).json({ error: 'خطا در اتصال به زرین‌پال' });
  } catch (e) {
    return res.status(500).json({ error: 'خطای سرور' });
  }
});

app.get('/api/wallet/zarinpal-verify', async (req, res) => {
  const { pid, Authority, Status } = req.query;
  const payment = db.prepare('SELECT * FROM zarinpal_payments WHERE id = ?').get(pid);
  if (!payment || payment.status !== 'pending') return res.send('<h1>تراکنش یافت نشد</h1>');
  if (Status !== 'OK') {
    db.prepare('UPDATE zarinpal_payments SET status = ? WHERE id = ?').run('failed', pid);
    return res.send('<h1>پرداخت لغو شد</h1><p><a href="' + PUBLIC_URL + '">بازگشت به مینی‌اپ</a></p>');
  }
  const merchantId = getConfig('zarinpal_merchant_id');
  try {
    const response = await fetch('https://api.zarinpal.com/pg/v4/payment/verify.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchant_id: merchantId, amount: payment.amount * 10, authority: Authority })
    });
    const data = await response.json();
    if (data.data && data.data.code === 100) {
      db.prepare('UPDATE zarinpal_payments SET status = ?, ref_id = ? WHERE id = ?').run('paid', String(data.data.ref_id), pid);
      changeBalance(payment.tg_id, 'TOMAN', payment.amount, 'شارژ زرین‌پال');
      return res.send('<h1>پرداخت موفق!</h1><p>مبلغ ' + payment.amount.toLocaleString() + ' تومان به حسابت اضافه شد.</p><p><a href="' + PUBLIC_URL + '">بازگشت به مینی‌اپ</a></p>');
    }
    db.prepare('UPDATE zarinpal_payments SET status = ? WHERE id = ?').run('failed', pid);
    return res.send('<h1>پرداخت ناموفق</h1><p><a href="' + PUBLIC_URL + '">بازگشت</a></p>');
  } catch (e) {
    return res.status(500).send('خطا');
  }
});

// ========================
// FILE UPLOADS
// ========================
import multer from 'multer';
import fs from 'fs';
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

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایلی آپلود نشد' });
  const url = PUBLIC_URL + '/uploads/' + req.file.filename;
  res.json({ url });
});

// ========================
// CONFIG
// ========================
app.get('/api/config', (req, res) => {
  const botUsername = BOT_TOKEN.split(':')[0] ? 'bot' + BOT_TOKEN.split(':')[0] : '';
  res.json({
    cardNumber: getConfig('card_number'),
    cardOwner: getConfig('card_owner'),
    botUsername: botUsername,
    welcomeMessage: getConfig('welcome_message'),
    requiredChannel: getConfig('required_channel')
  });
});

// ========================
// ME
// ========================
app.get('/api/me', auth, (req, res) => {
  const user = ensureUser(req.tgId, req.tgUser.username, req.tgUser.first_name, req.tgUser.last_name);
  res.json({
    tg_id: user.tg_id,
    username: user.username,
    first_name: user.first_name,
    balance_toman: getWalletBalance(user.tg_id, 'TOMAN'),
    is_banned: user.is_banned
  });
});

// ========================
// PRODUCTS
// ========================
app.get('/api/products', (req, res) => {
  const rows = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id DESC').all();
  res.json(rows);
});

// ========================
// CHECKOUT
// ========================
app.post('/api/checkout', auth, (req, res) => {
  const { productId, qty, note } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return res.status(404).json({ error: 'محصول یافت نشد' });
  const total = product.price_toman * (qty || 1);
  const balance = getWalletBalance(req.tgId, 'TOMAN');
  if (balance < total) return res.status(400).json({ error: 'موجودی کافی نیست' });
  changeBalance(req.tgId, 'TOMAN', -total, 'خرید محصول: ' + product.title);
  db.prepare('INSERT INTO orders (tg_id, product_id, qty, total_toman, note) VALUES (?, ?, ?, ?, ?)')
    .run(req.tgId, productId, qty || 1, total, note || null);
  res.json({ ok: true });
});

// ========================
// WALLET (merged with currency)
// ========================
app.get('/api/wallet/balances', auth, (req, res) => {
  const rows = db.prepare('SELECT currency_code, balance FROM wallets WHERE tg_id = ?').all(req.tgId);
  const obj = {};
  rows.forEach(r => obj[r.currency_code] = r.balance);
  if (!obj['TOMAN']) obj['TOMAN'] = 0;
  res.json(obj);
});

app.get('/api/wallet/ledger', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM ledger WHERE tg_id = ? ORDER BY id DESC LIMIT 50').all(req.tgId);
  res.json(rows);
});

app.post('/api/wallet/toman-topup', auth, (req, res) => {
  const { amount, trackingCode } = req.body;
  if (!amount || amount < 10000) return res.status(400).json({ error: 'حداقل ۱۰,۰۰۰ تومان' });
  db.prepare('INSERT INTO toman_topups (tg_id, amount, tracking_code) VALUES (?, ?, ?)')
    .run(req.tgId, amount, trackingCode || '');
  res.json({ ok: true });
});

app.post('/api/wallet/toman-withdraw', auth, (req, res) => {
  const { amount, cardNumber } = req.body;
  if (!amount || amount < 10000) return res.status(400).json({ error: 'حداقل ۱۰,۰۰۰ تومان' });
  const balance = getWalletBalance(req.tgId, 'TOMAN');
  if (balance < amount) return res.status(400).json({ error: 'موجودی کافی نیست' });
  changeBalance(req.tgId, 'TOMAN', -amount, 'درخواست برداشت');
  db.prepare('INSERT INTO toman_withdrawals (tg_id, amount, card_number) VALUES (?, ?, ?)')
    .run(req.tgId, amount, cardNumber || '');
  res.json({ ok: true });
});

// ========================
// CURRENCIES
// ========================
app.get('/api/currencies', (req, res) => {
  const rows = db.prepare('SELECT * FROM currencies WHERE active = 1').all();
  res.json(rows);
});

app.post('/api/wallet/swap', auth, (req, res) => {
  const { from, to, amount } = req.body;
  if (!from || !to || !amount || amount <= 0 || from === to) return res.status(400).json({ error: 'اطلاعات نامعتبر' });
  const feePercent = Number(getConfig('swap_fee_percent') || '1');
  let outputAmount = amount;
  if (from === 'TOMAN') {
    const cur = db.prepare('SELECT rate_toman FROM currencies WHERE code = ?').get(to);
    if (!cur || !cur.rate_toman) return res.status(400).json({ error: 'ارز نامعتبر' });
    outputAmount = amount / cur.rate_toman * (1 - feePercent / 100);
  } else if (to === 'TOMAN') {
    const cur = db.prepare('SELECT rate_toman FROM currencies WHERE code = ?').get(from);
    if (!cur || !cur.rate_toman) return res.status(400).json({ error: 'ارز نامعتبر' });
    outputAmount = amount * cur.rate_toman * (1 - feePercent / 100);
  } else {
    const curFrom = db.prepare('SELECT rate_toman FROM currencies WHERE code = ?').get(from);
    const curTo = db.prepare('SELECT rate_toman FROM currencies WHERE code = ?').get(to);
    if (!curFrom || !curTo) return res.status(400).json({ error: 'ارز نامعتبر' });
    const toman = amount * curFrom.rate_toman;
    outputAmount = toman / curTo.rate_toman * (1 - feePercent / 100);
  }
  const balance = getWalletBalance(req.tgId, from);
  if (balance < amount) return res.status(400).json({ error: 'موجودی کافی نیست' });
  changeBalance(req.tgId, from, -amount, 'تبدیل به ' + to);
  changeBalance(req.tgId, to, outputAmount, 'تبدیل از ' + from);
  res.json({ outputAmount: Math.floor(outputAmount * 1000000) / 1000000 });
});

app.post('/api/wallet/currency-deposit', auth, (req, res) => {
  const { code, amount, txHash } = req.body;
  if (!code || !amount || amount <= 0) return res.status(400).json({ error: 'اطلاعات نامعتبر' });
  db.prepare('INSERT INTO currency_requests (tg_id, kind, currency_code, amount, tx_hash) VALUES (?, ?, ?, ?, ?)')
    .run(req.tgId, 'deposit', code, amount, txHash || '');
  res.json({ ok: true });
});

app.post('/api/wallet/currency-withdraw', auth, (req, res) => {
  const { code, amount, address } = req.body;
  if (!code || !amount || amount <= 0 || !address) return res.status(400).json({ error: 'اطلاعات نامعتبر' });
  const balance = getWalletBalance(req.tgId, code);
  if (balance < amount) return res.status(400).json({ error: 'موجودی کافی نیست' });
  changeBalance(req.tgId, code, -amount, 'درخواست برداشت ' + code);
  db.prepare('INSERT INTO currency_requests (tg_id, kind, currency_code, amount, address) VALUES (?, ?, ?, ?, ?)')
    .run(req.tgId, 'withdraw', code, amount, address);
  res.json({ ok: true });
});

// ========================
// GIFT MARKET
// ========================
app.get('/api/gifts/market', auth, (req, res) => {
  const offers = db.prepare('SELECT * FROM gift_offers WHERE status = ? ORDER BY id DESC').all('active');
  const fee = Number(getConfig('gift_market_fee_percent') || '5');
  res.json({ offers, feePercent: fee });
});

app.get('/api/gifts/my', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM gift_offers WHERE seller_tg_id = ? ORDER BY id DESC').all(req.tgId);
  res.json(rows);
});

app.post('/api/gifts/list', auth, (req, res) => {
  const { title, image_url, price } = req.body;
  if (!title || !price || price < 5000) return res.status(400).json({ error: 'حداقل ۵,۰۰۰ تومان' });
  db.prepare('INSERT INTO gift_offers (seller_tg_id, title, image_url, price_toman) VALUES (?, ?, ?, ?)')
    .run(req.tgId, title, image_url || null, price);
  res.json({ ok: true });
});

app.post('/api/gifts/:id/buy', auth, (req, res) => {
  const offer = db.prepare('SELECT * FROM gift_offers WHERE id = ?').get(req.params.id);
  if (!offer || offer.status !== 'active') return res.status(400).json({ error: 'آگهی نامعتبر' });
  const balance = getWalletBalance(req.tgId, 'TOMAN');
  if (balance < offer.price_toman) return res.status(400).json({ error: 'موجودی کافی نیست' });
  changeBalance(req.tgId, 'TOMAN', -offer.price_toman, 'رزرو گیفت: ' + offer.title);
  db.prepare('UPDATE gift_offers SET buyer_tg_id = ?, status = ? WHERE id = ?').run(req.tgId, 'reserved', offer.id);
  res.json({ ok: true });
});

app.post('/api/gifts/:id/cancel', auth, (req, res) => {
  const offer = db.prepare('SELECT * FROM gift_offers WHERE id = ?').get(req.params.id);
  if (!offer || offer.seller_tg_id !== req.tgId) return res.status(403).json({ error: 'غیرمجاز' });
  db.prepare('UPDATE gift_offers SET status = ? WHERE id = ?').run('cancelled', offer.id);
  res.json({ ok: true });
});

app.post('/api/gifts/:id/confirm-received', auth, (req, res) => {
  const offer = db.prepare('SELECT * FROM gift_offers WHERE id = ?').get(req.params.id);
  if (!offer || offer.buyer_tg_id !== req.tgId) return res.status(403).json({ error: 'غیرمجاز' });
  const feePercent = Number(getConfig('gift_market_fee_percent') || '5');
  const fee = Math.floor(offer.price_toman * feePercent / 100);
  const sellerGets = offer.price_toman - fee;
  changeBalance(offer.seller_tg_id, 'TOMAN', sellerGets, 'فروش گیفت: ' + offer.title);
  db.prepare('UPDATE gift_offers SET status = ? WHERE id = ?').run('completed', offer.id);
  res.json({ ok: true });
});

// ========================
// TASKS
// ========================
app.get('/api/tasks', auth, (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks WHERE active = 1').all();
  const done = db.prepare('SELECT task_id FROM task_completions WHERE tg_id = ?').all(req.tgId).map(r => r.task_id);
  res.json(tasks.map(t => ({ ...t, done: done.includes(t.id) })));
});

app.post('/api/tasks/:id/claim', auth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'تسک یافت نشد' });
  const exists = db.prepare('SELECT 1 FROM task_completions WHERE tg_id = ? AND task_id = ?').get(req.tgId, task.id);
  if (exists) return res.status(400).json({ error: 'قبلاً دریافت کردی' });
  const channel = getConfig('required_channel') || task.channel_username;
  if (task.kind === 'join_channel' && channel) {
    const member = getChatMember(channel, req.tgId);
    if (!member || (member.status !== 'member' && member.status !== 'administrator' && member.status !== 'creator')) {
      return res.status(400).json({ error: 'اول باید عضو کانال ' + channel + ' بشی' });
    }
  }
  db.prepare('INSERT INTO task_completions (tg_id, task_id) VALUES (?, ?)').run(req.tgId, task.id);
  changeBalance(req.tgId, 'TOMAN', task.reward_toman, 'پاداش تسک: ' + task.title);
  res.json({ ok: true });
});

// ========================
// REFERRAL
// ========================
app.get('/api/referral', auth, (req, res) => {
  const user = getUser(req.tgId);
  const invited = db.prepare('SELECT COUNT(*) as c FROM users WHERE referred_by = ?').get(req.tgId);
  const earned = db.prepare('SELECT COALESCE(SUM(amount), 0) as s FROM ledger WHERE tg_id = ? AND reason LIKE ?').get(req.tgId, '%پورسانت%');
  res.json({
    ref_code: user.ref_code,
    invitedCount: invited.c,
    totalEarned: earned.s || 0
  });
});

// ========================
// SUPPORT
// ========================
app.get('/api/support/messages', auth, (req, res) => {
  let ticket = db.prepare('SELECT * FROM support_tickets WHERE tg_id = ? AND status = ? ORDER BY id DESC LIMIT 1').get(req.tgId, 'open');
  if (!ticket) {
    const r = db.prepare('INSERT INTO support_tickets (tg_id) VALUES (?)').run(req.tgId);
    ticket = { id: r.lastInsertRowid };
  }
  const messages = db.prepare('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY id ASC').all(ticket.id);
  res.json({ messages });
});

app.post('/api/support/send', auth, (req, res) => {
  const { text } = req.body;
  let ticket = db.prepare('SELECT * FROM support_tickets WHERE tg_id = ? AND status = ? ORDER BY id DESC LIMIT 1').get(req.tgId, 'open');
  if (!ticket) {
    const r = db.prepare('INSERT INTO support_tickets (tg_id) VALUES (?)').run(req.tgId);
    ticket = { id: r.lastInsertRowid };
  }
  db.prepare('INSERT INTO support_messages (ticket_id, sender, body) VALUES (?, ?, ?)').run(ticket.id, 'user', text);
  db.prepare('UPDATE support_tickets SET last_message = ?, updated_at = datetime("now") WHERE id = ?').run(text, ticket.id);
  res.json({ ok: true });
});

// ========================
// GAME
// ========================
app.get('/api/game/status', auth, (req, res) => {
  const cfg = getGameConfig();
  const today = new Date().toISOString().slice(0, 10);
  const playsToday = db.prepare('SELECT COUNT(*) as c FROM game_matches WHERE (player_a = ? OR player_b = ?) AND date(played_at) = ?').get(req.tgId, req.tgId, today).c;
  const extra = db.prepare('SELECT COALESCE(SUM(extra_plays), 0) as s FROM user_game_extra WHERE tg_id = ? AND date = ?').get(req.tgId, today);
  const totalPlays = cfg.daily_play_limit + (extra ? extra.s : 0);
  const remaining = Math.max(0, totalPlays - playsToday);
  const rank = db.prepare('SELECT rank FROM (SELECT tg_id, RANK() OVER (ORDER BY score DESC) as rank FROM game_leaderboard) WHERE tg_id = ?').get(req.tgId);
  res.json({
    playsRemaining: remaining,
    myRank: rank ? rank.rank : '-',
    config: cfg,
    queue: { waiting: false }
  });
});

app.get('/api/game/cards', (req, res) => {
  const rows = db.prepare('SELECT * FROM game_cards WHERE active = 1').all();
  res.json(rows);
});

app.get('/api/game/my-cards', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT uc.*, gc.name, gc.image_url, gc.rarity, gc.base_power, gc.max_level
    FROM user_cards uc JOIN game_cards gc ON uc.card_id = gc.id
    WHERE uc.tg_id = ? ORDER BY uc.power DESC
  `).all(req.tgId);
  res.json(rows);
});

app.post('/api/game/buy-card', auth, (req, res) => {
  const { cardId } = req.body;
  const card = db.prepare('SELECT * FROM game_cards WHERE id = ?').get(cardId);
  if (!card) return res.status(404).json({ error: 'کارت یافت نشد' });
  const balance = getWalletBalance(req.tgId, 'TOMAN');
  if (balance < card.price_toman) return res.status(400).json({ error: 'موجودی کافی نیست' });
  changeBalance(req.tgId, 'TOMAN', -card.price_toman, 'خرید کارت: ' + card.name);
  db.prepare('INSERT INTO user_cards (tg_id, card_id, level, power) VALUES (?, ?, 1, ?)').run(req.tgId, cardId, card.base_power);
  res.json({ ok: true });
});

app.post('/api/game/upgrade-card', auth, (req, res) => {
  const { userCardId } = req.body;
  const uc = db.prepare('SELECT uc.*, gc.rarity, gc.max_level FROM user_cards uc JOIN game_cards gc ON uc.card_id = gc.id WHERE uc.id = ? AND uc.tg_id = ?').get(userCardId, req.tgId);
  if (!uc) return res.status(404).json({ error: 'کارت یافت نشد' });
  if (uc.level >= uc.max_level) return res.status(400).json({ error: 'حداکثر سطح reached' });
  const cfg = getGameConfig();
  const cost = cfg.upgrade_base_cost_toman * uc.level;
  const balance = getWalletBalance(req.tgId, 'TOMAN');
  if (balance < cost) return res.status(400).json({ error: 'موجودی کافی نیست' });
  changeBalance(req.tgId, 'TOMAN', -cost, 'ارتقای کارت: ' + uc.name);
  const newLevel = uc.level + 1;
  const newPower = Math.floor(uc.power * 1.2);
  db.prepare('UPDATE user_cards SET level = ?, power = ? WHERE id = ?').run(newLevel, newPower, userCardId);
  res.json({ ok: true, newLevel, newPower });
});

// NEW: Evolve (merge two identical same-level cards)
app.post('/api/game/evolve', auth, (req, res) => {
  const { cardId } = req.body;
  const cards = db.prepare(`
    SELECT uc.*, gc.name, gc.rarity, gc.max_level
    FROM user_cards uc JOIN game_cards gc ON uc.card_id = gc.id
    WHERE uc.tg_id = ? AND uc.card_id = ? ORDER BY uc.level, uc.id
  `).all(req.tgId, cardId);

  if (cards.length < 2) return res.status(400).json({ error: 'حداقل ۲ کارت مشابه لازمه' });

  // Find two cards with same level
  let target = null, sacrifice = null;
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      if (cards[i].level === cards[j].level) {
        target = cards[i];
        sacrifice = cards[j];
        break;
      }
    }
    if (target) break;
  }

  if (!target) return res.status(400).json({ error: '۲ کارت هم‌سطح مشابه پیدا نشد' });
  if (target.level >= target.max_level) return res.status(400).json({ error: 'به حداکثر سطح رسیده' });

  const newLevel = target.level + 1;
  const newPower = Math.floor(target.power * 1.5);
  db.prepare('UPDATE user_cards SET level = ?, power = ? WHERE id = ?').run(newLevel, newPower, target.id);
  db.prepare('DELETE FROM user_cards WHERE id = ?').run(sacrifice.id);

  res.json({ ok: true, newLevel, newPower, deletedSacrificeId: sacrifice.id });
});

app.post('/api/game/buy-extra-plays', auth, (req, res) => {
  const cfg = getGameConfig();
  const balance = getWalletBalance(req.tgId, 'TOMAN');
  if (balance < cfg.extra_play_price_toman) return res.status(400).json({ error: 'موجودی کافی نیست' });
  changeBalance(req.tgId, 'TOMAN', -cfg.extra_play_price_toman, 'خرید بازی اضافه');
  const today = new Date().toISOString().slice(0, 10);
  db.prepare('INSERT INTO user_game_extra (tg_id, date, extra_plays) VALUES (?, ?, ?) ON CONFLICT(tg_id, date) DO UPDATE SET extra_plays = extra_plays + ?')
    .run(req.tgId, today, cfg.extra_play_count, cfg.extra_play_count);
  const playsToday = db.prepare('SELECT COUNT(*) as c FROM game_matches WHERE (player_a = ? OR player_b = ?) AND date(played_at) = ?').get(req.tgId, req.tgId, today).c;
  const extra = db.prepare('SELECT COALESCE(SUM(extra_plays), 0) as s FROM user_game_extra WHERE tg_id = ? AND date = ?').get(req.tgId, today);
  res.json({ playsRemaining: cfg.daily_play_limit + (extra ? extra.s : 0) - playsToday });
});

app.post('/api/game/queue', auth, (req, res) => {
  const { userCardIds } = req.body;
  const cfg = getGameConfig();
  if (!userCardIds || userCardIds.length < cfg.min_deck_size || userCardIds.length > cfg.max_deck_size) {
    return res.status(400).json({ error: 'دسته باید ' + cfg.min_deck_size + ' تا ' + cfg.max_deck_size + ' کارت باشه' });
  }
  const today = new Date().toISOString().slice(0, 10);
  const playsToday = db.prepare('SELECT COUNT(*) as c FROM game_matches WHERE (player_a = ? OR player_b = ?) AND date(played_at) = ?').get(req.tgId, req.tgId, today).c;
  const extra = db.prepare('SELECT COALESCE(SUM(extra_plays), 0) as s FROM user_game_extra WHERE tg_id = ? AND date = ?').get(req.tgId, today);
  const totalPlays = cfg.daily_play_limit + (extra ? extra.s : 0);
  if (playsToday >= totalPlays) return res.status(400).json({ error: 'بازی امروزت تموم شده' });

  const myCards = db.prepare('SELECT * FROM user_cards WHERE tg_id = ? AND id IN (' + userCardIds.map(() => '?').join(',') + ')').all(req.tgId, ...userCardIds);
  const myPower = myCards.reduce((s, c) => s + c.power, 0);
  const opponent = db.prepare('SELECT tg_id FROM users WHERE tg_id != ? AND is_banned = 0 ORDER BY RANDOM() LIMIT 1').get(req.tgId);
  if (!opponent) return res.status(400).json({ error: 'حریفی پیدا نشد' });
  const oppCards = db.prepare('SELECT * FROM user_cards WHERE tg_id = ? ORDER BY RANDOM() LIMIT ?').all(opponent.tg_id, Math.min(userCardIds.length, 5));
  const oppPower = oppCards.reduce((s, c) => s + c.power, 0);
  const won = myPower >= oppPower;
  const winner = won ? req.tgId : opponent.tg_id;
  db.prepare('INSERT INTO game_matches (player_a, player_b, power_a, power_b, winner_tg_id) VALUES (?, ?, ?, ?, ?)')
    .run(req.tgId, opponent.tg_id, myPower, oppPower, winner);
  const scoreChange = won ? 3 : -1;
  db.prepare('INSERT INTO game_leaderboard (tg_id, score, wins, losses) VALUES (?, ?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET score = score + ?, wins = wins + ?, losses = losses + ?')
    .run(req.tgId, scoreChange, won ? 1 : 0, won ? 0 : 1, scoreChange, won ? 1 : 0, won ? 0 : 1);
  db.prepare('INSERT INTO game_leaderboard (tg_id, score, wins, losses) VALUES (?, ?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET score = score + ?, wins = wins + ?, losses = losses + ?')
    .run(opponent.tg_id, won ? -1 : 3, won ? 0 : 1, won ? 1 : 0, won ? -1 : 3, won ? 0 : 1, won ? 1 : 0);
  res.json({ matched: true, won, myPower, opponentPower: oppPower });
});

app.post('/api/game/queue/cancel', auth, (req, res) => {
  res.json({ ok: true });
});

app.get('/api/game/leaderboard', (req, res) => {
  const cfg = getGameConfig();
  const leaderboard = db.prepare(`
    SELECT l.*, u.first_name, u.username
    FROM game_leaderboard l JOIN users u ON l.tg_id = u.tg_id
    ORDER BY l.score DESC LIMIT 10
  `).all();
  const prizes = db.prepare('SELECT * FROM leaderboard_prizes ORDER BY rank_from ASC').all();
  res.json({ leaderboard, state: { period_started_at: cfg.period_started_at }, prizes });
});

app.get('/api/game/history', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM game_matches WHERE player_a = ? OR player_b = ? ORDER BY id DESC LIMIT 20').all(req.tgId, req.tgId);
  res.json(rows);
});

app.get('/api/card-tasks', auth, (req, res) => {
  const tasks = db.prepare('SELECT ct.*, gc.name as card_name FROM card_tasks ct JOIN game_cards gc ON ct.reward_card_id = gc.id WHERE ct.active = 1').all();
  const done = db.prepare('SELECT card_task_id FROM card_task_completions WHERE tg_id = ?').all(req.tgId).map(r => r.card_task_id);
  res.json(tasks.map(t => ({ ...t, done: done.includes(t.id) })));
});

app.post('/api/card-tasks/:id/claim', auth, (req, res) => {
  const task = db.prepare('SELECT * FROM card_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'تسک یافت نشد' });
  const exists = db.prepare('SELECT 1 FROM card_task_completions WHERE tg_id = ? AND card_task_id = ?').get(req.tgId, task.id);
  if (exists) return res.status(400).json({ error: 'قبلاً دریافت کردی' });
  const channel = getConfig('required_channel') || task.channel_username;
  if (task.kind === 'join_channel' && channel) {
    const member = getChatMember(channel, req.tgId);
    if (!member || (member.status !== 'member' && member.status !== 'administrator' && member.status !== 'creator')) {
      return res.status(400).json({ error: 'اول باید عضو کانال ' + channel + ' بشی' });
    }
  }
  db.prepare('INSERT INTO card_task_completions (tg_id, card_task_id) VALUES (?, ?)').run(req.tgId, task.id);
  const card = db.prepare('SELECT * FROM game_cards WHERE id = ?').get(task.reward_card_id);
  db.prepare('INSERT INTO user_cards (tg_id, card_id, level, power) VALUES (?, ?, 1, ?)').run(req.tgId, task.reward_card_id, card.base_power);
  res.json({ ok: true });
});

// ========================
// TELEGRAM WEBHOOK
// ========================
app.post('/webhook/' + WEBHOOK_SECRET, express.json(), (req, res) => {
  res.sendStatus(200);
  const upd = req.body;
  if (!upd.message && !upd.callback_query && !upd.inline_query) return;

  const msg = upd.message;
  if (msg && msg.text && msg.text.startsWith('/start')) {
    const tgId = msg.from.id;
    const username = msg.from.username;
    const firstName = msg.from.first_name;
    const lastName = msg.from.last_name;
    let refCode = null;
    const parts = msg.text.split(' ');
    if (parts[1] && parts[1].startsWith('ref_')) refCode = parts[1].replace('ref_', '');

    const user = ensureUser(tgId, username, firstName, lastName);
    if (refCode && !user.referred_by) {
      const referrer = db.prepare('SELECT tg_id FROM users WHERE ref_code = ?').get(refCode);
      if (referrer && referrer.tg_id !== tgId) {
        db.prepare('UPDATE users SET referred_by = ? WHERE tg_id = ?').run(referrer.tg_id, tgId);
        const percent = Number(getConfig('referral_percent') || '5');
        changeBalance(referrer.tg_id, 'TOMAN', 0, 'پورسانت رفرال: ' + tgId);
      }
    }

    const welcomeMsg = getConfig('welcome_message') || 'سلام! خوش اومدی 🎁';
    const channel = getConfig('required_channel');
    let text = welcomeMsg + '\n\n';
    if (channel) text += 'برای استفاده از ربات، لطفاً عضو کانال @' + channel + ' بشo.\n\n';
    text += 'مینی‌اپ: ' + PUBLIC_URL;
    sendMessage(tgId, text);
  }

  if (upd.inline_query) {
    answerInlineQuery(upd.inline_query.id, []);
  }
});

// ========================
// START
// ========================
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  if (PUBLIC_URL && BOT_TOKEN) {
    deleteWebhook().then(() => setWebhook(PUBLIC_URL + '/webhook/' + WEBHOOK_SECRET));
  }
});
