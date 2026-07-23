import 'dotenv/config';
import dns from 'node:dns';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import {
  sendMessage, answerCallbackQuery, setWebhook, validateInitData, isChannelMember, getMe,
} from './telegram.js';
import db, {
  getOrCreateUser, getUser, adjustToman, isBanned, getLedger, payReferralBonus, getReferralInfo,
  listCurrencies, getCurrency, getWalletBalances, getCurrencyBalance, adjustCurrencyBalance,
  createTomanTopup, createTomanWithdrawal,
  createCurrencyRequest,
  decideTomanTopup, decideTomanWithdrawal, decideCurrencyRequest, getTomanTopup, getTomanWithdrawal, getCurrencyRequest,
  listCategories, listProducts, getProduct,
  createOrder, listOrdersForUser,
  createGiftOffer, listMyGiftOffers, listMarketGiftOffers, cancelGiftOffer, reserveGiftOffer, confirmGiftReceived, getGiftOffer,
  listActiveTasks, hasClaimedTask, claimTask, getTask,
  getOrCreateOpenTicket, addTicketMessage, listTicketMessages, listMyTickets,
} from './db.js';
import {
  listGameCards, getUserCards, buyGameCard, upgradeUserCard, sacrificeUpgradeCard,
  getGameConfig, getPlaysRemaining, getExtraPlays, buyExtraPlays,
  joinQueue, getQueueStatus, cancelQueue, getMatchHistory,
  getLeaderboard, getMyRank, checkAndAutoResetLeaderboard,
  listActiveCardTasks, hasClaimedCardTask, claimCardTask, getCardTask,
} from './game-db.js';
import adminApi from './admin-api.js';

// بعضی سرورها (مثل این VPS) IPv6 خراب/فیلتر شده دارن ولی IPv4‌شون سالمه. بدون این خط،
// Node گاهی اول IPv6 رو امتحان می‌کنه، گیر می‌کنه، و قبل از رسیدن به IPv4 سالم، درخواست
// (مثلا به api.telegram.org) تایم‌اوت می‌خوره. این خط همیشه IPv4 رو اول امتحان می‌کنه.
dns.setDefaultResultOrder('ipv4first');

const app = express();
app.use(express.json());

// هر روت async رو با این می‌پیچونیم تا اگه throw یا reject بشه، مستقیم بره سمت
// میدلور خطا و پاسخ مناسب برگرده — نه اینکه ریکوئست بی‌جواب بمونه یا سرور کرش کنه.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ===================== آپلود عکس (برای آگهی گیفت و تیکت) ===================== */
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
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/', (req, res) => res.send('✅ Lando Gifts backend is running'));

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const isAdminId = (id) => ADMIN_IDS.includes(Number(id));
function notifyAdmins(text, extra) {
  ADMIN_IDS.forEach(id => sendMessage(id, text, extra).catch(() => {}));
}

let cachedBotUsername = null;
app.get('/api/config', ah(async (req, res) => {
  if (!cachedBotUsername) {
    try { const me = await getMe(); cachedBotUsername = me.result?.username || null; } catch (e) {}
  }
  res.json({
    botUsername: cachedBotUsername,
    channel: process.env.REQUIRED_CHANNEL || null,
    cardNumber: process.env.ADMIN_CARD_NUMBER || null,
    cardOwner: process.env.ADMIN_CARD_OWNER || null,
    referralPercent: Number(process.env.REFERRAL_PERCENT || 5),
    giftMarketFeePercent: Number(process.env.GIFT_MARKET_FEE_PERCENT || 5),
    swapFeePercent: Number(process.env.SWAP_FEE_PERCENT || 1),
  });
}));

/* =========================================================================
 * هر درخواست /api/* باید initData معتبر تلگرام رو تو هدر X-Init-Data داشته باشه
 * ========================================================================= */
