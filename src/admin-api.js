import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import {
  getStats, listUsers, banUser, unbanUser, getUser, adjustToman, adjustCurrencyBalance,
  listCurrencies, upsertCurrency, deleteCurrency,
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
  getGiveawayChannelSettings, setGiveawayChannelSettings,
  getUiImages, setUiImages, getComebackConfig, setComebackConfig,
  getReferralSettings, setReferralSettings, getLndcWalletSettings, setLndcWalletSettings,
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
  getAuctionConfig, setAuctionConfig, listAllAuctionsAdmin, createAuctionFromProduct, createAuctionFromCard, cancelAuction, listAuctionBids,
} from './auction-db.js';
import {
  getSeasonConfig, setSeasonConfig, getCurrentSeason, startNewSeason, listSeasonTiers, upsertSeasonTier, deleteSeasonTier,
} from './season-db.js';
import { getClanConfig, setClanConfig, getClanLeaderboard, resetClanSeason, adminDeleteClan, adminAdjustClanBank, listAllClansAdmin, getClanChatConfig, setClanChatConfig } from './clan-db.js';
import { getClanWarConfig, setClanWarConfig } from './clan-war-db.js';
import { getLeagueConfig, setLeagueConfig, getLeagueTierConfig, setLeagueTierConfig } from './league-db.js';
import {
  listRafflesAdmin, getRaffle, createRaffle, updateRaffle, deleteRaffle, cancelRaffle, listRaffleEntries, finishRaffle,
} from './raffle-db.js';
import {
  getRankConfig, setRankConfig, listRankTitles, upsertRankTitle, deleteRankTitle,
  listAvatars, upsertAvatar, deleteAvatar, listStreakRewards, setStreakReward, deleteStreakReward,
} from './rank-db.js';
import { getQuestConfig, setQuestConfig, listQuestTemplates, upsertQuestTemplate, deleteQuestTemplate } from './quest-db.js';
import { listChests, getChest, upsertChest, deleteChest, listChestItems, upsertChestItem, deleteChestItem } from './chest-db.js';
import { listPromoCodes, createPromoCode, deletePromoCode, listRedemptions } from './promo-db.js';
import { listAlbums, upsertAlbum, deleteAlbum, getAlbumRequirements } from './album-db.js';
import { getGiftConfig, setGiftConfig } from './gift-db.js';
import { listSeasons, createSeason, deleteSeason, setCardSeason } from './seasonal-db.js';
import { getCardMarketConfig, setCardMarketConfig, listCardMarketOffers } from './card-market-db.js';
import { sendMessage, sendPhoto } from './telegram.js';
import { getBackupConfig, setBackupConfig, listBackups, runBackupNow } from './backup.js';

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

/* ---------- Simple login with a single password + in-memory session token ---------- */
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
  if (!process.env.ADMIN_PANEL_PASSWORD) return res.status(500).json({ error: 'ADMIN_PANEL_PASSWORD Not set' });
  if (req.body.password !== process.env.ADMIN_PANEL_PASSWORD) return res.status(401).json({ error: 'Incorrect password' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + TOKEN_TTL_MS);
  res.json({ token });
});

router.use(requireAdmin);

