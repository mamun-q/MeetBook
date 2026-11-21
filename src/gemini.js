// Browser-side Gemini generation for AI bots (Spark-plan wiring).
//
// The server engine in functions/botEngine.js reads its Gemini key from
// the Cloud Functions secret environment — but Functions need the Blaze
// plan. On Spark, the admin's own browser calls Gemini directly with a
// key the admin saved in the Admin/Bot panel (stored in the admin-only
// Firestore doc botSecrets/config; see api.js). Every failure path here
// returns null so callers fall back silently to the template generator
// in botLogic.js — bots keep working with zero provider cost.
import { normaliseBot, selectMemories, BOT_PRESENCE_RULES } from './botLogic.js';

export const GEMINI_MODEL = 'gemini-3.5-flash'; // gemini-2.0-flash was shut down by Google on 2026-06-01 (every call 404s); 3.5-flash is its GA successor
export const GEMINI_TIMEOUT_MS = 15_000;

// The model a bot actually generates with: its own configured model
// (Bot Control Center, stored on the bot doc) when set, else the
// platform default above.
export function botModel(bot) {
  const m = typeof bot?.model === 'string' ? bot.model.trim() : '';
  return m || GEMINI_MODEL;
}

// Single source of truth for who may touch botSecrets: admins only
// (admin or superadmin — the Pack A role ladder). api.js gates every
// botSecrets read/write on this predicate, and the Firestore rules
// enforce the same check server-side (isAdmin()).
export function canAccessBotSecrets(user) {
  return Boolean(user && (user.role === 'admin' || user.role === 'superadmin') && !user.isBot);
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
    b.personality.systemPrompt || `You are ${b.name}, a member of MeetBook.`,
    `Traits: ${b.personality.traits.join(', ')}. Tone: ${b.personality.tone}.`,
    'Your own memories:', memoryText || '(none)',
    `Task: write a short ${kind === 'message' ? 'message reply' : kind} for a social network. ${BOT_PRESENCE_RULES} Keep it under 60 words.`,
    'Reply in the same language as the context: if the context is in Bangla, reply in Bangla; if it is in English, reply in English.',
    context?.thread ? `Recent conversation (oldest first — continue it naturally, do not repeat yourself):\n${context.thread}` : '',
    context?.text ? `Context: ${context.text}` : ''
  ].filter(Boolean).join('\n');
}

// The most recent Gemini failure in this session, in admin-safe terms
// (an HTTP status plus Google's own error.message snippet, or a network
// error name — never the key and never the prompt). The bot panel
// surfaces it on the runner's Last cycle line so a silent template
// fallback is diagnosable from the UI: without it, a bad key and a
// healthy template fallback look identical. When several models were
// tried (see generateGeminiText), the string names the model that
// produced the recorded (last) failure, e.g.
// "HTTP 400 (gemini-3.5-flash-lite): API key not valid. ...".
let lastGeminiFailure = '';
let lastGeminiAttempts = 0;
export function getLastGeminiFailure() {
  return lastGeminiFailure;
}
// How many real HTTP attempts the last generateGeminiDetailed call
// made (the model chain can try up to 3 models for one routed call) —
// the router's usage accounting needs the true count, not 1.
export function getLastGeminiAttempts() {
  return lastGeminiAttempts;
}
export function resetLastGeminiFailure() {
  lastGeminiFailure = '';
}

// Backup model tried when the bot's configured model (and then the
// platform default) fail: the lite tier is the least likely to be the
// one that is retired, renamed or overloaded at any given moment.
export const GEMINI_FALLBACK_MODEL = 'gemini-3.5-flash-lite';

// Ordered, deduped attempt list for one generation: the bot's own
// configured model first, then the platform default, then the lite
// backup. A bot whose stored model string has gone stale (retired by
// Google, typo'd in the Bot Control Center) must not be silenced while
// its key and the default models are perfectly healthy.
export function geminiAttemptModels(bot) {
  return [...new Set([botModel(bot), GEMINI_MODEL, GEMINI_FALLBACK_MODEL])];
}

// Google's error.message for a failed call, made admin-safe: whitespace
// collapsed, capped at ~120 chars, and cut at the API key if the key
// somehow appears in it (it never should — but the key must not reach
// the bot panel or any log through this string, even defensively).
function sanitiseProviderMessage(raw, key) {
  let msg = String(raw || '').replace(/\s+/g, ' ').trim();
  if (key) {
    const at = msg.indexOf(key);
    if (at !== -1) msg = msg.slice(0, at).trim();
  }
  return msg.slice(0, 120);
}

