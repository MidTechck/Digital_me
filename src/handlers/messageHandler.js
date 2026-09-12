import fs from 'fs';
import path from 'path';
import { processManualMessage } from '../engine/learning.js';
import { simulateTyping } from '../engine/humanizer.js';

const pausedChats = new Map();

export async function handleMessage(sock, msg, groqClient) {
  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@g.us')) return; 

  const isFromMe = msg.key.fromMe;
  const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

  if (isFromMe) {
    pausedChats.set(jid, Date.now() + 2 * 60 * 60 * 1000);
    console.log(`[TAKEOVER ACTIVE] Observed manual message to ${jid}. Auto-reply paused for 2 hours.`);

    await processManualMessage(jid, text, groqClient);
    return;
  }

  const takeoverUntil = pausedChats.get(jid);
  if (takeoverUntil && Date.now() < takeoverUntil) {
    console.log(`[PAUSED] Bot is active-learning mode for ${jid}. Skipping automated reply.`);
    return;
  }

  const contactsPath = path.resolve('config/contacts.json');
  let contactData = {};
  if (fs.existsSync(contactsPath)) {
    try { contactData = JSON.parse(fs.readFileSync(contactsPath, 'utf-8'))[jid] || {}; } catch {}
  }

  const systemPrompt = `You are Charles, a software developer and web platforms entrepreneur based in Zambia.
You are replying to a message on WhatsApp. Keep your message short, casual, and completely natural (1-2 sentences maximum).
Never sound like an generic AI assistant. Do not use bullet points or formal sign-offs.

Contact Context:
- Relationship: ${contactData.relationshipLevel || 'Unknown'}
- Topic: ${contactData.currentTopic || 'General'}
- Style to match: ${contactData.chatStyle || 'Direct, short'}
- Key Facts: ${JSON.stringify(contactData.learnedFacts || [])}`;

  try {
    const completion = await groqClient.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      model: 'llama-3.3-70b-versatile'
    });

    const replyText = completion.choices[0]?.message?.content?.trim();
    if (replyText) {
      await simulateTyping(sock, jid, replyText);
      await sock.sendMessage(jid, { text: replyText });
    }
  } catch (err) {
    console.error('[REPLY ERROR]', err.message);
  }
}