router.post('/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file was sent' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

/* ---------- Dashboard ---------- */
router.get('/stats', (req, res) => res.json(getStats()));

/* ---------- Users ---------- */
router.get('/users', (req, res) => res.json(listUsers(req.query.q)));
router.post('/users/:tgId/ban', (req, res) => { banUser(Number(req.params.tgId), req.body.reason); res.json({ ok: true }); });
router.post('/users/:tgId/unban', (req, res) => { unbanUser(Number(req.params.tgId)); res.json({ ok: true }); });
router.post('/users/:tgId/adjust-balance', (req, res) => {
  const amount = Number(req.body.amount);
  if (!amount) return res.status(400).json({ error: 'Invalid amount' });
  adjustToman(Number(req.params.tgId), amount, 'Manual balance adjustment by admin');
  sendMessage(Number(req.params.tgId), `💰 Your wallet balance ${amount > 0 ? '+' : ''}${amount.toLocaleString()} LNDC changed by support.`).catch(() => {});
  res.json({ ok: true, user: getUser(Number(req.params.tgId)) });
});
router.post('/users/:tgId/adjust-currency', (req, res) => {
  const amount = Number(req.body.amount);
  const code = (req.body.code || '').toUpperCase();
  if (!amount || !code) return res.status(400).json({ error: 'Currency and amount are required' });
  adjustCurrencyBalance(Number(req.params.tgId), code, amount, 'Manual currency balance adjustment by admin');
  sendMessage(Number(req.params.tgId), `💰 Your ${code} balance ${amount > 0 ? '+' : ''}${amount} changed by support.`).catch(() => {});
  res.json({ ok: true });
});

/* ---------- Currencies (fully manual) ---------- */
router.get('/currencies', (req, res) => res.json(listCurrencies()));
router.post('/currencies', (req, res) => {
  const { code, name, rate_toman, min_deposit, min_withdraw, active, deposit_address } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'Currency code and name are required' });
  upsertCurrency({
    code: code.toUpperCase(), name,
    rate_toman: Number(rate_toman) || 0,
    min_deposit: Number(min_deposit) || 0,
    min_withdraw: Number(min_withdraw) || 0,
    active: !!active,
    deposit_address: deposit_address || null,
  });
  res.json({ ok: true });
});
router.delete('/currencies/:code', (req, res) => {
  try { deleteCurrency(req.params.code); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- Payment settings (deposit card number, manual from the panel) ---------- */
router.get('/payment-settings', (req, res) => res.json(getPaymentSettings()));
router.post('/payment-settings', (req, res) => {
  setPaymentSettings({
    cardNumber: req.body.cardNumber,
    cardOwner: req.body.cardOwner,
  });
  res.json({ ok: true });
});

/* ---------- Design images for the mini app's main sections (hub tiles + section banners) ---------- */
router.get('/ui-images', (req, res) => res.json(getUiImages()));
router.post('/ui-images', (req, res) => { setUiImages(req.body); res.json({ ok: true }); });

/* ---------- Comeback (re-engagement) notifications ---------- */
router.get('/comeback-config', (req, res) => res.json(getComebackConfig()));
router.post('/comeback-config', (req, res) => {
  setComebackConfig({
    enabled: !!req.body.enabled, inactive_days: req.body.inactive_days,
    reward_toman: req.body.reward_toman, message: req.body.message, cooldown_days: req.body.cooldown_days,
  });
  res.json({ ok: true });
});

/* ---------- Database backups ---------- */
router.get('/backup/config', (req, res) => res.json(getBackupConfig()));
router.post('/backup/config', (req, res) => {
  setBackupConfig({ enabled: !!req.body.enabled, intervalHours: req.body.intervalHours, retentionCount: req.body.retentionCount });
  res.json({ ok: true });
});
router.get('/backup/list', (req, res) => res.json(listBackups()));
router.post('/backup/run', async (req, res) => {
  try { const file = await runBackupNow(); res.json({ ok: true, file }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Enable/disable deposit & withdraw for the default currency (Lando Coin) ---------- */
router.get('/lndc-wallet-settings', (req, res) => res.json(getLndcWalletSettings()));
router.post('/lndc-wallet-settings', (req, res) => {
  setLndcWalletSettings({ depositEnabled: !!req.body.depositEnabled, withdrawEnabled: !!req.body.withdrawEnabled });
  res.json({ ok: true });
});

/* ---------- Support ID (instead of internal ticket) ---------- */
router.get('/support-contact', (req, res) => res.json({ username: getSupportContact() }));
router.post('/support-contact', (req, res) => { setSupportContact(req.body.username); res.json({ ok: true }); });

/* ---------- Referral reward (purchase commission percent + flat membership reward) ---------- */
router.get('/referral-settings', (req, res) => res.json(getReferralSettings()));
router.post('/referral-settings', (req, res) => {
  setReferralSettings({
    percent: req.body.percent,
    signupBonusType: req.body.signupBonusType,
    signupBonus: req.body.signupBonus,
    signupBonusCurrency: req.body.signupBonusCurrency,
    signupBonusCardId: req.body.signupBonusCardId,
  });
  res.json({ ok: true });
});

/* ---------- Info pages (guide/FAQ/rules) ---------- */
router.get('/info-pages', (req, res) => res.json({
  guide: getInfoPage('guide'), faq: getInfoPage('faq'), rules: getInfoPage('rules'),
}));
router.post('/info-pages', (req, res) => {
  setInfoPage('guide', req.body.guide);
  setInfoPage('faq', req.body.faq);
  setInfoPage('rules', req.body.rules);
  res.json({ ok: true });
});

/* ---------- Bot messages (welcome / membership request) ---------- */
router.get('/message-settings', (req, res) => res.json(getMessageSettings()));
router.post('/message-settings', (req, res) => {
  setMessageSettings({ welcomeMessage: req.body.welcomeMessage, joinPromptMessage: req.body.joinPromptMessage });
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

  const ids = getAllUserIds();
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
router.get('/toman-topups', (req, res) => res.json(listPendingTomanTopups()));
router.post('/toman-topups/:id/decide', (req, res) => {
  const row = decideTomanTopup(Number(req.params.id), !!req.body.approve);
  if (!row) return res.status(404).json({ error: 'Not found or already processed' });
  const msg = req.body.approve
    ? `✅ Your card-to-card top-up was approved.\n+${row.amount.toLocaleString()} LNDC added to your wallet.`
    : `❌ Unfortunately your card-to-card top-up was not approved. Please contact support.`;
  sendMessage(row.tg_id, msg).catch(() => {});
  res.json({ ok: true });
});

/* ---------- LNDC withdrawal ---------- */
router.get('/toman-withdrawals', (req, res) => res.json(listPendingTomanWithdrawals()));
router.post('/toman-withdrawals/:id/decide', (req, res) => {
  const row = decideTomanWithdrawal(Number(req.params.id), !!req.body.approve);
  if (!row) return res.status(404).json({ error: 'Not found or already processed' });
  const msg = req.body.approve
    ? `✅ Your withdrawal of ${row.amount.toLocaleString()} LNDC was completed and deposited to card ${row.card_number}.`
    : `❌ Your withdrawal was rejected and the amount was refunded to your wallet.`;
  sendMessage(row.tg_id, msg).catch(() => {});
  res.json({ ok: true });
});

/* ---------- Crypto deposit/withdrawal ---------- */
router.get('/currency-requests', (req, res) => res.json(listPendingCurrencyRequests()));
router.post('/currency-requests/:id/decide', (req, res) => {
  const row = decideCurrencyRequest(Number(req.params.id), !!req.body.approve);
  if (!row) return res.status(404).json({ error: 'Not found or already processed' });
  const label = `${row.amount} ${row.currency_code}`;
  let msg;
  if (row.kind === 'deposit') {
    msg = req.body.approve ? `✅ ${label} deposit approved and added to your wallet.` : `❌ ${label} deposit was not approved.`;
  } else {
    msg = req.body.approve ? `✅ ${label} withdrawal completed and sent to the address below:\n${row.address}` : `❌ ${label} withdrawal was rejected and the amount was refunded to your wallet.`;
  }
  sendMessage(row.tg_id, msg).catch(() => {});
  res.json({ ok: true });
});

/* ---------- Categories ---------- */
router.get('/categories', (req, res) => res.json(listCategories()));
router.post('/categories', (req, res) => res.json({ id: addCategory(req.body.title) }));
router.delete('/categories/:id', (req, res) => { deleteCategory(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Products ---------- */
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

/* ---------- Gift market categories ---------- */
router.get('/gift-categories', (req, res) => res.json(listGiftCategories(false)));
router.post('/gift-categories', (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Category name is required' });
  const id = upsertGiftCategory({
    id: req.body.id ? Number(req.body.id) : null,
    name: req.body.name, image_url: req.body.image_url, active: req.body.active !== false,
  });
  res.json({ ok: true, id });
});
router.delete('/gift-categories/:id', (req, res) => { deleteGiftCategory(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Orders ---------- */
router.get('/orders', (req, res) => res.json(listAllOrders()));
router.post('/orders/:id/status', (req, res) => {
  setOrderStatus(Number(req.params.id), req.body.status);
  res.json({ ok: true });
});

/* ---------- Gift market ---------- */
router.get('/gift-offers', (req, res) => res.json(listAllGiftOffersAdmin()));
router.post('/gift-offers/:id/refund', (req, res) => {
  try { adminRefundGiftOffer(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/gift-offers/pending', (req, res) => res.json(listPendingGiftOffers()));
router.post('/gift-offers/:id/approve', (req, res) => {
  try {
    approveGiftOffer(Number(req.params.id));
    const offer = getGiftOffer(Number(req.params.id));
    sendMessage(offer.seller_tg_id, `✅ Gift listing "${offer.title}" was approved and is now visible in the market.`).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/gift-offers/:id/reject', (req, res) => {
  try {
    const offer = getGiftOffer(Number(req.params.id));
    rejectGiftOffer(Number(req.params.id));
    if (offer) sendMessage(offer.seller_tg_id, `❌ Gift listing "${offer.title}" was rejected.${req.body.reason ? ` Reason: ${req.body.reason}` : ''}`).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/gift-offers/:id', (req, res) => {
  try { adminDeleteGiftOffer(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- Tasks ---------- */
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

/* ---------- Support tickets ---------- */
router.get('/tickets', (req, res) => res.json(listAllTicketsAdmin()));
router.get('/tickets/:id/messages', (req, res) => {
  const ticket = getTicket(Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticket, messages: listTicketMessages(ticket.id) });
});
router.post('/tickets/:id/reply', upload.single('image'), (req, res) => {
  const ticket = getTicket(Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
  addTicketMessage(ticket.id, 'admin', req.body.text || '', imageUrl);
  sendMessage(ticket.tg_id, `📩 Support message:\n${req.body.text || ''}`).catch(() => {});
  res.json({ ok: true });
});
router.post('/tickets/:id/close', (req, res) => { closeTicket(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Card categories ---------- */
router.get('/card-categories', (req, res) => res.json(listCardCategories(false)));
router.post('/card-categories', (req, res) => {
  const { id, name, icon, color, description, active } = req.body;
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  const savedId = upsertCardCategory({ id: id ? Number(id) : null, name, icon, color, description, active: active !== false });
  res.json({ ok: true, id: savedId });
});
router.delete('/card-categories/:id', (req, res) => { deleteCardCategory(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Merge/mutation cost per step ---------- */
router.get('/merge-costs', (req, res) => res.json(listMergeCosts()));
router.post('/merge-costs', (req, res) => {
  const { from_level, cost_toman } = req.body;
  if (!from_level) return res.status(400).json({ error: 'Source level is required' });
  upsertMergeCost(Number(from_level), Number(cost_toman) || 0);
  res.json({ ok: true });
});

/* ---------- Card game: cards ---------- */
router.get('/game/cards', (req, res) => res.json(listGameCards(false)));
router.post('/game/cards', (req, res) => {
  const { id, name, image_url, base_power, price_toman, active, category_id, level_images, edition, max_supply, instant_level, fixed_power, market_coefficient } = req.body;
  if (!name) return res.status(400).json({ error: 'Card name is required' });
  if (instant_level) {
    // This card is custom, so it only respects that level's cap (not that it must equal it exactly)
    const range = getCardLevelPowerConfig().find(r => r.level === Number(instant_level));
    const fp = Number(fixed_power);
    if (range && fp > range.max_power) {
      return res.status(400).json({ error: `Power must not exceed ${range.max_power} (the allowed cap for level ${instant_level})` });
    }
  }
  const savedId = upsertGameCard({
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
    market_coefficient: market_coefficient !== undefined && market_coefficient !== '' ? Number(market_coefficient) : 1,
  });
  res.json({ ok: true, id: savedId });
});
router.delete('/game/cards/:id', (req, res) => { deleteGameCard(Number(req.params.id)); res.json({ ok: true }); });
router.post('/game/cards/:id/grant', (req, res) => {
  try { const userCardId = grantCardInstance(Number(req.body.tgId), Number(req.params.id)); res.json({ ok: true, userCardId }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- Min/Max upgradable power per level (1 to 7) ---------- */
router.get('/game/level-power', (req, res) => res.json(getCardLevelPowerConfig()));
router.post('/game/level-power', (req, res) => {
  // max_power is the main name; power is also accepted for client simplicity
  const maxPower = req.body.max_power !== undefined ? req.body.max_power : req.body.power;
  const minPower = req.body.min_power;
  try { setCardLevelPower(Number(req.body.level), maxPower, minPower); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- Card game: settings ---------- */
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

/* ---------- Card game: leaderboard and prizes ---------- */
router.get('/game/leaderboard', (req, res) => res.json({ leaderboard: getLeaderboard(50), state: getLeaderboardState() }));
router.get('/game/leaderboard-prizes', (req, res) => res.json(listLeaderboardPrizes()));
router.post('/game/leaderboard-prizes', (req, res) => {
  const { id, rank_from, rank_to, reward_toman } = req.body;
  if (!rank_from || !rank_to || !reward_toman) return res.status(400).json({ error: 'All fields are required' });
  const savedId = upsertLeaderboardPrize({ id: id ? Number(id) : null, rank_from: Number(rank_from), rank_to: Number(rank_to), reward_toman: Number(reward_toman) });
  res.json({ ok: true, id: savedId });
});
router.delete('/game/leaderboard-prizes/:id', (req, res) => { deleteLeaderboardPrize(Number(req.params.id)); res.json({ ok: true }); });
router.post('/game/leaderboard-reset', (req, res) => {
  try {
    resetLeaderboard((tgId, rank, reward) => {
      sendMessage(tgId, `🏆 Congrats! You placed #${rank} on the leaderboard and got a ${reward.toLocaleString()} LNDC prize!`).catch(() => {});
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- Card tasks ---------- */
router.get('/card-tasks', (req, res) => res.json(listAllCardTasksAdmin()));
router.post('/card-tasks', (req, res) => {
  const { id, title, kind, channel_username, reward_card_id, active } = req.body;
  if (!title || !reward_card_id) return res.status(400).json({ error: 'Title and prize card are required' });
  const savedId = upsertCardTask({
    id: id ? Number(id) : null, title, kind: kind || 'join_channel',
    channel_username, reward_card_id: Number(reward_card_id), active: active !== false,
  });
  res.json({ ok: true, id: savedId });
});
router.delete('/card-tasks/:id', (req, res) => { deleteCardTask(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Flash auction ---------- */
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

/* ---------- Seasonal battle pass ---------- */
router.get('/season/config', (req, res) => res.json(getSeasonConfig()));
router.post('/season/config', (req, res) => {
  const b = req.body;
  setSeasonConfig({
    enabled: !!b.enabled, price_toman: Number(b.price_toman), duration_days: Number(b.duration_days),
    tier_count: Number(b.tier_count), xp_per_tier: Number(b.xp_per_tier),
    xp_per_win: Number(b.xp_per_win), xp_per_purchase: Number(b.xp_per_purchase), xp_per_donation: Number(b.xp_per_donation),
    tier_skip_price_toman: Number(b.tier_skip_price_toman) || 0,
  });
  res.json({ ok: true });
});
router.get('/season/current', (req, res) => res.json(getCurrentSeason()));
router.post('/season/start-new', (req, res) => { startNewSeason(); res.json({ ok: true }); });
router.get('/season/tiers', (req, res) => res.json(listSeasonTiers()));
router.post('/season/tiers', (req, res) => {
  const b = req.body;
  if (!b.tier_number) return res.status(400).json({ error: 'Tier number is required' });
  upsertSeasonTier({
    tier_number: Number(b.tier_number),
    free_reward_type: b.free_reward_type, free_reward_value: b.free_reward_value,
    premium_reward_type: b.premium_reward_type, premium_reward_value: b.premium_reward_value,
  });
  res.json({ ok: true });
});
router.delete('/season/tiers/:n', (req, res) => { deleteSeasonTier(Number(req.params.n)); res.json({ ok: true }); });

/* ---------- Clan system ---------- */
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
router.get('/clan/all', (req, res) => res.json(listAllClansAdmin()));
router.delete('/clan/:id', (req, res) => {
  try { adminDeleteClan(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/clan/:id/adjust-bank', (req, res) => {
  try { adminAdjustClanBank(Number(req.params.id), Number(req.body.amount)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/clan/reset-season', (req, res) => {
  resetClanSeason((tgId, clan, reward) => {
    sendMessage(tgId, `🏆 Your clan "${clan.name}" was on the top leaderboard and got a ${reward.toLocaleString()} LNDC prize!`).catch(() => {});
  });
  res.json({ ok: true });
});

/* ---------- Clan chat ---------- */
router.get('/clan/chat-config', (req, res) => res.json(getClanChatConfig()));
router.post('/clan/chat-config', (req, res) => {
  setClanChatConfig({ enabled: !!req.body.enabled, retention_minutes: req.body.retention_minutes, max_message_length: req.body.max_message_length });
  res.json({ ok: true });
});

/* ---------- Clan vs clan war ---------- */
router.get('/clanwar/config', (req, res) => res.json(getClanWarConfig()));
router.post('/clanwar/config', (req, res) => {
  setClanWarConfig(req.body);
  res.json({ ok: true });
});

/* ---------- Weekly league ---------- */
router.get('/league/config', (req, res) => res.json(getLeagueConfig()));
router.post('/league/config', (req, res) => {
  setLeagueConfig(req.body);
  res.json({ ok: true });
});
router.get('/league/tiers', (req, res) => res.json(getLeagueTierConfig()));
router.post('/league/tiers', (req, res) => {
  try { setLeagueTierConfig(req.body.league, req.body.promote_count, req.body.relegate_count); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- Big wheel (raffle / giveaway) ---------- */
router.get('/raffles', (req, res) => res.json(listRafflesAdmin()));
router.get('/giveaway-channel', (req, res) => res.json(getGiveawayChannelSettings()));
router.post('/giveaway-channel', (req, res) => {
  setGiveawayChannelSettings({ channelId: req.body.channelId, startImage: req.body.startImage, endImage: req.body.endImage });
  res.json({ ok: true });
});
router.post('/raffles', (req, res) => {
  try {
    if (!req.body.title) return res.status(400).json({ error: 'Title is required' });
    const isNew = !req.body.id;
    const id = req.body.id ? (updateRaffle(Number(req.body.id), req.body), Number(req.body.id)) : createRaffle(req.body);
    if (isNew) postGiveawayToChannel(getRaffle(id), 'start').catch(() => {});
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/raffles/:id', (req, res) => { deleteRaffle(Number(req.params.id)); res.json({ ok: true }); });
router.post('/raffles/:id/cancel', (req, res) => { cancelRaffle(Number(req.params.id)); res.json({ ok: true }); });
router.get('/raffles/:id/entries', (req, res) => res.json(listRaffleEntries(Number(req.params.id))));
router.post('/raffles/:id/finish', (req, res) => {
  try {
    const winners = finishRaffle(Number(req.params.id));
    postGiveawayToChannel(getRaffle(Number(req.params.id)), 'end', winners).catch(() => {});
    res.json({ ok: true, winners });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Posts a giveaway's info to the configured channel — the bot must already be an admin there with
// post permission, or this silently fails (caught by the .catch(()=>{}) at each call site above, so
// a channel-posting problem never blocks the actual raffle create/finish action for the admin).
async function postGiveawayToChannel(raffle, phase, winners = []) {
  const { channelId, startImage, endImage } = getGiveawayChannelSettings();
  if (!channelId || !raffle) return;
  let text;
  if (phase === 'start') {
    text = `🎉 <b>New giveaway started!</b>\n\n🏆 <b>${raffle.title}</b>` +
      (raffle.prize_description ? `\n🎁 Prize: ${raffle.prize_description}` : '') +
      `\n👥 Winners: ${raffle.winners_count}` +
      (raffle.ticket_price_toman > 0 ? `\n🎟 Ticket price: ${raffle.ticket_price_toman.toLocaleString('en-US')} LNDC` : '\n🎟 Free entry') +
      `\n\nOpen the mini app to join! 👇`;
    if (startImage) await sendPhoto(channelId, startImage, text);
    else await sendMessage(channelId, text);
  } else {
    const winnerList = winners.length ? winners.map(w => `🆔 <code>${w.tg_id}</code>`).join('\n') : 'No entries were registered.';
    text = `🏁 <b>Giveaway ended!</b>\n\n🏆 <b>${raffle.title}</b>\n\n🎊 Winners:\n${winnerList}`;
    if (endImage) await sendPhoto(channelId, endImage, text);
    else await sendMessage(channelId, text);
  }
}

/* ---------- Shop chests (loot boxes) ---------- */
router.get('/chests', (req, res) => res.json(listChests(false)));
router.post('/chests', (req, res) => {
  try { res.json({ ok: true, id: upsertChest(req.body) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/chests/:id', (req, res) => { deleteChest(Number(req.params.id)); res.json({ ok: true }); });
router.get('/chests/:id/items', (req, res) => res.json(listChestItems(Number(req.params.id))));
router.post('/chest-items', (req, res) => {
  try { res.json({ ok: true, id: upsertChestItem(req.body) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/chest-items/:id', (req, res) => { deleteChestItem(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Ranking, title, avatar ---------- */
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

/* ---------- Check-in streak rewards ---------- */
router.get('/rank/streak-rewards', (req, res) => res.json(listStreakRewards()));
router.post('/rank/streak-rewards', (req, res) => {
  setStreakReward(req.body.streak_days, req.body.reward_toman);
  res.json({ ok: true });
});
router.delete('/rank/streak-rewards/:days', (req, res) => { deleteStreakReward(req.params.days); res.json({ ok: true }); });

router.get('/avatars', (req, res) => res.json(listAvatars(false)));
router.post('/avatars', (req, res) => {
  const { id, name, image_url, price_toman, quantity, source, active } = req.body;
  if (!name) return res.status(400).json({ error: 'Avatar name is required' });
  const savedId = upsertAvatar({ id: id ? Number(id) : null, name, image_url, price_toman: Number(price_toman) || 0, quantity: quantity ? Number(quantity) : null, source, active: active !== false });
  res.json({ ok: true, id: savedId });
});
router.delete('/avatars/:id', (req, res) => { deleteAvatar(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Daily quests ---------- */
router.get('/quests/config', (req, res) => res.json(getQuestConfig()));
router.post('/quests/config', (req, res) => {
  setQuestConfig({ enabled: !!req.body.enabled, quest_count: Number(req.body.quest_count) || 3 });
  res.json({ ok: true });
});
router.get('/quests/templates', (req, res) => res.json(listQuestTemplates(false)));
router.post('/quests/templates', (req, res) => {
  const { id, title, type, target_count, reward_type, reward_value, active } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const savedId = upsertQuestTemplate({ id: id ? Number(id) : null, title, type, target_count: Number(target_count) || 1, reward_type, reward_value, active: active !== false });
  res.json({ ok: true, id: savedId });
});
router.delete('/quests/templates/:id', (req, res) => { deleteQuestTemplate(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Gift code ---------- */
router.get('/promo', (req, res) => res.json(listPromoCodes()));
router.post('/promo', (req, res) => {
  const { code, reward_type, reward_value, max_uses, expires_at, active } = req.body;
  if (!code || !reward_type) return res.status(400).json({ error: 'Code and prize type are required' });
  createPromoCode({ code, reward_type, reward_value, max_uses: max_uses ? Number(max_uses) : null, expires_at, active });
  res.json({ ok: true });
});
router.delete('/promo/:code', (req, res) => { deletePromoCode(req.params.code.toUpperCase()); res.json({ ok: true }); });
router.get('/promo/:code/redemptions', (req, res) => res.json(listRedemptions(req.params.code.toUpperCase())));

/* ---------- Collection album ---------- */
router.get('/albums', (req, res) => res.json(listAlbums(false).map(a => ({ ...a, requirements: getAlbumRequirements(a.id) }))));
router.post('/albums', (req, res) => {
  const { id, name, reward_type, reward_value, is_seasonal, starts_at, ends_at, active, category_ids } = req.body;
  if (!name) return res.status(400).json({ error: 'Album name is required' });
  const savedId = upsertAlbum({ id: id ? Number(id) : null, name, reward_type, reward_value, is_seasonal, starts_at, ends_at, active, category_ids });
  res.json({ ok: true, id: savedId });
});
router.delete('/albums/:id', (req, res) => { deleteAlbum(Number(req.params.id)); res.json({ ok: true }); });

/* ---------- Gift to a friend ---------- */
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

/* ---------- Seasonal cards ---------- */
router.get('/seasons', (req, res) => res.json(listSeasons()));
router.post('/seasons', (req, res) => {
  const { name, theme, starts_at, ends_at, active } = req.body;
  if (!name || !starts_at || !ends_at) return res.status(400).json({ error: 'Name and start/end date are required' });
  const id = createSeason({ name, theme, starts_at, ends_at, active });
  res.json({ ok: true, id });
});
router.delete('/seasons/:id', (req, res) => { deleteSeason(Number(req.params.id)); res.json({ ok: true }); });
router.post('/seasons/assign-card', (req, res) => {
  setCardSeason(Number(req.body.cardId), req.body.seasonId ? Number(req.body.seasonId) : null);
  res.json({ ok: true });
});

/* ---------- Card Marketplace ---------- */
router.get('/card-market/config', (req, res) => res.json(getCardMarketConfig()));
router.post('/card-market/config', (req, res) => {
  setCardMarketConfig({ enabled: !!req.body.enabled, fee_percent: Number(req.body.fee_percent) });
  res.json({ ok: true });
});
router.get('/card-market/listings', (req, res) => res.json(listCardMarketOffers(0)));

export default router;
