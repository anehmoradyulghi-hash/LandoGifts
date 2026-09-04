import db from './db.js';
import { adjustToman, getUser, createOrder } from './db.js';
import { grantAvatar } from './rank-db.js';
import { grantCardInstance, rollWeightedCardLevel, normalizeCardLevelWeights } from './game-db.js';
import { drawFromGiftPackForReward } from './giftpack-db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS season_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  price_toman INTEGER NOT NULL DEFAULT 50000,
  duration_days INTEGER NOT NULL DEFAULT 30,
  tier_count INTEGER NOT NULL DEFAULT 30,
  xp_per_tier INTEGER NOT NULL DEFAULT 100,
  xp_per_win INTEGER NOT NULL DEFAULT 20,
  xp_per_purchase INTEGER NOT NULL DEFAULT 10,
  xp_per_donation INTEGER NOT NULL DEFAULT 15,
  tier_skip_price_toman INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO season_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS current_season (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ends_at TEXT
);
INSERT OR IGNORE INTO current_season (id) VALUES (1);

CREATE TABLE IF NOT EXISTS season_tiers (
  tier_number INTEGER PRIMARY KEY,
  free_reward_type TEXT,      -- toman | card | extra_games | avatar | product | gift_pack | none
  free_reward_value TEXT,
  premium_reward_type TEXT,
  premium_reward_value TEXT
);

