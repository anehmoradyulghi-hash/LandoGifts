import db, { round2 } from './db.js';
import { adjustToman, getUser, checkAndUnlockReferralBalance } from './db.js';
import { getUserCard, getPlaysRemaining, getPlaysUsedToday, consumePlay } from './game-db.js';
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
// Reused an existing table (war_towers) for map position instead of a parallel table — adds only the
// 3 columns actually needed (x, y, and a cached league key to detect league changes cheaply).
try { db.exec(`ALTER TABLE war_towers ADD COLUMN map_x REAL`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
try { db.exec(`ALTER TABLE war_towers ADD COLUMN map_y REAL`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
try { db.exec(`ALTER TABLE war_towers ADD COLUMN league_key TEXT`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
db.exec(`CREATE INDEX IF NOT EXISTS idx_war_towers_league_key ON war_towers(league_key)`);

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
// Fixed world-space size the map is laid out in (frontend scales/pans within this — not admin
// configurable, only the tower COUNT per league is, via war_config.map_capacity).
export const WAR_MAP_SIZE = 1000;

// Places a tower at a free grid cell within its league's map so towers don't overlap, with a little
// random jitter inside the cell so it doesn't look like a rigid grid. Grid size scales with the
// configured map capacity (e.g. capacity 100 -> a 10x10 grid). Only ever called when a tower is
// created or changes league (or on an admin-triggered reset) — never on a normal map load — so it
// stays a rare, cheap, bounded (<= map_capacity rows) query, not a per-request cost.
//
// Cell selection is a shuffled walk of every free cell (not repeated random guesses) so towers
// spread evenly across the whole grid from the very first placement, instead of clustering toward
// whichever cells the RNG happens to land on early — random-with-retry can leave large visible gaps
// when the grid is sparse (well below full capacity), since nothing steers it away from a region
// it has already filled by chance.
function assignMapPosition(tgId, leagueKey) {
  const cfg = getWarConfig();
  const gridSize = Math.max(4, Math.ceil(Math.sqrt(cfg.map_capacity)));
  const cell = WAR_MAP_SIZE / gridSize;
  const occupied = new Set(
    db.prepare('SELECT map_x, map_y FROM war_towers WHERE league_key = ? AND tg_id != ? AND map_x IS NOT NULL')
      .all(leagueKey, tgId)
      .map(r => `${Math.floor(r.map_x / cell)},${Math.floor(r.map_y / cell)}`)
  );
  const freeCells = [];
  for (let gx = 0; gx < gridSize; gx++) {
    for (let gy = 0; gy < gridSize; gy++) {
      if (!occupied.has(`${gx},${gy}`)) freeCells.push([gx, gy]);
    }
  }
  let gx, gy;
  if (freeCells.length) {
    // Deterministic-but-varied pick: hash the user id into the free-cell list instead of pure
    // Math.random(), so placement is reproducible per user (stable across retries) while still
    // effectively shuffled across the grid.
    const idx = Math.abs(tgId * 2654435761 % freeCells.length);
    [gx, gy] = freeCells[idx];
  } else {
    // Grid is completely full (more towers than capacity allows) — fall back to a random cell
    // rather than failing; towers will overlap slightly, which is the honest outcome of exceeding
    // configured capacity, not a bug to hide.
    gx = Math.floor(Math.random() * gridSize);
    gy = Math.floor(Math.random() * gridSize);
  }
  const jitter = cell * 0.15;
  const x = Math.round((gx * cell + cell / 2 + (Math.random() * 2 - 1) * jitter) * 100) / 100;
  const y = Math.round((gy * cell + cell / 2 + (Math.random() * 2 - 1) * jitter) * 100) / 100;
  db.prepare('UPDATE war_towers SET map_x = ?, map_y = ?, league_key = ? WHERE tg_id = ?').run(x, y, leagueKey, tgId);
  return { x, y };
}

// Creates the tower row if needed, and (only when actually necessary — first creation, a league
// change since last touch, or after an admin map-position reset) assigns it a permanent map
// position. A normal reload/re-entry does nothing here beyond the cheap initial SELECT — the
// position is NOT reassigned "just because" the player opened the app again.
export function getOrCreateWarTower(tgId) {
  const cfg = getWarConfig();
  db.prepare('INSERT OR IGNORE INTO war_towers (tg_id, trophies) VALUES (?, ?)').run(tgId, cfg.starting_trophies);
  let tower = db.prepare('SELECT * FROM war_towers WHERE tg_id = ?').get(tgId);
  const currentLeagueKey = leagueForTrophies(tower.trophies).key;
  if (tower.league_key !== currentLeagueKey || tower.map_x == null) {
    assignMapPosition(tgId, currentLeagueKey);
    tower = db.prepare('SELECT * FROM war_towers WHERE tg_id = ?').get(tgId);
  }
  return tower;
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
  const playsInfo = getPlaysUsedToday(tgId);
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
    playsUsed: playsInfo.used, playsTotal: playsInfo.total,
    seasonEndsAt: getWarSeasonEndsAt(),
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

// One optimized query for the whole league map — everything the frontend needs to render every
// tower as a dot (id, name, position, trophies, level, shield) and nothing more (no card/wallet/user
// data), so this stays cheap even with the map at full capacity. Positions are read as-is — this
// does NOT touch/reassign anyone's position, it only ensures the CALLER's own tower position is
// current (via getOrCreateWarTower, a single cheap row check) before picking which league's map to load.
export function getWarMap(tgId) {
  const cfg = getWarConfig();
  const myTower = getOrCreateWarTower(tgId);
  const league = leagueForTrophies(myTower.trophies);
  const now = Date.now();
  const rows = db.prepare(`
    SELECT wt.tg_id, wt.trophies, wt.tower_level, wt.map_x, wt.map_y, wt.shield_until
    FROM war_towers wt
    WHERE wt.league_key = ? AND wt.map_x IS NOT NULL
    ORDER BY wt.tg_id ASC LIMIT ?
  `).all(league.key, Math.max(cfg.map_capacity * 2, 100));
  // Names come from the same `users` table lookup the rest of the bot already keeps hot in cache —
  // still a single extra indexed query, not one per tower.
  const tgIds = rows.map(r => r.tg_id);
  const names = {};
  if (tgIds.length) {
    const placeholders = tgIds.map(() => '?').join(',');
    db.prepare(`SELECT tg_id, first_name, username FROM users WHERE tg_id IN (${placeholders})`).all(...tgIds)
      .forEach(u => { names[u.tg_id] = u.first_name || u.username || `Player ${u.tg_id}`; });
  }
  return {
    league: { key: league.key, label: league.label, icon: league.icon },
    mapSize: WAR_MAP_SIZE,
    capacity: cfg.map_capacity,
    shieldHours: cfg.shield_hours,
    myTgId: tgId,
    towers: rows.map(r => ({
      tgId: r.tg_id,
      name: names[r.tg_id] || `Player ${r.tg_id}`,
      x: r.map_x, y: r.map_y,
      trophies: r.trophies,
      towerLevel: r.tower_level,
      shielded: !!(r.shield_until && new Date(r.shield_until.replace(' ', 'T') + 'Z').getTime() > now),
      shieldUntil: (r.shield_until && new Date(r.shield_until.replace(' ', 'T') + 'Z').getTime() > now) ? r.shield_until : null,
      isMe: r.tg_id === tgId,
    })),
  };
}

// Full detail for ONE tower, fetched only when the player taps it on the map (never for the whole
// map at once) — the map payload above already carries name/position/trophies/shield, so this only
// adds what that payload deliberately leaves out: defense power and whether attacking is even
// possible. A plain read — never assigns/changes the target's position as a side effect of someone
// else looking at them.
export function getWarTowerDetail(targetTgId) {
  const cfg = getWarConfig();
  let tower = db.prepare('SELECT * FROM war_towers WHERE tg_id = ?').get(targetTgId);
  if (!tower) tower = getOrCreateWarTower(targetTgId); // target has never opened Tower War yet
  const league = leagueForTrophies(tower.trophies);
  const defenseCards = enrichCardIds(targetTgId, JSON.parse(tower.defense_card_ids || '[]'));
  const defensePower = Math.round(computeDeckPower(defenseCards) * towerDefenseMultiplier(tower, cfg));
  return {
    tgId: targetTgId,
    trophies: tower.trophies,
    towerLevel: tower.tower_level,
    league: { key: league.key, label: league.label, icon: league.icon },
    defensePower,
    hasDefenseSet: tower.defense_card_ids !== '[]',
    shielded: isShielded(tower),
    shieldUntil: tower.shield_until,
  };
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

  // A battle just happened for both sides — check whether it satisfies either one's referral
  // withdrawal requirement (a no-op for the vast majority who don't have one configured).
  checkAndUnlockReferralBalance(attackerTgId);
  checkAndUnlockReferralBalance(defenderTgId);

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
// The season's end time, computed from the same period_started_at + season_days the auto-reset
// check already uses — exposed for the UI's countdown, not a separately-tracked value.
function getWarSeasonEndsAt() {
  const cfg = getWarConfig();
  const state = getWarState();
  const startedAt = new Date(state.period_started_at.replace(' ', 'T') + 'Z').getTime();
  return new Date(startedAt + cfg.season_days * 24 * 60 * 60 * 1000).toISOString();
}
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
  // Positions get a fresh layout at season boundaries too (per spec: reassigned on join OR season
  // reset) — separate from the prize/counter transaction since it's its own batch of per-league writes.
  resetWarMapPositions();
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
// Manual "resolve season now" for the admin panel — same logic the automatic hourly check uses.
export function forceResolveWarSeason() { return resolveWarSeason(); }

/* ---------- Map administration ---------- */
// Per-league occupancy, for the admin panel's "map status" view — a handful of GROUP BY rows, not a
// per-tower query.
export function getWarMapStats() {
  const tiers = listWarLeagues();
  const counts = db.prepare('SELECT league_key, COUNT(*) c FROM war_towers WHERE league_key IS NOT NULL GROUP BY league_key').all();
  const countByKey = {};
  counts.forEach(c => { countByKey[c.league_key] = c.c; });
  const cfg = getWarConfig();
  return tiers.map(t => ({ key: t.key, label: t.label, icon: t.icon, count: countByKey[t.key] || 0, capacity: cfg.map_capacity }));
}
// Re-lays-out every tower currently on a map — a fresh, non-overlapping position per league, in one
// batch per league (bounded by that league's member count, not a global per-tower loop across the
// whole player base). Does not touch trophies, wallet, cards, defense deck, or anything else.
export function resetWarMapPositions() {
  const tiers = listWarLeagues();
  let reassigned = 0;
  const tx = db.transaction(() => {
    for (const tier of tiers) {
      const idx = tiers.findIndex(t => t.key === tier.key);
      const nextThreshold = idx < tiers.length - 1 ? tiers[idx + 1].min_trophies : Infinity;
      const members = db.prepare('SELECT tg_id FROM war_towers WHERE trophies >= ? AND trophies < ?').all(tier.min_trophies, nextThreshold);
      // Clear this league's positions first so assignMapPosition's occupancy check starts fresh
      // instead of every tower avoiding its OWN previous spot as if it were taken by someone else.
      db.prepare('UPDATE war_towers SET map_x = NULL, map_y = NULL WHERE trophies >= ? AND trophies < ?').run(tier.min_trophies, nextThreshold);
      for (const m of members) { assignMapPosition(m.tg_id, tier.key); reassigned++; }
    }
  });
  tx();
  return { reassigned };
}
// Resets EVERY player's trophies back to the configured starting value (war_config.starting_trophies)
// — a full ladder reset. Doesn't touch tower level, defense deck, wallet, cards, or season win/loss
// counters. Positions are re-laid-out afterward since almost everyone's league changes.
export function resetAllWarTrophies() {
  const cfg = getWarConfig();
  let affected = 0;
  const tx = db.transaction(() => {
    affected = db.prepare('SELECT COUNT(*) c FROM war_towers').get().c;
    db.prepare('UPDATE war_towers SET trophies = ?, league_key = NULL, map_x = NULL, map_y = NULL').run(cfg.starting_trophies);
  });
  tx();
  const { reassigned } = resetWarMapPositions();
  return { affected, reassigned };
}
// Resets trophies back to the configured starting value only for players currently placed in the
// given league (by trophy range — the same membership rule used everywhere else in this file), so
// e.g. clearing out one league doesn't touch anyone sitting in a different one. A player reset this
// way will very likely drop to a lower league once positions are re-laid-out below.
export function resetWarLeagueTrophies(leagueKey) {
  const cfg = getWarConfig();
  const tiers = listWarLeagues();
  const idx = tiers.findIndex(t => t.key === leagueKey);
  if (idx === -1) throw new Error('Unknown league');
  const tier = tiers[idx];
  const nextThreshold = idx < tiers.length - 1 ? tiers[idx + 1].min_trophies : Infinity;
  let affected = 0;
  const tx = db.transaction(() => {
    affected = db.prepare('SELECT COUNT(*) c FROM war_towers WHERE trophies >= ? AND trophies < ?').get(tier.min_trophies, nextThreshold).c;
    db.prepare('UPDATE war_towers SET trophies = ?, league_key = NULL, map_x = NULL, map_y = NULL WHERE trophies >= ? AND trophies < ?')
      .run(cfg.starting_trophies, tier.min_trophies, nextThreshold);
  });
  tx();
  const { reassigned } = resetWarMapPositions();
  return { affected, reassigned };
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
