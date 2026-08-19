import db, { round2 } from './db.js';
import { adjustToman, getUser } from './db.js';
import { getUserCard, getPlaysRemaining, consumePlay } from './game-db.js';
import { isCardListedForSale } from './card-market-db.js';
import { checkAchievements, logPlayerActivity } from './achievements-db.js';

/* =========================================================================
 * Tower War — a separate PvP mode from the queue-based card battle, built on
 * the exact same card power (base power + level + upgrades, via game-db.js's
 * getUserCard) so leveling/upgrading cards pays off here too. Every player
 * has one tower with a defense deck (used automatically whenever someone
 * attacks them) and can pick an attack deck to raid another player's tower
 * for a cut of their LNDC. Trophies place players into league tiers, each
 * with its own leaderboard "map" capped to a configurable size. Daily
 * attacks draw from the SAME plays pool as the card battle queue (see
 * getPlaysRemaining/consumePlay in game-db.js) — "games left today" means
 * the same thing everywhere, whichever mode used them.
 * ========================================================================= */
db.exec(`
CREATE TABLE IF NOT EXISTS war_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  deck_size INTEGER NOT NULL DEFAULT 4,
  plunder_percent INTEGER NOT NULL DEFAULT 10,
  shield_hours INTEGER NOT NULL DEFAULT 8,
  starting_trophies INTEGER NOT NULL DEFAULT 1000,
  trophy_win_attacker INTEGER NOT NULL DEFAULT 30,
  trophy_lose_attacker INTEGER NOT NULL DEFAULT 15,
  trophy_lose_defender INTEGER NOT NULL DEFAULT 30,
  trophy_win_defender INTEGER NOT NULL DEFAULT 10,
  upgrade_base_cost_toman INTEGER NOT NULL DEFAULT 5000,
  upgrade_power_percent INTEGER NOT NULL DEFAULT 5,
  max_tower_level INTEGER NOT NULL DEFAULT 10,
  map_capacity INTEGER NOT NULL DEFAULT 100,
  season_days INTEGER NOT NULL DEFAULT 14
);
INSERT OR IGNORE INTO war_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS war_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  period_started_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO war_state (id) VALUES (1);

-- Admin-defined league tiers for the war map, lowest to highest (sort_order ascending). Unlike the
-- card-battle weekly league (rank-based promotion/relegation), placement here is a direct trophy
-- threshold — the same style Clash Royale-like games use — so trophies persist across seasons
-- instead of resetting, and a tier's "map" is simply everyone whose trophies fall in its range.
CREATE TABLE IF NOT EXISTS war_leagues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  icon TEXT,
  min_trophies INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- End-of-season rewards for finishing in a given rank range within a specific war league.
CREATE TABLE IF NOT EXISTS war_league_prizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_key TEXT NOT NULL,
  rank_from INTEGER NOT NULL,
  rank_to INTEGER NOT NULL,
  reward_type TEXT NOT NULL DEFAULT 'toman', -- toman | card
  reward_toman INTEGER DEFAULT 0,
  card_id INTEGER
);

CREATE TABLE IF NOT EXISTS war_towers (
  tg_id INTEGER PRIMARY KEY,
  trophies INTEGER NOT NULL DEFAULT 1000,
  tower_level INTEGER NOT NULL DEFAULT 1,
  defense_card_ids TEXT NOT NULL DEFAULT '[]',
  shield_until TEXT,
  season_wins INTEGER NOT NULL DEFAULT 0,
  season_losses INTEGER NOT NULL DEFAULT 0,
  total_looted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS war_attacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attacker_tg_id INTEGER NOT NULL,
  defender_tg_id INTEGER NOT NULL,
  attacker_power INTEGER NOT NULL,
  defender_power INTEGER NOT NULL,
  result TEXT NOT NULL, -- win | loss (from the attacker's perspective)
  loot_amount INTEGER NOT NULL DEFAULT 0,
  trophy_change_attacker INTEGER NOT NULL DEFAULT 0,
  trophy_change_defender INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
// Seed a reasonable default set of tiers once, on a fresh install only.
if (!db.prepare('SELECT 1 FROM war_leagues LIMIT 1').get()) {
  const seed = db.prepare('INSERT INTO war_leagues (key, label, icon, min_trophies, sort_order) VALUES (?,?,?,?,?)');
  seed.run('bronze', 'Bronze', '🥉', 0, 0);
  seed.run('silver', 'Silver', '🥈', 1000, 1);
  seed.run('gold', 'Gold', '🥇', 2000, 2);
  seed.run('platinum', 'Platinum', '💎', 3500, 3);
}


export function getWarConfig() { return db.prepare('SELECT * FROM war_config WHERE id = 1').get(); }
export function setWarConfig(c) {
  db.prepare(`
    UPDATE war_config SET enabled=?, deck_size=?, plunder_percent=?, shield_hours=?, starting_trophies=?,
      trophy_win_attacker=?, trophy_lose_attacker=?, trophy_lose_defender=?, trophy_win_defender=?,
      upgrade_base_cost_toman=?, upgrade_power_percent=?, max_tower_level=?, map_capacity=?, season_days=?
    WHERE id = 1
  `).run(
    c.enabled ? 1 : 0, Math.max(1, Number(c.deck_size) || 4), Math.max(0, Number(c.plunder_percent) || 0),
    Math.max(0, Number(c.shield_hours) || 0), Math.max(0, Number(c.starting_trophies) || 0),
    Math.max(0, Number(c.trophy_win_attacker) || 0), Math.max(0, Number(c.trophy_lose_attacker) || 0),
    Math.max(0, Number(c.trophy_lose_defender) || 0), Math.max(0, Number(c.trophy_win_defender) || 0),
    Math.max(0, Number(c.upgrade_base_cost_toman) || 0), Math.max(0, Number(c.upgrade_power_percent) || 0),
    Math.max(1, Number(c.max_tower_level) || 10), Math.max(1, Number(c.map_capacity) || 100), Math.max(1, Number(c.season_days) || 14)
  );
}

/* ---------- Admin: league tiers ---------- */
export function listWarLeagues() { return db.prepare('SELECT * FROM war_leagues ORDER BY sort_order ASC, id ASC').all(); }
export function getWarLeague(key) { return db.prepare('SELECT * FROM war_leagues WHERE key = ?').get(key); }
export function upsertWarLeagueTier(l) {
  const existing = l.originalKey ? getWarLeague(l.originalKey) : (l.key ? getWarLeague(l.key) : null);
  if (existing) {
    db.prepare('UPDATE war_leagues SET key=?, label=?, icon=?, min_trophies=?, sort_order=? WHERE id=?')
      .run(l.key, l.label, l.icon || null, Math.max(0, Number(l.min_trophies) || 0), Number(l.sort_order) || 0, existing.id);
    return existing.id;
  }
  return db.prepare('INSERT INTO war_leagues (key, label, icon, min_trophies, sort_order) VALUES (?,?,?,?,?)')
    .run(l.key, l.label, l.icon || null, Math.max(0, Number(l.min_trophies) || 0), Number(l.sort_order) || 0).lastInsertRowid;
}
export function deleteWarLeagueTier(key) {
  const all = listWarLeagues();
  if (all.length <= 1) throw new Error('At least one league tier must remain');
  db.prepare('DELETE FROM war_leagues WHERE key = ?').run(key);
}

/* ---------- Admin: league prizes ---------- */
export function listWarLeaguePrizesAdmin() { return db.prepare('SELECT * FROM war_league_prizes ORDER BY league_key ASC, rank_from ASC').all(); }
export function listWarLeaguePrizes(leagueKey) { return db.prepare('SELECT * FROM war_league_prizes WHERE league_key = ? ORDER BY rank_from ASC').all(leagueKey); }
export function upsertWarLeaguePrize(p) {
  if (p.id) {
    db.prepare('UPDATE war_league_prizes SET league_key=?, rank_from=?, rank_to=?, reward_type=?, reward_toman=?, card_id=? WHERE id=?')
      .run(p.league_key, Number(p.rank_from), Number(p.rank_to), p.reward_type, Number(p.reward_toman) || 0, p.card_id ? Number(p.card_id) : null, p.id);
    return p.id;
  }
  return db.prepare('INSERT INTO war_league_prizes (league_key, rank_from, rank_to, reward_type, reward_toman, card_id) VALUES (?,?,?,?,?,?)')
    .run(p.league_key, Number(p.rank_from), Number(p.rank_to), p.reward_type, Number(p.reward_toman) || 0, p.card_id ? Number(p.card_id) : null).lastInsertRowid;
}
export function deleteWarLeaguePrize(id) { db.prepare('DELETE FROM war_league_prizes WHERE id = ?').run(id); }

// The highest tier whose min_trophies threshold the given trophy count has reached.
function leagueForTrophies(trophies) {
  const tiers = listWarLeagues();
  let best = tiers[0];
  for (const t of tiers) if (trophies >= t.min_trophies) best = t;
  return best;
}

/* ---------- Tower ---------- */
export function getOrCreateWarTower(tgId) {
  const cfg = getWarConfig();
  db.prepare('INSERT OR IGNORE INTO war_towers (tg_id, trophies) VALUES (?, ?)').run(tgId, cfg.starting_trophies);
  return db.prepare('SELECT * FROM war_towers WHERE tg_id = ?').get(tgId);
}
function isShielded(tower) {
  return !!(tower.shield_until && new Date(tower.shield_until.replace(' ', 'T') + 'Z').getTime() > Date.now());
}
function getTowerUpgradeCost(tower) {
  const cfg = getWarConfig();
  return round2(cfg.upgrade_base_cost_toman * tower.tower_level);
}
// A card's power scaled up by the tower's defense bonus (upgrade_power_percent per level above 1) —
// the tower level itself never changes a card's own power/level, it's a separate multiplier on top.
function towerDefenseMultiplier(tower, cfg) {
  return 1 + (cfg.upgrade_power_percent / 100) * (tower.tower_level - 1);
}
function enrichCardIds(tgId, ids) {
  return (ids || []).map(id => getUserCard(tgId, id)).filter(Boolean);
}
function computeDeckPower(cards) { return cards.reduce((s, c) => s + c.power, 0); }

export function getMyWarStatus(tgId) {
  const cfg = getWarConfig();
  const tower = getOrCreateWarTower(tgId);
  const league = leagueForTrophies(tower.trophies);
  const defenseCards = enrichCardIds(tgId, JSON.parse(tower.defense_card_ids || '[]'));
  const defenseMultiplier = towerDefenseMultiplier(tower, cfg);
  const defensePower = Math.round(computeDeckPower(defenseCards) * defenseMultiplier);
  const rank = db.prepare('SELECT COUNT(*) + 1 AS rank FROM war_towers WHERE trophies > ?').get(tower.trophies).rank;
  const leagueRank = db.prepare('SELECT COUNT(*) + 1 AS rank FROM war_towers WHERE trophies > ? AND trophies >= ?')
    .get(tower.trophies, league.min_trophies).rank;
  return {
    config: cfg,
    trophies: tower.trophies,
    league: { key: league.key, label: league.label, icon: league.icon },
    towerLevel: tower.tower_level,
    upgradeCost: tower.tower_level < cfg.max_tower_level ? getTowerUpgradeCost(tower) : null,
    defenseCards, defensePower, defenseMultiplier,
    shielded: isShielded(tower), shieldUntil: tower.shield_until,
    seasonWins: tower.season_wins, seasonLosses: tower.season_losses, totalLooted: tower.total_looted,
    globalRank: rank, leagueRank,
    playsRemaining: getPlaysRemaining(tgId),
  };
}

export function setDefenseDeck(tgId, userCardIds) {
  const cfg = getWarConfig();
  const ids = [...new Set((userCardIds || []).map(Number))];
  if (!ids.length || ids.length > cfg.deck_size) throw new Error(`Pick between 1 and ${cfg.deck_size} cards for defense`);
  const cards = ids.map(id => getUserCard(tgId, id));
  if (cards.some(c => !c)) throw new Error('One of the selected cards was not found');
  if (ids.some(id => isCardListedForSale(id))) throw new Error('One of the selected cards is currently listed on the marketplace — cancel that listing first');
  getOrCreateWarTower(tgId);
  db.prepare('UPDATE war_towers SET defense_card_ids = ? WHERE tg_id = ?').run(JSON.stringify(ids), tgId);
}

export function upgradeTower(tgId) {
  const cfg = getWarConfig();
  const tower = getOrCreateWarTower(tgId);
  if (tower.tower_level >= cfg.max_tower_level) throw new Error('Your tower is already at the maximum level');
  const cost = getTowerUpgradeCost(tower);
  const user = getUser(tgId);
  if (!user || user.balance_toman < cost) throw new Error('Insufficient wallet balance');
  adjustToman(tgId, -cost, `Tower upgrade to level ${tower.tower_level + 1}`);
  db.prepare('UPDATE war_towers SET tower_level = tower_level + 1 WHERE tg_id = ?').run(tgId);
  return { newLevel: tower.tower_level + 1 };
}

// Attack targets are only ever picked from the SAME league (same trophy bracket), same spirit as
// the card-battle queue preferring same-league opponents — a Bronze tower is never a Gold player's
// target. Shielded towers and towers with no defense deck set are excluded (attacking either would
// not be a meaningful fight).
export function listAttackTargets(tgId, limit = 10) {
  const cfg = getWarConfig();
  const myTower = getOrCreateWarTower(tgId);
  const myLeague = leagueForTrophies(myTower.trophies);
  const rows = db.prepare(`
    SELECT wt.*, u.first_name, u.username FROM war_towers wt
    JOIN users u ON u.tg_id = wt.tg_id
    WHERE wt.tg_id != ? AND wt.defense_card_ids != '[]'
    ORDER BY ABS(wt.trophies - ?) ASC LIMIT 50
  `).all(tgId, myTower.trophies);
  return rows
    .filter(r => !isShielded(r) && leagueForTrophies(r.trophies).key === myLeague.key)
    .slice(0, limit)
    .map(r => ({
      tgId: r.tg_id, name: r.first_name || r.username || `Player ${r.tg_id}`,
      trophies: r.trophies, towerLevel: r.tower_level,
    }));
}

export function getWarAttackHistory(tgId, limit = 20) {
  return db.prepare(`
    SELECT * FROM war_attacks WHERE attacker_tg_id = ? OR defender_tg_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(tgId, tgId, limit);
}

