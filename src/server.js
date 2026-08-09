import 'dotenv/config';
import dns from 'node:dns';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import {
  sendMessage, answerCallbackQuery, setWebhook, validateInitData, isChannelMember, getMe,
  createStarsInvoiceLink, answerPreCheckoutQuery,
} from './telegram.js';
import db, {
  getOrCreateUser, getUser, adjustToman, isBanned, getLedger, payReferralBonus, getReferralInfo, getReferralSettings,
  listCurrencies, getCurrency, getWalletBalances, getCurrencyBalance, adjustCurrencyBalance,
  createTomanTopup, createTomanWithdrawal,
  createCurrencyRequest,
  decideTomanTopup, decideTomanWithdrawal, decideCurrencyRequest, getTomanTopup, getTomanWithdrawal, getCurrencyRequest,
  listCategories, listProducts, getProduct,
  createOrder, listOrdersForUser,
  createGiftOffer, listMyGiftOffers, listMarketGiftOffers, cancelGiftOffer, reserveGiftOffer, confirmGiftReceived, getGiftOffer, listGiftCategories, updateGiftOffer,
  listActiveTasks, hasClaimedTask, claimTask, getTask,
  getPaymentSettings, getMessageSettings, getSupportContact, getInfoPage, getLndcWalletSettings, getUiImages,
  createStarPaymentRequest, getStarPayment, completeStarPayment,
} from './db.js';
import {
  listGameCards, getUserCards, buyGameCard, sacrificeCards, getMutationGroups, mutateCards, getGameCard,
  getGameConfig, getPlaysRemaining, getExtraPlays, buyExtraPlays,
  joinQueue, getQueueStatus, cancelQueue, getMatchHistory,
  getLeaderboard, getMyRank, getUserLeaderboardRow, listLeaderboardPrizes, checkAndAutoResetLeaderboard,
  listActiveCardTasks, hasClaimedCardTask, claimCardTask, getCardTask,
  listCardCategories, getCardImageForLevel, getRarityForLevel, computeCardPower,
} from './game-db.js';
import { getWheelStatus, spinWheel, listWheelSlots, getWheelHistory } from './wheel-db.js';
import {
  getAuctionConfig, listActiveAuctions, getAuction, listAuctionBids, placeBid, finalizeExpiredAuctions, getMyAuctionHistory,
} from './auction-db.js';
import {
  getSeasonConfig, getCurrentSeason, checkAutoResetSeason, listSeasonTiers,
  getUserSeasonProgress, purchasePremiumPass, claimSeasonTierReward, addSeasonXp, buySeasonTiers,
} from './season-db.js';
import {
  getClanConfig, getMyClan, getClanMembers, searchClans, getClanLeaderboard, getClanRank,
  createClan, joinClan, leaveClan, kickMember, setMemberRole, donateToClan, withdrawFromClanBank, giftFromClanBank,
  addClanPurchaseScore, addClanWinScore, checkAutoResetClanSeason,
  sendClanMessage, getClanMessages,
  setClanJoinSettings, listClanJoinRequests, respondClanJoinRequest,
} from './clan-db.js';
import {
  getClanWarConfig, listOpenClanWars, getMyActiveClanWar, getClanWarHistory,
  createClanWar, cancelClanWar, joinClanWar, submitWarPicks, getClanWar, getMemberCardsForLeader,
} from './clan-war-db.js';
import { getLeagueConfig, getUserLeagueInfo, getLeagueLeaderboard, checkAutoResetLeague } from './league-db.js';
import { listOpenRaffles, getRaffleStatusForUser, registerForRaffle, buyRaffleTicket, getRaffle } from './raffle-db.js';
import {
  getRankConfig, getUserRankInfo, addUserXp, canCheckinToday, doCheckin,
  listAvatars, getMyAvatars, buyAvatar, equipAvatar,
  getLevelLeaderboard, getUserLevelRank, getUserLevelRow,
} from './rank-db.js';
import { getTodayQuestsForUser, incrementQuestProgress, claimQuestReward } from './quest-db.js';
import { redeemPromoCode } from './promo-db.js';
import { listAlbums, getAlbumProgress, claimAlbumReward } from './album-db.js';
import { getGiftConfig, giftToman, giftCard, getRemainingCardGifts } from './gift-db.js';
import { checkExpiredSeasons } from './seasonal-db.js';
import {
  getCardMarketConfig, createCardMarketListing, cancelCardMarketListing,
  listCardMarketOffers, getMyCardMarketListings, buyCardMarketListing, getPriceGuidance,
} from './card-market-db.js';
import adminApi from './admin-api.js';
import './db-indexes.js'; // must be imported last — creates indexes on every table defined above

// Some servers (like this VPS) have broken/filtered IPv6 but their IPv4 is fine. Without this line,
// Node sometimes tries IPv6 first, gets stuck, and before reaching a healthy IPv4, the request
// (e.g. to api.telegram.org) times out. This line always tries IPv4 first.
dns.setDefaultResultOrder('ipv4first');

const app = express();
app.use(express.json());

/* ================= Force English (Latin) digits everywhere =================
   Backstop for the front-end digit conversion: even if a request reaches the API with
   Persian (۰-۹) or Arabic-Indic (٠-٩) numerals in it (e.g. a bypassed client, an old cached
   page), every string in the JSON body is normalized to plain English digits before any
   route handler runs. This makes it effectively impossible for Persian numbers to end up
   stored anywhere in the system. */
const FA_AR_DIGIT_MAP = { '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9',
  '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };
function toEnglishDigitsDeep(value) {
  if (typeof value === 'string') return value.replace(/[۰-۹٠-٩]/g, d => FA_AR_DIGIT_MAP[d] || d);
  if (Array.isArray(value)) return value.map(toEnglishDigitsDeep);
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = toEnglishDigitsDeep(value[key]);
    return value;
  }
  return value;
}
app.use((req, res, next) => { if (req.body) req.body = toEnglishDigitsDeep(req.body); next(); });

// We wrap every async route with this so that if it throws or rejects, it goes straight to
// error middleware and a proper response is returned — instead of the request hanging or the server crashing.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ===================== Image upload (for gift listings and tickets) ===================== */
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
  const payment = getPaymentSettings(); // The card number can now be changed manually from the admin panel, not only from .env
  res.json({
    botUsername: cachedBotUsername,
    channel: process.env.REQUIRED_CHANNEL || null,
    cardNumber: payment.cardNumber || null,
    cardOwner: payment.cardOwner || null,
    referralPercent: getReferralSettings().percent,
    giftMarketFeePercent: Number(process.env.GIFT_MARKET_FEE_PERCENT || 5),
    swapFeePercent: Number(process.env.SWAP_FEE_PERCENT || 1),
    supportUsername: getSupportContact(),
    lndcWallet: getLndcWalletSettings(),
    uiImages: getUiImages(),
  });
}));

