import db from './db.js';
import { adjustToman } from './db.js';
import { addUserXp } from './rank-db.js';
import { grantCardInstance } from './game-db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS quest_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  quest_count INTEGER NOT NULL DEFAULT 3
);
INSERT OR IGNORE INTO quest_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS quest_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  type TEXT NOT NULL,           -- win_battles | play_battles | buy_card | buy_product | upgrade_cards | deposit_toman | donate_clan | checkin | join_raffle | custom
  target_count INTEGER NOT NULL DEFAULT 1,
  reward_type TEXT NOT NULL,    -- toman | xp | card | extra_games
  reward_value TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_quest_assignments (
  quest_date TEXT NOT NULL,
  template_id INTEGER NOT NULL,
  PRIMARY KEY (quest_date, template_id)
);

CREATE TABLE IF NOT EXISTS user_quest_progress (
  tg_id INTEGER NOT NULL,
  quest_date TEXT NOT NULL,
  template_id INTEGER NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  claimed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tg_id, quest_date, template_id)
);
`);

export function getQuestConfig() { return db.prepare('SELECT * FROM quest_config WHERE id = 1').get(); }
export function setQuestConfig(c) {
  db.prepare('UPDATE quest_config SET enabled=?, quest_count=? WHERE id=1').run(c.enabled ? 1 : 0, c.quest_count);
}
export function listQuestTemplates(onlyActive = false) {
  return onlyActive
    ? db.prepare('SELECT * FROM quest_templates WHERE active = 1 ORDER BY id DESC').all()
    : db.prepare('SELECT * FROM quest_templates ORDER BY id DESC').all();
}
export function upsertQuestTemplate(t) {
  if (t.id) {
    db.prepare(`UPDATE quest_templates SET title=?, type=?, target_count=?, reward_type=?, reward_value=?, active=? WHERE id=?`)
      .run(t.title, t.type, t.target_count, t.reward_type, t.reward_value, t.active ? 1 : 0, t.id);
    return t.id;
  }
  return db.prepare(`INSERT INTO quest_templates (title, type, target_count, reward_type, reward_value, active) VALUES (?,?,?,?,?,?)`)
    .run(t.title, t.type, t.target_count, t.reward_type, t.reward_value, t.active ? 1 : 0).lastInsertRowid;
}
export function deleteQuestTemplate(id) { db.prepare('DELETE FROM quest_templates WHERE id = ?').run(id); }

// Picking "today's quests" deterministically from the date (not stored in the database) —
// meaning it's always computed from the current list of active templates, so with any change the admin makes
// (add/edit/disable) you see the effect immediately, not just from tomorrow
function seededShuffle(arr, seed) {
  let s = seed % 2147483647; if (s <= 0) s += 2147483646;
  const rand = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function getTodaysQuestTemplates() {
  const cfg = getQuestConfig();
  const today = new Date().toISOString().slice(0, 10);
  const templates = listQuestTemplates(true);
  if (templates.length <= cfg.quest_count) return templates;
  const seed = today.split('-').reduce((s, p) => s + Number(p), 0) * 7919;
  return seededShuffle(templates, seed).slice(0, cfg.quest_count);
}

export function getTodayQuestsForUser(tgId) {
  const cfg = getQuestConfig();
  if (!cfg.enabled) return { enabled: false, quests: [] };
  const today = new Date().toISOString().slice(0, 10);
  const todaysTemplates = getTodaysQuestTemplates();
  const quests = todaysTemplates.map(t => {
    const progress = db.prepare('SELECT * FROM user_quest_progress WHERE tg_id=? AND quest_date=? AND template_id=?').get(tgId, today, t.id);
    return { ...t, progress: progress?.progress || 0, claimed: !!progress?.claimed, done: (progress?.progress || 0) >= t.target_count };
  });
  return { enabled: true, quests };
}

// A hook called from other parts (game win, purchase, deposit) to advance today's quest progress
export function incrementQuestProgress(tgId, type, amount = 1) {
  const cfg = getQuestConfig();
  if (!cfg.enabled) return;
  const today = new Date().toISOString().slice(0, 10);
  const todays = getTodaysQuestTemplates().filter(t => t.type === type);
  for (const t of todays) {
    db.prepare(`
      INSERT INTO user_quest_progress (tg_id, quest_date, template_id, progress) VALUES (?,?,?,?)
      ON CONFLICT(tg_id, quest_date, template_id) DO UPDATE SET progress = MIN(progress + excluded.progress, ?)
    `).run(tgId, today, t.id, amount, t.target_count);
  }
}

export function claimQuestReward(tgId, templateId) {
  const today = new Date().toISOString().slice(0, 10);
  const template = getTodaysQuestTemplates().find(t => t.id === templateId);
  if (!template) throw new Error('This quest is not for today');
  const progress = db.prepare('SELECT * FROM user_quest_progress WHERE tg_id=? AND quest_date=? AND template_id=?').get(tgId, today, templateId);
  if (!progress || progress.progress < template.target_count) throw new Error('This quest is not complete yet');
  if (progress.claimed) throw new Error('You have already claimed this quest reward');

  const tx = db.transaction(() => {
    if (template.reward_type === 'toman' && Number(template.reward_value) > 0) {
      adjustToman(tgId, Number(template.reward_value), `Daily quest reward: ${template.title}`);
    } else if (template.reward_type === 'xp' && Number(template.reward_value) > 0) {
      addUserXp(tgId, Number(template.reward_value));
    } else if (template.reward_type === 'card' && template.reward_value) {
      grantCardInstance(tgId, Number(template.reward_value));
    } else if (template.reward_type === 'extra_games' && Number(template.reward_value) > 0) {
      db.prepare(`
        INSERT INTO game_extra_plays (tg_id, extra_plays) VALUES (?, ?)
        ON CONFLICT(tg_id) DO UPDATE SET extra_plays = extra_plays + excluded.extra_plays
      `).run(tgId, Number(template.reward_value));
    }
    db.prepare('UPDATE user_quest_progress SET claimed = 1 WHERE tg_id=? AND quest_date=? AND template_id=?').run(tgId, today, templateId);
  });
  tx();
  return { rewardType: template.reward_type, rewardValue: template.reward_value };
}
