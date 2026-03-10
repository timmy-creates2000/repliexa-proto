/**
 * Repliexa — Render Express Server
 * 
 * Webhook handlers for Telegram and WhatsApp
 * AI message processing with OpenAI GPT
 * Customer and conversation management
 */

const express = require('express');
const admin = require('firebase-admin');
const OpenAI = require('openai');
const axios = require('axios');
const cors = require('cors');
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('baileys');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
// Important: the Render environment must have FIREBASE_CONFIG or GOOGLE_APPLICATION_CREDENTIALS set
// Or they can be initialized via a downloaded serviceAccountKey.json file during deployment.
try {
    admin.initializeApp();
    console.log('Firebase Admin initialized locally via default credentials.');
} catch (e) {
    console.log('Firebase Admin error:', e);
}

const db = admin.firestore();

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
    telegramApiUrl: 'https://api.telegram.org/bot',
    whatsappApiUrl: 'https://graph.facebook.com/v18.0',
    openaiModel: 'gpt-4o-mini',
};

// In-memory fallback if Firestore fails or config not found (primarily for testing)
const userConfigs = new Map();
const conversations = new Map();
const baileysSessions = new Map();

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
    res.json({
        status: 'Repliexa Render Server is running!',
        timestamp: new Date().toISOString()
    });
});

// ═══════════════════════════════════════════════════════════════
// CONFIG SETUP ENDPOINTS (CALLED FROM FLUTTER APP)
// ═══════════════════════════════════════════════════════════════

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
    res.json({ success: true, message: 'Telegram config saved in-memory' });
});

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
    res.json({ success: true, message: 'WhatsApp config saved in-memory' });
});

// ═══════════════════════════════════════════════════════════════
// TELEGRAM WEBHOOK HANDLER
// ═══════════════════════════════════════════════════════════════

app.post('/webhook/telegram', async (req, res) => {
    try {
        const update = req.body;
        console.log('Telegram webhook received');

        const message = update.message || update.edited_message;
        if (!message) {
            return res.status(200).send('OK');
        }

        const chatId = message.chat.id.toString();
        const from = message.from;
        const text = message.text || '';
        const chatType = message.chat.type;

        if (chatType === 'group' || chatType === 'supergroup') {
            if (!text.includes('@')) {
                return res.status(200).send('OK');
            }
        }

        // Try to find user from Firestore
        let userId = await findUserByTelegramChat(chatId);
        let configSource = 'firestore';
        let userConfig = null;

        if (userId) {
            userConfig = await getUserConfig(userId);
        } else {
            // Fallback: check headers for generic test requests or in-memory map
            const headerBotToken = req.headers['x-bot-token'];
            if (headerBotToken && userConfigs.has(headerBotToken)) {
                userConfig = {
                    toggleActive: true,
                    openAiApiKey: req.headers['x-openai-key'] || userConfigs.get(headerBotToken).openAiKey,
                    systemPrompt: req.headers['x-system-prompt'] || userConfigs.get(headerBotToken).systemPrompt,
                    telegramBotToken: headerBotToken,
                    businessName: 'Testing Business'
                };
                configSource = 'in-memory/headers';
                userId = 'test_user';
            }
        }

        if (!userConfig || userConfig.toggleActive === false) {
            console.log('AI is disabled or no user found for chat:', chatId);
            return res.status(200).send('OK');
        }

        console.log(`Processing message via ${configSource}`);

        await processIncomingMessage({
            userId,
            platform: 'telegram',
            chatId,
            customerData: {
                id: from.id.toString(),
                username: from.username,
                firstName: from.first_name,
                lastName: from.last_name,
            },
            message: text,
            userConfig,
            replyFunction: (replyText, options) => sendTelegramMessage(userConfig.telegramBotToken, chatId, replyText, options),
        });

        return res.status(200).send('OK');
    } catch (error) {
        console.error('Error in telegramWebhook:', error.message);
        return res.status(200).send('OK');
    }
});

