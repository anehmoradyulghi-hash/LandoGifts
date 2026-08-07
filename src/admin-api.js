import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import {
  getStats, listUsers, banUser, unbanUser, getUser, adjustToman, adjustCurrencyBalance,
  listCurrencies, upsertCurrency,
  listPendingTomanTopups, decideTomanTopup,
  listPendingTomanWithdrawals, decideTomanWithdrawal,
  listPendingCurrencyRequests, decideCurrencyRequest, getCurrencyRequest,
  listCategories, addCategory, deleteCategory,
  listProducts, upsertProduct, deleteProduct,
  listAllOrders, setOrderStatus,
  listAllGiftOffersAdmin, adminRefundGiftOffer, listPendingGiftOffers, approveGiftOffer, rejectGiftOffer, adminDeleteGiftOffer, getGiftOffer,
  listAllTasksAdmin, upsertTask, deleteTask,
  listAllTicketsAdmin, getTicket, listTicketMessages, addTicketMessage, closeTicket,
  getTomanTopup, getTomanWithdrawal,
  getPaymentSettings, setPaymentSettings, getSupportContact, setSupportContact, getInfoPage, setInfoPage,
  getReferralSettings, setReferralSettings,
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
import { getClanConfig, setClanConfig, getClanLeaderboard, resetClanSeason, adminDeleteClan, adminAdjustClanBank, listAllClansAdmin } from './clan-db.js';
import { getClanWarConfig, setClanWarConfig } from './clan-war-db.js';
import { getLeagueConfig, setLeagueConfig } from './league-db.js';
import {
  listRafflesAdmin, createRaffle, updateRaffle, deleteRaffle, cancelRaffle, listRaffleEntries, finishRaffle,
} from './raffle-db.js';
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

import { redis } from './redis.js';

/* ---------- Simple login with a single password + Redis-backed session token ---------- */
const SESSION_PREFIX = 'admin:session:';
const TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12 hours

async function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const exists = await redis.exists(SESSION_PREFIX + token);
  if (!exists) return res.status(401).json({ error: 'unauthorized' });
  await redis.expire(SESSION_PREFIX + token, TOKEN_TTL_SECONDS); // sliding expiry, same as before
  next();
}

router.post('/login', async (req, res) => {
  if (!process.env.ADMIN_PANEL_PASSWORD) return res.status(500).json({ error: 'ADMIN_PANEL_PASSWORD Not set' });
  if (req.body.password !== process.env.ADMIN_PANEL_PASSWORD) return res.status(401).json({ error: 'Incorrect password' });
  const token = crypto.randomBytes(24).toString('hex');
  await redis.set(SESSION_PREFIX + token, '1', { EX: TOKEN_TTL_SECONDS });
  res.json({ token });
});

router.use(async (req, res, next) => { requireAdmin(req, res, next).catch(next); });

router.post('/upload-image', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file was sent' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

/* ---------- Dashboard ---------- */
router.get('/stats', async (req, res) => res.json(await getStats()));

/* ---------- Users ---------- */
router.get('/users', async (req, res) => res.json(await listUsers(req.query.q)));
router.post('/users/:tgId/ban', async (req, res) => { await banUser(Number(req.params.tgId), req.body.reason); res.json({ ok: true }); });
router.post('/users/:tgId/unban', async (req, res) => { await unbanUser(Number(req.params.tgId)); res.json({ ok: true }); });
router.post('/users/:tgId/adjust-balance', async (req, res) => {
  const amount = Number(req.body.amount);
  if (!amount) return res.status(400).json({ error: 'Invalid amount' });
  await adjustToman(Number(req.params.tgId), amount, 'Manual balance adjustment by admin');
  (await sendMessage(Number(req.params.tgId), `💰 Your wallet balance ${amount > 0 ? '+' : ''}${amount.toLocaleString()} LNDC changed by support.`)).catch(() => {});
  res.json({ ok: true, user: await getUser(Number(req.params.tgId)) });
});
router.post('/users/:tgId/adjust-currency', async (req, res) => {
  const amount = Number(req.body.amount);
  const code = (req.body.code || '').toUpperCase();
  if (!amount || !code) return res.status(400).json({ error: 'Currency and amount are required' });
  await adjustCurrencyBalance(Number(req.params.tgId), code, amount, 'Manual currency balance adjustment by admin');
  (await sendMessage(Number(req.params.tgId), `💰 Your ${code} balance ${amount > 0 ? '+' : ''}${amount} changed by support.`)).catch(() => {});
  res.json({ ok: true });
});

/* ---------- Currencies (fully manual) ---------- */
router.get('/currencies', async (req, res) => res.json(await listCurrencies()));
router.post('/currencies', async (req, res) => {
  const { code, name, rate_toman, min_deposit, min_withdraw, active, deposit_address } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'Currency code and name are required' });
  await upsertCurrency({
    code: code.toUpperCase(), name,
    rate_toman: Number(rate_toman) || 0,
    min_deposit: Number(min_deposit) || 0,
    min_withdraw: Number(min_withdraw) || 0,
    active: !!active,
    deposit_address: deposit_address || null,
  });
  res.json({ ok: true });
});