app.get('/api/info/:key', (req, res) => res.json({ content: getInfoPage(req.params.key) }));

/* =========================================================================
 * Every /api/* request must have valid Telegram initData in the X-Init-Data header
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
    res.status(500).json({ error: 'Internal server error' });
  }
}

app.post('/api/upload-image', requireTelegramAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file was sent' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

/* =========================================================================
 * Profile & wallet
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

app.get('/api/wallet/ledger', requireTelegramAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 15, 50);
  const offset = Number(req.query.offset) || 0;
  res.json(getLedger(req.dbUser.tg_id, limit, offset));
});

app.post('/api/wallet/toman-topup', requireTelegramAuth, (req, res) => {
  if (!getLndcWalletSettings().depositEnabled) return res.status(400).json({ error: 'Lando Coin deposit is currently disabled' });
  const amount = Number(req.body.amount);
  const trackingCode = String(req.body.trackingCode || '').trim();
  if (!amount || amount < 1000) return res.status(400).json({ error: 'Minimum top-up amount is 1,000 LNDC' });
  if (!trackingCode) return res.status(400).json({ error: 'Enter the tracking code or last 4 digits of the card' });
  const id = createTomanTopup(req.dbUser.tg_id, amount, trackingCode);
  notifyAdmins(
    `💳 Card-to-card top-up request\nUser: ${req.dbUser.first_name || ''} (${req.dbUser.tg_id})\nAmount: ${amount.toLocaleString()} LNDC\nTracking code: ${trackingCode}`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Approve & top up', callback_data: `approve_topup:${id}` },
      { text: '❌ Reject', callback_data: `reject_topup:${id}` },
    ]] } }
  );
  res.json({ ok: true });
});

app.post('/api/wallet/toman-withdraw', requireTelegramAuth, (req, res) => {
  if (!getLndcWalletSettings().withdrawEnabled) return res.status(400).json({ error: 'Lando Coin withdrawal is currently disabled' });
  const amount = Number(req.body.amount);
  const cardNumber = String(req.body.cardNumber || '').trim();
  if (!amount || amount < 10000) return res.status(400).json({ error: 'Minimum withdrawal amount is 10,000 LNDC' });
  if (!cardNumber) return res.status(400).json({ error: 'Enter the destination card number' });
  const user = getUser(req.dbUser.tg_id);
  if (user.balance_toman < amount) return res.status(400).json({ error: 'Insufficient balance' });

  adjustToman(user.tg_id, -amount, 'Withdrawal request (pending approval)');
  const id = createTomanWithdrawal(user.tg_id, amount, cardNumber);
  notifyAdmins(
    `📤 LNDC withdrawal request\nUser: ${req.dbUser.first_name || ''} (${req.dbUser.tg_id})\nAmount: ${amount.toLocaleString()} LNDC\nCard number: ${cardNumber}`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Sent', callback_data: `approve_withdraw:${id}` },
      { text: '❌ Reject', callback_data: `reject_withdraw:${id}` },
    ]] } }
  );
  res.json({ ok: true });
});

/* =========================================================================
 * Currencies — fully manual: rates are set only by the admin from the panel, no external API
 * ========================================================================= */
app.get('/api/currencies', (req, res) => res.json(listCurrencies(true)));
app.get('/api/wallet/balances', requireTelegramAuth, (req, res) => res.json(getWalletBalances(req.dbUser.tg_id)));

app.post('/api/wallet/swap', requireTelegramAuth, (req, res) => {
  const { from, to, amount } = req.body; // 'LNDC' <-> 'USDT'/'TON'/...
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (from === to) return res.status(400).json({ error: 'Source and destination cannot be the same' });
  if (![from, to].includes('LNDC')) return res.status(400).json({ error: 'Conversion is only between LNDC and one other currency' });

  const feePercent = Number(process.env.SWAP_FEE_PERCENT || 1);
  const code = from === 'LNDC' ? to : from;
  const currency = getCurrency(code);
  if (!currency || !currency.active || !currency.rate_toman) return res.status(503).json({ error: `The ${code} rate has not been set by the admin yet` });

  const user = getUser(req.dbUser.tg_id);
  let outputAmount;
  if (from === 'LNDC') {
    if (user.balance_toman < amt) return res.status(400).json({ error: 'Insufficient LNDC balance' });
    const gross = amt / currency.rate_toman;
    outputAmount = Math.floor(gross * (1 - feePercent / 100)); // whole numbers only — no decimals anywhere in the wallet
    if (outputAmount <= 0) return res.status(400).json({ error: 'Amount too small — it rounds down to 0' });
    adjustToman(req.dbUser.tg_id, -amt, `Convert LNDC to ${to}`);
    adjustCurrencyBalance(req.dbUser.tg_id, to, outputAmount, `Convert from LNDC`);
  } else {
    const bal = getCurrencyBalance(req.dbUser.tg_id, from);
    if (bal < amt) return res.status(400).json({ error: `Insufficient ${from} balance` });
    const gross = amt * currency.rate_toman;
    outputAmount = Math.floor(gross * (1 - feePercent / 100));
    adjustCurrencyBalance(req.dbUser.tg_id, from, -amt, `Convert to LNDC`);
    adjustToman(req.dbUser.tg_id, outputAmount, `Convert ${from} to LNDC`);
  }
  res.json({ ok: true, outputAmount, rate: currency.rate_toman });
});

app.post('/api/wallet/currency-deposit', requireTelegramAuth, (req, res) => {
  const { code, amount, txHash } = req.body;
  const currency = getCurrency(code);
  if (!currency || !currency.active) return res.status(404).json({ error: 'This currency is not active' });
  const amt = Number(amount);
  if (!amt || amt < currency.min_deposit) return res.status(400).json({ error: `Minimum deposit amount is ${currency.min_deposit} ${code}` });
  if (!txHash) return res.status(400).json({ error: 'Enter the transaction hash or tracking code' });

  const id = createCurrencyRequest(req.dbUser.tg_id, code, 'deposit', amt, { txHash });
  notifyAdmins(
    `💰 Deposit request ${code}\nUser: ${req.dbUser.first_name || ''} (${req.dbUser.tg_id})\nAmount: ${amt} ${code}\nTransaction hash: ${txHash}`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Approve & top up', callback_data: `approve_cdep:${id}` },
      { text: '❌ Reject', callback_data: `reject_cdep:${id}` },
    ]] } }
  );
  res.json({ ok: true });
});

