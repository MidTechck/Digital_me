require('dotenv').config();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ====== ENV ======
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '';
const OWNER_NOTIFY_NUMBER = process.env.OWNER_NOTIFY_NUMBER || '';
const OWNER_DIRECT_LINE = process.env.OWNER_DIRECT_LINE || '';

// ====== STORAGE (Railway volume) ======
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const AUTH_DIR = path.join(DATA_DIR, 'auth_info_baileys');
const STATE_FILE = path.join(DATA_DIR, 'bot_state.json');
const LEADS_FILE = path.join(DATA_DIR, 'leads.log');

// ====== WEB SERVER (QR) ======
const app = express();
const PORT = process.env.PORT || 8080;
let qrCodeDataUrl = '';
let isConnected = false;
let currentSock = null;

app.get('/', (req, res) => {
    if (isConnected) {
        return res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:40px;">Bot is connected</h2>');
    }
    if (qrCodeDataUrl) {
        return res.send(`
            <html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
            <body style="font-family:Arial;text-align:center;margin-top:40px;">
                <h2>Scan QR Code with WhatsApp</h2>
                <p>Linked Devices → Link a Device</p>
                <img src="${qrCodeDataUrl}" style="max-width:300px">
            </body></html>
        `);
    }
    return res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:40px;">Waiting for QR...</h2>');
});
app.listen(PORT, () => console.log(`Web server on port ${PORT}`));

// ====== STATE ======
const manualMutes = new Map();
const MUTE_DURATION = 30 * 60 * 1000;
const customers = new Map();          // phone → { memory, history }
const MAX_HISTORY = 12;
const botMessageIds = new Set();
const lastLeadAlert = new Map();
const LEAD_ALERT_COOLDOWN = 20 * 60 * 1000;

function getCleanNumber(jid) {
    if (!jid) return null;
    return jid.split('@')[0].replace(/\D/g, '');
}

function getOrCreateCustomer(phone) {
    if (!customers.has(phone)) {
        customers.set(phone, {
            memory: {
                name: null,
                location: null,
                service: null,
                quotation: null,
                status: 'new',
                notes: '',
                lastSummary: '',
                updatedAt: new Date().toISOString()
            },
            history: []
        });
    }
    return customers.get(phone);
}

function addToHistory(phone, role, content, isHuman = false) {
    const customer = getOrCreateCustomer(phone);
    customer.history.push({
        role,
        content,
        isHuman,
        timestamp: new Date().toISOString()
    });
    if (customer.history.length > MAX_HISTORY) {
        customer.history.splice(0, customer.history.length - MAX_HISTORY);
    }
    customer.memory.updatedAt = new Date().toISOString();
}

function generateMessageID() {
    return crypto.randomBytes(16).toString('hex').toUpperCase();
}

async function sendTrackedMessage(sock, jid, content) {
    const messageId = generateMessageID();
    botMessageIds.add(messageId);
    if (botMessageIds.size > 300) {
        const first = botMessageIds.values().next().value;
        botMessageIds.delete(first);
    }
    return sock.sendMessage(jid, content, { messageId });
}

function sanitizeReply(text) {
    let cleaned = text.replace(/!+/g, '.');
    cleaned = cleaned.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
    cleaned = cleaned.replace(/\.{2,}/g, '.').replace(/[ \t]{2,}/g, ' ').trim();
    return cleaned;
}

// ====== LOAD / SAVE ======
function loadState() {
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.customers) {
            for (const [phone, data] of Object.entries(parsed.customers)) {
                customers.set(phone, data);
            }
        }
        if (parsed.manualMutes) {
            for (const [k, v] of Object.entries(parsed.manualMutes)) {
                manualMutes.set(k, v);
            }
        }
        console.log(`Restored ${customers.size} customers`);
    } catch (e) {
        console.log('No previous state, starting fresh');
    }
}

