# 🚀 راه‌اندازی روی Termux (گوشی) با دامنه‌ی خودت

این راهنما فرض می‌کنه می‌خوای Lando Gifts رو مستقیم روی گوشی اندرویدت، داخل Termux،
اجرا کنی و با دامنه خودت (نه یه لینک موقت) در دسترس باشه — طوری که با ریستارت گوشی
یا قطعی لحظه‌ای اینترنت هم از کار نیفته.

نکته مهم: گوشی معمولا IP عمومی نداره، پس نمی‌شه مستقیم از بیرون بهش وصل شد. راه‌حل
استاندارد و رایگان همینه که با **Cloudflare Tunnel** دامنه‌ت رو به سرور روی گوشی
وصل کنی؛ نیازی به باز کردن پورت روی روتر نیست.

## ۱) نصب پیش‌نیازها در Termux

```bash
pkg update && pkg upgrade -y
pkg install -y nodejs-lts git python make clang pkg-config sqlite
```

> `better-sqlite3` یه ماژول نیتیوعه و موقع `npm install` کامپایل می‌شه؛ به همین خاطر
> python/make/clang لازمه. اگه کامپایلش خطا داد، `pkg install -y binutils-is-llvm` رو هم امتحان کن.

اجازه بده Termux پس‌زمینه نخوابه:

```bash
termux-wake-lock
```

## ۲) گرفتن پروژه و نصب دیپندنسی‌ها

```bash
cd ~
git clone <آدرس ریپوی گیت‌هابت>
cd lando-gifts
npm install
cp .env.example .env
nano .env   # مقادیر رو پر کن (پایین توضیح داده شده)
```

## ۳) نصب pm2 (برای بالا موندن دائمی و ریستارت خودکار در صورت کرش)

```bash
npm install -g pm2
npm run pm2:start
pm2 save
```

با `pm2 logs lando-gifts` می‌تونی لاگ زنده رو ببینی، و با `pm2 restart lando-gifts` ریستارتش کنی.

## ۴) وصل کردن دامنه‌ی خودت با Cloudflare Tunnel

اول دامنه‌ت رو (اگه قبلا نیست) به Cloudflare اضافه کن (رایگانه) و DNS‌ش رو به Cloudflare بسپار.

```bash
pkg install -y cloudflared
cloudflared tunnel login          # یه لینک میده، تو مرورگر گوشی بازش کن و دامنه رو تایید کن
cloudflared tunnel create lando-gifts
cloudflared tunnel route dns lando-gifts bot.yourdomain.com
```

فایل تنظیمات تانل رو بساز:

```bash
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: lando-gifts
credentials-file: /data/data/com.termux/files/home/.cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: bot.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
EOF
```

(`<TUNNEL-ID>` رو از خروجی دستور `create` بالا کپی کن.)

تانل رو اجرا کن:

```bash
cloudflared tunnel run lando-gifts
```

بهتره این هم با pm2 مدیریت بشه تا اگه قطع شد خودش وصل بشه:

```bash
pm2 start "cloudflared tunnel run lando-gifts" --name cf-tunnel
pm2 save
```

## ۵) تنظیم `.env`

```
BOT_TOKEN=...                      # از BotFather
PUBLIC_URL=https://bot.yourdomain.com
WEBHOOK_SECRET=یه-رشته-رندوم-طولانی
PORT=3000
ADMIN_IDS=123456789
ADMIN_PANEL_PASSWORD=یه-رمز-قوی
```

بعد از پر کردن، سرور رو ریستارت کن:

```bash
pm2 restart lando-gifts
```

سرور موقع بالا اومدن خودش وبهوک رو روی `PUBLIC_URL/telegram-webhook` ثبت می‌کنه. اگه
دامنه یا تانل هنوز آماده نبود، هر ۳۰ ثانیه خودش دوباره تلاش می‌کنه — نیازی نیست کاری بکنی.

مینی‌اپ: `https://bot.yourdomain.com/miniapp`
پنل ادمین: `https://bot.yourdomain.com/admin`

آدرس مینی‌اپ رو تو BotFather (دستور `/mybots` → ربات → Bot Settings → Menu Button)
هم ثبت کن تا از منوی ربات باز بشه.

## ۶) روشن ماندن بعد از ریستارت گوشی

با اپ **Termux:Boot** (از F-Droid نصبش کن، از پلی‌استور حذف شده) می‌تونی موقع
روشن شدن گوشی این‌ها خودکار اجرا بشن:

```bash
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/start-lando-gifts.sh << 'EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
pm2 resurrect
EOF
chmod +x ~/.termux/boot/start-lando-gifts.sh
```

(چون قبلش `pm2 save` زدی، `pm2 resurrect` همون اپ‌هایی که داشتی رو برمی‌گردونه.)

## ۷) اگه بعدا خواستی از Termux به یه VPS واقعی (Ubuntu) کوچ کنی

روند مشابهه فقط به‌جای Cloudflare Tunnel می‌تونی مستقیم:
1. `npm install -g pm2 && npm run pm2:start && pm2 save && pm2 startup`
2. Nginx به‌عنوان ریورس‌پروکسی جلوی پورت ۳۰۰۰ + گواهی SSL رایگان با `certbot --nginx -d bot.yourdomain.com`
3. باز هم `PUBLIC_URL=https://bot.yourdomain.com` رو تو `.env` بذار.

## چرا این نسخه دیگه هنگ/متوقف نمی‌شه

- هر خطای پیش‌بینی‌نشده تو یه درخواست، جلوی کل سرور رو نمی‌گیره — لاگ می‌شه و پاسخ خطا برمی‌گرده، نه کرش.
- پردازش وبهوک تلگرام تو یه تابع جدا و توی `try/catch` هست؛ یه آپدیت بد نمی‌تونه بقیه ربات رو بخوابونه.
- ثبت وبهوک اگه اول بار (مثلا موقع بالا اومدن تانل) شکست بخوره، هر ۳۰ ثانیه دوباره تلاش می‌کنه.
- `pm2` با `autorestart` هر کرش ناگهانی پروسه رو در کمتر از چند ثانیه دوباره بالا میاره.
- صف مسابقه بازی کاملا سینکرون (بدون await وسطش) پیاده شده تا هیچ‌وقت دو نفر با هم قاطی نشن یا نتیجه گم بشه.
