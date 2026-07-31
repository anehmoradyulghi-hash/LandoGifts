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
  getPaymentSettings, setPaymentSettings, getSupportContact, setSupportContact,
  listGiftCategories, upsertGiftCategory, deleteGiftCategory,
  getMessageSettings, setMessageSettings, getAllUserIds,
} from './db.js';
import {
  listGameCards, upsertGameCard, deleteGameCard, grantCardInstance,
  getCardLevelPowerConfig, setCardLevelPower,
  getGameConfig, setGameConfig,
  listLeaderboardPrizes, upsertLeaderboardPrize, deleteLeaderboardPrize,
  getLeaderboard, getLeaderboardState, resetLeaderboard,
  listAllCardTasksAdmin, upsertCardTask, deleteCardTask,
  listCardCategories, upsertCardCategory, deleteCardCategory,
  listMergeCosts, upsertMergeCost,
} from './game-db.js';
import {
  getWheelConfig, setWheelConfig, listWheelSlots, upsertWheelSlot, deleteWheelSlot,
} from './wheel-db.js';
import {
  getAuctionConfig, setAuctionConfig, listAllAuctionsAdmin, createAuctionFromProduct, createAuctionFromCard, cancelAuction, listAuctionBids,
} from './auction-db.js';
import {
  getSeasonConfig, setSeasonConfig, getCurrentSeason, startNewSeason, listSeasonTiers, upsertSeasonTier, deleteSeasonTier,
} from './season-db.js';
import { getClanConfig, setClanConfig, getClanLeaderboard, resetClanSeason } from './clan-db.js';
import { getClanWarConfig, setClanWarConfig } from './clan-war-db.js';
import {
  getRankConfig, setRankConfig, listRankTitles, upsertRankTitle, deleteRankTitle,
  listAvatars, upsertAvatar, deleteAvatar,
} from './rank-db.js';
import { getQuestConfig, setQuestConfig, listQuestTemplates, upsertQuestTemplate, deleteQuestTemplate } from './quest-db.js';
import { listPromoCodes, createPromoCode, deletePromoCode, listRedemptions } from './promo-db.js';
import { listAlbums, upsertAlbum, deleteAlbum, getAlbumRequirements } from './album-db.js';
import { getGiftConfig, setGiftConfig } from './gift-db.js';
import { listSeasons, createSeason, deleteSeason, setCardSeason } from './seasonal-db.js';
import { getTradeConfig, setTradeConfig } from './trade-db.js';
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

/* ---------- تنظیمات پرداخت (شماره کارت واریزی، دستی از پنل) ---------- */
router.get('/payment-settings', (req, res) => res.json(getPaymentSettings()));
router.post('/payment-settings', (req, res) => {
  setPaymentSettings({
    cardNumber: req.body.cardNumber,
    cardOwner: req.body.cardOwner,
    zarinpalMerchantId: req.body.zarinpalMerchantId,
  });
  res.json({ ok: true });
});

/* ---------- آیدی پشتیبانی (به‌جای تیکت داخلی) ---------- */
router.get('/support-contact', (req, res) => res.json({ username: getSupportContact() }));
router.post('/support-contact', (req, res) => { setSupportContact(req.body.username); res.json({ ok: true }); });

/* ---------- پیام‌های ربات (خوش‌آمد / درخواست عضویت) ---------- */
router.get('/message-settings', (req, res) => res.json(getMessageSettings()));
router.post('/message-settings', (req, res) => {
  setMessageSettings({ welcomeMessage: req.body.welcomeMessage, joinPromptMessage: req.body.joinPromptMessage });
  res.json({ ok: true });
});

