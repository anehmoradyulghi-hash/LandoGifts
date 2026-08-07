import db from './db.js';
import { adjustToman, getUser, createOrder } from './db.js';
import { grantAvatar } from './rank-db.js';
import { grantCardInstance } from './game-db.js';

export async function getSeasonConfig() { return await db.prepare('SELECT * FROM season_config WHERE id = 1').get(); }
export async function setSeasonConfig(c) {
  await db.prepare(`
    UPDATE season_config SET enabled=?, price_toman=?, duration_days=?, tier_count=?, xp_per_tier=?, xp_per_win=?, xp_per_purchase=?, xp_per_donation=?, tier_skip_price_toman=?
    WHERE id = 1
  `).run(c.enabled ? 1 : 0, c.price_toman, c.duration_days, c.tier_count, c.xp_per_tier, c.xp_per_win, c.xp_per_purchase, c.xp_per_donation, c.tier_skip_price_toman || 0);
}

export async function getCurrentSeason() { return await db.prepare('SELECT * FROM current_season WHERE id = 1').get(); }

// Starting a new season: everyone's score and claims are wiped, new start/end dates are recorded
export async function startNewSeason() {
  const cfg = await getSeasonConfig();
  const endsAt = new Date(Date.now() + cfg.duration_days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const tx = db.transaction(async () => {
    await db.prepare(`UPDATE current_season SET started_at = now_text(), ends_at = ? WHERE id = 1`).run(endsAt);
    await db.prepare('DELETE FROM user_season').run();
    await db.prepare('DELETE FROM season_tier_claims').run();
  });
  await tx();
}
export async function checkAutoResetSeason() {
  const cfg = await getSeasonConfig();
  if (!cfg.enabled) return;
  const season = await getCurrentSeason();
  if (!season.ends_at) { await startNewSeason(); return; }
  if (new Date(season.ends_at.replace(' ', 'T') + 'Z').getTime() <= Date.now()) await startNewSeason();
}

async function enrichReward(type, value) {
  if (!value) return { image: null, name: null };
  if (type === 'card') { const r = await db.prepare('SELECT name, image_url FROM game_cards WHERE id = ?').get(value); return { image: r?.image_url || null, name: r?.name || null }; }
  if (type === 'avatar') { const r = await db.prepare('SELECT name, image_url FROM avatars WHERE id = ?').get(value); return { image: r?.image_url || null, name: r?.name || null }; }
  if (type === 'product') { const r = await db.prepare('SELECT title AS name, image_url FROM products WHERE id = ?').get(value); return { image: r?.image_url || null, name: r?.name || null }; }
  return { image: null, name: null };
}
export async function listSeasonTiers() {
  const rows = await db.prepare('SELECT * FROM season_tiers ORDER BY tier_number ASC').all();
  return Promise.all(rows.map(async t => {
    const free = await enrichReward(t.free_reward_type, t.free_reward_value);
    const premium = await enrichReward(t.premium_reward_type, t.premium_reward_value);
    return { ...t, free_reward_image: free.image, free_reward_name: free.name, premium_reward_image: premium.image, premium_reward_name: premium.name };
  }));
}
export async function getSeasonTier(n) { return await db.prepare('SELECT * FROM season_tiers WHERE tier_number = ?').get(n); }
export async function upsertSeasonTier(t) {
  await db.prepare(`
    INSERT INTO season_tiers (tier_number, free_reward_type, free_reward_value, premium_reward_type, premium_reward_value)
    VALUES (?,?,?,?,?)
    ON CONFLICT(tier_number) DO UPDATE SET
      free_reward_type=excluded.free_reward_type, free_reward_value=excluded.free_reward_value,
      premium_reward_type=excluded.premium_reward_type, premium_reward_value=excluded.premium_reward_value
  `).run(t.tier_number, t.free_reward_type || 'none', t.free_reward_value || '', t.premium_reward_type || 'none', t.premium_reward_value || '');
}
export async function deleteSeasonTier(n) { await db.prepare('DELETE FROM season_tiers WHERE tier_number = ?').run(n); }

async function getOrCreateUserSeason(tgId) {
  await db.prepare('INSERT INTO user_season (tg_id) VALUES (?) ON CONFLICT (tg_id) DO NOTHING').run(tgId);
  return await db.prepare('SELECT * FROM user_season WHERE tg_id = ?').get(tgId);
}
export async function addSeasonXp(tgId, amount) {
  const cfg = await getSeasonConfig();
  if (!cfg.enabled || !amount) return;
  await getOrCreateUserSeason(tgId);
  await db.prepare('UPDATE user_season SET xp = xp + ? WHERE tg_id = ?').run(amount, tgId);
}

export async function getUserSeasonProgress(tgId) {
  const cfg = await getSeasonConfig();
  const us = await getOrCreateUserSeason(tgId);
  const currentTier = Math.min(cfg.tier_count, Math.floor(us.xp / cfg.xp_per_tier) + 1);
  const claims = await db.prepare('SELECT tier_number, track FROM season_tier_claims WHERE tg_id = ?').all(tgId);
  return { xp: us.xp, purchasedPremium: !!us.purchased_premium, currentTier, xpPerTier: cfg.xp_per_tier, tierCount: cfg.tier_count, claims };
}

export async function purchasePremiumPass(tgId) {
  const cfg = await getSeasonConfig();
  if (!cfg.enabled) throw new Error('The season is not active right now');
  const us = await getOrCreateUserSeason(tgId);
  if (us.purchased_premium) throw new Error('You have already bought the Premium pass');
  const user = await getUser(tgId);
  if (!user || user.balance_toman < cfg.price_toman) throw new Error('Insufficient balance');
  await adjustToman(tgId, -cfg.price_toman, 'Buy seasonal Premium battle pass');
  await db.prepare('UPDATE user_season SET purchased_premium = 1 WHERE tg_id = ?').run(tgId);
}

// Buying unfilled (skip) tiers with LNDC — the user can jump straight to a later tier without playing
export async function buySeasonTiers(tgId, targetTier) {
  const cfg = await getSeasonConfig();
  if (!cfg.enabled) throw new Error('The season is not active right now');
  if (!cfg.tier_skip_price_toman) throw new Error('Tier purchase has not been enabled by the admin');
  const progress = await getUserSeasonProgress(tgId);
  const target = Math.min(cfg.tier_count, Math.max(1, Number(targetTier)));
  if (target <= progress.currentTier) throw new Error('you have already reached this tier');
  const tiersToSkip = target - progress.currentTier;
  const cost = tiersToSkip * cfg.tier_skip_price_toman;
  const user = await getUser(tgId);
  if (!user || user.balance_toman < cost) throw new Error('Insufficient balance');
  const neededXp = (target - 1) * cfg.xp_per_tier;
  const tx = db.transaction(async () => {
    await adjustToman(tgId, -cost, `Buy ${tiersToSkip} battle pass tier(s)`);
    await db.prepare('UPDATE user_season SET xp = MAX(xp, ?) WHERE tg_id = ?').run(neededXp, tgId);
  });
  await tx();
  return { cost, newTier: target };
}

// Claiming a tier's reward (free or Premium)
export async function claimSeasonTierReward(tgId, tierNumber, track) {
  const progress = await getUserSeasonProgress(tgId);
  if (tierNumber > progress.currentTier) throw new Error('You have not reached this tier yet');
  if (track === 'premium' && !progress.purchasedPremium) throw new Error('This reward is only for Premium pass holders');
  const already = await db.prepare('SELECT 1 FROM season_tier_claims WHERE tg_id=? AND tier_number=? AND track=?').get(tgId, tierNumber, track);
  if (already) throw new Error('You have already claimed this reward');

  const tier = await getSeasonTier(tierNumber);
  if (!tier) throw new Error('This tier is not defined');
  const type = track === 'free' ? tier.free_reward_type : tier.premium_reward_type;
  const value = track === 'free' ? tier.free_reward_value : tier.premium_reward_value;

  const tx = db.transaction(async () => {
    if (type === 'toman' && Number(value) > 0) {
      await adjustToman(tgId, Number(value), `Battle pass tier ${tierNumber} reward (${track === 'free' ? 'Free' : 'Premium'})`);
    } else if (type === 'card' && value) {
      await grantCardInstance(tgId, Number(value));
    } else if (type === 'extra_games' && Number(value) > 0) {
      await db.prepare(`
        INSERT INTO game_extra_plays (tg_id, extra_plays) VALUES (?, ?)
        ON CONFLICT(tg_id) DO UPDATE SET extra_plays = extra_plays + excluded.extra_plays
      `).run(tgId, Number(value));
    } else if (type === 'avatar' && value) {
      await grantAvatar(tgId, Number(value));
    } else if (type === 'product' && value) {
      await createOrder(tgId, Number(value), 1, 0, `Battle pass tier ${tierNumber} reward (${track === 'free' ? 'Free' : 'Premium'})`);
    }
    await db.prepare('INSERT INTO season_tier_claims (tg_id, tier_number, track) VALUES (?,?,?)').run(tgId, tierNumber, track);
  });
  await tx();
  return { type, value };
}