// Read the provider's error detail from a non-200 response. A non-JSON
// body (or a mock without one) yields '' — the status alone is kept.
async function providerErrorMessage(res, key) {
  try {
    const json = await res.json();
    return sanitiseProviderMessage(json?.error?.message, key);
  } catch {
    return '';
  }
}

// Real token usage from a Gemini response: usageMetadata carries
// promptTokenCount / candidatesTokenCount. Returns null when the
// response reports neither (the Admin panel then says so honestly
// instead of inventing a number).
function geminiUsage(json) {
  const u = json?.usageMetadata;
  if (!u) return null;
  const promptTokens = Number(u.promptTokenCount);
  const completionTokens = Number(u.candidatesTokenCount);
  if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens)) return null;
  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0
  };
}

// One provider attempt against one model, with its own timeout. Returns
// { text, usage } on success or { failure } with the raw failure detail — the
// caller formats it with the model context. Never throws.
async function attemptGeminiOnce({ key, model, prompt, doFetch, timeoutMs }) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!res) return { failure: { kind: 'noresponse' } };
    if (!res.ok) {
      return { failure: { kind: 'http', status: res.status, message: await providerErrorMessage(res, key) } };
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
    if (!text) return { failure: { kind: 'empty' } };
    return { text, usage: geminiUsage(json) };
  } catch (err) {
    return { failure: { kind: 'error', detail: String(err?.name || err?.message || 'network error') } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Render one attempt's failure for the bot panel. When more than one
// model was tried, the model that produced this (last) failure is named
// in parens so the panel stays truthful about which model failed:
// "HTTP 503 (gemini-3.5-flash-lite): The model is overloaded ...".
function formatGeminiFailure(failure, model, multiModel) {
  if (failure.kind === 'http') {
    const head = multiModel ? `HTTP ${failure.status} (${model})` : `HTTP ${failure.status}`;
    return failure.message ? `${head}: ${failure.message}` : head;
  }
  const base = failure.kind === 'empty' ? 'empty response'
    : failure.kind === 'noresponse' ? 'no response'
      : failure.detail;
  return multiModel ? `${base} (${model})` : base;
}

// Generate one bot text with Gemini, with full detail: tries the bot's
// configured model, then the platform default, then the lite backup —
// one attempt each, moving on after ANY failure — and returns
// { text, model, usage } for the first success (model = the model that
// actually answered; usage = real token counts or null when Gemini did
// not report them). Returns null when every attempt fails (no key,
// timeout, network error, non-200, empty text) so the caller can use
// its template fallback; the last attempt's failure is recorded in
// lastGeminiFailure for the bot panel. Never throws. An explicit
// `prompt` may be passed (the multi-provider router builds the prompt
// once and shares it across providers); otherwise it is built from
// bot + memories + context exactly as before.
export async function generateGeminiDetailed({ apiKey, bot, memories = [], context = {}, prompt, fetchImpl, timeoutMs = GEMINI_TIMEOUT_MS } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) return null; // no key -> never call the provider at all
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return null;
  const finalPrompt = typeof prompt === 'string' && prompt ? prompt : buildGeminiPrompt(bot, memories, context);
  const models = geminiAttemptModels(bot);
  let attempts = 0;
  let lastFailure = null;
  let lastModel = '';
  for (const model of models) {
    attempts += 1;
    const r = await attemptGeminiOnce({ key, model, prompt: finalPrompt, doFetch, timeoutMs });
    if (r.text) {
      lastGeminiFailure = '';
      lastGeminiAttempts = attempts;
      return { text: r.text, model, usage: r.usage || null, attempts };
    }
    lastFailure = r.failure;
    lastModel = model;
  }
  lastGeminiFailure = formatGeminiFailure(lastFailure, lastModel, attempts > 1);
  lastGeminiAttempts = attempts;
  return null;
}

// Text-only wrapper kept for the original callers/tests: same attempts,
// same failure recording, returns just the trimmed text (or null).
export async function generateGeminiText(args = {}) {
  const r = await generateGeminiDetailed(args);
  return r ? r.text : null;
}