/* ---------- Account top-up with Telegram Stars (⭐ XTR) — instant, no manual admin approval ---------- */
app.post('/api/wallet/stars-invoice', requireTelegramAuth, async (req, res) => {
  try {
    const starsAmount = Math.round(Number(req.body.starsAmount));
    if (!starsAmount || starsAmount < 1) return res.status(400).json({ error: 'Invalid Stars amount' });
    const starsCurrency = getCurrency('STARS') || getCurrency('XTR');
    if (!starsCurrency || !starsCurrency.active || !starsCurrency.rate_toman) {
      return res.status(400).json({ error: 'The admin has not set the Stars rate yet' });
    }
    const id = createStarPaymentRequest(req.dbUser.tg_id, starsAmount, starsCurrency.rate_toman);
    const r = await createStarsInvoiceLink(
      'Top up wallet', `Top-up ${starsAmount}⭐ = ${(starsAmount * starsCurrency.rate_toman).toLocaleString()} LNDC`,
      `star_topup_${id}`, starsAmount
    );
    if (!r.ok) return res.status(500).json({ error: 'Creating the payment invoice failed' });
    res.json({ ok: true, link: r.result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/wallet/currency-withdraw', requireTelegramAuth, (req, res) => {
  const { code, amount, address } = req.body;
  const currency = getCurrency(code);
  if (!currency || !currency.active) return res.status(404).json({ error: 'This currency is not active' });
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!address) return res.status(400).json({ error: 'Enter the destination address' });
  const balance = getCurrencyBalance(req.dbUser.tg_id, code);
  if (balance < amt) return res.status(400).json({ error: 'Insufficient balance' });

  adjustCurrencyBalance(req.dbUser.tg_id, code, -amt, 'Withdrawal request (pending approval)');
  const id = createCurrencyRequest(req.dbUser.tg_id, code, 'withdraw', amt, { address });
  notifyAdmins(
    `📤 Withdrawal request ${code}\nUser: ${req.dbUser.first_name || ''} (${req.dbUser.tg_id})\nAmount: ${amt} ${code}\nDestination address: ${address}`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Sent', callback_data: `approve_cwd:${id}` },
      { text: '❌ Reject', callback_data: `reject_cwd:${id}` },
    ]] } }
  );
  res.json({ ok: true });
});

/* =========================================================================
 * Shop
 * ========================================================================= */
app.get('/api/categories', (req, res) => res.json(listCategories()));
app.get('/api/products', (req, res) => res.json(listProducts(true)));

app.post('/api/checkout', requireTelegramAuth, (req, res) => {
  const { productId, qty, note } = req.body;
  const product = getProduct(productId);
  if (!product || !product.active) return res.status(404).json({ error: 'Product not found' });
  const q = Math.max(1, Number(qty) || 1);
  const total = product.price_toman * q;

  const user = getUser(req.dbUser.tg_id);
  if (user.balance_toman < total) return res.status(400).json({ error: 'Insufficient wallet balance' });

  adjustToman(user.tg_id, -total, `Purchase «${product.title}»`);
  createOrder(user.tg_id, product.id, q, total, note || null);
  payReferralBonus(user.tg_id, total, getReferralSettings().percent);
  addClanPurchaseScore(user.tg_id, total);
  addSeasonXp(user.tg_id, getSeasonConfig().xp_per_purchase);
  addUserXp(user.tg_id, Math.floor(total / 1000) * getRankConfig().xp_per_1k_purchase);
  // This is a regular shop/gift product purchase (not a game card) — tracked as its own quest type
  // ('buy_product') so it can never be confused with, or silently satisfy, a "buy game card" quest.
  incrementQuestProgress(user.tg_id, 'buy_product', 1);

  sendMessage(user.tg_id, `✅ Your order has been placed.\nItem: ${product.title} ×${q}\nAmount: ${total.toLocaleString()} LNDC${note ? `\nDestination: ${note}` : ''}`).catch(() => {});
  notifyAdmins(`🛒 New order\nUser: ${user.first_name || ''} (${user.tg_id})\nItem: ${product.title} ×${q}\nAmount: ${total.toLocaleString()} LNDC${note ? `\nDestination: ${note}` : ''}`);
  res.json({ ok: true, total });
});

app.get('/api/orders', requireTelegramAuth, (req, res) => res.json(listOrdersForUser(req.dbUser.tg_id)));

/* =========================================================================
 * Referral
 * ========================================================================= */
app.get('/api/referral', requireTelegramAuth, (req, res) => res.json({ ref_code: req.dbUser.ref_code, ...getReferralInfo(req.dbUser.tg_id) }));

/* =========================================================================
 * Gift market — consignment, between users
 * ========================================================================= */
app.get('/api/gifts/my', requireTelegramAuth, (req, res) => res.json(listMyGiftOffers(req.dbUser.tg_id)));
app.get('/api/gifts/market', requireTelegramAuth, (req, res) => res.json({ offers: listMarketGiftOffers(req.dbUser.tg_id), feePercent: Number(process.env.GIFT_MARKET_FEE_PERCENT || 5) }));
app.get('/api/gifts/categories', (req, res) => res.json(listGiftCategories(true)));

