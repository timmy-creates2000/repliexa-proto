const express = require('express');
const axios = require('axios');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

// In-memory storage
const conversations = new Map();
// Store user configs: { botToken: { openAiKey, systemPrompt, whatsappToken, phoneNumberId } }
const userConfigs = new Map();

// Self-ping to keep Render free tier awake (prevents spin-down)
const SELF_PING_INTERVAL = 10 * 60 * 1000; // 10 minutes (Render spins down after 15 min)
const SERVER_URL = process.env.RENDER_EXTERNAL_URL || process.env.SERVER_URL || 'http://localhost';

function keepAlive() {
  if (SERVER_URL && SERVER_URL !== 'http://localhost') {
    https.get(SERVER_URL, (res) => {
      console.log(`[Keep-Alive] Self-ping successful: ${res.statusCode}`);
    }).on('error', (err) => {
      console.log(`[Keep-Alive] Self-ping failed: ${err.message}`);
    });
  }
}

// Start keep-alive ping
setInterval(keepAlive, SELF_PING_INTERVAL);
console.log(`[Keep-Alive] Enabled - pinging every ${SELF_PING_INTERVAL / 60000} minutes`);

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Repliexa Webhook Server is running!',
    timestamp: new Date().toISOString(),
    connectedUsers: userConfigs.size
  });
});

// Store user config (called from Flutter app when user connects)
app.post('/config/telegram', (req, res) => {
  const { botToken, openAiKey, systemPrompt } = req.body;
  
  if (!botToken || !openAiKey) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  
  userConfigs.set(botToken, {
    openAiKey,
    systemPrompt: systemPrompt || 'You are a helpful assistant.',
    type: 'telegram'
  });
  
  console.log(`[Config] Telegram bot registered: ${botToken.substring(0, 10)}...`);
  res.json({ success: true, message: 'Telegram config saved' });
});

// Store WhatsApp config
app.post('/config/whatsapp', (req, res) => {
  const { phoneNumberId, whatsappToken, openAiKey, systemPrompt } = req.body;
  
  if (!phoneNumberId || !whatsappToken || !openAiKey) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  
  userConfigs.set(phoneNumberId, {
    whatsappToken,
    openAiKey,
    systemPrompt: systemPrompt || 'You are a helpful assistant.',
    type: 'whatsapp'
  });
  
  console.log(`[Config] WhatsApp registered: ${phoneNumberId}`);
  res.json({ success: true, message: 'WhatsApp config saved' });
});

