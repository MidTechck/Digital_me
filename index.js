require('dotenv').config();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
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

// ====== VOICE / STYLE LEARNING ======
let styleProfile = '';               // short summary of how Charles actually texts, learned over time
let humanSamples = [];               // recent messages Charles typed himself, used to build styleProfile
const STYLE_SAMPLE_CAP = 60;
const STYLE_UPDATE_EVERY = 6;        // re-learn style every N new messages Charles sends
let sinceLastStyleUpdate = 0;
const RELATIONSHIP_TYPES = ['friend', 'family', 'client', 'lead', 'unknown'];

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
                relationship: null,        // 'friend' | 'family' | 'client' | 'lead' | 'unknown'
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
    let raw;
    try {
        raw = fs.readFileSync(STATE_FILE, 'utf8');
    } catch (e) {
        try {
            raw = fs.readFileSync(path.join(__dirname, 'seed_state.json'), 'utf8');
            console.log('No saved state yet - loading seed contacts');
        } catch (e2) {
            console.log('No previous state, starting fresh');
            return;
        }
    }
    try {
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
        if (typeof parsed.styleProfile === 'string') styleProfile = parsed.styleProfile;
        if (Array.isArray(parsed.humanSamples)) humanSamples = parsed.humanSamples;
        console.log(`Restored ${customers.size} customers`);
    } catch (e) {
        console.log('Failed to parse saved state:', e.message);
    }
}

function saveState() {
    try {
        const data = {
            customers: Object.fromEntries(customers),
            manualMutes: Object.fromEntries(manualMutes),
            styleProfile,
            humanSamples
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

function logLead(sender, text) {
    try {
        fs.appendFileSync(LEADS_FILE, `${new Date().toISOString()} | ${getCleanNumber(sender)} | ${text}\n`);
    } catch (e) {}
}

async function checkBuyingIntent(sock, sender, text, isMuted) {
    const lower = text.toLowerCase();
    if (!BUYING_INTENT_KEYWORDS.some(k => lower.includes(k))) return;

    logLead(sender, text);
    if (isMuted || !OWNER_NOTIFY_NUMBER) return;

    const last = lastLeadAlert.get(sender) || 0;
    if (Date.now() - last < LEAD_ALERT_COOLDOWN) return;
    lastLeadAlert.set(sender, Date.now());

    try {
        await sendTrackedMessage(sock, OWNER_NOTIFY_NUMBER, {
            text: `Possible business enquiry\nFrom: ${getCleanNumber(sender)}\nMessage: ${text}`
        });
    } catch (e) {}
}

const PERSONAL_FACTS = `- Runs an online business, MidTech Digital: builds websites, WhatsApp automation/chatbots, SEO, and Google Business Profiles for small businesses
- Based in Ndola, Zambia
- Into coding
Share these ONLY if someone directly asks about them. Never volunteer them unprompted, and never list off skills or brag about capabilities. If asked something more personal than this (age, school, relationships, etc.), keep it light and vague rather than specific.`;

// Figure out how Charles should sound for this specific contact, and build the
// persona + learned-style text shared by both the text and voice-note paths.
function buildPersonaAndStyle(phone) {
    const customer = getOrCreateCustomer(phone);
    const relationship = customer.memory.relationship;

    let personaBlock;
    if (relationship === 'client' || relationship === 'lead') {
        personaBlock = `You are Charles, replying to a client/business contact on WhatsApp about MidTech Digital work (websites, WhatsApp automation, SEO, Google Business Profiles).
Keep replies short (1-2 sentences), calm and professional. Only talk about specifics (prices, timelines, scope) that are in this contact's notes below or in the recent messages - never invent project details.`;
    } else if (relationship === 'friend' || relationship === 'family') {
        personaBlock = `You are Charles, personally replying to a ${relationship} of his on WhatsApp.
Keep it short, casual and warm - the way Charles actually texts people he knows. This is not a business conversation, so don't bring up work/business unless they ask about it directly.`;
    } else {
        personaBlock = `You are Charles, replying on WhatsApp to someone whose relationship to him isn't clear yet.
Keep it short, friendly and neutral in tone until you know them better. Don't bring up business/work unless they ask about it.`;
    }

    const styleBlock = styleProfile
        ? `\nHOW CHARLES ACTUALLY TEXTS (match this voice):\n${styleProfile}\n`
        : '';

    return `${personaBlock}
${styleBlock}
ABOUT CHARLES:
${PERSONAL_FACTS}

GENERAL RULES:
- Never use exclamation marks.
- Understand common chat shorthand (hru, wyd, wbu, brb, idk, lol, etc.) and emojis the way a real person would.
- Pick up on emotional tone (upset, joking, stressed, excited) and respond appropriately - don't ignore it.
- If someone just greets you ("hi", "hey", "how are you", "hru"), reply casually like a real person would ("hey, I'm good, you?"), never like a business assistant ("how can I help you today").
- If a message is genuinely unclear or hard to make out, ask the person to repeat it or type it out instead of guessing.
- If someone sincerely and directly asks whether they're talking to an AI/bot, or asks "is this really you", answer honestly - never deny it.
- Never invent prices, links, quotations or facts that aren't in memory or the recent messages.
- If someone brings up something not in your notes or the recent messages (a past chat, a quote, a plan), don't use a scripted line - just say naturally that you forgot or can't quite recall, and vary the phrasing each time so it doesn't sound scripted.`;
}

// Classify a contact as friend/family/client/lead based on the conversation so far.
// Runs in the background - never awaited on the critical reply path.
async function classifyRelationship(phone) {
    if (!GEMINI_API_KEY) return;
    const customer = getOrCreateCustomer(phone);
    if (customer.history.length < 4) return;
    if (customer.memory.relationship && customer.history.length % 6 !== 0) return;

    try {
        const convoText = customer.history.slice(-10)
            .map(h => `${h.role === 'assistant' ? 'Charles' : 'Them'}: ${h.content}`)
            .join('\n');
        const prompt = `Based on this WhatsApp conversation, classify who "Them" is to Charles as exactly one of: friend, family, client, lead, unknown.
Reply with only that one lowercase word, nothing else.

${convoText}`;

        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
            }
        );
        const data = await res.json();
        const word = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase().replace(/[^a-z]/g, '');
        if (RELATIONSHIP_TYPES.includes(word)) {
            customer.memory.relationship = word;
            saveState();
        }
    } catch (e) {
        console.log('[CLASSIFY]', e.message);
    }
}

// Re-learn Charles's own texting voice from his most recent sent messages.
// Runs in the background - never awaited on the critical reply path.
async function updateStyleProfile() {
    if (!GEMINI_API_KEY || humanSamples.length < 6) return;
    try {
        const sampleText = humanSamples.slice(-STYLE_SAMPLE_CAP).join('\n');
        const prompt = `These are real WhatsApp messages a person named Charles typed himself.
In 3 short bullet points (under 60 words total), describe his texting voice: tone, typical phrasing/slang, punctuation and capitalization habits, emoji use. This will guide an assistant writing replies in his voice, so be concrete, not generic.

${sampleText}`;

        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
            }
        );
        const data = await res.json();
        const summary = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (summary) {
            styleProfile = summary;
            saveState();
            console.log('[STYLE] profile updated');
        }
    } catch (e) {
        console.log('[STYLE]', e.message);
    }
}