// ═══════════════════════════════════════════════════════════════
// WHATSAPP WEBHOOK HANDLER
// ═══════════════════════════════════════════════════════════════

app.get('/webhook/whatsapp', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'repliexa_verify_token';

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('WhatsApp webhook verified');
        return res.status(200).send(challenge);
    }
    return res.status(403).send('Verification failed');
});

app.post('/webhook/whatsapp', async (req, res) => {
    try {
        const body = req.body;
        console.log('WhatsApp webhook received');

        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const messages = value?.messages;

        if (!messages || messages.length === 0) {
            return res.status(200).send('OK');
        }

        const message = messages[0];
        const from = message.from;
        const text = message.text?.body || '';
        const phoneNumberId = value.metadata?.phone_number_id;

        let userId = await findUserByWhatsAppPhone(phoneNumberId);
        let configSource = 'firestore';
        let userConfig = null;

        if (userId) {
            userConfig = await getUserConfig(userId);
        } else {
            // Fallback
            if (phoneNumberId && userConfigs.has(phoneNumberId)) {
                const memConfig = userConfigs.get(phoneNumberId);
                userConfig = {
                    toggleActive: true,
                    openAiApiKey: memConfig.openAiKey,
                    systemPrompt: memConfig.systemPrompt,
                    whatsappApiToken: memConfig.whatsappToken,
                    whatsappPhoneNumberId: phoneNumberId,
                    businessName: 'Testing Business'
                };
                configSource = 'in-memory';
                userId = 'test_whatsapp_user';
            }
        }

        if (!userConfig || userConfig.toggleActive === false) {
            console.log('AI is disabled or no user found for phone ID:', phoneNumberId);
            return res.status(200).send('OK');
        }

        console.log(`Processing WhatsApp message via ${configSource}`);

        await processIncomingMessage({
            userId,
            platform: 'whatsapp',
            chatId: from,
            customerData: {
                id: from,
                phone: from,
            },
            message: text,
            userConfig,
            replyFunction: (replyText, options) => sendWhatsAppMessage(userConfig.whatsappApiToken, userConfig.whatsappPhoneNumberId, from, replyText),
        });

        return res.status(200).send('OK');
    } catch (error) {
        console.error('Error in whatsappWebhook:', error.message);
        return res.status(200).send('OK');
    }
});

// ═══════════════════════════════════════════════════════════════
// WHATSAPP QR CODE (BAILEYS)
// ═══════════════════════════════════════════════════════════════

