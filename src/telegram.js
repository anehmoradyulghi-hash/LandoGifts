import crypto from 'crypto';

const API = () => `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const TIMEOUT_MS = 8000; // اگه تلگرام تو این مدت جواب نده، دیگه منتظر نمی‌مونیم

async function call(method, payload) {
  try {
    const res = await fetch(`${API()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS), // <- نکته اصلی: بدون این، یه تماس کند/بی‌جواب به API تلگرام کل مینی‌اپ رو برای همیشه قفل می‌کرد
    });
    const data = await res.json();
    if (!data.ok) console.error(`[telegram:${method}]`, data.description || data);
    return data;
  } catch (e) {
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    console.error(`[telegram:${method}] ${timedOut ? 'timeout (۸ ثانیه‌ای رد شد)' : 'network error'}`, e.message);
    return { ok: false, error: e.message, timedOut };
  }
}

export const sendMessage = (chatId, text, extra = {}) =>
  call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

export const sendPhoto = (chatId, photoUrl, caption, extra = {}) =>
  call('sendPhoto', { chat_id: chatId, photo: photoUrl, caption, parse_mode: 'HTML', ...extra });

export const answerCallbackQuery = (id, text) =>
  call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });

export const setWebhook = (url, secretToken) =>
  call('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message', 'callback_query'] });

export const getMe = () => call('getMe', {});

// چک عضویت در کانال، برای تسک‌ها و جوین اجباری
export async function isChannelMember(channelUsername, userId) {
  if (!channelUsername) return true;
  const data = await call('getChatMember', { chat_id: '@' + channelUsername.replace('@', ''), user_id: userId });
  if (!data.ok || !data.result?.status) return true; // اگه چک نشد یا جواب عجیب بود، کاربر رو بی‌دلیل مسدود نکن
  return !['left', 'kicked'].includes(data.result.status);
}

// اعتبارسنجی initData مینی‌اپ طبق مستندات رسمی تلگرام
// هر ورودی عجیب/دستکاری‌شده باعث throw نمی‌شه؛ فقط null برمی‌گرده تا درخواست
// با یه ۴۰۱ تمیز رد بشه، نه با یه ۵۰۰ ناشی از کرش این تابع
export function validateInitData(initData, botToken) {
  try {
    if (!initData || !botToken) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computedHash !== hash) return null;

    const authDate = Number(params.get('auth_date')) * 1000;
    if (!authDate || Date.now() - authDate > 24 * 60 * 60 * 1000) return null;

    const userJson = params.get('user');
    if (!userJson) return null;
    return JSON.parse(userJson);
  } catch (e) {
    console.error('[validateInitData] بدشکل یا دستکاری‌شده بود، رد شد:', e.message);
    return null;
  }
}