// Telegram webhook endpoint (with bot token in URL)
// Webhook URL format: /webhook/telegram/{botToken}
app.post('/webhook/telegram/:botToken?', async (req, res) => {
  try {
    console.log('Telegram webhook received');
    
    const { message } = req.body;
    if (!message || !message.text) {
      return res.sendStatus(200);
    }

    const chatId = message.chat.id;
    const userMessage = message.text;
    
    // Get bot token from URL param or try to find in stored configs
    let botToken = req.params.botToken;
    
    // If no token in URL, try to find by looking through configs
    if (!botToken) {
      // Try to match by checking getUpdates or using the stored config
      // For now, use the first stored telegram config
      for (const [token, config] of userConfigs.entries()) {
        if (config.type === 'telegram') {
          botToken = token;
          break;
        }
      }
    }
    
    if (!botToken) {
      console.log('No bot token found');
      return res.sendStatus(200);
    }

    // Get stored config
    const config = userConfigs.get(botToken);
    if (!config) {
      console.log('No config found for bot token');
      return res.sendStatus(200);
    }

    const openAiKey = config.openAiKey;
    const systemPrompt = config.systemPrompt;

    // Get conversation history
    const conversationKey = `telegram_${chatId}`;
    let history = conversations.get(conversationKey) || [];
    
    // Add user message to history
    history.push({ role: 'user', content: userMessage });
    
    // Keep only last 10 messages for context
    if (history.length > 10) {
      history = history.slice(-10);
    }

    // Call OpenAI
    const openAiResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          ...history
        ],
        max_tokens: 500
      },
      {
        headers: {
          'Authorization': `Bearer ${openAiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const aiReply = openAiResponse.data.choices[0].message.content;
    
    // Add AI response to history
    history.push({ role: 'assistant', content: aiReply });
    conversations.set(conversationKey, history);

    // Send reply back to Telegram
    await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: chatId,
        text: aiReply,
        parse_mode: 'HTML'
      }
    );

    console.log('Reply sent successfully');
    res.sendStatus(200);
    
  } catch (error) {
    console.error('Error processing webhook:', error.message);
    res.sendStatus(200); // Always return 200 to Telegram
  }
});

// WhatsApp webhook verification (Meta requirement)
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // You should set this in environment variables
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'repliexa_verify_token';

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WhatsApp webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// WhatsApp webhook endpoint
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    console.log('WhatsApp webhook received');
    
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) {
      return res.sendStatus(200);
    }

    const message = messages[0];
    const from = message.from;
    const userMessage = message.text?.body;

    if (!userMessage) {
      return res.sendStatus(200);
    }

    const phoneNumberId = value.metadata?.phone_number_id;
    
    // Get stored config
    const config = userConfigs.get(phoneNumberId);
    if (!config) {
      console.log('No config found for phone number ID:', phoneNumberId);
      return res.sendStatus(200);
    }

    const accessToken = config.whatsappToken;
    const openAiKey = config.openAiKey;
    const systemPrompt = config.systemPrompt;

    // Get conversation history
    const conversationKey = `whatsapp_${from}`;
    let history = conversations.get(conversationKey) || [];
    
    // Add user message to history
    history.push({ role: 'user', content: userMessage });
    
    // Keep only last 10 messages
    if (history.length > 10) {
      history = history.slice(-10);
    }

    // Call OpenAI
    const openAiResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          ...history
        ],
        max_tokens: 500
      },
      {
        headers: {
          'Authorization': `Bearer ${openAiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const aiReply = openAiResponse.data.choices[0].message.content;
    
    // Add AI response to history
    history.push({ role: 'assistant', content: aiReply });
    conversations.set(conversationKey, history);

    // Send reply back to WhatsApp
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: from,
        type: 'text',
        text: { body: aiReply }
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('WhatsApp reply sent successfully');
    res.sendStatus(200);
    
  } catch (error) {
    console.error('Error processing WhatsApp webhook:', error.message);
    res.sendStatus(200);
  }
});

// Get conversation history endpoint
app.get('/conversations/:platform/:id', (req, res) => {
  const { platform, id } = req.params;
  const key = `${platform}_${id}`;
  const history = conversations.get(key) || [];
  res.json({ platform, id, messages: history });
});

// Clear conversation endpoint
app.delete('/conversations/:platform/:id', (req, res) => {
  const { platform, id } = req.params;
  const key = `${platform}_${id}`;
  conversations.delete(key);
  res.json({ message: 'Conversation cleared' });
});

// ========== WHATSAPP QR CODE (BAILEYS) ==========
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

// Store Baileys sessions
const baileysSessions = new Map();

// Start WhatsApp QR session
app.post('/whatsapp-qr/start', async (req, res) => {
  const { sessionId, openAiKey, systemPrompt } = req.body;
  
  if (!sessionId || !openAiKey) {
    return res.status(400).json({ success: false, message: 'Missing sessionId or openAiKey' });
  }

  try {
    // Create auth state directory for this session
    const authDir = `/tmp/baileys_auth_${sessionId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
    });

    baileysSessions.set(sessionId, {
      sock,
      openAiKey,
      systemPrompt: systemPrompt || 'You are a helpful assistant.',
      saveCreds
    });

    // Handle QR code
    sock.ev.on('connection.update', async (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        // Generate QR code data URL
        const qrDataUrl = await QRCode.toDataURL(qr);
        
        // Store QR for retrieval
        const session = baileysSessions.get(sessionId);
        if (session) {
          session.qrCode = qrDataUrl;
          session.qrText = qr;
        }
        
        console.log(`[WhatsApp QR] Generated for session: ${sessionId}`);
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log(`[WhatsApp QR] Connection closed for ${sessionId}, reconnect: ${shouldReconnect}`);
        
        if (!shouldReconnect) {
          baileysSessions.delete(sessionId);
        }
      }

      if (connection === 'open') {
        console.log(`[WhatsApp QR] Connected for session: ${sessionId}`);
        const session = baileysSessions.get(sessionId);
        if (session) {
          session.connected = true;
          session.qrCode = null; // Clear QR after connection
        }
      }
    });

    // Handle incoming messages
    sock.ev.on('messages.upsert', async (m) => {
      const session = baileysSessions.get(sessionId);
      if (!session || !session.connected) return;

      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text;

      if (!messageText) return;

      console.log(`[WhatsApp QR] Message from ${from}: ${messageText}`);

      try {
        // Get conversation history
        const conversationKey = `whatsappqr_${from}`;
        let history = conversations.get(conversationKey) || [];
        history.push({ role: 'user', content: messageText });
        if (history.length > 10) history = history.slice(-10);

        // Call OpenAI
        const openAiResponse = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-3.5-turbo',
            messages: [
              { role: 'system', content: session.systemPrompt },
              ...history
            ],
            max_tokens: 500
          },
          {
            headers: {
              'Authorization': `Bearer ${session.openAiKey}`,
              'Content-Type': 'application/json'
            }
          }
        );

        const aiReply = openAiResponse.data.choices[0].message.content;
        history.push({ role: 'assistant', content: aiReply });
        conversations.set(conversationKey, history);

        // Send reply
        await sock.sendMessage(from, { text: aiReply });
        console.log(`[WhatsApp QR] Reply sent to ${from}`);

      } catch (error) {
        console.error('[WhatsApp QR] Error:', error.message);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    res.json({ success: true, message: 'WhatsApp QR session started' });

  } catch (error) {
    console.error('[WhatsApp QR] Start error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get QR code
app.get('/whatsapp-qr/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = baileysSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ success: false, message: 'Session not found' });
  }

  if (session.connected) {
    return res.json({ success: true, connected: true, message: 'Already connected' });
  }

  if (session.qrCode) {
    return res.json({ 
      success: true, 
      connected: false, 
      qrCode: session.qrCode,
      qrText: session.qrText 
    });
  }

  return res.json({ success: true, connected: false, message: 'QR code not ready yet' });
});

// Check connection status
app.get('/whatsapp-qr/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const session = baileysSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ success: false, message: 'Session not found' });
  }

  res.json({ 
    success: true, 
    connected: session.connected || false 
  });
});

// Disconnect session
app.post('/whatsapp-qr/:sessionId/disconnect', async (req, res) => {
  const { sessionId } = req.params;
  const session = baileysSessions.get(sessionId);

  if (session && session.sock) {
    await session.sock.logout();
    baileysSessions.delete(sessionId);
  }

  res.json({ success: true, message: 'Disconnected' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Repliexa webhook server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/`);
  console.log(`Telegram webhook: POST http://localhost:${PORT}/webhook/telegram`);
  console.log(`WhatsApp webhook: POST http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`WhatsApp QR: POST http://localhost:${PORT}/whatsapp-qr/start`);
});