async function requireTelegramAuth(req, res, next) {
  try {
    const initData = req.headers['x-init-data'];
    if (!initData) return res.status(401).json({ error: 'no init data' });
    const tgUser = validateInitData(initData, process.env.BOT_TOKEN);
    if (!tgUser) return res.status(401).json({ error: 'invalid init data' });

    const params = new URLSearchParams(initData);
    const startParam = params.get('start_param');
    req.dbUser = getOrCreateUser(tgUser, startParam);

    const ban = isBanned(tgUser.id);
    if (ban.banned) return res.status(403).json({ error: 'banned', reason: ban.reason });

    if (process.env.REQUIRED_CHANNEL) {
      const joined = await isChannelMember(process.env.REQUIRED_CHANNEL, tgUser.id);
      if (!joined) return res.status(403).json({ error: 'join_required', channel: process.env.REQUIRED_CHANNEL });
    }
    next();
  } catch (e) {
    console.error('[requireTelegramAuth]', e);
    res.status(500).json({ error: 'خطای داخلی سرور' });
  }
}

app.post('/api/upload-image', requireTelegramAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایل عکس ارسال نشد' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

/* =========================================================================
 * پروفایل و کیف‌پول
 * ========================================================================= */
app.get('/api/me', requireTelegramAuth, (req, res) => {
  res.json({
    tg_id: req.dbUser.tg_id,
    username: req.dbUser.username,
    first_name: req.dbUser.first_name,
    balance_toman: req.dbUser.balance_toman,
    ref_code: req.dbUser.ref_code,
  });
});

app.get('/api/wallet/ledger', requireTelegramAuth, (req, res) => res.json(getLedger(req.dbUser.tg_id)));

app.post('/api/wallet/toman-topup', requireTelegramAuth, (req, res) => {
  const amount = Number(req.body.amount);
  const trackingCode = String(req.body.trackingCode || '').trim();
  if (!amount || amount < 1000) return res.status(400).json({ error: 'حداقل مبلغ شارژ ۱,۰۰۰ تومانه' });
  if (!trackingCode) return res.status(400).json({ error: 'کد رهگیری یا ۴ رقم آخر کارت رو وارد کن' });
  const id = createTomanTopup(req.dbUser.tg_id, amount, trackingCode);
  notifyAdmins(
    `💳 درخواست شارژ کارت‌به‌کارت\nکاربر: ${req.dbUser.first_name || ''} (${req.dbUser.tg_id})\nمبلغ: ${amount.toLocaleString()} تومان\nکد رهگیری: ${trackingCode}`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ تایید و شارژ', callback_data: `approve_topup:${id}` },
      { text: '❌ رد', callback_data: `reject_topup:${id}` },
    ]] } }
  );
  res.json({ ok: true });
});

app.post('/api/wallet/toman-withdraw', requireTelegramAuth, (req, res) => {
  const amount = Number(req.body.amount);
  const cardNumber = String(req.body.cardNumber || '').trim();
  if (!amount || amount < 10000) return res.status(400).json({ error: 'حداقل مبلغ برداشت ۱۰,۰۰۰ تومانه' });
  if (!cardNumber) return res.status(400).json({ error: 'شماره کارت مقصد رو وارد کن' });
  const user = getUser(req.dbUser.tg_id);
  if (user.balance_toman < amount) return res.status(400).json({ error: 'موجودی کافی نیست' });

  adjustToman(user.tg_id, -amount, 'درخواست برداشت (در انتظار تایید)');
  const id = createTomanWithdrawal(user.tg_id, amount, cardNumber);
  notifyAdmins(
    `📤 درخواست برداشت تومانی\nکاربر: ${req.dbUser.first_name || ''} (${req.dbUser.tg_id})\nمبلغ: ${amount.toLocaleString()} تومان\nشماره کارت: ${cardNumber}`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ ارسال شد', callback_data: `approve_withdraw:${id}` },
      { text: '❌ رد', callback_data: `reject_withdraw:${id}` },
    ]] } }
  );
  res.json({ ok: true });
});

/* =========================================================================
 * ارزها — کاملا دستی: نرخ‌ها رو فقط ادمین از پنل تنظیم می‌کنه، هیچ API بیرونی نیست
 * ========================================================================= */