function saveState() {
    try {
        const data = {
            customers: Object.fromEntries(customers),
            manualMutes: Object.fromEntries(manualMutes)
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.log('[SAVE ERROR]', e.message);
    }
}

loadState();

// ====== LEADS ======
const BUYING_INTENT_KEYWORDS = [
    'price', 'cost', 'how much', 'quote', 'quotation', 'book', 'order',
    'buy', 'purchase', 'interested', 'install', 'schedule', 'appointment', 'deposit', 'pay'
];

const AD_LEAD_GREETING = `Hi. Thanks for your interest in Starlink.

Current offer:
Starlink Kit: K8,500
Original Mount: K2,000
Monthly Unlimited: K800
Installation: K1,500 within Lusaka & Copperbelt`;

function logLead(sender, text) {
    try {
        fs.appendFileSync(LEADS_FILE, `${new Date().toISOString()} | ${getCleanNumber(sender)} | ${text}\n`);
    } catch (e) {}
}

async function checkBuyingIntent(sock, sender, text, isMuted, isAdLead = false) {
    const lower = text.toLowerCase();
    if (!BUYING_INTENT_KEYWORDS.some(k => lower.includes(k)) && !isAdLead) return;

    logLead(sender, text);
    if (isMuted || !OWNER_NOTIFY_NUMBER) return;

    const last = lastLeadAlert.get(sender) || 0;
    if (Date.now() - last < LEAD_ALERT_COOLDOWN) return;
    lastLeadAlert.set(sender, Date.now());

    try {
        await sendTrackedMessage(sock, OWNER_NOTIFY_NUMBER, {
            text: `New potential sale\nClient: ${getCleanNumber(sender)}\nMessage: ${text}`
        });
    } catch (e) {}
}

// ====== AI ======
async function generateAIResponse(phone, userMessage, isAdLead = false) {
    const customer = getOrCreateCustomer(phone);
    const memory = customer.memory;

    // Recent history (includes human messages)
    const recent = customer.history.slice(-MAX_HISTORY).map(h => ({
        role: h.role,
        content: h.content
    }));

    // Ensure latest message is present
    if (recent.length === 0 || recent[recent.length - 1].content !== userMessage) {
        recent.push({ role: 'user', content: userMessage });
    }

    // Build memory block
    let memoryBlock = 'CUSTOMER MEMORY:\n';
    if (memory.name) memoryBlock += `Name: ${memory.name}\n`;
    if (memory.location) memoryBlock += `Location: ${memory.location}\n`;
    if (memory.service) memoryBlock += `Service: ${memory.service}\n`;
    if (memory.quotation) memoryBlock += `Quotation: ${memory.quotation}\n`;
    if (memory.status) memoryBlock += `Status: ${memory.status}\n`;
    if (memory.notes) memoryBlock += `Notes: ${memory.notes}\n`;
    if (memory.lastSummary) memoryBlock += `Last summary: ${memory.lastSummary}\n`;
    if (memoryBlock === 'CUSTOMER MEMORY:\n') {
        memoryBlock += 'No previous information stored yet.\n';
    }

    const systemPrompt = `You are a professional human representative of Sovet Link Technologies (Zambia).
Keep replies short (1-2 sentences maximum).

${memoryBlock}

STRICT RULES:
- Never use emojis or exclamation marks.
- Never invent prices, links, or past conversations.
- If the customer refers to a previous discussion, quotation, installation or anything that is NOT in the Customer Memory and NOT in the recent messages, reply exactly:
  "Let me connect you with the team so they can assist you properly."
- Before giving installation price you must know the city.
- Pricing:
  Lusaka / Eastern: K1,500 service + K2,000 mount if needed
  Kitwe / Copperbelt: K2,000 installation
  Other areas: special arrangement needed
- Packages: Gen 3 Kit K8,500 | Mini K6,500 | Mount K2,000 | Monthly K800
- Payment: Airtel Money or bank transfer only.
- Match a calm, professional tone.

${isAdLead ? 'This is an ad lead – briefly introduce the Starlink options.' : ''}`;

    // Gemini
    if (GEMINI_API_KEY) {
        try {
            const payload = {
                system_instruction: { parts: [{ text: systemPrompt }] },
                contents: recent.map(h => ({
                    role: h.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: h.content }]
                }))
            };

            const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }
            );
            const data = await res.json();
            if (res.ok && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                return data.candidates[0].content.parts[0].text.trim();
            }
        } catch (e) {
            console.log('[GEMINI]', e.message);
        }
    }

    // NVIDIA fallback
    if (NVIDIA_API_KEY) {
        try {
            const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${NVIDIA_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'meta/llama-3.1-8b-instruct',
                    messages: [{ role: 'system', content: systemPrompt }, ...recent],
                    max_tokens: 120,
                    temperature: 0.5
                })
            });
            const data = await res.json();
            if (res.ok && data?.choices?.[0]?.message?.content) {
                return data.choices[0].message.content.trim();
            }
        } catch (e) {
            console.log('[NVIDIA]', e.message);
        }
    }

    // Simple fallback
    const lower = userMessage.toLowerCase();
    if (isAdLead || lower.includes('starlink')) {
        return 'We have Starlink Gen 3 at K8,500 and Mini at K6,500. Which one are you interested in.';
    }
    if (lower.includes('price') || lower.includes('cost') || lower.includes('how much')) {
        return 'Pricing depends on your location. Which city are you in.';
    }
    return 'Hello. How can we help you today.';
}