/* ---------- Payment settings (deposit card number, manual from the panel) ---------- */
router.get('/payment-settings', async (req, res) => res.json(await getPaymentSettings()));
router.post('/payment-settings', async (req, res) => {
  await setPaymentSettings({
    cardNumber: req.body.cardNumber,
    cardOwner: req.body.cardOwner,
    zarinpalMerchantId: req.body.zarinpalMerchantId,
  });
  res.json({ ok: true });
});

/* ---------- Support ID (instead of internal ticket) ---------- */
router.get('/support-contact', async (req, res) => res.json({ username: await getSupportContact() }));
router.post('/support-contact', async (req, res) => { await setSupportContact(req.body.username); res.json({ ok: true }); });

/* ---------- Referral reward (purchase commission percent + flat membership reward) ---------- */
router.get('/referral-settings', async (req, res) => res.json(await getReferralSettings()));
router.post('/referral-settings', async (req, res) => {
  await setReferralSettings({ percent: req.body.percent, signupBonus: req.body.signupBonus });
  res.json({ ok: true });
});

/* ---------- Info pages (guide/FAQ/rules) ---------- */
router.get('/info-pages', async (req, res) => res.json({
  guide: await getInfoPage('guide'), faq: await getInfoPage('faq'), rules: await getInfoPage('rules'),
}));
router.post('/info-pages', async (req, res) => {
  await setInfoPage('guide', req.body.guide);
  await setInfoPage('faq', req.body.faq);
  await setInfoPage('rules', req.body.rules);
  res.json({ ok: true });
});

/* ---------- Bot messages (welcome / membership request) ---------- */
router.get('/message-settings', async (req, res) => res.json(await getMessageSettings()));
router.post('/message-settings', async (req, res) => {
  await setMessageSettings({ welcomeMessage: req.body.welcomeMessage, joinPromptMessage: req.body.joinPromptMessage });
  res.json({ ok: true });
});

/* ---------- Broadcast/individual messaging to users ---------- */
router.post('/broadcast', async (req, res) => {
  const text = String(req.body.message || '').trim();
  if (!text) return res.status(400).json({ error: 'Message text is empty' });

  if (req.body.targetTgId) {
    const result = await sendMessage(Number(req.body.targetTgId), text);
    if (!result.ok) return res.status(400).json({ error: 'Sending failed — the user blocked the bot or the ID is wrong' });
    return res.json({ ok: true, sent: 1 });
  }

  const ids = await getAllUserIds();
  res.json({ ok: true, queued: ids.length }); // we respond immediately; sending to everyone continues in the background and the admin's request does not hang
  (async () => {
    let sent = 0;
    for (const id of ids) {
      const r = await sendMessage(id, text).catch(() => ({ ok: false }));
      if (r.ok) sent++;
    }
    console.log(`[broadcast] ${sent}/${ids.length} Message sent successfully`);
  })();
});