app.get('/api/currencies', (req, res) => res.json(listCurrencies(true)));
app.get('/api/wallet/balances', requireTelegramAuth, (req, res) => res.json(getWalletBalances(req.dbUser.tg_id)));

app.post('/api/wallet/swap', requireTelegramAuth, (req, res) => {
  const { from, to, amount } = req.body; // 'TOMAN' <-> 'USDT'/'TON'/...
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'مقدار نامعتبر است' });
  if (from === to) return res.status(400).json({ error: 'مبدا و مقصد نمی‌تونن یکی باشن' });
  if (![from, to].includes('TOMAN')) return res.status(400).json({ error: 'تبدیل فقط بین تومان و یه ارز دیگه‌س' });

  const feePercent = Number(process.env.SWAP_FEE_PERCENT || 1);
  const code = from === 'TOMAN' ? to : from;
  const currency = getCurrency(code);
  if (!currency || !currency.active || !currency.rate_toman) return res.status(503).json({ error: `نرخ ${code} هنوز توسط ادمین ثبت نشده` });

  const user = getUser(req.dbUser.tg_id);
  let outputAmount;
  if (from === 'TOMAN') {
    if (user.balance_toman < amt) return res.status(400).json({ error: 'موجودی تومانی کافی نیست' });
    const gross = amt / currency.rate_toman;
    outputAmount = +(gross * (1 - feePercent / 100)).toFixed(6);
    adjustToman(req.dbUser.tg_id, -amt, `تبدیل تومان به ${to}`);
    adjustCurrencyBalance(req.dbUser.tg_id, to, outputAmount, `تبدیل از تومان`);
  } else {
    const bal = getCurrencyBalance(req.dbUser.tg_id, from);
    if (bal < amt) return res.status(400).json({ error: `موجودی ${from} کافی نیست` });
    const gross = amt * currency.rate_toman;
    outputAmount = Math.floor(gross * (1 - feePercent / 100));
    adjustCurrencyBalance(req.dbUser.tg_id, from, -amt, `تبدیل به تومان`);
    adjustToman(req.dbUser.tg_id, outputAmount, `تبدیل ${from} به تومان`);
  }
  res.json({ ok: true, outputAmount, rate: currency.rate_toman });
});

app.post('/api/wallet/currency-deposit', requireTelegramAuth, (req, res) => {
  const { code, amount, txHash } = req.body;
  const currency = getCurrency(code);
  if (!currency || !currency.active) return res.status(404).json({ error: 'این ارز فعال نیست' });
  const amt = Number(amount);
  if (!amt || amt < currency.min_deposit) return res.status(400).json({ error: `حداقل مقدار واریز ${currency.min_deposit} ${code} است` });
  if (!txHash) return res.status(400).json({ error: 'هش تراکنش یا کد رهگیری رو وارد کن' });

  const id = createCurrencyRequest(req.dbUser.tg_id, code, 'deposit', amt, { txHash });
  notifyAdmins(
    `💰 درخواست واریز ${code}\nکاربر: ${req.dbUser.first_name || ''} (${req.dbUser.tg_id})\nمقدار: ${amt} ${code}\nهش تراکنش: ${txHash}`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ تایید و شارژ', callback_data: `approve_cdep:${id}` },
      { text: '❌ رد', callback_data: `reject_cdep:${id}` },
    ]] } }
  );
  res.json({ ok: true });
});

app.post('/api/wallet/currency-withdraw', requireTelegramAuth, (req, res) => {
  const { code, amount, address } = req.body;
  const currency = getCurrency(code);
  if (!currency || !currency.active) return res.status(404).json({ error: 'این ارز فعال نیست' });
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'مقدار نامعتبر است' });
  if (!address) return res.status(400).json({ error: 'آدرس مقصد رو وارد کن' });
  const balance = getCurrencyBalance(req.dbUser.tg_id, code);
  if (balance < amt) return res.status(400).json({ error: 'موجودی کافی نیست' });

  adjustCurrencyBalance(req.dbUser.tg_id, code, -amt, 'درخواست برداشت (در انتظار تایید)');
  const id = createCurrencyRequest(req.dbUser.tg_id, code, 'withdraw', amt, { address });
  notifyAdmins(
    `📤 درخواست برداشت ${code}\nکاربر: ${req.dbUser.first_name || ''} (${req.dbUser.tg_id})\nمقدار: ${amt} ${code}\nآدرس مقصد: ${address}`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ ارسال شد', callback_data: `approve_cwd:${id}` },
      { text: '❌ رد', callback_data: `reject_cwd:${id}` },
    ]] } }
  );
  res.json({ ok: true });
});

