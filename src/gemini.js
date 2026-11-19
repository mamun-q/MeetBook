// Browser-side Gemini generation for AI bots (Spark-plan wiring).
//
// The server engine in functions/botEngine.js reads its Gemini key from
// the Cloud Functions secret environment — but Functions need the Blaze
// plan. On Spark, the admin's own browser calls Gemini directly with a
// key the admin saved in the Admin/Bot panel (stored in the admin-only
// Firestore doc botSecrets/config; see api.js). Every failure path here
// returns null so callers fall back silently to the template generator
// in botLogic.js — bots keep working with zero provider cost.
import { normaliseBot, selectMemories } from './botLogic.js';

export const GEMINI_MODEL = 'gemini-2.0-flash';
export const GEMINI_TIMEOUT_MS = 15_000;

// Single source of truth for who may touch botSecrets: admins only.
// api.js gates every botSecrets read/write on this predicate, and the
// Firestore rules enforce the same check server-side (isAdmin()).
export function canAccessBotSecrets(user) {
  return Boolean(user && user.role === 'admin' && !user.isBot);
}

// Prompt shape mirrors the Gemini provider in functions/botEngine.js:
// the bot's own system prompt, traits, tone, its OWN memories, the task
// kind and the context text — plus a language instruction so a Bangla
// context gets a Bangla reply (botEngine relies on the model inferring
// this; the browser wiring states it explicitly).
export function buildGeminiPrompt(bot, memories = [], context = {}) {
  const b = normaliseBot(bot);
  const kind = context?.kind || 'post';
  const memoryText = selectMemories(memories, context?.text || '')
    .map((m) => `- ${m.text}`)
    .join('\n');
  return [
    b.personality.systemPrompt || `You are ${b.name}, an AI bot on MeetBook.`,
    `Traits: ${b.personality.traits.join(', ')}. Tone: ${b.personality.tone}.`,
    'Your own memories:', memoryText || '(none)',
    `Task: write a short ${kind === 'message' ? 'message reply' : kind} for a social network. You are clearly an AI bot; never claim to be human. Keep it under 60 words.`,
    'Reply in the same language as the context: if the context is in Bangla, reply in Bangla; if it is in English, reply in English.',
    context?.text ? `Context: ${context.text}` : ''
  ].filter(Boolean).join('\n');
}

// Generate one bot text with Gemini. Returns the trimmed text, or null
// on ANY failure (no key, timeout, network error, non-200, empty text)
// so the caller can use its template fallback. Never throws.
export async function generateGeminiText({ apiKey, bot, memories = [], context = {}, fetchImpl, timeoutMs = GEMINI_TIMEOUT_MS } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) return null; // no key -> never call the provider at all
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return null;
  const prompt = buildGeminiPrompt(bot, memories, context);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!res || !res.ok) return null;
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
    return text || null;
  } catch {
    return null; // network error / timeout / bad JSON -> template fallback
  } finally {
    if (timer) clearTimeout(timer);
  }
}