/* ---------- Card-to-card top-up ---------- */
router.get('/toman-topups', async (req, res) => res.json(await listPendingTomanTopups()));
router.post('/toman-topups/:id/decide', async (req, res) => {
  const row = await decideTomanTopup(Number(req.params.id), !!req.body.approve);
  if (!row) return res.status(404).json({ error: 'Not found or already processed' });
  const msg = req.body.approve
    ? `✅ Your card-to-card top-up was approved.\n+${row.amount.toLocaleString()} LNDC added to your wallet.`
    : `❌ Unfortunately your card-to-card top-up was not approved. Please contact support.`;
  (await sendMessage(row.tg_id, msg)).catch(() => {});
  res.json({ ok: true });
});

/* ---------- LNDC withdrawal ---------- */
router.get('/toman-withdrawals', async (req, res) => res.json(await listPendingTomanWithdrawals()));
router.post('/toman-withdrawals/:id/decide', async (req, res) => {
  const row = await decideTomanWithdrawal(Number(req.params.id), !!req.body.approve);
  if (!row) return res.status(404).json({ error: 'Not found or already processed' });
  const msg = req.body.approve
    ? `✅ Your withdrawal of ${row.amount.toLocaleString()} LNDC was completed and deposited to card ${row.card_number}.`
    : `❌ Your withdrawal was rejected and the amount was refunded to your wallet.`;
  (await sendMessage(row.tg_id, msg)).catch(() => {});
  res.json({ ok: true });
});

/* ---------- Crypto deposit/withdrawal ---------- */
router.get('/currency-requests', async (req, res) => res.json(await listPendingCurrencyRequests()));
router.post('/currency-requests/:id/decide', async (req, res) => {
  const row = await decideCurrencyRequest(Number(req.params.id), !!req.body.approve);
  if (!row) return res.status(404).json({ error: 'Not found or already processed' });
  const label = `${row.amount} ${row.currency_code}`;
  let msg;
  if (row.kind === 'deposit') {
    msg = req.body.approve ? `✅ ${label} deposit approved and added to your wallet.` : `❌ ${label} deposit was not approved.`;
  } else {
    msg = req.body.approve ? `✅ ${label} withdrawal completed and sent to the address below:\n${row.address}` : `❌ ${label} withdrawal was rejected and the amount was refunded to your wallet.`;
  }
  (await sendMessage(row.tg_id, msg)).catch(() => {});
  res.json({ ok: true });
});