/* =========================================================================
 * فروشگاه
 * ========================================================================= */
app.get('/api/categories', (req, res) => res.json(listCategories()));
app.get('/api/products', (req, res) => res.json(listProducts(true)));

app.post('/api/checkout', requireTelegramAuth, (req, res) => {
  const { productId, qty, note } = req.body;
  const product = getProduct(productId);
  if (!product || !product.active) return res.status(404).json({ error: 'محصول پیدا نشد' });
  const q = Math.max(1, Number(qty) || 1);
  const total = product.price_toman * q;

  const user = getUser(req.dbUser.tg_id);
  if (user.balance_toman < total) return res.status(400).json({ error: 'موجودی کیف‌پول کافی نیست' });

  adjustToman(user.tg_id, -total, `خرید «${product.title}»`);
  createOrder(user.tg_id, product.id, q, total, note || null);
  payReferralBonus(user.tg_id, total, Number(process.env.REFERRAL_PERCENT || 5));

  sendMessage(user.tg_id, `✅ سفارش شما ثبت شد.\nکالا: ${product.title} ×${q}\nمبلغ: ${total.toLocaleString()} تومان${note ? `\nمقصد: ${note}` : ''}`).catch(() => {});
  notifyAdmins(`🛒 سفارش جدید\nکاربر: ${user.first_name || ''} (${user.tg_id})\nکالا: ${product.title} ×${q}\nمبلغ: ${total.toLocaleString()} تومان${note ? `\nمقصد: ${note}` : ''}`);
  res.json({ ok: true, total });
});

app.get('/api/orders', requireTelegramAuth, (req, res) => res.json(listOrdersForUser(req.dbUser.tg_id)));

/* =========================================================================
 * رفرال
 * ========================================================================= */
app.get('/api/referral', requireTelegramAuth, (req, res) => res.json({ ref_code: req.dbUser.ref_code, ...getReferralInfo(req.dbUser.tg_id) }));

/* =========================================================================
 * بازار گیفت — امانی، بین کاربران
 * ========================================================================= */
app.get('/api/gifts/my', requireTelegramAuth, (req, res) => res.json(listMyGiftOffers(req.dbUser.tg_id)));
app.get('/api/gifts/market', requireTelegramAuth, (req, res) => res.json({ offers: listMarketGiftOffers(req.dbUser.tg_id), feePercent: Number(process.env.GIFT_MARKET_FEE_PERCENT || 5) }));

