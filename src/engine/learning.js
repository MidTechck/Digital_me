cat << 'EOF' > src/engine/learning.js
import fs from 'fs';
import path from 'path';
import Groq from 'groq-sdk';

const contactsFilePath = path.resolve('config/contacts.json');

function loadContacts() {
  if (!fs.existsSync(contactsFilePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(contactsFilePath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveContacts(data) {
  fs.writeFileSync(contactsFilePath, JSON.stringify(data, null, 2));
}

export async function processManualMessage(jid, text, groqClient) {
  if (!text || text.startsWith('#')) return;

  const contacts = loadContacts();
  const currentProfile = contacts[jid] || {
    phone: jid.split('@')[0],
    relationshipLevel: 'Unknown',
    currentTopic: 'General',
    chatStyle: 'Natural, brief',
    learnedFacts: []
  };

  try {
    const prompt = `Analyze this message sent manually by Charles to contact ${jid}:
Message: "${text}"

Current Profile:
${JSON.stringify(currentProfile, null, 2)}

Return ONLY a JSON object with updated fields if new information is detected:
{
  "relationshipLevel": "Client | Friend | VIP",
  "currentTopic": "brief summary of main topic",
  "chatStyle": "notes on phrasing, slang, or tone used in this message",
  "newFact": "any explicit facts stated, or null if none"
}`;

    const completion = await groqClient.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' }
    });

    const analysis = JSON.parse(completion.choices[0]?.message?.content || '{}');

    if (analysis.relationshipLevel) currentProfile.relationshipLevel = analysis.relationshipLevel;
    if (analysis.currentTopic) currentProfile.currentTopic = analysis.currentTopic;
    if (analysis.chatStyle) currentProfile.chatStyle = `${currentProfile.chatStyle}; ${analysis.chatStyle}`;
    if (analysis.newFact) {
      currentProfile.learnedFacts = currentProfile.learnedFacts || [];
      currentProfile.learnedFacts.push(analysis.newFact);
    }

    contacts[jid] = currentProfile;
    saveContacts(contacts);
    console.log(`[LEARNING] Updated profile for ${jid}`);
  } catch (err) {
    console.error('[LEARNING ERROR]', err.message);
  }
}
EOF