/* ---------- پیام‌رسانی همگانی/تکی به کاربران ---------- */
router.post('/broadcast', async (req, res) => {
  const text = String(req.body.message || '').trim();
  if (!text) return res.status(400).json({ error: 'متن پیام خالیه' });

  if (req.body.targetTgId) {
    const result = await sendMessage(Number(req.body.targetTgId), text);
    if (!result.ok) return res.status(400).json({ error: 'ارسال ناموفق بود — کاربر رباتو بلاک کرده یا آیدی اشتباهه' });
    return res.json({ ok: true, sent: 1 });
  }

  const ids = getAllUserIds();
  res.json({ ok: true, queued: ids.length }); // فورا جواب می‌دیم؛ ارسال به همه تو پس‌زمینه ادامه پیدا می‌کنه و ریکوئست ادمین معطل نمی‌مونه
  (async () => {
    let sent = 0;
    for (const id of ids) {
      const r = await sendMessage(id, text).catch(() => ({ ok: false }));
      if (r.ok) sent++;
    }
    console.log(`[broadcast] ${sent}/${ids.length} پیام با موفقیت ارسال شد`);
  })();
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

/* ---------- دسته‌بندی‌های بازار گیفت ---------- */
router.get('/gift-categories', (req, res) => res.json(listGiftCategories(false)));
router.post('/gift-categories', (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'اسم دسته لازمه' });
  const id = upsertGiftCategory({
    id: req.body.id ? Number(req.body.id) : null,
    name: req.body.name, image_url: req.body.image_url, active: req.body.active !== false,
  });
  res.json({ ok: true, id });
});
router.delete('/gift-categories/:id', (req, res) => { deleteGiftCategory(Number(req.params.id)); res.json({ ok: true }); });

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