app.post('/api/gifts/list', requireTelegramAuth, (req, res) => {
  const { title, image_url, price } = req.body;
  const p = Number(price);
  if (!title || !p || p < 5000) return res.status(400).json({ error: 'عنوان و قیمت معتبر (حداقل ۵,۰۰۰ تومان) لازمه' });
  const id = createGiftOffer(req.dbUser.tg_id, title, image_url, p);
  res.json({ ok: true, id });
});
app.post('/api/gifts/:id/cancel', requireTelegramAuth, (req, res) => {
  try { cancelGiftOffer(req.dbUser.tg_id, Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/gifts/:id/buy', requireTelegramAuth, (req, res) => {
  try {
    const offer = reserveGiftOffer(req.dbUser.tg_id, Number(req.params.id));
    sendMessage(offer.seller_tg_id,
      `🎁 گیفت «${offer.title}» رزرو شد!\nخریدار: ${req.dbUser.first_name || ''} ${req.dbUser.username ? '@' + req.dbUser.username : `(آیدی: ${req.dbUser.tg_id})`}\n\nگیفت رو مستقیم تو تلگرام براش بفرست. پول بعد از تایید خریدار به کیف‌پولت واریز می‌شه.`
    ).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/gifts/:id/confirm-received', requireTelegramAuth, (req, res) => {
  try {
    const result = confirmGiftReceived(req.dbUser.tg_id, Number(req.params.id), Number(process.env.GIFT_MARKET_FEE_PERCENT || 5));
    sendMessage(result.seller_tg_id, `✅ خریدار دریافت گیفت «${result.title}» رو تایید کرد.\n+${result.sellerReceives.toLocaleString()} تومان به کیف‌پولت اضافه شد.`).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* =========================================================================
 * تسک‌ها
 * ========================================================================= */
app.get('/api/tasks', requireTelegramAuth, (req, res) => {
  res.json(listActiveTasks().map(t => ({ ...t, done: hasClaimedTask(req.dbUser.tg_id, t.id) })));
});
app.post('/api/tasks/:id/claim', requireTelegramAuth, ah(async (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task || !task.active) return res.status(404).json({ error: 'تسک پیدا نشد' });
  if (hasClaimedTask(req.dbUser.tg_id, task.id)) return res.status(400).json({ error: 'قبلاً این تسک رو انجام دادی' });
  if (task.kind === 'join_channel') {
    const joined = await isChannelMember(task.channel_username, req.dbUser.tg_id);
    if (!joined) return res.status(400).json({ error: 'هنوز عضو کانال نشدی' });
  }
  claimTask(req.dbUser.tg_id, task);
  res.json({ ok: true });
}));

/* =========================================================================
 * تسک‌های کارتی (پاداش = یه کارت مشخص)
 * ========================================================================= */
app.get('/api/card-tasks', requireTelegramAuth, (req, res) => {
  res.json(listActiveCardTasks().map(t => ({ ...t, done: hasClaimedCardTask(req.dbUser.tg_id, t.id) })));
});
app.post('/api/card-tasks/:id/claim', requireTelegramAuth, ah(async (req, res) => {
  const task = getCardTask(Number(req.params.id));
  if (!task || !task.active) return res.status(404).json({ error: 'تسک پیدا نشد' });
  if (hasClaimedCardTask(req.dbUser.tg_id, task.id)) return res.status(400).json({ error: 'قبلاً این تسک رو انجام دادی' });
  if (task.kind === 'join_channel') {
    const joined = await isChannelMember(task.channel_username, req.dbUser.tg_id);
    if (!joined) return res.status(400).json({ error: 'هنوز عضو کانال نشدی' });
  }
  claimCardTask(req.dbUser.tg_id, task);
  res.json({ ok: true });
}));

/* =========================================================================
 * بازی کارتی — خرید/ارتقای کارت، دسته‌بندی، صف مسابقه، جدول امتیازات
 * ========================================================================= */
app.get('/api/game/cards', (req, res) => res.json(listGameCards(true)));

app.get('/api/game/status', requireTelegramAuth, (req, res) => {
  checkAndAutoResetLeaderboard((tgId, rank, reward) => {
    sendMessage(tgId, `🏆 تبریک! تو رتبه ${rank} جدول امتیازات هفته شدی و ${reward.toLocaleString()} تومان جایزه گرفتی!`).catch(() => {});
  });
  const cfg = getGameConfig();
  res.json({
    config: cfg,
    playsRemaining: getPlaysRemaining(req.dbUser.tg_id),
    extraPlays: getExtraPlays(req.dbUser.tg_id),
    queue: getQueueStatus(req.dbUser.tg_id),
    myRank: getMyRank(req.dbUser.tg_id),
  });
});

app.get('/api/game/my-cards', requireTelegramAuth, (req, res) => res.json(getUserCards(req.dbUser.tg_id)));

app.post('/api/game/buy-card', requireTelegramAuth, (req, res) => {
  try {
    const id = buyGameCard(req.dbUser.tg_id, Number(req.body.cardId));
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/game/upgrade-card', requireTelegramAuth, (req, res) => {
  try {
    const result = upgradeUserCard(req.dbUser.tg_id, Number(req.body.userCardId));
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/game/sacrifice-upgrade', requireTelegramAuth, (req, res) => {
  try {
    const result = sacrificeUpgradeCard(req.dbUser.tg_id, Number(req.body.targetUserCardId), Number(req.body.sacrificeUserCardId));
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/game/buy-extra-plays', requireTelegramAuth, (req, res) => {
  try {
    const playsRemaining = buyExtraPlays(req.dbUser.tg_id);
    res.json({ ok: true, playsRemaining });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/game/queue', requireTelegramAuth, (req, res) => {
  try {
    const result = joinQueue(req.dbUser.tg_id, req.body.userCardIds || []);
    if (result.matched) {
      const opponent = getUser(result.opponentTgId);
      sendMessage(result.opponentTgId,
        result.won
          ? `⚔️ باختی! حریفت ${req.dbUser.first_name || 'یه بازیکن'} با قدرت ${result.myPower} در برابر ${result.opponentPower} برنده شد.`
          : `🏆 بردی! حریفت ${req.dbUser.first_name || 'یه بازیکن'} رو با قدرت ${result.opponentPower} در برابر ${result.myPower} شکست دادی.`
      ).catch(() => {});
    }
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/game/queue-status', requireTelegramAuth, (req, res) => res.json(getQueueStatus(req.dbUser.tg_id)));
app.post('/api/game/queue/cancel', requireTelegramAuth, (req, res) => { cancelQueue(req.dbUser.tg_id); res.json({ ok: true }); });
app.get('/api/game/history', requireTelegramAuth, (req, res) => res.json(getMatchHistory(req.dbUser.tg_id)));
app.get('/api/game/leaderboard', requireTelegramAuth, (req, res) => res.json({ leaderboard: getLeaderboard(20), myRank: getMyRank(req.dbUser.tg_id) }));

/* =========================================================================
 * پشتیبانی
 * ========================================================================= */
app.get('/api/support/messages', requireTelegramAuth, (req, res) => {
  const ticket = getOrCreateOpenTicket(req.dbUser.tg_id);
  res.json({ ticketId: ticket.id, messages: listTicketMessages(ticket.id) });
});
app.post('/api/support/send', requireTelegramAuth, upload.single('image'), (req, res) => {
  const text = req.body.text || '';
  if (!text.trim() && !req.file) return res.status(400).json({ error: 'پیام یا عکس رو وارد کن' });
  const ticket = getOrCreateOpenTicket(req.dbUser.tg_id);
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
  addTicketMessage(ticket.id, 'user', text, imageUrl);
  notifyAdmins(`🎫 تیکت جدید از ${req.dbUser.first_name || ''} (${req.dbUser.tg_id})\n${text}${imageUrl ? '\n(عکس ضمیمه — از پنل ادمین ببین)' : ''}`);
  res.json({ ok: true, ticketId: ticket.id });
});

/* =========================================================================
 * وبهوک تلگرام
 * ========================================================================= */
app.post('/telegram-webhook', async (req, res) => {
  if (req.headers['x-telegram-bot-api-secret-token'] !== process.env.WEBHOOK_SECRET) return res.sendStatus(401);
  res.sendStatus(200); // به تلگرام فورا جواب می‌دیم؛ هر خطای بعدی فقط لاگ می‌شه و ربات رو نمی‌خوابونه

  try {
    await handleTelegramUpdate(req.body);
  } catch (e) {
    console.error('[telegram-webhook]', e);
  }
});

async function handleTelegramUpdate(update) {
  if (update.message?.text?.startsWith('/start')) {
    const chatId = update.message.chat.id;
    const refParam = update.message.text.split(' ')[1];
    getOrCreateUser(update.message.from, refParam);

    if (process.env.REQUIRED_CHANNEL) {
      const joined = await isChannelMember(process.env.REQUIRED_CHANNEL, update.message.from.id);
      if (!joined) {
        await sendMessage(chatId, 'برای استفاده از ربات، اول عضو کانال ما شو:', {
          reply_markup: { inline_keyboard: [
            [{ text: '📢 عضویت در کانال', url: `https://t.me/${process.env.REQUIRED_CHANNEL.replace('@', '')}` }],
            [{ text: '✅ عضو شدم، بررسی کن', callback_data: 'check_join' }],
          ] },
        });
        return;
      }
    }
    await sendMessage(chatId, 'به <b>Lando Gifts</b> خوش اومدی 🎁\nاز دکمه پایین فروشگاه رو باز کن:', {
      reply_markup: { inline_keyboard: [[{ text: '🛍 باز کردن فروشگاه', web_app: { url: process.env.PUBLIC_URL + '/miniapp' } }]] },
    });
    return;
  }

  if (update.callback_query?.data === 'check_join') {
    answerCallbackQuery(update.callback_query.id).catch(() => {});
    const chatId = update.callback_query.message.chat.id;
    const joined = !process.env.REQUIRED_CHANNEL || await isChannelMember(process.env.REQUIRED_CHANNEL, update.callback_query.from.id);
    if (joined) {
      await sendMessage(chatId, 'عضویت تایید شد ✅', {
        reply_markup: { inline_keyboard: [[{ text: '🛍 باز کردن فروشگاه', web_app: { url: process.env.PUBLIC_URL + '/miniapp' } }]] },
      });
    } else {
      await sendMessage(chatId, '❌ هنوز عضو کانال نشدی.');
    }
    return;
  }

  // دکمه‌های تایید/رد ادمین در چت تلگرام (میانبر سریع، جدا از پنل ادمین تحت‌وب)
  const cq = update.callback_query;
  if (cq?.data && /^(approve|reject)_(topup|withdraw|cdep|cwd):/.test(cq.data)) {
    answerCallbackQuery(cq.id).catch(() => {});
    if (!isAdminId(cq.from.id)) { answerCallbackQuery(cq.id, 'فقط ادمین اجازه داره').catch(() => {}); return; }
    const [action, idStr] = cq.data.split(':');
    const id = Number(idStr);
    const approve = action.startsWith('approve');
    const kind = action.split('_')[1]; // topup | withdraw | cdep | cwd

    if (kind === 'topup') {
      const row = decideTomanTopup(id, approve);
      if (row) {
        await sendMessage(cq.message.chat.id, approve ? `✅ تایید شد، ${row.amount.toLocaleString()} تومان اضافه شد.` : '❌ رد شد.');
        await sendMessage(row.tg_id, approve ? `✅ شارژ شما تایید شد.\n+${row.amount.toLocaleString()} تومان` : '❌ شارژ شما تایید نشد.');
      }
    } else if (kind === 'withdraw') {
      const row = decideTomanWithdrawal(id, approve);
      if (row) {
        await sendMessage(cq.message.chat.id, approve ? `✅ برداشت تایید شد.` : '↩️ رد شد و مبلغ برگشت.');
        await sendMessage(row.tg_id, approve ? `✅ برداشت ${row.amount.toLocaleString()} تومان واریز شد.` : '❌ برداشت شما رد شد و مبلغ برگشت.');
      }
    } else if (kind === 'cdep') {
      const row = decideCurrencyRequest(id, approve);
      if (row) {
        await sendMessage(cq.message.chat.id, approve ? `✅ واریز ${row.amount} ${row.currency_code} تایید شد.` : '❌ رد شد.');
        await sendMessage(row.tg_id, approve ? `✅ واریز ${row.amount} ${row.currency_code} تایید شد.` : `❌ واریز ${row.currency_code} تایید نشد.`);
      }
    } else if (kind === 'cwd') {
      const row = decideCurrencyRequest(id, approve);
      if (row) {
        await sendMessage(cq.message.chat.id, approve ? `✅ ثبت شد. یادت نره ${row.amount} ${row.currency_code} رو دستی به ${row.address} بفرستی.` : '↩️ رد شد و موجودی برگشت.');
        await sendMessage(row.tg_id, approve ? `✅ برداشت ${row.amount} ${row.currency_code} انجام شد.` : `❌ برداشت ${row.currency_code} رد شد و مبلغ برگشت.`);
      }
    }
    return;
  }

  if (update.message?.text && isAdminId(update.message.from.id)) {
    const [cmd, ...args] = update.message.text.trim().split(' ');
    const chatId = update.message.chat.id;
    if (cmd === '/stats') {
      const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
      const orders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
      await sendMessage(chatId, `📊 آمار کلی\nکاربران: ${users}\nسفارش‌ها: ${orders}`);
    }
    if (cmd === '/addbalance') {
      const [targetId, amount] = args;
      const targetIdNum = Number(targetId);
      const amountNum = Number(amount);
      // ورودی نامعتبر رو رد می‌کنیم به‌جای اینکه NaN وارد موجودی کاربر بشه و کیف‌پولش خراب بشه
      if (args.length !== 2 || !Number.isFinite(targetIdNum) || !Number.isFinite(amountNum) || amountNum === 0) {
        await sendMessage(chatId, '⚠️ فرمت درست: /addbalance آیدی_عددی مبلغ\nمثال: /addbalance 123456789 50000');
      } else {
        adjustToman(targetIdNum, amountNum, 'شارژ دستی توسط ادمین');
        await sendMessage(chatId, `✅ ${amountNum.toLocaleString()} تومان به کیف‌پول ${targetIdNum} اضافه شد.`);
        await sendMessage(targetIdNum, `💰 مبلغ ${amountNum.toLocaleString()} تومان توسط پشتیبانی به کیف‌پولت اضافه شد.`);
      }
    }
  }
}

/* =========================================================================
 * سرو کردن مینی‌اپ و پنل ادمین
 * ========================================================================= */
app.use('/miniapp', express.static('public'));
app.use('/admin/api', adminApi);
app.use('/admin', express.static('admin'));

// هر مسیر /api/* که به هیچ روتی نخورد، یه ۴۰۴ تمیز JSON برمی‌گردونه (نه صفحه HTML پیش‌فرض اکسپرس)
app.use('/api', (req, res) => res.status(404).json({ error: 'این مسیر پیدا نشد' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'داده ارسالی نامعتبره' });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'حجم عکس بیشتر از حد مجاز (۵ مگابایت) است' });
  }
  console.error('[unhandled route error]', err);
  res.status(500).json({ error: 'خطای داخلی سرور' });
});
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException] سرور روشن می‌مونه:', err));

// چک دوره‌ای ریست جدول امتیازات، حتی وقتی هیچ کاربری وارد بخش بازی نشده
setInterval(() => {
  try {
    checkAndAutoResetLeaderboard((tgId, rank, reward) => {
      sendMessage(tgId, `🏆 تبریک! تو رتبه ${rank} جدول امتیازات هفته شدی و ${reward.toLocaleString()} تومان جایزه گرفتی!`).catch(() => {});
    });
  } catch (e) { console.error('[leaderboard auto-reset]', e); }
}, 60 * 60 * 1000);

// ثبت وبهوک تلگرام؛ اگه دامنه/تانل هنوز بالا نیومده باشه (مثلا موقع بوت شدن روی
// ترموکس)، به‌جای اینکه فقط یه بار fail بشه و ول بشه، هر ۳۰ ثانیه دوباره امتحان می‌کنه
async function ensureWebhookRegistered() {
  if (!process.env.PUBLIC_URL) return;
  try {
    const r = await setWebhook(`${process.env.PUBLIC_URL}/telegram-webhook`, process.env.WEBHOOK_SECRET);
    if (r.ok) { console.log('✅ webhook set:', process.env.PUBLIC_URL + '/telegram-webhook'); return; }
    console.warn('⚠️ webhook registration failed, retrying in 30s...');
  } catch (e) {
    console.warn('⚠️ webhook registration error, retrying in 30s...', e.message);
  }
  setTimeout(ensureWebhookRegistered, 30 * 1000);
}

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Lando Gifts server running on port ${process.env.PORT || 3000}`);
  ensureWebhookRegistered();
});
