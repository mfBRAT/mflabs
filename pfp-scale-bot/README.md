# PFP Scale Bot

Watches a Discord channel for image uploads and replies with a scaled version + size buttons (400, 512, 800, 1024). Built for pixel art communities.

---

## Requirements

- Node.js 18 or higher — https://nodejs.org
- A Discord bot token (see setup below)

---

## Setup

### 1. Create your Discord bot

1. Go to https://discord.com/developers/applications
2. Click **New Application** → give it a name (e.g. "PFP Scale")
3. Go to **Bot** in the left sidebar
4. Click **Reset Token** and copy the token — you'll need this in a moment
5. Under **Privileged Gateway Intents**, enable **Message Content Intent**
6. Save changes

### 2. Invite the bot to your server

1. Go to **OAuth2 → URL Generator** in the left sidebar
2. Under Scopes, check: `bot`
3. Under Bot Permissions, check: `Read Messages/View Channels`, `Send Messages`, `Attach Files`, `Read Message History`
4. Copy the generated URL and open it in your browser to invite the bot

### 3. Get your channel ID

1. In Discord, go to **User Settings → Advanced** and enable **Developer Mode**
2. Right-click the channel you want the bot to watch
3. Click **Copy Channel ID**

### 4. Configure the bot

1. Copy `.env.example` to `.env`
2. Fill in your bot token and channel ID:

```
BOT_TOKEN=your_token_here
WATCHED_CHANNEL_ID=your_channel_id_here
```

### 5. Install and run

```bash
npm install
npm start
```

---

## Keeping it running (optional)

Install PM2 to keep the bot alive in the background:

```bash
npm install -g pm2
pm2 start bot.js --name pfp-scale-bot
pm2 save
pm2 startup
```

---

## How it works

1. Someone posts an image in the watched channel
2. Bot replies with a 400×400 scaled version (nearest-neighbor, pixel-perfect)
3. Buttons appear for 400 · X PFP, 512, 800, 1024
4. Clicking a button re-scales and updates the reply
5. Buttons disable after 5 minutes

---

## Troubleshooting

- **Bot doesn't respond** — check that Message Content Intent is enabled in the Developer Portal
- **"Missing Access" error** — make sure the bot has permission to read and send messages in the watched channel
- **Sharp install fails** — run `npm install --ignore-scripts` then `npm rebuild sharp`