app.get('/api/gift-categories', (req, res) => res.json(listGiftCategories(true)));
app.post('/api/gifts/list', requireTelegramAuth, (req, res) => {
  const { title, image_url, price, serial_number, link } = req.body;
  const p = Number(price);
  if (!title || !p || p < 5000) return res.status(400).json({ error: 'A valid title and price (minimum 5,000 LNDC) are required' });
  const categories = listGiftCategories(true);
  if (categories.length && !categories.some(c => c.name === title)) return res.status(400).json({ error: 'This category is not approved, pick from the list' });
  const id = createGiftOffer(req.dbUser.tg_id, title, image_url, p, serial_number, link);
  res.json({ ok: true, id });
});
app.post('/api/gifts/:id/edit', requireTelegramAuth, (req, res) => {
  try {
    const { title, image_url, price, serial_number, link } = req.body;
    const p = Number(price);
    if (!title || !p || p < 5000) return res.status(400).json({ error: 'A valid title and price (minimum 5,000 LNDC) are required' });
    updateGiftOffer(req.dbUser.tg_id, Number(req.params.id), { title, image_url, price_toman: p, serial_number, link });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/gifts/:id/cancel', requireTelegramAuth, (req, res) => {
  try { cancelGiftOffer(req.dbUser.tg_id, Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/gifts/:id/buy', requireTelegramAuth, (req, res) => {
  try {
    const offer = reserveGiftOffer(req.dbUser.tg_id, Number(req.params.id));
    sendMessage(offer.seller_tg_id,
      `🎁 Gift "${offer.title}" reserved!\nBuyer: ${req.dbUser.first_name || ''} ${req.dbUser.username ? '@' + req.dbUser.username : `(ID: ${req.dbUser.tg_id})`}\n\nSend the gift directly on Telegram to them. The money is deposited to your wallet after the buyer confirms.`
    ).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/gifts/:id/confirm-received', requireTelegramAuth, (req, res) => {
  try {
    const result = confirmGiftReceived(req.dbUser.tg_id, Number(req.params.id), Number(process.env.GIFT_MARKET_FEE_PERCENT || 5));
    sendMessage(result.seller_tg_id, `✅ The buyer confirmed receipt of gift "${result.title}".\n+${result.sellerReceives.toLocaleString()} LNDC added to your wallet.`).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* =========================================================================
 * Tasks
 * ========================================================================= */
app.get('/api/tasks', requireTelegramAuth, (req, res) => {
  res.json(listActiveTasks().map(t => ({ ...t, done: hasClaimedTask(req.dbUser.tg_id, t.id) })));
});
app.post('/api/tasks/:id/claim', requireTelegramAuth, ah(async (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task || !task.active) return res.status(404).json({ error: 'Task not found' });
  if (hasClaimedTask(req.dbUser.tg_id, task.id)) return res.status(400).json({ error: 'You have already done this task' });
  if (task.kind === 'join_channel') {
    const joined = await isChannelMember(task.channel_username, req.dbUser.tg_id);
    if (!joined) return res.status(400).json({ error: 'You have not joined the channel yet' });
  }
  claimTask(req.dbUser.tg_id, task);
  res.json({ ok: true });
}));

/* =========================================================================
 * Card tasks (reward = a specific card)
 * ========================================================================= */
app.get('/api/card-tasks', requireTelegramAuth, (req, res) => {
  res.json(listActiveCardTasks().map(t => ({ ...t, done: hasClaimedCardTask(req.dbUser.tg_id, t.id) })));
});
app.post('/api/card-tasks/:id/claim', requireTelegramAuth, ah(async (req, res) => {
  const task = getCardTask(Number(req.params.id));
  if (!task || !task.active) return res.status(404).json({ error: 'Task not found' });
  if (hasClaimedCardTask(req.dbUser.tg_id, task.id)) return res.status(400).json({ error: 'You have already done this task' });
  if (task.kind === 'join_channel') {
    const joined = await isChannelMember(task.channel_username, req.dbUser.tg_id);
    if (!joined) return res.status(400).json({ error: 'You have not joined the channel yet' });
  }
  claimCardTask(req.dbUser.tg_id, task);
  res.json({ ok: true });
}));

/* =========================================================================
 * Daily wheel of fortune — free, spinnable only at a fixed interval
 * ========================================================================= */
app.get('/api/wheel/status', requireTelegramAuth, (req, res) => res.json(getWheelStatus(req.dbUser.tg_id)));
app.get('/api/wheel/slots', (req, res) => res.json(listWheelSlots(true)));
app.post('/api/wheel/spin', requireTelegramAuth, (req, res) => {
  try {
    const result = spinWheel(req.dbUser.tg_id);
    // Also return the exact slot list the backend used to pick the winner (post deleted-card filtering),
    // so the frontend animation renders/targets that exact same list instead of a possibly stale cached copy —
    // this is what guarantees the wheel visually lands on the same item the backend actually awarded.
    res.json({ ok: true, won: result.slot, slots: result.slots });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/wheel/history', requireTelegramAuth, (req, res) => res.json(getWheelHistory(req.dbUser.tg_id)));

/* =========================================================================
 * Flash auction
 * ========================================================================= */
app.get('/api/auctions', (req, res) => res.json({ auctions: listActiveAuctions(), config: getAuctionConfig() }));
app.get('/api/auctions/:id/bids', (req, res) => res.json(listAuctionBids(Number(req.params.id))));
app.post('/api/auctions/:id/bid', requireTelegramAuth, (req, res) => {
  try { res.json({ ok: true, ...placeBid(req.dbUser.tg_id, Number(req.params.id)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/auctions/my-history', requireTelegramAuth, (req, res) => res.json(getMyAuctionHistory(req.dbUser.tg_id)));

/* =========================================================================
 * Seasonal battle pass
 * ========================================================================= */
app.get('/api/season/status', requireTelegramAuth, (req, res) => {
  checkAutoResetSeason();
  res.json({
    config: getSeasonConfig(),
    season: getCurrentSeason(),
    tiers: listSeasonTiers(),
    progress: getUserSeasonProgress(req.dbUser.tg_id),
  });
});
app.post('/api/season/buy-premium', requireTelegramAuth, (req, res) => {
  try { purchasePremiumPass(req.dbUser.tg_id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/season/claim', requireTelegramAuth, (req, res) => {
  try { res.json({ ok: true, ...claimSeasonTierReward(req.dbUser.tg_id, Number(req.body.tier), req.body.track) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/season/buy-tier', requireTelegramAuth, (req, res) => {
  try { res.json({ ok: true, ...buySeasonTiers(req.dbUser.tg_id, Number(req.body.targetTier)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* =========================================================================
 * Clan system
 * ========================================================================= */
app.get('/api/clan/config', (req, res) => res.json(getClanConfig()));
app.get('/api/clan/my', requireTelegramAuth, (req, res) => {
  const clan = getMyClan(req.dbUser.tg_id);
  res.json({ clan, members: clan ? getClanMembers(clan.id) : [] });
});
app.get('/api/clan/search', requireTelegramAuth, (req, res) => res.json(searchClans(req.query.q || '')));
app.get('/api/clan/leaderboard', requireTelegramAuth, (req, res) => {
  const leaderboard = getClanLeaderboard(10);
  const myClan = getMyClan(req.dbUser.tg_id);
  const cfg = getClanConfig();
  const myRank = myClan ? getClanRank(myClan.id) : null;
  res.json({
    leaderboard, myRank, myClan,
    prizeInfo: { reward_toman: cfg.reward_toman, winners_count: cfg.winners_count, distribution_method: cfg.distribution_method, reset_days: cfg.reset_days },
  });
});
app.post('/api/clan/create', requireTelegramAuth, (req, res) => {
  try { const id = createClan(req.dbUser.tg_id, req.body.name, req.body.tag, req.body.avatarUrl); res.json({ ok: true, id }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/clan/:id/join', requireTelegramAuth, (req, res) => {
  try { res.json({ ok: true, ...joinClan(req.dbUser.tg_id, Number(req.params.id)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/clan/join-settings', requireTelegramAuth, (req, res) => {
  try {
    const clan = getMyClan(req.dbUser.tg_id);
    if (!clan) throw new Error('You are not in a clan');
    setClanJoinSettings(req.dbUser.tg_id, clan.id, { joinPolicy: req.body.joinPolicy, minLevel: req.body.minLevel });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/clan/join-requests', requireTelegramAuth, (req, res) => {
  try {
    const clan = getMyClan(req.dbUser.tg_id);
    if (!clan) throw new Error('You are not in a clan');
    res.json(listClanJoinRequests(req.dbUser.tg_id, clan.id));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/clan/join-requests/:id/respond', requireTelegramAuth, (req, res) => {
  try {
    const clan = getMyClan(req.dbUser.tg_id);
    if (!clan) throw new Error('You are not in a clan');
    respondClanJoinRequest(req.dbUser.tg_id, clan.id, Number(req.params.id), !!req.body.accept);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/clan/leave', requireTelegramAuth, (req, res) => {
  try { res.json({ ok: true, ...leaveClan(req.dbUser.tg_id) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/clan/kick', requireTelegramAuth, (req, res) => {
  try { kickMember(req.dbUser.tg_id, Number(req.body.targetTgId)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/clan/set-role', requireTelegramAuth, (req, res) => {
  try { setMemberRole(req.dbUser.tg_id, Number(req.body.targetTgId), req.body.role); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/clan/donate', requireTelegramAuth, (req, res) => {
  try {
    donateToClan(req.dbUser.tg_id, Number(req.body.amount));
    incrementQuestProgress(req.dbUser.tg_id, 'donate_clan', 1);
    addSeasonXp(req.dbUser.tg_id, getSeasonConfig().xp_per_donation);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/clan/withdraw', requireTelegramAuth, (req, res) => {
  try { res.json({ ok: true, ...withdrawFromClanBank(req.dbUser.tg_id, Number(req.body.amount)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/clan/gift', requireTelegramAuth, (req, res) => {
  try { res.json({ ok: true, ...giftFromClanBank(req.dbUser.tg_id, Number(req.body.targetTgId), Number(req.body.amount)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- Clan chat — private to each clan's own members, polled by the client every couple of
 * seconds while open; messages auto-delete after the admin-configured retention window. ---------- */
app.get('/api/clan/chat', requireTelegramAuth, (req, res) => {
  res.json(getClanMessages(req.dbUser.tg_id, Number(req.query.afterId) || 0));
});
app.post('/api/clan/chat', requireTelegramAuth, (req, res) => {
  try { const id = sendClanMessage(req.dbUser.tg_id, req.body.text); res.json({ ok: true, id }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* =========================================================================
 * Clan vs clan war
 * ========================================================================= */
app.get('/api/clanwar/status', requireTelegramAuth, (req, res) => {
  const clan = getMyClan(req.dbUser.tg_id);
  res.json({
    config: getClanWarConfig(),
    myClan: clan,
    myWar: clan ? getMyActiveClanWar(clan.id) : null,
    openWars: clan ? listOpenClanWars(clan.id) : [],
    history: clan ? getClanWarHistory(clan.id) : [],
    members: clan ? getClanMembers(clan.id) : [],
  });
});
app.post('/api/clanwar/create', requireTelegramAuth, (req, res) => {
  try { const id = createClanWar(req.dbUser.tg_id, Number(req.body.entryToman)); res.json({ ok: true, id }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/clanwar/:id/cancel', requireTelegramAuth, (req, res) => {
  try { cancelClanWar(Number(req.params.id), req.dbUser.tg_id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/clanwar/:id/join', requireTelegramAuth, (req, res) => {
  try { res.json({ ok: true, war: joinClanWar(Number(req.params.id), req.dbUser.tg_id) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/clanwar/:id/picks', requireTelegramAuth, (req, res) => {
  try { res.json({ ok: true, war: submitWarPicks(Number(req.params.id), req.dbUser.tg_id, req.body.picks) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/clanwar/:id', requireTelegramAuth, (req, res) => {
  const war = getClanWar(Number(req.params.id));
  if (!war) return res.status(404).json({ error: 'Not found' });
  res.json(war);
});
app.get('/api/clanwar/member-cards/:tgId', requireTelegramAuth, (req, res) => {
  try { res.json(getMemberCardsForLeader(req.dbUser.tg_id, Number(req.params.tgId))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* =========================================================================
 * Ranking, title, daily check-in, avatar
 * ========================================================================= */
app.get('/api/rank/me', requireTelegramAuth, (req, res) => res.json({ ...getUserRankInfo(req.dbUser.tg_id), canCheckin: canCheckinToday(req.dbUser.tg_id) }));
app.get('/api/rank/leaderboard', requireTelegramAuth, (req, res) => {
  const leaderboard = getLevelLeaderboard(10);
  const myRank = getUserLevelRank(req.dbUser.tg_id);
  const myRow = getUserLevelRow(req.dbUser.tg_id);
  res.json({ leaderboard, myRank, myRow });
});
app.get('/api/league/status', requireTelegramAuth, (req, res) => {
  const config = getLeagueConfig();
  const me = getUserLeagueInfo(req.dbUser.tg_id);
  const leaderboard = getLeagueLeaderboard(me.league, 10);
  res.json({ config, me, leaderboard });
});
app.get('/api/league/leaderboard/:league', requireTelegramAuth, (req, res) => {
  res.json(getLeagueLeaderboard(req.params.league, 10));
});

/* ---------- Big wheel (raffle) ---------- */
app.get('/api/raffle/list', requireTelegramAuth, (req, res) => {
  const raffles = listOpenRaffles().map(r => getRaffleStatusForUser(r.id, req.dbUser.tg_id));
  res.json(raffles);
});
app.post('/api/raffle/:id/register', requireTelegramAuth, (req, res) => {
  try { registerForRaffle(req.dbUser.tg_id, Number(req.params.id)); incrementQuestProgress(req.dbUser.tg_id, 'join_raffle', 1); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/raffle/:id/buy-ticket', requireTelegramAuth, (req, res) => {
  try { buyRaffleTicket(req.dbUser.tg_id, Number(req.params.id)); incrementQuestProgress(req.dbUser.tg_id, 'join_raffle', 1); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/rank/checkin', requireTelegramAuth, (req, res) => {
  try {
    const result = doCheckin(req.dbUser.tg_id);
    incrementQuestProgress(req.dbUser.tg_id, 'checkin', 1);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/avatars', (req, res) => res.json(listAvatars(true)));
app.get('/api/avatars/my', requireTelegramAuth, (req, res) => res.json(getMyAvatars(req.dbUser.tg_id)));
app.post('/api/avatars/buy', requireTelegramAuth, (req, res) => {
  try { buyAvatar(req.dbUser.tg_id, Number(req.body.avatarId)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/avatars/equip', requireTelegramAuth, (req, res) => {
  try { equipAvatar(req.dbUser.tg_id, Number(req.body.avatarId)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* =========================================================================
 * Daily quests
 * ========================================================================= */
app.get('/api/quests/today', requireTelegramAuth, (req, res) => res.json(getTodayQuestsForUser(req.dbUser.tg_id)));
app.post('/api/quests/:id/claim', requireTelegramAuth, (req, res) => {
  try { res.json({ ok: true, ...claimQuestReward(req.dbUser.tg_id, Number(req.params.id)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* =========================================================================
 * Gift code
 * ========================================================================= */
app.post('/api/promo/redeem', requireTelegramAuth, (req, res) => {
  try { res.json({ ok: true, ...redeemPromoCode(req.dbUser.tg_id, req.body.code) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* =========================================================================
 * Collection album
 * ========================================================================= */
app.get('/api/albums', requireTelegramAuth, (req, res) => {
  const albums = listAlbums(true).map(a => ({ ...a, ...getAlbumProgress(req.dbUser.tg_id, a.id) }));
  res.json(albums);
});
app.post('/api/albums/:id/claim', requireTelegramAuth, (req, res) => {
  try { res.json({ ok: true, ...claimAlbumReward(req.dbUser.tg_id, Number(req.params.id)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* =========================================================================
 * Gift to a friend
 * ========================================================================= */
app.get('/api/gift/config', requireTelegramAuth, (req, res) => res.json({ ...getGiftConfig(), ...getRemainingCardGifts(req.dbUser.tg_id) }));
app.post('/api/gift/toman', requireTelegramAuth, (req, res) => {
  try {
    const result = giftToman(req.dbUser.tg_id, req.body.receiver, Number(req.body.amount));
    sendMessage(result.receiverTgId, `🎁 ${req.dbUser.first_name || 'A user'} gifted you ${result.receiverGets.toLocaleString()} LNDC!`).catch(() => {});
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/gift/card', requireTelegramAuth, (req, res) => {
  try {
    const result = giftCard(req.dbUser.tg_id, req.body.receiver, Number(req.body.userCardId));
    sendMessage(result.receiverTgId, `🎁 ${req.dbUser.first_name || 'A user'} gifted you the card "${result.cardName}"!`).catch(() => {});
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* =========================================================================
 * Card Marketplace — list a card you own for LNDC, any other player can buy it.
 * Replaces the old direct card-to-card Exchange.
 * ========================================================================= */
app.get('/api/card-market/config', (req, res) => res.json(getCardMarketConfig()));
app.get('/api/card-market/board', requireTelegramAuth, (req, res) => res.json(listCardMarketOffers(req.dbUser.tg_id)));
app.get('/api/card-market/my-listings', requireTelegramAuth, (req, res) => res.json(getMyCardMarketListings(req.dbUser.tg_id)));
app.get('/api/card-market/price-guidance/:userCardId', requireTelegramAuth, (req, res) => {
  try { res.json(getPriceGuidance(req.dbUser.tg_id, Number(req.params.userCardId))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/card-market/list', requireTelegramAuth, (req, res) => {
  try { const id = createCardMarketListing(req.dbUser.tg_id, Number(req.body.userCardId), Number(req.body.priceToman)); res.json({ ok: true, id }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/card-market/listing/:id/cancel', requireTelegramAuth, (req, res) => {
  try { cancelCardMarketListing(req.dbUser.tg_id, Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/card-market/listing/:id/buy', requireTelegramAuth, (req, res) => {
  try { res.json(buyCardMarketListing(req.dbUser.tg_id, Number(req.params.id))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* =========================================================================
 * Card game — buy/upgrade cards, categories, match queue, leaderboard
 * ========================================================================= */
app.get('/api/game/cards', (req, res) => res.json(listGameCards(true).map(c => {
  const startLevel = c.instant_level || 1;
  const rarity = getRarityForLevel(startLevel);
  const power = c.fixed_power != null ? c.fixed_power : computeCardPower(c.base_power, startLevel);
  return { ...c, image_url: getCardImageForLevel(c, startLevel), power, rarity_key: rarity.key, rarity_label: rarity.label, rarity_color: rarity.color };
})));
app.get('/api/game/categories', (req, res) => res.json(listCardCategories(true)));

app.get('/api/game/status', requireTelegramAuth, (req, res) => {
  checkAndAutoResetLeaderboard((tgId, rank, reward) => {
    sendMessage(tgId, `🏆 Congrats! You placed #${rank} on this week's leaderboard and got a ${reward.toLocaleString()} LNDC prize!`).catch(() => {});
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
    const card = getGameCard(Number(req.body.cardId));
    const price = card?.price_toman || 0;
    addClanPurchaseScore(req.dbUser.tg_id, price);
    addSeasonXp(req.dbUser.tg_id, getSeasonConfig().xp_per_purchase);
    addUserXp(req.dbUser.tg_id, Math.floor(price / 1000) * getRankConfig().xp_per_1k_purchase);
    incrementQuestProgress(req.dbUser.tg_id, 'buy_card', 1);
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/game/sacrifice', requireTelegramAuth, (req, res) => {
  try {
    // For compatibility with old clients, we accept both sacrificeUserCardIds (array) and sacrificeUserCardId (single)
    const ids = Array.isArray(req.body.sacrificeUserCardIds)
      ? req.body.sacrificeUserCardIds
      : (req.body.sacrificeUserCardId != null ? [req.body.sacrificeUserCardId] : []);
    const result = sacrificeCards(req.dbUser.tg_id, Number(req.body.targetUserCardId), ids);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/game/mutation-groups', requireTelegramAuth, (req, res) => res.json(getMutationGroups(req.dbUser.tg_id)));
app.post('/api/game/mutate', requireTelegramAuth, (req, res) => {
  try {
    const result = mutateCards(req.dbUser.tg_id, Number(req.body.cardId), Number(req.body.level));
    incrementQuestProgress(req.dbUser.tg_id, 'upgrade_cards', 1);
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
      const winnerTgId = result.won ? req.dbUser.tg_id : result.opponentTgId;
      addClanWinScore(winnerTgId);
      addSeasonXp(winnerTgId, getSeasonConfig().xp_per_win);
      addUserXp(winnerTgId, getRankConfig().xp_per_win);
      incrementQuestProgress(winnerTgId, 'win_battles', 1);
      incrementQuestProgress(req.dbUser.tg_id, 'play_battles', 1);
      incrementQuestProgress(result.opponentTgId, 'play_battles', 1);
      const opponent = getUser(result.opponentTgId);
      sendMessage(result.opponentTgId,
        result.won
          ? `⚔️ You lost! Your opponent ${req.dbUser.first_name || 'A player'} won with power ${result.myPower} against ${result.opponentPower}.`
          : `🏆 You won! Your opponent ${req.dbUser.first_name || 'A player'} you defeated with power ${result.opponentPower} against ${result.myPower}.`
      ).catch(() => {});
    }
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/game/queue-status', requireTelegramAuth, (req, res) => res.json(getQueueStatus(req.dbUser.tg_id)));
app.post('/api/game/queue/cancel', requireTelegramAuth, (req, res) => { cancelQueue(req.dbUser.tg_id); res.json({ ok: true }); });
app.get('/api/game/history', requireTelegramAuth, (req, res) => res.json(getMatchHistory(req.dbUser.tg_id)));
app.get('/api/game/leaderboard', requireTelegramAuth, (req, res) => {
  const leaderboard = getLeaderboard(10);
  const myRank = getMyRank(req.dbUser.tg_id);
  const myRow = getUserLeaderboardRow(req.dbUser.tg_id);
  res.json({ leaderboard, myRank, myRow, prizes: listLeaderboardPrizes() });
});

/* =========================================================================
 * Support — instead of an internal ticket, /api/config → supportUsername is used for a direct deep link
 * ========================================================================= */

/* =========================================================================
 * Telegram webhook
 * ========================================================================= */
app.post('/telegram-webhook', async (req, res) => {
  if (req.headers['x-telegram-bot-api-secret-token'] !== process.env.WEBHOOK_SECRET) return res.sendStatus(401);
  res.sendStatus(200); // we respond to Telegram immediately; any later error is just logged and does not crash the bot

  try {
    await handleTelegramUpdate(req.body);
  } catch (e) {
    console.error('[telegram-webhook]', e);
  }
});

async function handleTelegramUpdate(update) {
  // Stars payment step 1: Telegram asks before taking money from the user "Confirm it?" — we need to respond quickly
  if (update.pre_checkout_query) {
    const payload = update.pre_checkout_query.invoice_payload || '';
    const m = payload.match(/^star_topup_(\d+)$/);
    const sp = m ? getStarPayment(Number(m[1])) : null;
    if (sp && sp.status === 'pending') {
      await answerPreCheckoutQuery(update.pre_checkout_query.id, true);
    } else {
      await answerPreCheckoutQuery(update.pre_checkout_query.id, false, 'This payment request is no longer valid.');
    }
    return;
  }
  // Step 2: payment succeeded — the wallet is topped up right here, right now
  if (update.message?.successful_payment) {
    const sPay = update.message.successful_payment;
    const payload = sPay.invoice_payload || '';
    const m = payload.match(/^star_topup_(\d+)$/);
    if (m) {
      const sp = completeStarPayment(Number(m[1]), sPay.telegram_payment_charge_id);
      if (sp) {
        await sendMessage(sp.tg_id, `⭐ Payment of ${sp.stars_amount} Stars succeeded and ${sp.toman_credited.toLocaleString()} LNDC was added to your wallet.`);
      }
    }
    return;
  }

  if (update.message?.text?.startsWith('/start')) {
    const chatId = update.message.chat.id;
    const refParam = update.message.text.split(' ')[1];
    getOrCreateUser(update.message.from, refParam);
    const { welcomeMessage, joinPromptMessage } = getMessageSettings();

    if (process.env.REQUIRED_CHANNEL) {
      const joined = await isChannelMember(process.env.REQUIRED_CHANNEL, update.message.from.id);
      if (!joined) {
        await sendMessage(chatId, joinPromptMessage, {
          reply_markup: { inline_keyboard: [
            [{ text: '📢 Channel membership', url: `https://t.me/${process.env.REQUIRED_CHANNEL.replace('@', '')}` }],
            [{ text: '✅ I joined, check it', callback_data: 'check_join' }],
          ] },
        });
        return;
      }
    }
    await sendMessage(chatId, welcomeMessage, {
      reply_markup: { inline_keyboard: [[{ text: '🛍 Open shop', web_app: { url: process.env.PUBLIC_URL + '/miniapp' } }]] },
    });
    return;
  }

  if (update.callback_query?.data === 'check_join') {
    answerCallbackQuery(update.callback_query.id).catch(() => {});
    const chatId = update.callback_query.message.chat.id;
    const joined = !process.env.REQUIRED_CHANNEL || await isChannelMember(process.env.REQUIRED_CHANNEL, update.callback_query.from.id);
    if (joined) {
      await sendMessage(chatId, 'Membership confirmed ✅', {
        reply_markup: { inline_keyboard: [[{ text: '🛍 Open shop', web_app: { url: process.env.PUBLIC_URL + '/miniapp' } }]] },
      });
    } else {
      await sendMessage(chatId, '❌ You have not joined the channel yet.');
    }
    return;
  }

  // Admin approve/reject buttons in the Telegram chat (quick shortcut, separate from the web admin panel)
  const cq = update.callback_query;
  if (cq?.data && /^(approve|reject)_(topup|withdraw|cdep|cwd):/.test(cq.data)) {
    answerCallbackQuery(cq.id).catch(() => {});
    if (!isAdminId(cq.from.id)) { answerCallbackQuery(cq.id, 'Only the admin is allowed').catch(() => {}); return; }
    const [action, idStr] = cq.data.split(':');
    const id = Number(idStr);
    const approve = action.startsWith('approve');
    const kind = action.split('_')[1]; // topup | withdraw | cdep | cwd

    if (kind === 'topup') {
      const row = decideTomanTopup(id, approve);
      if (row) {
        await sendMessage(cq.message.chat.id, approve ? `✅ Approved, ${row.amount.toLocaleString()} LNDC added.` : '❌ Rejected.');
        await sendMessage(row.tg_id, approve ? `✅ Your top-up was approved.\n+${row.amount.toLocaleString()} LNDC` : '❌ Your top-up was not approved.');
      }
    } else if (kind === 'withdraw') {
      const row = decideTomanWithdrawal(id, approve);
      if (row) {
        await sendMessage(cq.message.chat.id, approve ? `✅ Withdrawal approved.` : '↩️ Rejected and the amount was refunded.');
        await sendMessage(row.tg_id, approve ? `✅ Withdrawal of ${row.amount.toLocaleString()} LNDC deposited.` : '❌ Your withdrawal was rejected and the amount was refunded.');
      }
    } else if (kind === 'cdep') {
      const row = decideCurrencyRequest(id, approve);
      if (row) {
        await sendMessage(cq.message.chat.id, approve ? `✅ Deposit of ${row.amount} ${row.currency_code} approved.` : '❌ Rejected.');
        await sendMessage(row.tg_id, approve ? `✅ Deposit of ${row.amount} ${row.currency_code} approved.` : `❌ ${row.currency_code} deposit was not approved.`);
      }
    } else if (kind === 'cwd') {
      const row = decideCurrencyRequest(id, approve);
      if (row) {
        await sendMessage(cq.message.chat.id, approve ? `✅ Recorded. Don't forget to manually send ${row.amount} ${row.currency_code} to ${row.address}.` : '↩️ Rejected and the balance was refunded.');
        await sendMessage(row.tg_id, approve ? `✅ Withdrawal of ${row.amount} ${row.currency_code} completed.` : `❌ ${row.currency_code} withdrawal rejected and the amount was refunded.`);
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
      await sendMessage(chatId, `📊 Overall stats\nUsers: ${users}\nOrders: ${orders}`);
    }
    if (cmd === '/addbalance') {
      const [targetId, amount] = args;
      const targetIdNum = Number(targetId);
      const amountNum = Number(amount);
      // We reject invalid input instead of letting NaN get into the user's balance and corrupt their wallet
      if (args.length !== 2 || !Number.isFinite(targetIdNum) || !Number.isFinite(amountNum) || amountNum === 0) {
        await sendMessage(chatId, '⚠️ Correct format: /addbalance numeric_id amount\nExample: /addbalance 123456789 50000');
      } else {
        adjustToman(targetIdNum, amountNum, 'Manual top-up by admin');
        await sendMessage(chatId, `✅ ${amountNum.toLocaleString()} LNDC added to wallet ${targetIdNum}.`);
        await sendMessage(targetIdNum, `💰 ${amountNum.toLocaleString()} LNDC was added to your wallet by support.`);
      }
    }
  }
}

/* =========================================================================
 * Serving the mini app and admin panel
 * ========================================================================= */
// TonConnect needs this manifest reachable at a public HTTPS URL to let wallet apps identify this
// mini app when a user connects their TON wallet. Served dynamically (not a static file) so it always
// reflects the real PUBLIC_URL from the environment, instead of needing manual editing per deployment.
app.get('/tonconnect-manifest.json', (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    url: `${base}/miniapp`,
    name: 'Lando Gifts',
    iconUrl: `${base}/miniapp/icon.png`,
  });
});
app.use('/miniapp', express.static('public'));
app.use('/admin/api', adminApi);
app.use('/admin', express.static('admin'));

// Any /api/* path that does not match a route returns a clean JSON 404 (not Express's default HTML page)
app.use('/api', (req, res) => res.status(404).json({ error: 'This route was not found' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'The submitted data is invalid' });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Image size exceeds the allowed limit (5 MB)' });
  }
  console.error('[unhandled route error]', err);
  res.status(500).json({ error: 'Internal server error' });
});
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException] keeps the server running:', err));

// Periodic check that resets the leaderboard, even when no user has opened the game section
setInterval(() => {
  try {
    checkAndAutoResetLeaderboard((tgId, rank, reward) => {
      sendMessage(tgId, `🏆 Congrats! You placed #${rank} on this week's leaderboard and got a ${reward.toLocaleString()} LNDC prize!`).catch(() => {});
    });
  } catch (e) { console.error('[leaderboard auto-reset]', e); }
}, 60 * 60 * 1000);

// Closes finished auctions every 20 seconds — a short interval since auctions are usually a few minutes long
setInterval(() => {
  try {
    finalizeExpiredAuctions((tgId, auction, kind) => {
      const msg = kind === 'won'
        ? `🎉 You won the auction "${auction.title}" for ${auction.current_price.toLocaleString()} LNDC and it was deducted from your wallet.`
        : `⚠️ You won the auction "${auction.title}" but your wallet balance was not enough. Contact support.`;
      sendMessage(tgId, msg).catch(() => {});
    });
  } catch (e) { console.error('[auction finalize]', e); }
}, 20 * 1000);

// Periodic check that resets the battle pass season and the clan score season
setInterval(() => {
  try { checkAutoResetSeason(); } catch (e) { console.error('[season auto-reset]', e); }
  try {
    checkAutoResetClanSeason((tgId, clan, reward) => {
      sendMessage(tgId, `🏆 Your clan "${clan.name}" was on the top leaderboard and got a ${reward.toLocaleString()} LNDC prize!`).catch(() => {});
    });
  } catch (e) { console.error('[clan auto-reset]', e); }
  try { checkExpiredSeasons(); } catch (e) { console.error('[seasonal cards auto-expire]', e); }
  try { checkAutoResetLeague(); } catch (e) { console.error('[league auto-reset]', e); }
}, 60 * 60 * 1000);

// Register the Telegram webhook; if the domain/tunnel is not up yet (e.g. during boot on
// Termux), instead of just failing once and giving up, it retries every 30 seconds
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
