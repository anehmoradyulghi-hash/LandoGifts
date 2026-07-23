// telegram.js — سازگار با server.js و admin-api.js جدید
const BOT_TOKEN = process.env.BOT_TOKEN || '';

async function tgApi(method, payload = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Telegram API error: ${res.status}`);
  return res.json();
}

export function sendMessage(chatId, text, extra = {}) {
  return tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

export function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
  return tgApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: showAlert });
}

export function answerInlineQuery(inlineQueryId, results = []) {
  return tgApi('answerInlineQuery', { inline_query_id: inlineQueryId, results });
}

export async function getChatMember(chatId, userId) {
  const data = await tgApi('getChatMember', { chat_id: chatId, user_id: userId });
  return data.result || null;
}

export function setWebhook(url, secretToken) {
  return tgApi('setWebhook', { url, secret_token: secretToken });
}

export function deleteWebhook(dropPending = true) {
  return tgApi('deleteWebhook', { drop_pending_updates: dropPending });
}

// ↓↓↓ برای سازگاری با کدهای قدیمی ↓↓↓
export async function isChannelMember(channel, userId) {
  try {
    const member = await getChatMember(channel, userId);
    return member && ['member', 'administrator', 'creator'].includes(member.status);
  } catch (e) {
    return false;
  }
}

export function validateInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const user = params.get('user');
    if (!user) return null;
    return JSON.parse(user);
  } catch (e) {
    return null;
  }
}

export async function getMe() {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
  return res.json();
}
