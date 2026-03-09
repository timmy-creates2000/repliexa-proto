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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Repliexa webhook server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/`);
  console.log(`Telegram webhook: POST http://localhost:${PORT}/webhook/telegram`);
  console.log(`WhatsApp webhook: POST http://localhost:${PORT}/webhook/whatsapp`);
});
