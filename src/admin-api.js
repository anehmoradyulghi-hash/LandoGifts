import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import {
  getStats, listUsers, banUser, unbanUser, getUser, adjustToman,
  listCurrencies, upsertCurrency,
  listPendingTomanTopups, decideTomanTopup,
  listPendingTomanWithdrawals, decideTomanWithdrawal,
  listPendingCurrencyRequests, decideCurrencyRequest, getCurrencyRequest,
  listCategories, addCategory, deleteCategory,
  listProducts, upsertProduct, deleteProduct,
  listAllOrders, setOrderStatus,
  listAllGiftOffersAdmin, adminRefundGiftOffer,
  listAllTasksAdmin, upsertTask, deleteTask,
  listAllTicketsAdmin, getTicket, listTicketMessages, addTicketMessage, closeTicket,
  getTomanTopup, getTomanWithdrawal,
} from './db.js';
import {
  listGameCards, upsertGameCard, deleteGameCard,
  getGameConfig, setGameConfig,
  listLeaderboardPrizes, upsertLeaderboardPrize, deleteLeaderboardPrize,
  getLeaderboard, getLeaderboardState, resetLeaderboard,
  listAllCardTasksAdmin, upsertCardTask, deleteCardTask,
} from './game-db.js';
import { sendMessage } from './telegram.js';

const router = express.Router();

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname)),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /image\/(jpeg|png|webp|gif)/.test(file.mimetype)),
});

/* ---------- ورود ساده با رمز واحد + توکن نشست در حافظه ---------- */
const sessions = new Map();
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const expiry = token && sessions.get(token);
  if (!expiry || expiry < Date.now()) return res.status(401).json({ error: 'unauthorized' });
  sessions.set(token, Date.now() + TOKEN_TTL_MS);
  next();
}

router.post('/login', (req, res) => {
  if (!process.env.ADMIN_PANEL_PASSWORD) return res.status(500).json({ error: 'ADMIN_PANEL_PASSWORD تنظیم نشده' });
  if (req.body.password !== process.env.ADMIN_PANEL_PASSWORD) return res.status(401).json({ error: 'رمز اشتباه است' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + TOKEN_TTL_MS);
  res.json({ token });
});

router.use(requireAdmin);

router.post('/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایل عکس ارسال نشد' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

/* ---------- داشبورد ---------- */
router.get('/stats', (req, res) => res.json(getStats()));

/* ---------- کاربران ---------- */
router.get('/users', (req, res) => res.json(listUsers(req.query.q)));
router.post('/users/:tgId/ban', (req, res) => { banUser(Number(req.params.tgId), req.body.reason); res.json({ ok: true }); });
router.post('/users/:tgId/unban', (req, res) => { unbanUser(Number(req.params.tgId)); res.json({ ok: true }); });
router.post('/users/:tgId/adjust-balance', (req, res) => {
  const amount = Number(req.body.amount);
  if (!amount) return res.status(400).json({ error: 'مقدار نامعتبر' });
  adjustToman(Number(req.params.tgId), amount, 'اصلاح دستی موجودی توسط ادمین');
  sendMessage(Number(req.params.tgId), `💰 موجودی کیف‌پول شما ${amount > 0 ? '+' : ''}${amount.toLocaleString()} تومان توسط پشتیبانی تغییر کرد.`).catch(() => {});
  res.json({ ok: true, user: getUser(Number(req.params.tgId)) });
});

/* ---------- ارزها (کاملا دستی) ---------- */
router.get('/currencies', (req, res) => res.json(listCurrencies()));
router.post('/currencies', (req, res) => {
  const { code, name, rate_toman, min_deposit, min_withdraw, active } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'کد و نام ارز لازمه' });
  upsertCurrency({
    code: code.toUpperCase(), name,
    rate_toman: Number(rate_toman) || 0,
    min_deposit: Number(min_deposit) || 0,
    min_withdraw: Number(min_withdraw) || 0,
    active: !!active,
  });
  res.json({ ok: true });
});

