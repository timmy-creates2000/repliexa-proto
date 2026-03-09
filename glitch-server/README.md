# Repliexa Webhook Server

Free webhook handler for Repliexa AI Receptionist. Deploys on Render.com (free hosting with auto keep-alive).

## Features

- ✅ Telegram bot webhook handler
- ✅ WhatsApp Business API webhook handler
- ✅ OpenAI GPT integration
- ✅ Conversation history
- ✅ CORS enabled
- ✅ FREE hosting on Glitch

## Deploy to Render.com

### Step 1: Create Render Account
1. Go to https://render.com
2. Click "Get Started for Free"
3. Sign up with GitHub (easiest)
4. Verify email

### Step 2: Create New Web Service
1. Click "New" → "Web Service"
2. Connect your GitHub repo OR use "Build and deploy from a Git repository"
3. If no repo, use "Create a new Web Service from scratch"

### Step 3: Configure Service
1. Name: `repliexa-webhook`
2. Region: Choose closest to you (e.g., Ohio US East)
3. Branch: `main`
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Instance Type: **Free**
7. Click "Create Web Service"

### Step 4: Upload Files (Alternative Method)
If not using GitHub:
1. Install Render CLI: `npm install -g @render/cli`
2. Or use Render Dashboard → "Upload Files"
3. Upload `package.json` and `server.js`

### Step 5: Get Your URL
1. Wait for deployment (2-3 minutes)
2. Your URL will be: `https://repliexa-webhook.onrender.com`
3. This is your webhook URL!

## API Endpoints

### Health Check
```
GET /
```

### Telegram Webhook
```
POST /webhook/telegram
Headers:
  x-bot-token: YOUR_TELEGRAM_BOT_TOKEN
  x-openai-key: YOUR_OPENAI_API_KEY
  x-system-prompt: Your custom AI prompt (optional)
```

### WhatsApp Webhook
```
GET /webhook/whatsapp   (for verification)
POST /webhook/whatsapp  (for messages)
Headers:
  x-whatsapp-token: YOUR_WHATSAPP_ACCESS_TOKEN
  x-openai-key: YOUR_OPENAI_API_KEY
  x-system-prompt: Your custom AI prompt (optional)
```

### Get Conversation
```
GET /conversations/telegram/:chatId
GET /conversations/whatsapp/:phoneNumber
```

## Setup in Your Flutter App

### For Telegram:
1. Deploy this server to Glitch
2. Get your Glitch URL: `https://your-project.glitch.me`
3. In your Flutter app, set webhook URL to: `https://your-project.glitch.me/webhook/telegram`
4. Add headers when calling:
   - `x-bot-token`: Telegram bot token
   - `x-openai-key`: OpenAI API key
   - `x-system-prompt`: Your AI prompt

### For WhatsApp:
1. In Meta Developer Dashboard, set webhook URL to: `https://your-project.glitch.me/webhook/whatsapp`
2. Set verify token to: `repliexa_verify_token`
3. Add headers when calling:
   - `x-whatsapp-token`: WhatsApp access token
   - `x-openai-key`: OpenAI API key
   - `x-system-prompt`: Your AI prompt

## How It Works

1. Customer sends message to Telegram/WhatsApp bot
2. Platform sends webhook to your Glitch server
3. Server calls OpenAI with conversation history
4. OpenAI generates reply
5. Server sends reply back to customer
6. Conversation stored in memory (resets on server restart)

## Free Tier Limits (Render)

- ✅ Unlimited requests
- ✅ 750 hours/month (always enough)
- ⚠️ Spins down after 15 min inactivity (BUT we have auto keep-alive!)
- ✅ Auto wake-up on request

## Keep-Alive Feature (Built-in)

This server has **automatic keep-alive** built in! It pings itself every 10 minutes to prevent spin-down.

No need for external ping services or Flutter app pings!

### How it works:
- Server pings itself every 10 minutes
- Prevents Render free tier spin-down
- Stays awake 24/7 automatically
- Logs show: `[Keep-Alive] Self-ping successful`

## Troubleshooting

### Server sleeping?
- First request may be slow (server waking up)
- Use ping service or keep-alive in Flutter app

### Webhook not working?
- Check Glitch logs (Tools → Logs)
- Verify headers are sent correctly
- Check OpenAI API key is valid

### Need more power?
- Upgrade to Glitch Pro ($8/month)
- Or deploy to Railway/Render (free tier)

## Support

For issues, check Glitch logs or contact support.