// ====== BOT ======
async function startBot() {
    if (currentSock) {
        try { currentSock.end(undefined); } catch (e) {}
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: true                 // Option C
    });

    currentSock = sock;
    sock.ev.on('creds.update', saveCreds);

    // Try to receive older messages (Option C)
    sock.ev.on('messaging-history.set', ({ messages }) => {
        if (!messages || !messages.length) return;
        console.log(`History sync received: ${messages.length} messages`);

        for (const msg of messages) {
            try {
                const jid = msg.key?.remoteJid;
                if (!jid || jid.endsWith('@g.us')) continue;

                const phone = getCleanNumber(jid);
                if (!phone) continue;

                const text = msg.message?.conversation ||
                             msg.message?.extendedTextMessage?.text ||
                             msg.message?.imageMessage?.caption;
                if (!text) continue;

                addToHistory(phone, msg.key.fromMe ? 'assistant' : 'user', text, !!msg.key.fromMe);
            } catch (e) {}
        }
        saveState();
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) {
                    qrCodeDataUrl = url;
                    console.log('QR ready');
                }
            });
        }

        if (connection === 'open') {
            console.log('Connected to WhatsApp');
            isConnected = true;
            qrCodeDataUrl = '';
        } else if (connection === 'close') {
            isConnected = false;
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log('Disconnected:', code);
            if ([DisconnectReason.loggedOut, 401, 403, 405].includes(code)) {
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
            }
            setTimeout(startBot, 4000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const sender = msg.key.remoteJid;
        if (!sender || sender.endsWith('@g.us')) return;

        const phone = getCleanNumber(sender);
        if (!phone) return;

        const text = msg.message.conversation ||
                     msg.message.extendedTextMessage?.text ||
                     msg.message.imageMessage?.caption;

        // ========== HUMAN MESSAGE ==========
        if (msg.key.fromMe) {
            if (botMessageIds.has(msg.key.id)) return;

            if (text) {
                addToHistory(phone, 'assistant', text, true);   // SAVE human message
                manualMutes.set(sender, Date.now());
                saveState();
                console.log(`Human message saved for ${phone}`);
            }
            return;
        }

        // ========== CUSTOMER MESSAGE ==========
        if (!text) return;

        try { await sock.readMessages([msg.key]); } catch (e) {}

        const lower = text.trim().toLowerCase();
        const isOwner = OWNER_NOTIFY_NUMBER && sender.includes(OWNER_NOTIFY_NUMBER.replace(/\D/g, ''));

        // Manual seeding (Option B)
        if (isOwner && lower.startsWith('/note ')) {
            const parts = text.trim().slice(6).split(' ');
            const target = parts[0].replace(/\D/g, '');
            const note = parts.slice(1).join(' ');
            if (target && note) {
                const c = getOrCreateCustomer(target);
                c.memory.notes = c.memory.notes ? c.memory.notes + ' | ' + note : note;
                c.memory.updatedAt = new Date().toISOString();
                saveState();
                await sendTrackedMessage(sock, sender, { text: `Note saved for ${target}` });
            }
            return;
        }

        // Save customer message
        addToHistory(phone, 'user', text, false);

        if (lower === '/human') {
            manualMutes.set(sender, Date.now());
            saveState();
            await sendTrackedMessage(sock, sender, { text: 'AI paused. You are now connected with the team.' });
            return;
        }

        // Ad detection
        const ctx = msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo;
        const isAdLead = !!(ctx?.externalAdReply || ctx?.adReplyInfo) ||
                         lower.includes('can i get more info on this');

        const isMuted = Date.now() - (manualMutes.get(sender) || 0) < MUTE_DURATION;

        await checkBuyingIntent(sock, sender, text, isMuted, isAdLead);
        if (isMuted) return;

        if (lower.includes('owner') || lower.includes('human') || lower.includes('talk to someone')) {
            manualMutes.set(sender, Date.now());
            saveState();
            await sendTrackedMessage(sock, sender, { text: 'I have connected you with the team.' });
            return;
        }

        if (lower.includes('can i get more info on this')) {
            await sock.sendPresenceUpdate('composing', sender);
            await new Promise(r => setTimeout(r, 1800));
            await sendTrackedMessage(sock, sender, { text: AD_LEAD_GREETING });
            addToHistory(phone, 'assistant', AD_LEAD_GREETING, false);
            saveState();
            return;
        }

        console.log(`From ${phone}: ${text}`);

        await sock.sendPresenceUpdate('composing', sender);

        const raw = await generateAIResponse(phone, text, isAdLead);
        const reply = sanitizeReply(raw);

        // Auto-mute if AI decided to hand over
        if (reply.toLowerCase().includes('connect you with the team')) {
            manualMutes.set(sender, Date.now());
        }

        addToHistory(phone, 'assistant', reply, false);
        saveState();

        await new Promise(r => setTimeout(r, Math.min(Math.max(reply.length * 18, 1200), 3200)));
        await sock.sendPresenceUpdate('paused', sender);
        await sendTrackedMessage(sock, sender, { text: reply });
    });
}

startBot();