/* ---------- شارژ کارت‌به‌کارت ---------- */
router.get('/toman-topups', (req, res) => res.json(listPendingTomanTopups()));
router.post('/toman-topups/:id/decide', (req, res) => {
  const row = decideTomanTopup(Number(req.params.id), !!req.body.approve);
  if (!row) return res.status(404).json({ error: 'پیدا نشد یا قبلاً پردازش شده' });
  const msg = req.body.approve
    ? `✅ شارژ کارت‌به‌کارت شما تایید شد.\n+${row.amount.toLocaleString()} تومان به کیف‌پولت اضافه شد.`
    : `❌ متاسفانه شارژ کارت‌به‌کارت شما تایید نشد. با پشتیبانی در ارتباط باش.`;
  sendMessage(row.tg_id, msg).catch(() => {});
  res.json({ ok: true });
});

/* ---------- برداشت تومانی ---------- */
router.get('/toman-withdrawals', (req, res) => res.json(listPendingTomanWithdrawals()));
router.post('/toman-withdrawals/:id/decide', (req, res) => {
  const row = decideTomanWithdrawal(Number(req.params.id), !!req.body.approve);
  if (!row) return res.status(404).json({ error: 'پیدا نشد یا قبلاً پردازش شده' });
  const msg = req.body.approve
    ? `✅ برداشت ${row.amount.toLocaleString()} تومان شما انجام و به کارت ${row.card_number} واریز شد.`
    : `❌ برداشت شما رد شد و مبلغ به کیف‌پولت برگشت.`;
  sendMessage(row.tg_id, msg).catch(() => {});
  res.json({ ok: true });
});

/* ---------- واریز/برداشت ارز دیجیتال ---------- */
router.get('/currency-requests', (req, res) => res.json(listPendingCurrencyRequests()));
router.post('/currency-requests/:id/decide', (req, res) => {
  const row = decideCurrencyRequest(Number(req.params.id), !!req.body.approve);
  if (!row) return res.status(404).json({ error: 'پیدا نشد یا قبلاً پردازش شده' });
  const label = `${row.amount} ${row.currency_code}`;
  let msg;
  if (row.kind === 'deposit') {
    msg = req.body.approve ? `✅ واریز ${label} تایید شد و به کیف‌پولت اضافه شد.` : `❌ واریز ${label} تایید نشد.`;
  } else {
    msg = req.body.approve ? `✅ برداشت ${label} انجام و به آدرس زیر ارسال شد:\n${row.address}` : `❌ برداشت ${label} رد شد و مبلغ به کیف‌پولت برگشت.`;
  }
  sendMessage(row.tg_id, msg).catch(() => {});
  res.json({ ok: true });
});

