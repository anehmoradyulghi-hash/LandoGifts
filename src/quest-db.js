import db from './db.js';
import { adjustToman } from './db.js';
import { addUserXp } from './rank-db.js';
import { grantCardInstance } from './game-db.js';

export async function getQuestConfig() { return await db.prepare('SELECT * FROM quest_config WHERE id = 1').get(); }
export async function setQuestConfig(c) {
  await db.prepare('UPDATE quest_config SET enabled=?, quest_count=? WHERE id=1').run(c.enabled ? 1 : 0, c.quest_count);
}
export async function listQuestTemplates(onlyActive = false) {
  return onlyActive
    ? await db.prepare('SELECT * FROM quest_templates WHERE active = 1 ORDER BY id DESC').all()
    : await db.prepare('SELECT * FROM quest_templates ORDER BY id DESC').all();
}
export async function upsertQuestTemplate(t) {
  if (t.id) {
    await db.prepare(`UPDATE quest_templates SET title=?, type=?, target_count=?, reward_type=?, reward_value=?, active=? WHERE id=?`)
      .run(t.title, t.type, t.target_count, t.reward_type, t.reward_value, t.active ? 1 : 0, t.id);
    return t.id;
  }
  return (await db.prepare(`INSERT INTO quest_templates (title, type, target_count, reward_type, reward_value, active) VALUES (?,?,?,?,?,?)`)
    .run(t.title, t.type, t.target_count, t.reward_type, t.reward_value, t.active ? 1 : 0)).lastInsertRowid;
}
export async function deleteQuestTemplate(id) { await db.prepare('DELETE FROM quest_templates WHERE id = ?').run(id); }

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
async function getTodaysQuestTemplates() {
  const cfg = await getQuestConfig();
  const today = new Date().toISOString().slice(0, 10);
  const templates = await listQuestTemplates(true);
  if (templates.length <= cfg.quest_count) return templates;
  const seed = today.split('-').reduce((s, p) => s + Number(p), 0) * 7919;
  return seededShuffle(templates, seed).slice(0, cfg.quest_count);
}

export async function getTodayQuestsForUser(tgId) {
  const cfg = await getQuestConfig();
  if (!cfg.enabled) return { enabled: false, quests: [] };
  const today = new Date().toISOString().slice(0, 10);
  const todaysTemplates = await getTodaysQuestTemplates();
  const quests = await Promise.all(todaysTemplates.map(async t => {
    const progress = await db.prepare('SELECT * FROM user_quest_progress WHERE tg_id=? AND quest_date=? AND template_id=?').get(tgId, today, t.id);
    return { ...t, progress: progress?.progress || 0, claimed: !!progress?.claimed, done: (progress?.progress || 0) >= t.target_count };
  }));
  return { enabled: true, quests };
}

// A hook called from other parts (game win, purchase, deposit) to advance today's quest progress
export async function incrementQuestProgress(tgId, type, amount = 1) {
  const cfg = await getQuestConfig();
  if (!cfg.enabled) return;
  const today = new Date().toISOString().slice(0, 10);
  const todays = (await getTodaysQuestTemplates()).filter(t => t.type === type);
  for (const t of todays) {
    await db.prepare(`
      INSERT INTO user_quest_progress (tg_id, quest_date, template_id, progress) VALUES (?,?,?,?)
      ON CONFLICT(tg_id, quest_date, template_id) DO UPDATE SET progress = MIN(progress + excluded.progress, ?)
    `).run(tgId, today, t.id, amount, t.target_count);
  }
}

export async function claimQuestReward(tgId, templateId) {
  const today = new Date().toISOString().slice(0, 10);
  const template = (await getTodaysQuestTemplates()).find(t => t.id === templateId);
  if (!template) throw new Error('This quest is not for today');
  const progress = await db.prepare('SELECT * FROM user_quest_progress WHERE tg_id=? AND quest_date=? AND template_id=?').get(tgId, today, templateId);
  if (!progress || progress.progress < template.target_count) throw new Error('This quest is not complete yet');
  if (progress.claimed) throw new Error('You have already claimed this quest reward');

  const tx = db.transaction(async () => {
    if (template.reward_type === 'toman' && Number(template.reward_value) > 0) {
      await adjustToman(tgId, Number(template.reward_value), `Daily quest reward: ${template.title}`);
    } else if (template.reward_type === 'xp' && Number(template.reward_value) > 0) {
      await addUserXp(tgId, Number(template.reward_value));
    } else if (template.reward_type === 'card' && template.reward_value) {
      await grantCardInstance(tgId, Number(template.reward_value));
    } else if (template.reward_type === 'extra_games' && Number(template.reward_value) > 0) {
      await db.prepare(`
        INSERT INTO game_extra_plays (tg_id, extra_plays) VALUES (?, ?)
        ON CONFLICT(tg_id) DO UPDATE SET extra_plays = extra_plays + excluded.extra_plays
      `).run(tgId, Number(template.reward_value));
    }
    await db.prepare('UPDATE user_quest_progress SET claimed = 1 WHERE tg_id=? AND quest_date=? AND template_id=?').run(tgId, today, templateId);
  });
  await tx();
  return { rewardType: template.reward_type, rewardValue: template.reward_value };
}