app.post('/whatsapp-qr/start', async (req, res) => {
    const { sessionId, openAiKey, systemPrompt } = req.body;
    if (!sessionId || !openAiKey) {
        return res.status(400).json({ success: false, message: 'Missing sessionId or openAiKey' });
    }

    try {
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

        sock.ev.on('connection.update', async (update) => {
            const { qr, connection, lastDisconnect } = update;

            if (qr) {
                const qrDataUrl = await QRCode.toDataURL(qr);
                const session = baileysSessions.get(sessionId);
                if (session) {
                    session.qrCode = qrDataUrl;
                    session.qrText = qr;
                }
                console.log(`[WhatsApp QR] Generated for session: ${sessionId}`);
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (!shouldReconnect) {
                    baileysSessions.delete(sessionId);
                }
            }

            if (connection === 'open') {
                console.log(`[WhatsApp QR] Connected for session: ${sessionId}`);
                const session = baileysSessions.get(sessionId);
                if (session) {
                    session.connected = true;
                    session.qrCode = null;
                }
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            const session = baileysSessions.get(sessionId);
            if (!session || !session.connected) return;

            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const from = msg.key.remoteJid;
            const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text;

            if (!messageText) return;

            try {
                const conversationKey = `whatsappqr_${from}`;
                let history = conversations.get(conversationKey) || [];
                history.push({ role: 'user', content: messageText });
                if (history.length > 10) history = history.slice(-10);

                const openAiResponse = await axios.post(
                    'https://api.openai.com/v1/chat/completions',
                    {
                        model: CONFIG.openaiModel,
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

                await sock.sendMessage(from, { text: aiReply });
            } catch (error) {
                console.error('[WhatsApp QR] Error:', error.message);
            }
        });

        sock.ev.on('creds.update', saveCreds);

        res.json({ success: true, message: 'WhatsApp QR session started' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/whatsapp-qr/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = baileysSessions.get(sessionId);

    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    if (session.connected) return res.json({ success: true, connected: true, message: 'Already connected' });
    if (session.qrCode) return res.json({ success: true, connected: false, qrCode: session.qrCode, qrText: session.qrText });

    return res.json({ success: true, connected: false, message: 'QR code not ready yet' });
});

app.get('/whatsapp-qr/:sessionId/status', (req, res) => {
    const { sessionId } = req.params;
    const session = baileysSessions.get(sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    res.json({ success: true, connected: session.connected || false });
});

app.post('/whatsapp-qr/:sessionId/disconnect', async (req, res) => {
    const { sessionId } = req.params;
    const session = baileysSessions.get(sessionId);
    if (session && session.sock) {
        await session.sock.logout();
        baileysSessions.delete(sessionId);
    }
    res.json({ success: true, message: 'Disconnected' });
});

// ═══════════════════════════════════════════════════════════════
// OTHER API ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/conversations/:platform/:id', async (req, res) => {
    try {
        const { platform, id } = req.params;
        const history = await getConversationHistory('test_user', id);
        res.json({ platform, id, messages: history });
    } catch (e) {
        const key = `${req.params.platform}_${req.params.id}`;
        const memHistory = conversations.get(key) || [];
        res.json({ platform: req.params.platform, id: req.params.id, messages: memHistory });
    }
});

app.delete('/conversations/:platform/:id', (req, res) => {
    const key = `${req.params.platform}_${req.params.id}`;
    conversations.delete(key);
    res.json({ message: 'Conversation cleared globally (in memory).' });
});

// ═══════════════════════════════════════════════════════════════
// MESSAGE PROCESSING LOGIC
// ═══════════════════════════════════════════════════════════════

async function processIncomingMessage({ userId, platform, chatId, customerData, message, userConfig, replyFunction }) {
    try {
        const customer = await getOrCreateCustomer(userId, platform, customerData);
        const conversationHistory = await getConversationHistory(userId, customer.id);

        const missingInfo = getMissingCustomerInfo(customer);
        if (missingInfo.length > 0) {
            const infoPrompt = generateInfoCollectionPrompt(missingInfo, userConfig.businessName);
            await replyFunction(infoPrompt);
            await saveMessage(userId, customer.id, platform, 'user', message);
            await saveMessage(userId, customer.id, platform, 'assistant', infoPrompt);
            return;
        }

        const paymentIntent = detectPaymentIntent(message);
        if (paymentIntent) {
            await handlePaymentConfirmation(userId, customer, message, replyFunction, userConfig);
            return;
        }

        const aiResponse = await generateAIResponse({ message, conversationHistory, userConfig, customer });
        await replyFunction(aiResponse);
        await saveMessage(userId, customer.id, platform, 'user', message);
        await saveMessage(userId, customer.id, platform, 'assistant', aiResponse);
        await updateCustomerLastInteraction(customer.id);
    } catch (error) {
        console.error('Error processing message:', error);
        await replyFunction('Sorry, I encountered an error. Please try again later.');
    }
}

async function generateAIResponse({ message, conversationHistory, userConfig, customer }) {
    try {
        const openai = new OpenAI({ apiKey: userConfig.openAiApiKey });
        const systemPrompt = buildSystemPrompt(userConfig, customer);

        // Convert Firestore objects to standard array format
        const formattedHistory = [];
        if (conversationHistory) {
            conversationHistory.forEach(msg => {
                formattedHistory.push({ role: msg.role || (msg.data && msg.data().role), content: msg.content || (msg.data && msg.data().content) });
            });
        }

        const messages = [
            { role: 'system', content: systemPrompt },
            ...formattedHistory,
            { role: 'user', content: message },
        ];

        const completion = await openai.chat.completions.create({
            model: CONFIG.openaiModel,
            messages: messages,
            temperature: 0.7,
            max_tokens: 500,
        });

        return completion.choices[0].message.content;
    } catch (error) {
        console.error('Error generating AI response:', error);
        return 'I apologize, but I\'m having trouble processing your request right now. Please try again in a moment.';
    }
}

function buildSystemPrompt(userConfig, customer) {
    const basePrompt = userConfig.aiSystemPrompt || userConfig.systemPrompt || '';
    return `You are an AI receptionist for ${userConfig.businessName}.

BUSINESS INFORMATION:
- Business Name: ${userConfig.businessName}
- Tone: ${userConfig.tone || 'Professional'}

CUSTOMER INFORMATION:
- Name: ${customer.name || 'Not provided'}
- Email: ${customer.email || 'Not provided'}
- Phone: ${customer.phone || 'Not provided'}

INSTRUCTIONS:
1. Be helpful, professional, and friendly
2. Answer questions about the business and its products/services
3. Help customers make bookings or purchases
4. Collect missing customer information when needed
5. Handle payment confirmations
6. Provide product delivery links after payment confirmation

${basePrompt}

IMPORTANT: If the customer wants to make a purchase or booking, make sure you have their name, email, and phone number first.`;
}

// ═══════════════════════════════════════════════════════════════
// CUSTOMER & DB MANAGEMENT
// ═══════════════════════════════════════════════════════════════
// If Firestore is available, use it. If not, use in-memory versions.

const hasFirestore = () => {
    try {
        return admin.apps.length > 0;
    } catch (e) { return false; }
};

async function getOrCreateCustomer(userId, platform, customerData) {
    if (!hasFirestore()) return { id: customerData.id, ...customerData };

    try {
        const customersRef = db.collection('customers');
        let query = customersRef.where('userId', '==', userId).where('platform', '==', platform);

        if (platform === 'telegram' && customerData.id) {
            query = query.where('telegramChatId', '==', customerData.id);
        } else if (platform === 'whatsapp' && customerData.phone) {
            query = query.where('phone', '==', customerData.phone);
        }

        const snapshot = await query.limit(1).get();
        if (!snapshot.empty) return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };

        const newCustomer = {
            userId,
            platform,
            name: customerData.firstName || customerData.name || null,
            email: null,
            phone: customerData.phone || null,
            telegramChatId: platform === 'telegram' ? customerData.id : null,
            waNumber: platform === 'whatsapp' ? customerData.phone : null,
            username: customerData.username || null,
            status: 'new',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const docRef = await customersRef.add(newCustomer);
        return { id: docRef.id, ...newCustomer };
    } catch (e) {
        console.log('Firebase error, returning mock customer:', e.message);
        return { id: customerData.id, ...customerData };
    }
}

function getMissingCustomerInfo(customer) {
    const missing = [];
    if (!customer.name) missing.push('name');
    if (!customer.email) missing.push('email');
    if (!customer.phone) missing.push('phone');
    return missing;
}

function generateInfoCollectionPrompt(missingInfo, businessName) {
    const fields = missingInfo.join(', ');
    return `Hello! Welcome to ${businessName}. To better assist you, could you please provide your ${fields}?`;
}

async function updateCustomerLastInteraction(customerId) {
    if (!hasFirestore()) return;
    try {
        await db.collection('customers').doc(customerId).update({
            lastInteraction: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (e) { console.log('Firestore update error', e.message); }
}

async function getConversationHistory(userId, customerId, limitCount = 10) {
    if (!hasFirestore()) {
        return conversations.get(`${userId}_${customerId}`) || [];
    }
    try {
        const messagesRef = db.collection('conversations')
            .doc(`${userId}_${customerId}`)
            .collection('messages');

        const snapshot = await messagesRef.orderBy('timestamp', 'desc').limit(limitCount).get();
        return snapshot.docs.map(doc => doc.data()).reverse();
    } catch (e) {
        return conversations.get(`${userId}_${customerId}`) || [];
    }
}

async function saveMessage(userId, customerId, platform, role, content) {
    const key = `${userId}_${customerId}`;
    let history = conversations.get(key) || [];
    history.push({ role, content });
    if (history.length > 20) history = history.slice(-20);
    conversations.set(key, history);

    if (!hasFirestore()) return;
    try {
        const conversationRef = db.collection('conversations').doc(key);
        await conversationRef.set({
            userId,
            customerId,
            platform,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        await conversationRef.collection('messages').add({
            role,
            content,
            platform,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (e) { console.log('Firestore write failed, cached in memory', e.message); }
}

function detectPaymentIntent(message) {
    const lowerMessage = message.toLowerCase();
    const paymentKeywords = ['paid', 'payment', 'sent', 'transfer', 'deposit', 'confirm'];
    return paymentKeywords.some(keyword => lowerMessage.includes(keyword));
}

async function handlePaymentConfirmation(userId, customer, message, replyFunction, userConfig) {
    await saveMessage(userId, customer.id, customer.platform, 'user', message);
    if (hasFirestore()) {
        try {
            await db.collection('transactions').add({
                userId,
                customerId: customer.id,
                customerName: customer.name,
                customerEmail: customer.email,
                customerPhone: customer.phone,
                status: 'pending_confirmation',
                message: message,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        } catch (e) { }
    }
    const reply = `Thank you ${customer.name || ''}! I've received your payment confirmation. Let me verify this with the team and get back to you shortly.`;
    await replyFunction(reply);
    await saveMessage(userId, customer.id, customer.platform, 'assistant', reply);
}

// API Sending Helpers
async function sendTelegramMessage(botToken, chatId, text, options = {}) {
    try {
        const response = await axios.post(`${CONFIG.telegramApiUrl}${botToken}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: options.parseMode || 'HTML',
        });
        return response.data;
    } catch (error) {
        console.error('Error sending Telegram message');
        throw error;
    }
}

async function sendWhatsAppMessage(apiToken, phoneNumberId, to, text) {
    try {
        const response = await axios.post(`${CONFIG.whatsappApiUrl}/${phoneNumberId}/messages`, {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: to,
            type: 'text',
            text: { body: text },
        }, {
            headers: { 'Authorization': `Bearer ${apiToken}` }
        });
        return response.data;
    } catch (error) {
        console.error('Error sending WhatsApp message');
        throw error;
    }
}

// User Config Lookups
async function findUserByTelegramChat(chatId) {
    if (!hasFirestore()) return null;
    try {
        const snapshot = await db.collection('users').where('telegramConnected', '==', true).limit(10).get();
        return snapshot.empty ? null : snapshot.docs[0].id;
    } catch (e) { return null; }
}

async function findUserByWhatsAppPhone(phoneNumberId) {
    if (!hasFirestore()) return null;
    try {
        const snapshot = await db.collection('users').where('whatsappPhoneNumberId', '==', phoneNumberId).where('whatsappConnected', '==', true).limit(1).get();
        return snapshot.empty ? null : snapshot.docs[0].id;
    } catch (e) { return null; }
}

async function getUserConfig(userId) {
    if (!hasFirestore()) return null;
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        return userDoc.exists ? userDoc.data() : null;
    } catch (e) { return null; }
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Repliexa Render Server running on port ${PORT}`);
});
