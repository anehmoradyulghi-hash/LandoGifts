import TelegramBot from 'node-telegram-bot-api';

export function setupTelegramBot() {
    const token = process.env.BOT_TOKEN;
    if (!token) {
        console.warn("BOT_TOKEN is not set in environment variables. Telegram bot initialization skipped.");
        return;
    }

    const bot = new TelegramBot(token, { polling: true });

    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const supportUser = process.env.SUPPORT_USERNAME || "YourSupportHandle";
        
        const options = {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: "🚀 Open Super MiniApp",
                            web_app: { url: process.env.MINI_APP_URL || "https://your-domain.com" }
                        }
                    ],
                    [
                        {
                            text: "🎧 Support / پشتیبانی",
                            url: `https://t.me/${supportUser}`
                        }
                    ]
                ]
            }
        };

        bot.sendMessage(chatId, "خوش آمدید! برای ورود به مینی‌اپ یا ارتباط با پشتیبانی از دکمه‌های زیر استفاده کنید:", options);
    });

    console.log("Telegram bot active.");
}
