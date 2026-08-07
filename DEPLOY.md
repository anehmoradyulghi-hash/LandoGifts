# 🚀 Deploying on Termux (phone) with your own domain

This guide assumes you want to run Lando Gifts directly on your Android phone, inside
Termux, and have it reachable at your own domain (not a temporary link) — so it keeps
working through phone restarts or brief internet drops.

Important note: a phone usually doesn't have a public IP, so it can't be reached
directly from outside. The standard free solution is to connect your domain to the
server on your phone with **Cloudflare Tunnel**; no router port-forwarding needed.

You'll also need a PostgreSQL database and a Redis instance — see step 2a below for the
easiest way to get both without self-hosting them on the phone.

## 1) Install prerequisites in Termux

```bash
pkg update && pkg upgrade -y
pkg install -y nodejs-lts git postgresql-client redis
```

> `better-sqlite3` (used only by the one-time SQLite→Postgres data migration script, if
> you're migrating an existing deployment) is a native module that needs compiling. If
> you need it, also run `pkg install -y python make clang pkg-config` first, and if the
> build fails, try `pkg install -y binutils-is-llvm` too. If you're starting fresh
> (no old SQLite data to migrate), you can skip this entirely.

Keep Termux from being killed in the background:

```bash
termux-wake-lock
```

## 2) Get the project and install dependencies

```bash
cd ~
git clone <your GitHub repo URL>
cd lando-gifts
npm install
cp .env.example .env
nano .env   # fill in the values (explained below)
```

## 2a) PostgreSQL and Redis

The easiest option is a free/low-cost managed instance (Railway, Supabase, Neon, or
similar for Postgres; Upstash or Railway for Redis) — copy the connection strings they
give you into `DATABASE_URL` and `REDIS_URL` in `.env`. Managed hosting means you don't
have to keep a database process alive on the phone itself, which is more reliable.

If you'd rather self-host Redis on the phone:
```bash
redis-server --daemonize yes
```

Once `DATABASE_URL` is set, create the schema:
```bash
npm run migrate
```

Migrating data from an older SQLite-based deployment of this project? See
[MIGRATION.md](./MIGRATION.md) for `npm run migrate:data`.

## 3) Install pm2 (to keep the app running and auto-restart it if it crashes)

```bash
npm install -g pm2
npm run pm2:start
pm2 save
```

Use `pm2 logs lando-gifts` to watch live logs, and `pm2 restart lando-gifts` to restart it.

## 4) Connecting your domain with Cloudflare Tunnel

First add your domain to Cloudflare (if it isn't already — it's free) and point its DNS
to Cloudflare.

```bash
pkg install -y cloudflared
cloudflared tunnel login          # gives you a link — open it in your phone's browser and confirm the domain
cloudflared tunnel create lando-gifts
cloudflared tunnel route dns lando-gifts bot.yourdomain.com
```

Create the tunnel config file:

```bash
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml << 'CFG_EOF'
tunnel: lando-gifts
credentials-file: /data/data/com.termux/files/home/.cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: bot.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
CFG_EOF
```

(Copy `<TUNNEL-ID>` from the output of the `create` command above.)

Run the tunnel:

```bash
cloudflared tunnel run lando-gifts
```

It's best to also manage this with pm2, so it reconnects automatically if it drops:

```bash
pm2 start "cloudflared tunnel run lando-gifts" --name cf-tunnel
pm2 save
```

## 5) Configuring `.env`

```
BOT_TOKEN=...                      # from BotFather
PUBLIC_URL=https://bot.yourdomain.com
WEBHOOK_SECRET=a-long-random-string
PORT=3000
DATABASE_URL=postgres://user:password@host:5432/lando_gifts
REDIS_URL=redis://127.0.0.1:6379
ADMIN_IDS=123456789
ADMIN_PANEL_PASSWORD=a-strong-password
```

After filling it in, restart the server:

```bash
pm2 restart lando-gifts
```

On startup, the server registers its own webhook at `PUBLIC_URL/telegram-webhook`. If
the domain or tunnel isn't ready yet, it automatically retries every 30 seconds — you
don't need to do anything.

Mini app: `https://bot.yourdomain.com/miniapp`
Admin panel: `https://bot.yourdomain.com/admin`

Also register the mini app URL in BotFather (`/mybots` → your bot → Bot Settings → Menu
Button) so it opens from the bot's menu.

## 6) Staying on after a phone restart

With the **Termux:Boot** app (install it from F-Droid — it's been removed from the Play
Store) you can have all of this start automatically when the phone boots:

```bash
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/start-lando-gifts.sh << 'BOOT_EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
pm2 resurrect
BOOT_EOF
chmod +x ~/.termux/boot/start-lando-gifts.sh
```

(Since you already ran `pm2 save` earlier, `pm2 resurrect` brings back the same apps you had running.)

## 7) If you later want to move from Termux to a real VPS (Ubuntu)

The process is similar, except instead of Cloudflare Tunnel you can go directly:
1. `npm install -g pm2 && npm run pm2:start && pm2 save && pm2 startup`
2. Nginx as a reverse proxy in front of port 3000 + a free SSL certificate via `certbot --nginx -d bot.yourdomain.com`
3. Set `PUBLIC_URL=https://bot.yourdomain.com` in `.env` as before.
4. Use a proper managed PostgreSQL/Redis instance rather than anything running on the same box, for reliability.

## Why this version doesn't hang or crash anymore

- An unexpected error in one request doesn't take down the whole server — it's logged and an error response is returned, not a crash.
- Telegram webhook processing runs in its own function wrapped in `try/catch`; one bad update can't put the rest of the bot to sleep.
- If webhook registration fails on first try (e.g. while the tunnel is still coming up), it automatically retries every 30 seconds.
- `pm2` with `autorestart` brings the process back up within seconds of any sudden crash.
- The game match queue is written to avoid overlapping/interleaved writes, so two players never get mismatched or a result never gets lost.
- Every database call goes through a connection pool (`pg`), so many requests can be handled concurrently without one slow query blocking everything else.