CREATE TABLE IF NOT EXISTS user_season (
  tg_id INTEGER PRIMARY KEY,
  xp INTEGER NOT NULL DEFAULT 0,
  purchased_premium INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS season_tier_claims (
  tg_id INTEGER NOT NULL,
  tier_number INTEGER NOT NULL,
  track TEXT NOT NULL, -- free | premium
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tg_id, tier_number, track)
);
`);

function safeAddColumn(table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
safeAddColumn('season_config', 'tier_skip_price_toman INTEGER NOT NULL DEFAULT 0');
// Per-level odds for a leveled-card tier reward (same mechanism as chests — see game-db.js's
// rollWeightedCardLevel/normalizeCardLevelWeights) — JSON [{level, weight}, ...], nullable.
safeAddColumn('season_tiers', 'free_reward_level_weights TEXT');
safeAddColumn('season_tiers', 'premium_reward_level_weights TEXT');
export function getSeasonConfig() { return db.prepare('SELECT * FROM season_config WHERE id = 1').get(); }
export function setSeasonConfig(c) {
  db.prepare(`
    UPDATE season_config SET enabled=?, price_toman=?, duration_days=?, tier_count=?, xp_per_tier=?, xp_per_win=?, xp_per_purchase=?, xp_per_donation=?, tier_skip_price_toman=?
    WHERE id = 1
  `).run(c.enabled ? 1 : 0, c.price_toman, c.duration_days, c.tier_count, c.xp_per_tier, c.xp_per_win, c.xp_per_purchase, c.xp_per_donation, c.tier_skip_price_toman || 0);
}

export function getCurrentSeason() { return db.prepare('SELECT * FROM current_season WHERE id = 1').get(); }

// Starting a new season: everyone's score and claims are wiped, new start/end dates are recorded
export function startNewSeason() {
  const cfg = getSeasonConfig();
  const endsAt = new Date(Date.now() + cfg.duration_days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const tx = db.transaction(() => {
    db.prepare(`UPDATE current_season SET started_at = datetime('now'), ends_at = ? WHERE id = 1`).run(endsAt);
    db.prepare('DELETE FROM user_season').run();
    db.prepare('DELETE FROM season_tier_claims').run();
  });
  tx();
}
export function checkAutoResetSeason() {
  const cfg = getSeasonConfig();
  if (!cfg.enabled) return;
  const season = getCurrentSeason();
  if (!season.ends_at) { startNewSeason(); return; }
  if (new Date(season.ends_at.replace(' ', 'T') + 'Z').getTime() <= Date.now()) startNewSeason();
}

function enrichReward(type, value) {
  if (!value) return { image: null, name: null };
  if (type === 'card') { const r = db.prepare('SELECT name, image_url FROM game_cards WHERE id = ?').get(value); return { image: r?.image_url || null, name: r?.name || null }; }
  if (type === 'avatar') { const r = db.prepare('SELECT name, image_url FROM avatars WHERE id = ?').get(value); return { image: r?.image_url || null, name: r?.name || null }; }
  if (type === 'product') { const r = db.prepare('SELECT title AS name, image_url FROM products WHERE id = ?').get(value); return { image: r?.image_url || null, name: r?.name || null }; }
  if (type === 'gift_pack') { const r = db.prepare('SELECT title AS name, image_url FROM gift_packs WHERE id = ?').get(value); return { image: r?.image_url || null, name: r?.name || null }; }
  return { image: null, name: null };
}
export function listSeasonTiers() {
  return db.prepare('SELECT * FROM season_tiers ORDER BY tier_number ASC').all().map(t => {
    const free = enrichReward(t.free_reward_type, t.free_reward_value);
    const premium = enrichReward(t.premium_reward_type, t.premium_reward_value);
    return { ...t, free_reward_image: free.image, free_reward_name: free.name, premium_reward_image: premium.image, premium_reward_name: premium.name };
  });
}
export function getSeasonTier(n) { return db.prepare('SELECT * FROM season_tiers WHERE tier_number = ?').get(n); }
export function upsertSeasonTier(t) {
  // Per-level odds only make sense (and are only stored) for a card-type reward on that track.
  const freeLevelWeights = t.free_reward_type === 'card' ? normalizeCardLevelWeights(t.free_reward_level_weights, t.free_reward_value) : null;
  const premiumLevelWeights = t.premium_reward_type === 'card' ? normalizeCardLevelWeights(t.premium_reward_level_weights, t.premium_reward_value) : null;
  db.prepare(`
    INSERT INTO season_tiers (tier_number, free_reward_type, free_reward_value, premium_reward_type, premium_reward_value, free_reward_level_weights, premium_reward_level_weights)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(tier_number) DO UPDATE SET
      free_reward_type=excluded.free_reward_type, free_reward_value=excluded.free_reward_value,
      premium_reward_type=excluded.premium_reward_type, premium_reward_value=excluded.premium_reward_value,
      free_reward_level_weights=excluded.free_reward_level_weights, premium_reward_level_weights=excluded.premium_reward_level_weights
  `).run(t.tier_number, t.free_reward_type || 'none', t.free_reward_value || '', t.premium_reward_type || 'none', t.premium_reward_value || '', freeLevelWeights, premiumLevelWeights);
}
export function deleteSeasonTier(n) { db.prepare('DELETE FROM season_tiers WHERE tier_number = ?').run(n); }

function getOrCreateUserSeason(tgId) {
  db.prepare('INSERT OR IGNORE INTO user_season (tg_id) VALUES (?)').run(tgId);
  return db.prepare('SELECT * FROM user_season WHERE tg_id = ?').get(tgId);
}
export function addSeasonXp(tgId, amount) {
  const cfg = getSeasonConfig();
  if (!cfg.enabled || !amount) return;
  getOrCreateUserSeason(tgId);
  db.prepare('UPDATE user_season SET xp = xp + ? WHERE tg_id = ?').run(amount, tgId);
}

export function getUserSeasonProgress(tgId) {
  const cfg = getSeasonConfig();
  const us = getOrCreateUserSeason(tgId);
  const currentTier = Math.min(cfg.tier_count, Math.floor(us.xp / cfg.xp_per_tier) + 1);
  const claims = db.prepare('SELECT tier_number, track FROM season_tier_claims WHERE tg_id = ?').all(tgId);
  return { xp: us.xp, purchasedPremium: !!us.purchased_premium, currentTier, xpPerTier: cfg.xp_per_tier, tierCount: cfg.tier_count, claims };
}

export function purchasePremiumPass(tgId) {
  const cfg = getSeasonConfig();
  if (!cfg.enabled) throw new Error('The season is not active right now');
  const us = getOrCreateUserSeason(tgId);
  if (us.purchased_premium) throw new Error('You have already bought the Premium pass');
  const user = getUser(tgId);
  if (!user || user.balance_toman < cfg.price_toman) throw new Error('Insufficient balance');
  adjustToman(tgId, -cfg.price_toman, 'Buy seasonal Premium battle pass');
  db.prepare('UPDATE user_season SET purchased_premium = 1 WHERE tg_id = ?').run(tgId);
}

// Buying unfilled (skip) tiers with LNDC — the user can jump straight to a later tier without playing
export function buySeasonTiers(tgId, targetTier) {
  const cfg = getSeasonConfig();
  if (!cfg.enabled) throw new Error('The season is not active right now');
  if (!cfg.tier_skip_price_toman) throw new Error('Tier purchase has not been enabled by the admin');
  const progress = getUserSeasonProgress(tgId);
  const target = Math.min(cfg.tier_count, Math.max(1, Number(targetTier)));
  if (target <= progress.currentTier) throw new Error('you have already reached this tier');
  const tiersToSkip = target - progress.currentTier;
  const cost = tiersToSkip * cfg.tier_skip_price_toman;
  const user = getUser(tgId);
  if (!user || user.balance_toman < cost) throw new Error('Insufficient balance');
  const neededXp = (target - 1) * cfg.xp_per_tier;
  const tx = db.transaction(() => {
    adjustToman(tgId, -cost, `Buy ${tiersToSkip} battle pass tier(s)`);
    db.prepare('UPDATE user_season SET xp = MAX(xp, ?) WHERE tg_id = ?').run(neededXp, tgId);
  });
  tx();
  return { cost, newTier: target };
}

// Claiming a tier's reward (free or Premium)
export function claimSeasonTierReward(tgId, tierNumber, track) {
  const progress = getUserSeasonProgress(tgId);
  if (tierNumber > progress.currentTier) throw new Error('You have not reached this tier yet');
  if (track === 'premium' && !progress.purchasedPremium) throw new Error('This reward is only for Premium pass holders');
  const already = db.prepare('SELECT 1 FROM season_tier_claims WHERE tg_id=? AND tier_number=? AND track=?').get(tgId, tierNumber, track);
  if (already) throw new Error('You have already claimed this reward');

  const tier = getSeasonTier(tierNumber);
  if (!tier) throw new Error('This tier is not defined');
  const type = track === 'free' ? tier.free_reward_type : tier.premium_reward_type;
  const value = track === 'free' ? tier.free_reward_value : tier.premium_reward_value;
  const levelWeights = track === 'free' ? tier.free_reward_level_weights : tier.premium_reward_level_weights;

  let giftPackWin = null;
  const tx = db.transaction(() => {
    if (type === 'toman' && Number(value) > 0) {
      adjustToman(tgId, Number(value), `Battle pass tier ${tierNumber} reward (${track === 'free' ? 'Free' : 'Premium'})`);
    } else if (type === 'card' && value) {
      grantCardInstance(tgId, Number(value), rollWeightedCardLevel(levelWeights));
    } else if (type === 'extra_games' && Number(value) > 0) {
      db.prepare(`
        INSERT INTO game_extra_plays (tg_id, extra_plays) VALUES (?, ?)
        ON CONFLICT(tg_id) DO UPDATE SET extra_plays = extra_plays + excluded.extra_plays
      `).run(tgId, Number(value));
    } else if (type === 'avatar' && value) {
      grantAvatar(tgId, Number(value));
    } else if (type === 'product' && value) {
      createOrder(tgId, Number(value), 1, 0, `Battle pass tier ${tierNumber} reward (${track === 'free' ? 'Free' : 'Premium'})`);
    } else if (type === 'gift_pack' && value) {
      // A real NFT gift can't be granted programmatically — this queues a pending delivery the same
      // way opening a gift pack from the shop does (see giftpack-db.js).
      giftPackWin = drawFromGiftPackForReward(tgId, Number(value), `Battle pass tier ${tierNumber} reward (${track === 'free' ? 'Free' : 'Premium'})`);
    }
    db.prepare('INSERT INTO season_tier_claims (tg_id, tier_number, track) VALUES (?,?,?)').run(tgId, tierNumber, track);
  });
  tx();
  return { type, value, giftPackWin };
}
