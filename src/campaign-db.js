import db from './db.js';
import { adjustToman } from './db.js';
import { getUserCard, getPlaysRemaining, consumePlay, grantCardInstance, getGameConfig } from './game-db.js';

/* =========================================================================
 * Story Campaign — a single-player PvE mode: a "land" (سرزمین) is a themed
 * world containing an ordered sequence of stages. Stages unlock strictly in
 * order (clear stage N to unlock N+1); clearing a stage for the first time
 * can grant a specific card (at a specific level) and/or an LNDC reward —
 * re-clearing an already-won stage never re-grants that reward. Battles use
 * the exact same deck-power formula as the real Card Game queue (game-db.js
 * joinQueue) — total power of the chosen cards, ±15% random jitter — just
 * against a fixed enemy power instead of a live opponent, and draw from the
 * same daily "games left" pool so campaign grinding can't bypass it.
 * ========================================================================= */
db.exec(`
CREATE TABLE IF NOT EXISTS campaign_lands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
`);
function safeAddColumn(table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
// A purely visual palette (forest/fire/ice/shadow/gold) — picks the CSS gradient + decorative
// silhouette shown behind the land's stage path and battle screens when no custom image_url is set.
safeAddColumn('campaign_lands', "theme TEXT NOT NULL DEFAULT 'forest'");
db.exec(`
CREATE TABLE IF NOT EXISTS campaign_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  land_id INTEGER NOT NULL REFERENCES campaign_lands(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  story_text TEXT,
  image_url TEXT,
  enemy_name TEXT NOT NULL DEFAULT 'Unknown Foe',
  enemy_power INTEGER NOT NULL DEFAULT 100,
  reward_card_id INTEGER REFERENCES game_cards(id),
  reward_card_level INTEGER,
  reward_toman REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS user_campaign_clears (
  tg_id INTEGER NOT NULL,
  stage_id INTEGER NOT NULL,
  cleared_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tg_id, stage_id)
);
`);

// A starter land so the feature isn't empty before an admin configures anything — five stages of
// gently rising difficulty. Rewards here are LNDC only (never assumes any particular game card
// exists in this installation's catalog); an admin can edit any stage afterward to add a card reward.
(function seedDefaultLand() {
  const existing = db.prepare('SELECT COUNT(*) c FROM campaign_lands').get().c;
  if (existing > 0) return;
  const landId = db.prepare(`INSERT INTO campaign_lands (name, description, sort_order) VALUES (?,?,0)`)
    .run('Whispering Woods', 'An old forest at the edge of the map, said to hide the ashes of a fallen kingdom.').lastInsertRowid;
  const stages = [
    ['The Overgrown Path', 'The trail into the woods hasn\u2019t been cleared in years. Something rustles just out of sight.', 'Wild Boarhound', 80, 20],
    ['The Broken Bridge', 'Half the bridge has collapsed into the ravine below. Whatever guards the far side doesn\u2019t want company.', 'Ravine Stalker', 160, 35],
    ['The Sunken Shrine', 'A shrine, swallowed by moss and mud, still hums with old magic \u2014 and something that never left it.', 'Shrine Wraith', 260, 55],
    ['The Hollow Tree', 'The oldest tree in the forest is hollow all the way down. Its guardian has slept for a century.', 'Hollow Guardian', 380, 80],
    ['The Ashen King', 'At the heart of the woods, the fallen king\u2019s throne still stands \u2014 and so, somehow, does he.', 'The Ashen King', 520, 150],
  ];
  stages.forEach(([name, story, enemyName, enemyPower, rewardToman], i) => {
    db.prepare(`
      INSERT INTO campaign_stages (land_id, sort_order, name, story_text, enemy_name, enemy_power, reward_toman)
      VALUES (?,?,?,?,?,?,?)
    `).run(landId, i, name, story, enemyName, enemyPower, rewardToman);
  });
})();

/* ---------- Admin ---------- */
export function listCampaignLandsAdmin() {
  return db.prepare('SELECT * FROM campaign_lands ORDER BY sort_order ASC, id ASC').all();
}
export function upsertCampaignLand(l) {
  if (l.id) {
    db.prepare('UPDATE campaign_lands SET name=?, description=?, image_url=?, theme=?, sort_order=?, active=? WHERE id=?')
      .run(l.name, l.description || null, l.image_url || null, l.theme || 'forest', Number(l.sort_order) || 0, l.active ? 1 : 0, l.id);
    return l.id;
  }
  return db.prepare('INSERT INTO campaign_lands (name, description, image_url, theme, sort_order, active) VALUES (?,?,?,?,?,?)')
    .run(l.name, l.description || null, l.image_url || null, l.theme || 'forest', Number(l.sort_order) || 0, l.active === false ? 0 : 1).lastInsertRowid;
}
export function deleteCampaignLand(id) {
  db.prepare('DELETE FROM campaign_stages WHERE land_id = ?').run(id);
  db.prepare('DELETE FROM campaign_lands WHERE id = ?').run(id);
}
export function listCampaignStagesAdmin(landId) {
  return db.prepare('SELECT * FROM campaign_stages WHERE land_id = ? ORDER BY sort_order ASC, id ASC').all(landId);
}
export function getCampaignStage(id) { return db.prepare('SELECT * FROM campaign_stages WHERE id = ?').get(id); }
export function upsertCampaignStage(s) {
  const fields = [s.land_id, s.name, s.story_text || null, s.image_url || null, s.enemy_name || 'Unknown Foe',
    Math.max(1, Number(s.enemy_power) || 100), s.reward_card_id ? Number(s.reward_card_id) : null,
    s.reward_card_level ? Number(s.reward_card_level) : null, Number(s.reward_toman) || 0,
    Number(s.sort_order) || 0, s.active === false ? 0 : 1];
  if (s.id) {
    db.prepare(`
      UPDATE campaign_stages SET land_id=?, name=?, story_text=?, image_url=?, enemy_name=?, enemy_power=?,
        reward_card_id=?, reward_card_level=?, reward_toman=?, sort_order=?, active=? WHERE id=?
    `).run(...fields, s.id);
    return s.id;
  }
  return db.prepare(`
    INSERT INTO campaign_stages (land_id, name, story_text, image_url, enemy_name, enemy_power, reward_card_id, reward_card_level, reward_toman, sort_order, active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(...fields).lastInsertRowid;
}
export function deleteCampaignStage(id) { db.prepare('DELETE FROM campaign_stages WHERE id = ?').run(id); }

/* ---------- Player ---------- */
function listAllActiveStagesInOrder() {
  return db.prepare(`
    SELECT st.*, l.name AS land_name, l.image_url AS land_image_url, l.theme AS land_theme
    FROM campaign_stages st JOIN campaign_lands l ON l.id = st.land_id
    WHERE st.active = 1 AND l.active = 1
    ORDER BY l.sort_order ASC, l.id ASC, st.sort_order ASC, st.id ASC
  `).all();
}
// Full progress map for the player's own screen: every land, every stage, each annotated with
// whether it's cleared and whether it's unlocked yet (strictly sequential across the WHOLE
// campaign — clearing the last stage of one land unlocks the first stage of the next).
export function getCampaignProgress(tgId) {
  const stages = listAllActiveStagesInOrder();
  const clearedIds = new Set(db.prepare('SELECT stage_id FROM user_campaign_clears WHERE tg_id = ?').all(tgId).map(r => r.stage_id));
  let unlocked = true;
  const lands = new Map();
  for (const st of stages) {
    const cleared = clearedIds.has(st.id);
    if (!lands.has(st.land_id)) lands.set(st.land_id, { id: st.land_id, name: st.land_name, imageUrl: st.land_image_url, theme: st.land_theme || 'forest', stages: [] });
    lands.get(st.land_id).stages.push({
      id: st.id, name: st.name, story: st.story_text, imageUrl: st.image_url, enemyName: st.enemy_name, enemyPower: st.enemy_power,
      rewardCardId: st.reward_card_id, rewardCardLevel: st.reward_card_level, rewardToman: st.reward_toman,
      cleared, unlocked,
    });
    unlocked = cleared; // next stage only unlocks if THIS one is cleared
  }
  return { lands: [...lands.values()], playsRemaining: getPlaysRemaining(tgId), deckSize: [getGameConfig().min_deck_size, getGameConfig().max_deck_size] };
}
// Resolves one campaign battle. Same power formula as the real PvP queue (game-db.js), against the
// stage's fixed enemy power instead of a live opponent. First win on a stage grants its reward
// exactly once; replaying an already-cleared stage still costs a play and can still be won/lost, it
// just never re-grants the reward (checked here, not left to the caller).
export function fightCampaignStage(tgId, stageId, userCardIds) {
  const stage = getCampaignStage(stageId);
  if (!stage || !stage.active) throw new Error('Stage not found');
  const cfg = getGameConfig();
  if (!Array.isArray(userCardIds) || userCardIds.length < cfg.min_deck_size || userCardIds.length > cfg.max_deck_size) {
    throw new Error(`The deck must have between ${cfg.min_deck_size} and ${cfg.max_deck_size} cards`);
  }
  // Enforce sequential unlock — can't skip ahead by calling the API directly with a later stage id.
  const allStages = listAllActiveStagesInOrder();
  const idx = allStages.findIndex(s => s.id === stageId);
  if (idx === -1) throw new Error('Stage not found');
  if (idx > 0) {
    const prevCleared = db.prepare('SELECT 1 FROM user_campaign_clears WHERE tg_id = ? AND stage_id = ?').get(tgId, allStages[idx - 1].id);
    if (!prevCleared) throw new Error('Clear the previous stage first');
  }
  if (getPlaysRemaining(tgId) <= 0) throw new Error('Your games for today are used up — buy extra games from the shop');

  const uniqueIds = [...new Set(userCardIds.map(Number))];
  if (uniqueIds.length !== userCardIds.length) throw new Error('Duplicate cards are not allowed in the deck');
  const cards = uniqueIds.map(id => getUserCard(tgId, id));
  if (cards.some(c => !c)) throw new Error('One of the selected cards was not found');
  const myPower = cards.reduce((s, c) => s + c.power, 0);

  return db.transaction(() => {
    consumePlay(tgId);
    const rollMe = myPower * (1 + Math.random() * 0.15);
    const rollEnemy = stage.enemy_power * (1 + Math.random() * 0.15);
    const won = rollMe >= rollEnemy;
    let firstClear = false;
    let reward = null;
    if (won) {
      const already = db.prepare('SELECT 1 FROM user_campaign_clears WHERE tg_id = ? AND stage_id = ?').get(tgId, stageId);
      if (!already) {
        firstClear = true;
        db.prepare('INSERT INTO user_campaign_clears (tg_id, stage_id) VALUES (?,?)').run(tgId, stageId);
        reward = { toman: 0, cardId: null, cardLevel: null };
        if (stage.reward_toman > 0) { adjustToman(tgId, stage.reward_toman, `Campaign reward: ${stage.name}`); reward.toman = stage.reward_toman; }
        if (stage.reward_card_id) {
          grantCardInstance(tgId, stage.reward_card_id, stage.reward_card_level || null);
          reward.cardId = stage.reward_card_id; reward.cardLevel = stage.reward_card_level;
        }
      }
    }
    return { won, myPower, enemyPower: stage.enemy_power, firstClear, reward };
  })();
}