/* ---------- دسته‌بندی‌های کارت ---------- */
router.get('/card-categories', (req, res) => res.json(listCardCategories(false)));
router.post('/card-categories', (req, res) => {
  const { id, name, icon, color, description, active } = req.body;
  if (!name) return res.status(400).json({ error: 'اسم دسته لازمه' });
  const savedId = upsertCardCategory({ id: id ? Number(id) : null, name, icon, color, description, active: active !== false });
  res.json({ ok: true, id: savedId });
});
router.delete('/card-categories/:id', (req, res) => { deleteCardCategory(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- هزینه ادغام/جهش هر پله ---------- */
router.get('/merge-costs', (req, res) => res.json(listMergeCosts()));
router.post('/merge-costs', (req, res) => {
  const { from_level, cost_toman } = req.body;
  if (!from_level) return res.status(400).json({ error: 'سطح مبدا لازمه' });
  upsertMergeCost(Number(from_level), Number(cost_toman) || 0);
  res.json({ ok: true });
});

/* ---------- بازی کارتی: کارت‌ها ---------- */
router.get('/game/cards', (req, res) => res.json(listGameCards(false)));
router.post('/game/cards', (req, res) => {
  const { id, name, image_url, base_power, price_toman, active, category_id, level_images, edition, max_supply, instant_level, fixed_power } = req.body;
  if (!name) return res.status(400).json({ error: 'اسم کارت لازمه' });
  const savedId = upsertGameCard({
    id: id ? Number(id) : null,
    name, image_url,
    rarity: 'common', // دیگه استفاده نمی‌شه؛ ریرتی نمایشی از خود سطح کارت محاسبه می‌شه
    base_power: Number(base_power) || 10,
    price_toman: Number(price_toman) || 0,
    max_level: 7, // سیستم سطح‌بندی ثابت ۷ تایی: معمولی تا الهی — قابل تغییر نیست
    active: active !== false,
    category_id: category_id ? Number(category_id) : null,
    level_images: Array.isArray(level_images) ? level_images : [],
    edition: edition || 'standard',
    max_supply: max_supply ? Number(max_supply) : null,
    instant_level: instant_level ? Number(instant_level) : null,
    fixed_power: fixed_power ? Number(fixed_power) : null,
  });
  res.json({ ok: true, id: savedId });
});
router.delete('/game/cards/:id', (req, res) => { deleteGameCard(Number(req.params.id)); res.json({ ok: true }); });
router.post('/game/cards/:id/grant', (req, res) => {
  try { const userCardId = grantCardInstance(Number(req.body.tgId), Number(req.params.id)); res.json({ ok: true, userCardId }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- بازهٔ قدرت هر سطح (۱ تا ۷) ---------- */
router.get('/game/level-power', (req, res) => res.json(getCardLevelPowerConfig()));
router.post('/game/level-power', (req, res) => {
  try { setCardLevelPower(Number(req.body.level), req.body.min_power, req.body.max_power); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- چرخ شانس روزانه ---------- */
router.get('/wheel/config', (req, res) => res.json(getWheelConfig()));
router.post('/wheel/config', (req, res) => {
  setWheelConfig({ enabled: !!req.body.enabled, cooldown_hours: req.body.cooldown_hours, require_purchase: !!req.body.require_purchase });
  res.json({ ok: true });
});
router.get('/wheel/slots', (req, res) => res.json(listWheelSlots(false)));
router.post('/wheel/slots', (req, res) => {
  const { id, label, type, amount_toman, card_id, extra_games_count, probability_percent, color, active } = req.body;
  if (!label || !type) return res.status(400).json({ error: 'عنوان و نوع جایزه لازمه' });
  const savedId = upsertWheelSlot({
    id: id ? Number(id) : null, label, type,
    amount_toman: Number(amount_toman) || 0,
    card_id: card_id ? Number(card_id) : null,
    extra_games_count: Number(extra_games_count) || 0,
    probability_percent: Number(probability_percent) || 0,
    color, active: active !== false,
  });
  res.json({ ok: true, id: savedId });
});
router.delete('/wheel/slots/:id', (req, res) => { deleteWheelSlot(Number(req.params.id)); res.json({ ok: true }); });

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
    upgrade_base_cost_toman: Number(b.upgrade_base_cost_toman) || 0,
    sacrifice_fee_toman: Number(b.sacrifice_fee_toman) || 0,
    sacrifice_transfer_percent: Number(b.sacrifice_transfer_percent) || 20,
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

/* ---------- مزایده فلش ---------- */
router.get('/auction/config', (req, res) => res.json(getAuctionConfig()));
router.post('/auction/config', (req, res) => {
  const b = req.body;
  setAuctionConfig({
    enabled: !!b.enabled, discount_percent: Number(b.discount_percent),
    duration_minutes: Number(b.duration_minutes), bid_step: Number(b.bid_step),
    anti_snipe_enabled: !!b.anti_snipe_enabled, min_wallet_balance: Number(b.min_wallet_balance) || 0,
  });
  res.json({ ok: true });
});
router.get('/auction/list', (req, res) => res.json(listAllAuctionsAdmin()));
router.get('/auction/:id/bids', (req, res) => res.json(listAuctionBids(Number(req.params.id))));
router.post('/auction/create', (req, res) => {
  try {
    const id = req.body.itemType === 'card'
      ? createAuctionFromCard(Number(req.body.cardId))
      : createAuctionFromProduct(Number(req.body.productId));
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/auction/:id/cancel', (req, res) => { cancelAuction(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- بتل‌پس فصلی ---------- */
router.get('/season/config', (req, res) => res.json(getSeasonConfig()));
router.post('/season/config', (req, res) => {
  const b = req.body;
  setSeasonConfig({
    enabled: !!b.enabled, price_toman: Number(b.price_toman), duration_days: Number(b.duration_days),
    tier_count: Number(b.tier_count), xp_per_tier: Number(b.xp_per_tier),
    xp_per_win: Number(b.xp_per_win), xp_per_purchase: Number(b.xp_per_purchase), xp_per_donation: Number(b.xp_per_donation),
  });
  res.json({ ok: true });
});
router.get('/season/current', (req, res) => res.json(getCurrentSeason()));
router.post('/season/start-new', (req, res) => { startNewSeason(); res.json({ ok: true }); });
router.get('/season/tiers', (req, res) => res.json(listSeasonTiers()));
router.post('/season/tiers', (req, res) => {
  const b = req.body;
  if (!b.tier_number) return res.status(400).json({ error: 'شماره تایر لازمه' });
  upsertSeasonTier({
    tier_number: Number(b.tier_number),
    free_reward_type: b.free_reward_type, free_reward_value: b.free_reward_value,
    premium_reward_type: b.premium_reward_type, premium_reward_value: b.premium_reward_value,
  });
  res.json({ ok: true });
});
router.delete('/season/tiers/:n', (req, res) => { deleteSeasonTier(Number(req.params.n)); res.json({ ok: true }); });

/* ---------- سیستم کلن ---------- */
router.get('/clan/config', (req, res) => res.json(getClanConfig()));
router.post('/clan/config', (req, res) => {
  const b = req.body;
  setClanConfig({
    enabled: !!b.enabled, creation_cost_toman: Number(b.creation_cost_toman), max_members: Number(b.max_members),
    score_per_1k_purchase: Number(b.score_per_1k_purchase), score_per_win: Number(b.score_per_win),
    score_per_1k_donation: Number(b.score_per_1k_donation), reward_toman: Number(b.reward_toman),
    winners_count: Number(b.winners_count) || 1, distribution_method: b.distribution_method || 'equal',
    min_score_threshold: Number(b.min_score_threshold) || 0, reset_days: Number(b.reset_days) || 7,
  });
  res.json({ ok: true });
});
router.get('/clan/leaderboard', (req, res) => res.json(getClanLeaderboard(20)));
router.post('/clan/reset-season', (req, res) => {
  resetClanSeason((tgId, clan, reward) => {
    sendMessage(tgId, `🏆 کلن «${clan.name}» تو جدول برترین‌ها بود و ${reward.toLocaleString()} تومان جایزه گرفتی!`).catch(() => {});
  });
  res.json({ ok: true });
});

/* ---------- جنگ کلن به کلن ---------- */
router.get('/clanwar/config', (req, res) => res.json(getClanWarConfig()));
router.post('/clanwar/config', (req, res) => {
  setClanWarConfig(req.body);
  res.json({ ok: true });
});

/* ---------- رنکینگ، لقب، آواتار ---------- */
router.get('/rank/config', (req, res) => res.json(getRankConfig()));
router.post('/rank/config', (req, res) => {
  const b = req.body;
  setRankConfig({
    enabled: !!b.enabled, xp_per_level: Number(b.xp_per_level), xp_per_1k_purchase: Number(b.xp_per_1k_purchase),
    xp_per_win: Number(b.xp_per_win), xp_per_quest: Number(b.xp_per_quest),
    xp_per_referral: Number(b.xp_per_referral), xp_per_checkin: Number(b.xp_per_checkin),
  });
  res.json({ ok: true });
});
router.get('/rank/titles', (req, res) => res.json(listRankTitles()));
router.post('/rank/titles', (req, res) => {
  upsertRankTitle({ level_threshold: Number(req.body.level_threshold), title: req.body.title, icon: req.body.icon });
  res.json({ ok: true });
});
router.delete('/rank/titles/:t', (req, res) => { deleteRankTitle(Number(req.params.t)); res.json({ ok: true }); });

router.get('/avatars', (req, res) => res.json(listAvatars(false)));
router.post('/avatars', (req, res) => {
  const { id, name, image_url, price_toman, quantity, source, active } = req.body;
  if (!name) return res.status(400).json({ error: 'اسم آواتار لازمه' });
  const savedId = upsertAvatar({ id: id ? Number(id) : null, name, image_url, price_toman: Number(price_toman) || 0, quantity: quantity ? Number(quantity) : null, source, active: active !== false });
  res.json({ ok: true, id: savedId });
});
router.delete('/avatars/:id', (req, res) => { deleteAvatar(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- ماموریت‌های روزانه ---------- */
router.get('/quests/config', (req, res) => res.json(getQuestConfig()));
router.post('/quests/config', (req, res) => {
  setQuestConfig({ enabled: !!req.body.enabled, quest_count: Number(req.body.quest_count) || 3 });
  res.json({ ok: true });
});
router.get('/quests/templates', (req, res) => res.json(listQuestTemplates(false)));
router.post('/quests/templates', (req, res) => {
  const { id, title, type, target_count, reward_type, reward_value, active } = req.body;
  if (!title) return res.status(400).json({ error: 'عنوان لازمه' });
  const savedId = upsertQuestTemplate({ id: id ? Number(id) : null, title, type, target_count: Number(target_count) || 1, reward_type, reward_value, active: active !== false });
  res.json({ ok: true, id: savedId });
});
router.delete('/quests/templates/:id', (req, res) => { deleteQuestTemplate(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- کد هدیه ---------- */
router.get('/promo', (req, res) => res.json(listPromoCodes()));
router.post('/promo', (req, res) => {
  const { code, reward_type, reward_value, max_uses, expires_at, active } = req.body;
  if (!code || !reward_type) return res.status(400).json({ error: 'کد و نوع جایزه لازمه' });
  createPromoCode({ code, reward_type, reward_value, max_uses: max_uses ? Number(max_uses) : null, expires_at, active });
  res.json({ ok: true });
});
router.delete('/promo/:code', (req, res) => { deletePromoCode(req.params.code.toUpperCase()); res.json({ ok: true }); });
router.get('/promo/:code/redemptions', (req, res) => res.json(listRedemptions(req.params.code.toUpperCase())));

/* ---------- آلبوم کلکسیون ---------- */
router.get('/albums', (req, res) => res.json(listAlbums(false).map(a => ({ ...a, requirements: getAlbumRequirements(a.id) }))));
router.post('/albums', (req, res) => {
  const { id, name, reward_type, reward_value, is_seasonal, starts_at, ends_at, active, category_ids } = req.body;
  if (!name) return res.status(400).json({ error: 'اسم آلبوم لازمه' });
  const savedId = upsertAlbum({ id: id ? Number(id) : null, name, reward_type, reward_value, is_seasonal, starts_at, ends_at, active, category_ids });
  res.json({ ok: true, id: savedId });
});
router.delete('/albums/:id', (req, res) => { deleteAlbum(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- هدیه به دوست ---------- */
router.get('/gift/config', (req, res) => res.json(getGiftConfig()));
router.post('/gift/config', (req, res) => {
  const b = req.body;
  setGiftConfig({
    enabled: !!b.enabled, card_gift_min_referrals: Number(b.card_gift_min_referrals),
    card_gift_max_per_month: Number(b.card_gift_max_per_month), card_gift_max_level: Number(b.card_gift_max_level),
    toman_gift_fee_percent: Number(b.toman_gift_fee_percent),
  });
  res.json({ ok: true });
});

/* ---------- کارت‌های فصلی ---------- */
router.get('/seasons', (req, res) => res.json(listSeasons()));
router.post('/seasons', (req, res) => {
  const { name, theme, starts_at, ends_at, active } = req.body;
  if (!name || !starts_at || !ends_at) return res.status(400).json({ error: 'اسم و تاریخ شروع/پایان لازمه' });
  const id = createSeason({ name, theme, starts_at, ends_at, active });
  res.json({ ok: true, id });
});
router.delete('/seasons/:id', (req, res) => { deleteSeason(Number(req.params.id)); res.json({ ok: true }); });
router.post('/seasons/assign-card', (req, res) => {
  setCardSeason(Number(req.body.cardId), req.body.seasonId ? Number(req.body.seasonId) : null);
  res.json({ ok: true });
});

/* ---------- تبادل کارت ---------- */
router.get('/trade/config', (req, res) => res.json(getTradeConfig()));
router.post('/trade/config', (req, res) => {
  const b = req.body;
  setTradeConfig({
    enabled: !!b.enabled, max_tradable_level: Number(b.max_tradable_level),
    max_trades_per_month: Number(b.max_trades_per_month), min_user_level: Number(b.min_user_level),
    trade_fee_toman: Number(b.trade_fee_toman),
  });
  res.json({ ok: true });
});

export default router;
