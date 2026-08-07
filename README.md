# 🎁 Lando Gifts

A Telegram mini app for a gift shop and marketplace, with a Lando Coin (LNDC) wallet plus a multi-currency wallet. **Everything is manual and admin-controlled** —
no automatic payment gateway and no external pricing API is connected:

- Wallet top-ups only via card-to-card transfer + manual admin approval
- Withdrawals only with manual admin approval
- Digital currency rates (USDT / TON / anything else you add) are entered manually by the admin from the panel
- Digital currency deposits and withdrawals also go through manual admin approval (the user submits a transaction hash/address, the admin checks and approves it)

## Features

- 🛍 Product/gift shop with payment from the LNDC wallet
- 💳 LNDC wallet + transaction history
- 💱 Multi-currency wallet (manual) + LNDC⇄currency conversion at admin-set rates
- 🎁 Consignment gift market between users (the seller posts a listing, the buyer's payment is held in escrow, the funds are released once gift receipt is confirmed)
- 🎮 **Card game**: buy cards from the shop, paid upgrades or free merging (sacrificing a similar card), build a deck and enter the match queue (instant, fully automatic matchmaking), a leaderboard with configurable prizes and periodic resets, a daily play limit + extra game purchases, and card tasks (rewarded with a specific card)
- 👥 Referral system with automatic commission from a referral's purchases
- ✅ Manageable tasks (e.g. channel membership) with LNDC rewards
- 🆘 In-app support tickets (chat with the admin)
- 🔐 A simple admin panel (no framework, plain HTML/JS) for managing every section

## Installation

```bash
npm install
cp .env.example .env
# fill in .env (especially BOT_TOKEN, PUBLIC_URL, ADMIN_IDS, ADMIN_PANEL_PASSWORD, WEBHOOK_SECRET, DATABASE_URL, REDIS_URL)
npm run migrate
npm start
```

Migrating an existing deployment from the old SQLite database? See **[MIGRATION.md](./MIGRATION.md)**.

Want to run it on your own phone (Termux) with your own domain, always on?
Read the full step-by-step guide in **[DEPLOY.md](./DEPLOY.md)** (covers pm2 for auto-restart and Cloudflare Tunnel to connect a domain without needing a public IP).

Once the server is up:
- Mini app at `PUBLIC_URL/miniapp`
- Admin panel at `PUBLIC_URL/admin`

Also register the mini app URL (`PUBLIC_URL/miniapp`) as the bot's Menu Button in BotFather.

## Project structure

```
src/
  server.js      # mini app API routes + Telegram webhook
  db.js          # core database layer (users, wallet, shop, gifts, tasks, tickets)
  db-core.js     # PostgreSQL connection layer (async db.prepare().get/all/run shim)
  redis.js       # Redis client (admin panel sessions)
  game-db.js     # card game database layer (cards, queue/matches, leaderboard)
  telegram.js    # Bot API helper + initData validation
  admin-api.js   # admin panel API routes (password + session token)
public/
  index.html     # mini app frontend (vanilla JS, no framework)
admin/
  index.html     # admin panel frontend (vanilla JS)
migrations/      # PostgreSQL schema, one file per feature area
scripts/
  migrate.js                     # applies pending migrations
  migrate-data-from-sqlite.js    # one-time data copy from an old SQLite deployment
ecosystem.config.cjs  # pm2 config for auto-restart
DEPLOY.md        # full deployment guide for Termux + a personal domain
MIGRATION.md     # guide for migrating an existing SQLite deployment to PostgreSQL
```

## About the database

This project uses PostgreSQL (via `pg`) for data and Redis for admin panel sessions. See [MIGRATION.md](./MIGRATION.md) for setup and for migrating data from an older SQLite-based deployment.

When deploying to a host like Railway/Render, make sure your PostgreSQL and Redis instances are persistent (managed services, not local containers that reset), and that the `uploads/` folder has a persistent volume — otherwise uploaded images are lost on every restart.

## Pushing to GitHub

```bash
git init
git add .
git commit -m "Lando Gifts - initial commit"
git branch -M main
git remote add origin <your GitHub repo URL>
git push -u origin main
```