/* ---------- Categories ---------- */
router.get('/categories', async (req, res) => res.json(await listCategories()));
router.post('/categories', async (req, res) => res.json({ id: await addCategory(req.body.title) }));
router.delete('/categories/:id', async (req, res) => { await deleteCategory(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Products ---------- */
router.get('/products', async (req, res) => res.json(await listProducts(false)));
router.post('/products', async (req, res) => {
  const id = await upsertProduct({
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
router.delete('/products/:id', async (req, res) => { await deleteProduct(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Gift market categories ---------- */
router.get('/gift-categories', async (req, res) => res.json(await listGiftCategories(false)));
router.post('/gift-categories', async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Category name is required' });
  const id = await upsertGiftCategory({
    id: req.body.id ? Number(req.body.id) : null,
    name: req.body.name, image_url: req.body.image_url, active: req.body.active !== false,
  });
  res.json({ ok: true, id });
});
router.delete('/gift-categories/:id', async (req, res) => { await deleteGiftCategory(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Orders ---------- */
router.get('/orders', async (req, res) => res.json(await listAllOrders()));
router.post('/orders/:id/status', async (req, res) => {
  await setOrderStatus(Number(req.params.id), req.body.status);
  res.json({ ok: true });
});

/* ---------- Gift market ---------- */
router.get('/gift-offers', async (req, res) => res.json(await listAllGiftOffersAdmin()));
router.post('/gift-offers/:id/refund', async (req, res) => {
  try { await adminRefundGiftOffer(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/gift-offers/pending', async (req, res) => res.json(await listPendingGiftOffers()));
router.post('/gift-offers/:id/approve', async (req, res) => {
  try {
    await approveGiftOffer(Number(req.params.id));
    const offer = await getGiftOffer(Number(req.params.id));
    (await sendMessage(offer.seller_tg_id, `✅ Gift listing "${offer.title}" was approved and is now visible in the market.`)).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/gift-offers/:id/reject', async (req, res) => {
  try {
    const offer = await getGiftOffer(Number(req.params.id));
    await rejectGiftOffer(Number(req.params.id));
    if (offer) (await sendMessage(offer.seller_tg_id, `❌ Gift listing "${offer.title}" was rejected.${req.body.reason ? ` Reason: ${req.body.reason}` : ''}`)).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/gift-offers/:id', async (req, res) => {
  try { await adminDeleteGiftOffer(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- Tasks ---------- */
router.get('/tasks', async (req, res) => res.json(await listAllTasksAdmin()));
router.post('/tasks', async (req, res) => {
  const id = await upsertTask({
    id: req.body.id ? Number(req.body.id) : null,
    title: req.body.title,
    kind: req.body.kind || 'join_channel',
    channel_username: req.body.channel_username,
    reward_toman: Number(req.body.reward_toman) || 0,
    active: req.body.active !== false,
  });
  res.json({ ok: true, id });
});
router.delete('/tasks/:id', async (req, res) => { await deleteTask(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Support tickets ---------- */
router.get('/tickets', async (req, res) => res.json(await listAllTicketsAdmin()));
router.get('/tickets/:id/messages', async (req, res) => {
  const ticket = await getTicket(Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticket, messages: await listTicketMessages(ticket.id) });
});
router.post('/tickets/:id/reply', upload.single('image'), async (req, res) => {
  const ticket = await getTicket(Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
  await addTicketMessage(ticket.id, 'admin', req.body.text || '', imageUrl);
  (await sendMessage(ticket.tg_id, `📩 Support message:\n${req.body.text || ''}`)).catch(() => {});
  res.json({ ok: true });
});
router.post('/tickets/:id/close', async (req, res) => { await closeTicket(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Card categories ---------- */
router.get('/card-categories', async (req, res) => res.json(await listCardCategories(false)));
router.post('/card-categories', async (req, res) => {
  const { id, name, icon, color, description, active } = req.body;
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  const savedId = await upsertCardCategory({ id: id ? Number(id) : null, name, icon, color, description, active: active !== false });
  res.json({ ok: true, id: savedId });
});
router.delete('/card-categories/:id', async (req, res) => { await deleteCardCategory(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Merge/mutation cost per step ---------- */
router.get('/merge-costs', async (req, res) => res.json(await listMergeCosts()));
router.post('/merge-costs', async (req, res) => {
  const { from_level, cost_toman } = req.body;
  if (!from_level) return res.status(400).json({ error: 'Source level is required' });
  await upsertMergeCost(Number(from_level), Number(cost_toman) || 0);
  res.json({ ok: true });
});

/* ---------- Card game: cards ---------- */
router.get('/game/cards', async (req, res) => res.json(await listGameCards(false)));
router.post('/game/cards', async (req, res) => {
  const { id, name, image_url, base_power, price_toman, active, category_id, level_images, edition, max_supply, instant_level, fixed_power, min_power, max_power } = req.body;
  if (!name) return res.status(400).json({ error: 'Card name is required' });
  if (instant_level) {
    // This card is custom, so it only respects that level's cap (not that it must equal it exactly)
    const range = (await getCardLevelPowerConfig()).find(r => r.level === Number(instant_level));
    const fp = Number(fixed_power);
    if (range && fp > range.max_power) {
      return res.status(400).json({ error: `Power must not exceed ${range.max_power} (the allowed cap for level ${instant_level})` });
    }
  }
  const savedId = await upsertGameCard({
    id: id ? Number(id) : null,
    name, image_url,
    rarity: 'common', // no longer used; the displayed rarity is computed from the card's level
    base_power: Number(base_power) || 10,
    price_toman: Number(price_toman) || 0,
    max_level: 7, // Fixed 7-tier leveling system: Common to Divine — not changeable
    active: active !== false,
    category_id: category_id ? Number(category_id) : null,
    level_images: Array.isArray(level_images) ? level_images : [],
    edition: edition || 'standard',
    max_supply: max_supply ? Number(max_supply) : null,
    instant_level: instant_level ? Number(instant_level) : null,
    fixed_power: fixed_power ? Number(fixed_power) : null,
    min_power: min_power !== undefined && min_power !== '' ? Number(min_power) : null,
    max_power: max_power !== undefined && max_power !== '' ? Number(max_power) : null,
  });
  res.json({ ok: true, id: savedId });
});
router.delete('/game/cards/:id', async (req, res) => { await deleteGameCard(Number(req.params.id)); res.json({ ok: true }); });
router.post('/game/cards/:id/grant', async (req, res) => {
  try { const userCardId = await grantCardInstance(Number(req.body.tgId), Number(req.params.id)); res.json({ ok: true, userCardId }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- Max upgradable power per level (1 to 7) ---------- */
router.get('/game/level-power', async (req, res) => res.json(await getCardLevelPowerConfig()));
router.post('/game/level-power', async (req, res) => {
  // max_power is the main name; power is also accepted for client simplicity
  const maxPower = req.body.max_power !== undefined ? req.body.max_power : req.body.power;
  try { await setCardLevelPower(Number(req.body.level), maxPower); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- Daily wheel of fortune ---------- */
router.get('/wheel/config', async (req, res) => res.json(await getWheelConfig()));
router.post('/wheel/config', async (req, res) => {
  await setWheelConfig({ enabled: !!req.body.enabled, cooldown_hours: req.body.cooldown_hours, require_purchase: !!req.body.require_purchase });
  res.json({ ok: true });
});
router.get('/wheel/slots', async (req, res) => res.json(await listWheelSlots(false)));
router.post('/wheel/slots', async (req, res) => {
  const { id, label, type, amount_toman, card_id, extra_games_count, probability_percent, color, active } = req.body;
  if (!label || !type) return res.status(400).json({ error: 'Title and prize type are required' });
  const savedId = await upsertWheelSlot({
    id: id ? Number(id) : null, label, type,
    amount_toman: Number(amount_toman) || 0,
    card_id: card_id ? Number(card_id) : null,
    extra_games_count: Number(extra_games_count) || 0,
    probability_percent: Number(probability_percent) || 0,
    color, active: active !== false,
  });
  res.json({ ok: true, id: savedId });
});
router.delete('/wheel/slots/:id', async (req, res) => { await deleteWheelSlot(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Card game: settings ---------- */
router.get('/game/config', async (req, res) => res.json(await getGameConfig()));
router.post('/game/config', async (req, res) => {
  const b = req.body;
  await setGameConfig({
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

/* ---------- Card game: leaderboard and prizes ---------- */
router.get('/game/leaderboard', async (req, res) => res.json({ leaderboard: await getLeaderboard(50), state: await getLeaderboardState() }));
router.get('/game/leaderboard-prizes', async (req, res) => res.json(await listLeaderboardPrizes()));
router.post('/game/leaderboard-prizes', async (req, res) => {
  const { id, rank_from, rank_to, reward_toman } = req.body;
  if (!rank_from || !rank_to || !reward_toman) return res.status(400).json({ error: 'All fields are required' });
  const savedId = await upsertLeaderboardPrize({ id: id ? Number(id) : null, rank_from: Number(rank_from), rank_to: Number(rank_to), reward_toman: Number(reward_toman) });
  res.json({ ok: true, id: savedId });
});
router.delete('/game/leaderboard-prizes/:id', async (req, res) => { await deleteLeaderboardPrize(Number(req.params.id)); res.json({ ok: true }); });
router.post('/game/leaderboard-reset', async (req, res) => {
  try {
    await resetLeaderboard((tgId, rank, reward) => {
      sendMessage(tgId, `🏆 Congrats! You placed #${rank} on the leaderboard and got a ${reward.toLocaleString()} LNDC prize!`).catch(() => {});
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- Card tasks ---------- */
router.get('/card-tasks', async (req, res) => res.json(await listAllCardTasksAdmin()));
router.post('/card-tasks', async (req, res) => {
  const { id, title, kind, channel_username, reward_card_id, active } = req.body;
  if (!title || !reward_card_id) return res.status(400).json({ error: 'Title and prize card are required' });
  const savedId = await upsertCardTask({
    id: id ? Number(id) : null, title, kind: kind || 'join_channel',
    channel_username, reward_card_id: Number(reward_card_id), active: active !== false,
  });
  res.json({ ok: true, id: savedId });
});
router.delete('/card-tasks/:id', async (req, res) => { await deleteCardTask(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Flash auction ---------- */
router.get('/auction/config', async (req, res) => res.json(await getAuctionConfig()));
router.post('/auction/config', async (req, res) => {
  const b = req.body;
  await setAuctionConfig({
    enabled: !!b.enabled, discount_percent: Number(b.discount_percent),
    duration_minutes: Number(b.duration_minutes), bid_step: Number(b.bid_step),
    anti_snipe_enabled: !!b.anti_snipe_enabled, min_wallet_balance: Number(b.min_wallet_balance) || 0,
  });
  res.json({ ok: true });
});
router.get('/auction/list', async (req, res) => res.json(await listAllAuctionsAdmin()));
router.get('/auction/:id/bids', async (req, res) => res.json(await listAuctionBids(Number(req.params.id))));
router.post('/auction/create', async (req, res) => {
  try {
    const id = req.body.itemType === 'card'
      ? await createAuctionFromCard(Number(req.body.cardId))
      : await createAuctionFromProduct(Number(req.body.productId));
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/auction/:id/cancel', async (req, res) => { await cancelAuction(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Seasonal battle pass ---------- */
router.get('/season/config', async (req, res) => res.json(await getSeasonConfig()));
router.post('/season/config', async (req, res) => {
  const b = req.body;
  await setSeasonConfig({
    enabled: !!b.enabled, price_toman: Number(b.price_toman), duration_days: Number(b.duration_days),
    tier_count: Number(b.tier_count), xp_per_tier: Number(b.xp_per_tier),
    xp_per_win: Number(b.xp_per_win), xp_per_purchase: Number(b.xp_per_purchase), xp_per_donation: Number(b.xp_per_donation),
    tier_skip_price_toman: Number(b.tier_skip_price_toman) || 0,
  });
  res.json({ ok: true });
});
router.get('/season/current', async (req, res) => res.json(await getCurrentSeason()));
router.post('/season/start-new', async (req, res) => { await startNewSeason(); res.json({ ok: true }); });
router.get('/season/tiers', async (req, res) => res.json(await listSeasonTiers()));
router.post('/season/tiers', async (req, res) => {
  const b = req.body;
  if (!b.tier_number) return res.status(400).json({ error: 'Tier number is required' });
  await upsertSeasonTier({
    tier_number: Number(b.tier_number),
    free_reward_type: b.free_reward_type, free_reward_value: b.free_reward_value,
    premium_reward_type: b.premium_reward_type, premium_reward_value: b.premium_reward_value,
  });
  res.json({ ok: true });
});
router.delete('/season/tiers/:n', async (req, res) => { await deleteSeasonTier(Number(req.params.n)); res.json({ ok: true }); });

/* ---------- Clan system ---------- */
router.get('/clan/config', async (req, res) => res.json(await getClanConfig()));
router.post('/clan/config', async (req, res) => {
  const b = req.body;
  await setClanConfig({
    enabled: !!b.enabled, creation_cost_toman: Number(b.creation_cost_toman), max_members: Number(b.max_members),
    score_per_1k_purchase: Number(b.score_per_1k_purchase), score_per_win: Number(b.score_per_win),
    score_per_1k_donation: Number(b.score_per_1k_donation), reward_toman: Number(b.reward_toman),
    winners_count: Number(b.winners_count) || 1, distribution_method: b.distribution_method || 'equal',
    min_score_threshold: Number(b.min_score_threshold) || 0, reset_days: Number(b.reset_days) || 7,
  });
  res.json({ ok: true });
});
router.get('/clan/leaderboard', async (req, res) => res.json(await getClanLeaderboard(20)));
router.get('/clan/all', async (req, res) => res.json(await listAllClansAdmin()));
router.delete('/clan/:id', async (req, res) => {
  try { await adminDeleteClan(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/clan/:id/adjust-bank', async (req, res) => {
  try { await adminAdjustClanBank(Number(req.params.id), Number(req.body.amount)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/clan/reset-season', async (req, res) => {
  await resetClanSeason((tgId, clan, reward) => {
    sendMessage(tgId, `🏆 Your clan "${clan.name}" was on the top leaderboard and got a ${reward.toLocaleString()} LNDC prize!`).catch(() => {});
  });
  res.json({ ok: true });
});

/* ---------- Clan vs clan war ---------- */
router.get('/clanwar/config', async (req, res) => res.json(await getClanWarConfig()));
router.post('/clanwar/config', async (req, res) => {
  await setClanWarConfig(req.body);
  res.json({ ok: true });
});

/* ---------- Weekly league ---------- */
router.get('/league/config', async (req, res) => res.json(await getLeagueConfig()));
router.post('/league/config', async (req, res) => {
  await setLeagueConfig(req.body);
  res.json({ ok: true });
});

/* ---------- Big wheel (raffle) ---------- */
router.get('/raffles', async (req, res) => res.json(await listRafflesAdmin()));
router.post('/raffles', async (req, res) => {
  try {
    if (!req.body.title) return res.status(400).json({ error: 'Title is required' });
    const id = req.body.id ? (await updateRaffle(Number(req.body.id), req.body), Number(req.body.id)) : await createRaffle(req.body);
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/raffles/:id', async (req, res) => { await deleteRaffle(Number(req.params.id)); res.json({ ok: true }); });
router.post('/raffles/:id/cancel', async (req, res) => { await cancelRaffle(Number(req.params.id)); res.json({ ok: true }); });
router.get('/raffles/:id/entries', async (req, res) => res.json(await listRaffleEntries(Number(req.params.id))));
router.post('/raffles/:id/finish', async (req, res) => {
  try { res.json({ ok: true, winners: await finishRaffle(Number(req.params.id)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- Ranking, title, avatar ---------- */
router.get('/rank/config', async (req, res) => res.json(await getRankConfig()));
router.post('/rank/config', async (req, res) => {
  const b = req.body;
  await setRankConfig({
    enabled: !!b.enabled, xp_per_level: Number(b.xp_per_level), xp_per_1k_purchase: Number(b.xp_per_1k_purchase),
    xp_per_win: Number(b.xp_per_win), xp_per_quest: Number(b.xp_per_quest),
    xp_per_referral: Number(b.xp_per_referral), xp_per_checkin: Number(b.xp_per_checkin),
  });
  res.json({ ok: true });
});
router.get('/rank/titles', async (req, res) => res.json(await listRankTitles()));
router.post('/rank/titles', async (req, res) => {
  await upsertRankTitle({ level_threshold: Number(req.body.level_threshold), title: req.body.title, icon: req.body.icon });
  res.json({ ok: true });
});
router.delete('/rank/titles/:t', async (req, res) => { await deleteRankTitle(Number(req.params.t)); res.json({ ok: true }); });

router.get('/avatars', async (req, res) => res.json(await listAvatars(false)));
router.post('/avatars', async (req, res) => {
  const { id, name, image_url, price_toman, quantity, source, active } = req.body;
  if (!name) return res.status(400).json({ error: 'Avatar name is required' });
  const savedId = await upsertAvatar({ id: id ? Number(id) : null, name, image_url, price_toman: Number(price_toman) || 0, quantity: quantity ? Number(quantity) : null, source, active: active !== false });
  res.json({ ok: true, id: savedId });
});
router.delete('/avatars/:id', async (req, res) => { await deleteAvatar(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Daily quests ---------- */
router.get('/quests/config', async (req, res) => res.json(await getQuestConfig()));
router.post('/quests/config', async (req, res) => {
  await setQuestConfig({ enabled: !!req.body.enabled, quest_count: Number(req.body.quest_count) || 3 });
  res.json({ ok: true });
});
router.get('/quests/templates', async (req, res) => res.json(await listQuestTemplates(false)));
router.post('/quests/templates', async (req, res) => {
  const { id, title, type, target_count, reward_type, reward_value, active } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const savedId = await upsertQuestTemplate({ id: id ? Number(id) : null, title, type, target_count: Number(target_count) || 1, reward_type, reward_value, active: active !== false });
  res.json({ ok: true, id: savedId });
});
router.delete('/quests/templates/:id', async (req, res) => { await deleteQuestTemplate(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Gift code ---------- */
router.get('/promo', async (req, res) => res.json(await listPromoCodes()));
router.post('/promo', async (req, res) => {
  const { code, reward_type, reward_value, max_uses, expires_at, active } = req.body;
  if (!code || !reward_type) return res.status(400).json({ error: 'Code and prize type are required' });
  await createPromoCode({ code, reward_type, reward_value, max_uses: max_uses ? Number(max_uses) : null, expires_at, active });
  res.json({ ok: true });
});
router.delete('/promo/:code', async (req, res) => { await deletePromoCode(req.params.code.toUpperCase()); res.json({ ok: true }); });
router.get('/promo/:code/redemptions', async (req, res) => res.json(await listRedemptions(req.params.code.toUpperCase())));

/* ---------- Collection album ---------- */
router.get('/albums', async (req, res) => {
  const albums = await listAlbums(false);
  const withReqs = await Promise.all(albums.map(async a => ({ ...a, requirements: await getAlbumRequirements(a.id) })));
  res.json(withReqs);
});
router.post('/albums', async (req, res) => {
  const { id, name, reward_type, reward_value, is_seasonal, starts_at, ends_at, active, category_ids } = req.body;
  if (!name) return res.status(400).json({ error: 'Album name is required' });
  const savedId = await upsertAlbum({ id: id ? Number(id) : null, name, reward_type, reward_value, is_seasonal, starts_at, ends_at, active, category_ids });
  res.json({ ok: true, id: savedId });
});
router.delete('/albums/:id', async (req, res) => { await deleteAlbum(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Gift to a friend ---------- */
router.get('/gift/config', async (req, res) => res.json(await getGiftConfig()));
router.post('/gift/config', async (req, res) => {
  const b = req.body;
  await setGiftConfig({
    enabled: !!b.enabled, card_gift_min_referrals: Number(b.card_gift_min_referrals),
    card_gift_max_per_month: Number(b.card_gift_max_per_month), card_gift_max_level: Number(b.card_gift_max_level),
    toman_gift_fee_percent: Number(b.toman_gift_fee_percent),
  });
  res.json({ ok: true });
});

/* ---------- Seasonal cards ---------- */
router.get('/seasons', async (req, res) => res.json(await listSeasons()));
router.post('/seasons', async (req, res) => {
  const { name, theme, starts_at, ends_at, active } = req.body;
  if (!name || !starts_at || !ends_at) return res.status(400).json({ error: 'Name and start/end date are required' });
  const id = await createSeason({ name, theme, starts_at, ends_at, active });
  res.json({ ok: true, id });
});
router.delete('/seasons/:id', async (req, res) => { await deleteSeason(Number(req.params.id)); res.json({ ok: true }); });
router.post('/seasons/assign-card', async (req, res) => {
  await setCardSeason(Number(req.body.cardId), req.body.seasonId ? Number(req.body.seasonId) : null);
  res.json({ ok: true });
});

/* ---------- Card trade ---------- */
router.get('/trade/config', async (req, res) => res.json(await getTradeConfig()));
router.post('/trade/config', async (req, res) => {
  const b = req.body;
  await setTradeConfig({
    enabled: !!b.enabled, max_tradable_level: Number(b.max_tradable_level),
    max_trades_per_month: Number(b.max_trades_per_month), min_user_level: Number(b.min_user_level),
    trade_fee_toman: Number(b.trade_fee_toman),
  });
  res.json({ ok: true });
});

export default router;
