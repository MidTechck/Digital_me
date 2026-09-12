import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const groqClient = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || '',
  baseURL: 'https://api.groq.com/openai/v1'
});

const geminiClient = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/'
});

const nvidiaClient = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY || '',
  baseURL: 'https://integrate.api.nvidia.com/v1'
});

export async function generatePersonaReply(systemPrompt, userText) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userText }
  ];

  // 1. Try Groq
  if (process.env.GROQ_API_KEY) {
    try {
      const res = await groqClient.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages
      });
      return res.choices[0]?.message?.content?.trim();
    } catch (err) {
      console.warn('[BRAIN] Groq primary failed. Switching to Gemini...', err.message);
    }
  }

  // 2. Fallback to Google Gemini
  if (process.env.GEMINI_API_KEY) {
    try {
      const res = await geminiClient.chat.completions.create({
        model: 'gemini-1.5-flash',
        messages
      });
      return res.choices[0]?.message?.content?.trim();
    } catch (err) {
      console.warn('[BRAIN] Gemini fallback failed. Switching to NVIDIA...', err.message);
    }
  }

  // 3. Fallback to NVIDIA NIM
  if (process.env.NVIDIA_API_KEY) {
    try {
      const res = await nvidiaClient.chat.completions.create({
        model: 'meta/llama-3.1-70b-instruct',
        messages
      });
      return res.choices[0]?.message?.content?.trim();
    } catch (err) {
      console.error('[BRAIN] NVIDIA fallback failed:', err.message);
    }
  }

  throw new Error('All configured API keys (Groq, Gemini, NVIDIA) failed or are missing.');
}