export function getWarLeaderboard(leagueKey, limit = 20) {
  const cfg = getWarConfig();
  const league = getWarLeague(leagueKey) || listWarLeagues()[0];
  if (!league) return [];
  const tiers = listWarLeagues();
  const idx = tiers.findIndex(t => t.key === league.key);
  const nextThreshold = idx >= 0 && idx < tiers.length - 1 ? tiers[idx + 1].min_trophies : Infinity;
  return db.prepare(`
    SELECT wt.tg_id, wt.trophies, wt.tower_level, wt.season_wins, wt.season_losses,
      u.first_name, u.username, av.image_url AS avatar_image
    FROM war_towers wt JOIN users u ON u.tg_id = wt.tg_id
    LEFT JOIN user_rank ur ON ur.tg_id = wt.tg_id
    LEFT JOIN avatars av ON av.id = ur.equipped_avatar_id
    WHERE wt.trophies >= ? AND wt.trophies < ?
    ORDER BY wt.trophies DESC LIMIT ?
  `).all(league.min_trophies, nextThreshold, Math.min(limit, cfg.map_capacity));
}

// The core fight: attacker's chosen deck power vs. the defender's saved defense deck power (scaled
// by the defender's tower level) — exactly the same power formula as the card-battle queue
// (base power + level + upgrades, via getUserCard), no new stats invented. On a win, a cut of the
// defender's LNDC balance is looted; either way trophies move and a shield protects the defender
// from being hit again immediately.
export function attackTower(attackerTgId, defenderTgId, attackUserCardIds) {
  const cfg = getWarConfig();
  if (!cfg.enabled) throw new Error('Tower War is currently disabled');
  if (attackerTgId === defenderTgId) throw new Error('You cannot attack your own tower');
  if (getPlaysRemaining(attackerTgId) <= 0) throw new Error('Your games for today are used up — buy extra games from the shop');

  const ids = [...new Set((attackUserCardIds || []).map(Number))];
  if (!ids.length || ids.length > cfg.deck_size) throw new Error(`Pick between 1 and ${cfg.deck_size} cards to attack with`);
  const attackCards = ids.map(id => getUserCard(attackerTgId, id));
  if (attackCards.some(c => !c)) throw new Error('One of the selected cards was not found');
  if (ids.some(id => isCardListedForSale(id))) throw new Error('One of the selected cards is currently listed on the marketplace — cancel that listing first');

  const defenderTower = getOrCreateWarTower(defenderTgId);
  if (isShielded(defenderTower)) throw new Error('This tower is currently protected by a shield');
  if (defenderTower.defense_card_ids === '[]') throw new Error('This player has not set up a defense deck yet');
  const attackerTower = getOrCreateWarTower(attackerTgId);
  const attackerLeague = leagueForTrophies(attackerTower.trophies);
  const defenderLeague = leagueForTrophies(defenderTower.trophies);
  if (attackerLeague.key !== defenderLeague.key) throw new Error('You can only attack players in your own league');

  const defenseCards = enrichCardIds(defenderTgId, JSON.parse(defenderTower.defense_card_ids));
  const attackerPower = Math.round(computeDeckPower(attackCards));
  const defenderPower = Math.round(computeDeckPower(defenseCards) * towerDefenseMultiplier(defenderTower, cfg));

  const attackerWon = attackerPower >= defenderPower;
  const defender = getUser(defenderTgId);
  const lootAmount = attackerWon ? round2(Math.max(0, (defender?.balance_toman || 0) * cfg.plunder_percent / 100)) : 0;
  const trophyChangeAttacker = attackerWon ? cfg.trophy_win_attacker : -cfg.trophy_lose_attacker;
  const trophyChangeDefender = attackerWon ? -cfg.trophy_lose_defender : cfg.trophy_win_defender;

  const tx = db.transaction(() => {
    consumePlay(attackerTgId);
    if (attackerWon && lootAmount > 0) {
      adjustToman(defenderTgId, -lootAmount, `Tower raided by ${attackerTgId}`);
      adjustToman(attackerTgId, lootAmount, `Looted from ${defenderTgId}'s tower`);
    }
    db.prepare('UPDATE war_towers SET trophies = MAX(0, trophies + ?), season_wins = season_wins + ?, total_looted = total_looted + ? WHERE tg_id = ?')
      .run(trophyChangeAttacker, attackerWon ? 1 : 0, lootAmount, attackerTgId);
    db.prepare('UPDATE war_towers SET trophies = MAX(0, trophies + ?), season_losses = season_losses + ? WHERE tg_id = ?')
      .run(trophyChangeDefender, attackerWon ? 1 : 0, defenderTgId);
    const shieldUntil = new Date(Date.now() + cfg.shield_hours * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('UPDATE war_towers SET shield_until = ? WHERE tg_id = ?').run(shieldUntil, defenderTgId);
    db.prepare(`
      INSERT INTO war_attacks (attacker_tg_id, defender_tg_id, attacker_power, defender_power, result, loot_amount, trophy_change_attacker, trophy_change_defender)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(attackerTgId, defenderTgId, attackerPower, defenderPower, attackerWon ? 'win' : 'loss', lootAmount, trophyChangeAttacker, trophyChangeDefender);
  });
  tx();

  const attacker = getUser(attackerTgId);
  const attackerName = attacker?.username || attacker?.first_name;
  if (attackerWon) {
    const wins = db.prepare('SELECT season_wins FROM war_towers WHERE tg_id = ?').get(attackerTgId).season_wins;
    checkAchievements(attackerTgId, 'war_wins', wins, attackerName);
    if (lootAmount > 0) logPlayerActivity(attackerName, `raided a tower and looted ${lootAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} LNDC ⚔️`, '⚔️');
  }

  return {
    won: attackerWon, attackerPower, defenderPower, lootAmount,
    trophyChangeAttacker, trophyChangeDefender, defenderTgId,
  };
}

/* ---------- Season resolution (rank-based prizes, like the weekly league) ---------- */
function getWarState() { return db.prepare('SELECT * FROM war_state WHERE id = 1').get(); }
function resolveWarSeason() {
  const tiers = listWarLeagues();
  const cardGrants = []; // caller grants the card (avoids a circular import with game-db.js)
  const tomanGrants = [];
  for (const tier of tiers) {
    const prizes = listWarLeaguePrizes(tier.key);
    if (!prizes.length) continue;
    const idx = tiers.findIndex(t => t.key === tier.key);
    const nextThreshold = idx < tiers.length - 1 ? tiers[idx + 1].min_trophies : Infinity;
    const members = db.prepare('SELECT tg_id FROM war_towers WHERE trophies >= ? AND trophies < ? ORDER BY trophies DESC')
      .all(tier.min_trophies, nextThreshold);
    members.forEach((m, idx2) => {
      const rank = idx2 + 1;
      const prize = prizes.find(p => rank >= p.rank_from && rank <= p.rank_to);
      if (!prize) return;
      if (prize.reward_type === 'card' && prize.card_id) cardGrants.push({ tg_id: m.tg_id, card_id: prize.card_id, league_label: tier.label, rank });
      else if (prize.reward_type === 'toman' && prize.reward_toman > 0) tomanGrants.push({ tg_id: m.tg_id, amount: prize.reward_toman, league_label: tier.label, rank });
    });
  }
  const tx = db.transaction(() => {
    for (const g of tomanGrants) adjustToman(g.tg_id, g.amount, `Tower War rank #${g.rank} prize (${g.league_label})`);
    db.prepare('UPDATE war_towers SET season_wins = 0, season_losses = 0').run();
    db.prepare(`UPDATE war_state SET period_started_at = datetime('now') WHERE id = 1`).run();
  });
  tx();
  return { cardGrants, tomanGrants };
}
export function checkAutoResetWarSeason() {
  const cfg = getWarConfig();
  if (!cfg.enabled) return null;
  const state = getWarState();
  const startedAt = new Date(state.period_started_at.replace(' ', 'T') + 'Z').getTime();
  if (Date.now() >= startedAt + cfg.season_days * 24 * 60 * 60 * 1000) return resolveWarSeason();
  return null;
}

/* ---------- Admin visibility ---------- */
export function listRecentWarAttacksAdmin(limit = 50) {
  return db.prepare(`
    SELECT wa.*, ua.first_name AS attacker_name, ud.first_name AS defender_name
    FROM war_attacks wa
    LEFT JOIN users ua ON ua.tg_id = wa.attacker_tg_id
    LEFT JOIN users ud ON ud.tg_id = wa.defender_tg_id
    ORDER BY wa.created_at DESC LIMIT ?
  `).all(limit);
}