// Download a voice note and let Gemini transcribe + reply to it in one pass.
// Returns the reply text, or null if it couldn't make sense of the audio.
async function transcribeAndRespond(sock, msg, phone) {
    if (!GEMINI_API_KEY) return null;
    try {
        const buffer = await downloadMediaMessage(
            msg, 'buffer', {},
            { reuploadRequest: sock.updateMediaMessage, logger: pino({ level: 'silent' }) }
        );
        const base64Audio = buffer.toString('base64');
        const systemPrompt = buildPersonaAndStyle(phone);

        const payload = {
            system_instruction: {
                parts: [{ text: systemPrompt + '\nThe person sent a voice note instead of typing. Listen to it and reply naturally to what they said, as if you heard it directly. If you cannot make out what they said, say so and ask them to repeat it or type it out.' }]
            },
            contents: [{
                role: 'user',
                parts: [{ inline_data: { mime_type: 'audio/ogg', data: base64Audio } }]
            }]
        };

        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
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
        console.log('[VOICE] no usable reply, status=' + res.status, JSON.stringify(data).slice(0, 500));
    } catch (e) {
        console.log('[VOICE]', e.message);
    }
    return null;
}

// ====== AI ======
async function generateAIResponse(phone, userMessage) {
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
    let memoryBlock = 'NOTES ON THIS CONTACT:\n';
    if (memory.name) memoryBlock += `Name: ${memory.name}\n`;
    if (memory.location) memoryBlock += `Location: ${memory.location}\n`;
    if (memory.service) memoryBlock += `Service/project: ${memory.service}\n`;
    if (memory.quotation) memoryBlock += `Quotation: ${memory.quotation}\n`;
    if (memory.status) memoryBlock += `Status: ${memory.status}\n`;
    if (memory.notes) memoryBlock += `Notes: ${memory.notes}\n`;
    if (memory.lastSummary) memoryBlock += `Last summary: ${memory.lastSummary}\n`;
    if (memoryBlock === 'NOTES ON THIS CONTACT:\n') {
        memoryBlock += 'Nothing saved yet - this may be a new or unfamiliar contact.\n';
    }

    const systemPrompt = `${buildPersonaAndStyle(phone)}

${memoryBlock}`;

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
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
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
            console.log('[GEMINI] no usable reply, status=' + res.status, JSON.stringify(data).slice(0, 500));
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
                    model: 'openai/gpt-oss-120b',
                    messages: [{ role: 'system', content: systemPrompt }, ...recent],
                    max_tokens: 120,
                    temperature: 0.5
                })
            });
            const data = await res.json();
            if (res.ok && data?.choices?.[0]?.message?.content) {
                return data.choices[0].message.content.trim();
            }
            console.log('[NVIDIA] no usable reply, status=' + res.status, JSON.stringify(data).slice(0, 500));
        } catch (e) {
            console.log('[NVIDIA]', e.message);
        }
    }

    // Simple fallback - both providers unavailable
    console.log('[AI] both providers unavailable/failed, using local fallback. GEMINI_API_KEY set=' + !!GEMINI_API_KEY + ', NVIDIA_API_KEY set=' + !!NVIDIA_API_KEY);
    return 'Hey, I am good, what is up.';
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
                if (!jid || !jid.endsWith('@s.whatsapp.net')) continue;

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
        if (!sender || !sender.endsWith('@s.whatsapp.net')) return;

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

                // Learn Charles's own texting voice from what he actually typed
                humanSamples.push(text);
                if (humanSamples.length > STYLE_SAMPLE_CAP) {
                    humanSamples.splice(0, humanSamples.length - STYLE_SAMPLE_CAP);
                }
                sinceLastStyleUpdate++;
                if (sinceLastStyleUpdate >= STYLE_UPDATE_EVERY) {
                    sinceLastStyleUpdate = 0;
                    updateStyleProfile().catch(() => {});
                }

                saveState();
                console.log(`Human message saved for ${phone}`);
            }
            return;
        }

        // ========== CUSTOMER MESSAGE ==========
        const isMutedNow = Date.now() - (manualMutes.get(sender) || 0) < MUTE_DURATION;

        // Voice note - no transcript from Baileys, so hand the audio straight to Gemini
        if (!text && msg.message.audioMessage) {
            if (isMutedNow) return;
            try { await sock.readMessages([msg.key]); } catch (e) {}
            await sock.sendPresenceUpdate('composing', sender);

            const voiceReply = await transcribeAndRespond(sock, msg, phone);
            addToHistory(phone, 'user', '[voice note]', false);

            if (voiceReply) {
                const clean = sanitizeReply(voiceReply);
                addToHistory(phone, 'assistant', clean, false);
                saveState();
                await new Promise(r => setTimeout(r, Math.min(Math.max(clean.length * 18, 1200), 3200)));
                await sock.sendPresenceUpdate('paused', sender);
                await sendTrackedMessage(sock, sender, { text: clean });
            } else {
                const fallback = 'Sorry, I did not catch that clearly. Could you say it again or type it out.';
                addToHistory(phone, 'assistant', fallback, false);
                saveState();
                await sock.sendPresenceUpdate('paused', sender);
                await sendTrackedMessage(sock, sender, { text: fallback });
            }
            classifyRelationship(phone).catch(() => {});
            return;
        }

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

        const isMuted = Date.now() - (manualMutes.get(sender) || 0) < MUTE_DURATION;

        await checkBuyingIntent(sock, sender, text, isMuted);
        if (isMuted) return;

        if (lower.includes('owner') || lower.includes('human') || lower.includes('talk to someone')) {
            manualMutes.set(sender, Date.now());
            saveState();
            await sendTrackedMessage(sock, sender, { text: 'I have connected you with the team.' });
            return;
        }

        console.log(`From ${phone}: ${text}`);

        // Brief "reading" pause before even showing typing - feels more natural than an instant reply
        await new Promise(r => setTimeout(r, Math.min(Math.max(text.length * 15, 400), 2500)));
        await sock.sendPresenceUpdate('composing', sender);

        const raw = await generateAIResponse(phone, text);
        const reply = sanitizeReply(raw);

        addToHistory(phone, 'assistant', reply, false);
        saveState();
        classifyRelationship(phone).catch(() => {});

        await new Promise(r => setTimeout(r, Math.min(Math.max(reply.length * 18, 1200), 3200)));
        await sock.sendPresenceUpdate('paused', sender);
        await sendTrackedMessage(sock, sender, { text: reply });
    });
}

startBot();
