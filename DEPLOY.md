# LandoGifts Super MiniApp Deployment Guide

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Environment Setup**:
   Copy `.env.example` to `.env` and fill in your values:
   ```bash
   cp .env.example .env
   ```

3. **Start Server**:
   ```bash
   npm start
   ```

4. **PM2 Production Setup**:
   ```bash
   pm2 start ecosystem.config.cjs
   ```