/* ---------- دسته‌بندی‌ها ---------- */
router.get('/categories', (req, res) => res.json(listCategories()));
router.post('/categories', (req, res) => res.json({ id: addCategory(req.body.title) }));
router.delete('/categories/:id', (req, res) => { deleteCategory(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- محصولات ---------- */
router.get('/products', (req, res) => res.json(listProducts(false)));
router.post('/products', (req, res) => {
  const id = upsertProduct({
    id: req.body.id ? Number(req.body.id) : null,
    title: req.body.title,
    description: req.body.description,
    image_url: req.body.image_url,
    price_toman: Number(req.body.price_toman),
    category_id: req.body.category_id ? Number(req.body.category_id) : null,
    active: req.body.active !== false,
  });
  res.json({ ok: true, id });
});
router.delete('/products/:id', (req, res) => { deleteProduct(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- سفارش‌ها ---------- */
router.get('/orders', (req, res) => res.json(listAllOrders()));
router.post('/orders/:id/status', (req, res) => {
  setOrderStatus(Number(req.params.id), req.body.status);
  res.json({ ok: true });
});

/* ---------- بازار گیفت ---------- */
router.get('/gift-offers', (req, res) => res.json(listAllGiftOffersAdmin()));
router.post('/gift-offers/:id/refund', (req, res) => {
  try { adminRefundGiftOffer(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- تسک‌ها ---------- */
router.get('/tasks', (req, res) => res.json(listAllTasksAdmin()));
router.post('/tasks', (req, res) => {
  const id = upsertTask({
    id: req.body.id ? Number(req.body.id) : null,
    title: req.body.title,
    kind: req.body.kind || 'join_channel',
    channel_username: req.body.channel_username,
    reward_toman: Number(req.body.reward_toman) || 0,
    active: req.body.active !== false,
  });
  res.json({ ok: true, id });
});
router.delete('/tasks/:id', (req, res) => { deleteTask(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- تیکت‌های پشتیبانی ---------- */
router.get('/tickets', (req, res) => res.json(listAllTicketsAdmin()));
router.get('/tickets/:id/messages', (req, res) => {
  const ticket = getTicket(Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'تیکت پیدا نشد' });
  res.json({ ticket, messages: listTicketMessages(ticket.id) });
});
router.post('/tickets/:id/reply', upload.single('image'), (req, res) => {
  const ticket = getTicket(Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'تیکت پیدا نشد' });
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
  addTicketMessage(ticket.id, 'admin', req.body.text || '', imageUrl);
  sendMessage(ticket.tg_id, `📩 پیام پشتیبانی:\n${req.body.text || ''}`).catch(() => {});
  res.json({ ok: true });
});
router.post('/tickets/:id/close', (req, res) => { closeTicket(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- بازی کارتی: کارت‌ها ---------- */
router.get('/game/cards', (req, res) => res.json(listGameCards(false)));
router.post('/game/cards', (req, res) => {
  const { id, name, image_url, rarity, base_power, price_toman, max_level, active } = req.body;
  if (!name) return res.status(400).json({ error: 'اسم کارت لازمه' });
  const savedId = upsertGameCard({
    id: id ? Number(id) : null,
    name, image_url,
    rarity: rarity || 'common',
    base_power: Number(base_power) || 10,
    price_toman: Number(price_toman) || 0,
    max_level: Number(max_level) || 10,
    active: active !== false,
  });
  res.json({ ok: true, id: savedId });
});
router.delete('/game/cards/:id', (req, res) => { deleteGameCard(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- بازی کارتی: تنظیمات ---------- */
router.get('/game/config', (req, res) => res.json(getGameConfig()));
router.post('/game/config', (req, res) => {
  const b = req.body;
  setGameConfig({
    min_deck_size: Number(b.min_deck_size),
    max_deck_size: Number(b.max_deck_size),
    daily_play_limit: Number(b.daily_play_limit),
    extra_play_price_toman: Number(b.extra_play_price_toman),
    extra_play_count: Number(b.extra_play_count),
    leaderboard_reset_days: Number(b.leaderboard_reset_days),
    upgrade_base_cost_toman: Number(b.upgrade_base_cost_toman),
  });
  res.json({ ok: true });
});

/* ---------- بازی کارتی: جدول امتیازات و جوایز ---------- */
router.get('/game/leaderboard', (req, res) => res.json({ leaderboard: getLeaderboard(50), state: getLeaderboardState() }));
router.get('/game/leaderboard-prizes', (req, res) => res.json(listLeaderboardPrizes()));
router.post('/game/leaderboard-prizes', (req, res) => {
  const { id, rank_from, rank_to, reward_toman } = req.body;
  if (!rank_from || !rank_to || !reward_toman) return res.status(400).json({ error: 'همه فیلدها لازمه' });
  const savedId = upsertLeaderboardPrize({ id: id ? Number(id) : null, rank_from: Number(rank_from), rank_to: Number(rank_to), reward_toman: Number(reward_toman) });
  res.json({ ok: true, id: savedId });
});
router.delete('/game/leaderboard-prizes/:id', (req, res) => { deleteLeaderboardPrize(Number(req.params.id)); res.json({ ok: true }); });
router.post('/game/leaderboard-reset', (req, res) => {
  try {
    resetLeaderboard((tgId, rank, reward) => {
      sendMessage(tgId, `🏆 تبریک! تو رتبه ${rank} جدول امتیازات شدی و ${reward.toLocaleString()} تومان جایزه گرفتی!`).catch(() => {});
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- تسک‌های کارتی ---------- */
router.get('/card-tasks', (req, res) => res.json(listAllCardTasksAdmin()));
router.post('/card-tasks', (req, res) => {
  const { id, title, kind, channel_username, reward_card_id, active } = req.body;
  if (!title || !reward_card_id) return res.status(400).json({ error: 'عنوان و کارت جایزه لازمه' });
  const savedId = upsertCardTask({
    id: id ? Number(id) : null, title, kind: kind || 'join_channel',
    channel_username, reward_card_id: Number(reward_card_id), active: active !== false,
  });
  res.json({ ok: true, id: savedId });
});
router.delete('/card-tasks/:id', (req, res) => { deleteCardTask(Number(req.params.id)); res.json({ ok: true }); });

export default router;
