// Multi-provider AI layer (Stage A) — a provider registry, one adapter
// per provider, and a router that gives every bot text from the best
// available provider. Design rules, from the verified free-tier facts
// (official docs, 2026-11-20):
//
//  - Only Gemini, Groq and OpenRouter have a genuine free tier with no
//    payment method on file. Cerebras (one-time $5 trial credit after
//    adding a card, expires in 30 days) and Hugging Face (free
//    inference credits removed) are PAID — they sit in the registry as
//    'paid-only', are never attempted while the platform's paid
//    approval is off, and their admin cards say why.
//  - Ollama is self-hosted software: the adapter speaks to a custom
//    endpoint (default http://localhost:11434/v1), needs no key, and
//    is disabled by default.
//  - Personality and memory are provider-agnostic: the router builds
//    the prompt ONCE (gemini.js buildGeminiPrompt) and hands the same
//    prompt to every adapter, so switching providers never changes who
//    a bot is.
//  - Usage numbers come from the providers' own usage fields (Gemini
//    usageMetadata, OpenAI-shaped usage) — never estimated. When a
//    provider does not report tokens, usage stays null and the panel
//    says "tokens not reported by provider".
//
// Storage (api.js): provider keys/endpoints live in the admin-only
// botSecrets/config doc (providers map; Gemini keeps its original
// geminiApiKey field), the fallback order + paid approval live in the
// config/app platform settings, and per-day usage counters ride inside
// botSecrets/config too (the aiUsage collection has no Firestore rules
// match, so the catch-all would deny it — botSecrets is admin
// read/write, which is exactly the runner's access).
import { buildGeminiPrompt, generateGeminiDetailed, getLastGeminiFailure, getLastGeminiAttempts, GEMINI_MODEL } from './gemini.js';
import { normaliseBot } from './botLogic.js';

export const AI_ROUTER_TIMEOUT_MS = 20_000;
export const DEFAULT_FALLBACK_ORDER = ['gemini', 'groq', 'openrouter'];

// ---------------------------------------------------------------------
// Registry. `models` lists the provider's FREE models where a fixed
// list exists; freeText providers accept any model id (OpenRouter's
// :free roster rotates, paid/self-hosted catalogues are open-ended).
// dailyCap is the verified free requests/day ceiling (null = no cap
// published / not applicable) — the router stops before crossing it.
// ---------------------------------------------------------------------
export const AI_PROVIDERS = [
  {
    id: 'gemini', label: 'Google Gemini', kind: 'gemini-native',
    models: ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'],
    freeText: false, defaultModel: GEMINI_MODEL,
    dailyCap: null, rpmNote: 'Free quotas are per project — visible only in AI Studio; Google no longer publishes per-model numbers.',
    freeStatus: 'free',
    blurb: 'Google Gemini API — free tier via AI Studio, no payment method needed. Free-tier content may be used by Google to improve its products.'
  },
  {
    id: 'groq', label: 'Groq', kind: 'openai-compat',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    freeText: false, defaultModel: 'openai/gpt-oss-120b',
    dailyCap: 1000, rpmNote: '30 requests/minute · 1,000 requests/day per free model (org-level).',
    freeStatus: 'free',
    blurb: 'Groq free plan — no card required. ONLY the models listed here are free; the Llama models are no longer on the free plan.'
  },
  {
    id: 'openrouter', label: 'OpenRouter', kind: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openrouter/free'],
    freeText: true, defaultModel: 'openrouter/free',
    dailyCap: 50, rpmNote: '20 requests/minute · 50 free requests/day.',
    freeStatus: 'free',
    blurb: 'OpenRouter free models through the openrouter/free router — the :free roster rotates every few weeks, so the router model id always resolves to a currently-free model. Any :free model id can also be entered as a custom model.'
  },
  {
    id: 'ollama', label: 'Ollama (self-hosted)', kind: 'openai-compat',
    baseUrl: 'http://localhost:11434/v1', endpointField: true, needsKey: false,
    models: [], freeText: true, defaultModel: '',
    dailyCap: null, rpmNote: 'Self-hosted — no provider limits.',
    freeStatus: 'self-hosted',
    blurb: 'Ollama runs open models on your own machine: free and unlimited, but the endpoint must be reachable from the admin\'s browser (the default points at this device). Off by default; model ids are whatever you have pulled locally (e.g. llama3.1).'
  },
  {
    id: 'cerebras', label: 'Cerebras', kind: 'openai-compat',
    baseUrl: 'https://api.cerebras.ai/v1',
    models: [], freeText: true, defaultModel: '',
    dailyCap: null, rpmNote: 'Paid per token once trial credit ends.',
    freeStatus: 'paid-only',
    paidNote: 'No standing free tier — only a one-time $5 trial credit AFTER adding a payment method, and it expires in 30 days.',
    blurb: 'Cerebras Inference — very fast, but not free. Kept disconnected unless paid-provider approval is on.'
  },
  {
    id: 'huggingface', label: 'Hugging Face', kind: 'openai-compat',
    baseUrl: 'https://router.huggingface.co/v1',
    models: [], freeText: true, defaultModel: '',
    dailyCap: null, rpmNote: 'Paid per token.',
    freeStatus: 'paid-only',
    paidNote: 'Hugging Face removed free inference credits — Inference Providers usage is billed per token.',
    blurb: 'Hugging Face Inference Providers router — not free anymore. Kept disconnected unless paid-provider approval is on.'
  }
];

export function providerById(id) {
  return AI_PROVIDERS.find((p) => p.id === String(id || '')) || null;
}

// The model a bot effectively generates with on a provider: its own
// configured model first, then the provider's default.
export function botEffectiveModel(bot, providerId) {
  const entry = providerById(providerId);
  const own = typeof bot?.model === 'string' ? bot.model.trim() : '';
  return own || entry?.defaultModel || GEMINI_MODEL;
}

// ---------------------------------------------------------------------
// Config resolution: merge the stored botSecrets providers map + the
// platform settings into the shape the router consumes. Gemini's key
// keeps living in its original top-level geminiApiKey field.
// ---------------------------------------------------------------------
export function resolveAiConfig(botSecrets = {}, platformConfig = {}) {
  const stored = botSecrets && typeof botSecrets.providers === 'object' && botSecrets.providers ? botSecrets.providers : {};
  const providers = {};
  for (const entry of AI_PROVIDERS) {
    const s = stored[entry.id] || {};
    providers[entry.id] = {
      enabled: s.enabled !== false,
      apiKey: entry.id === 'gemini'
        ? String(botSecrets?.geminiApiKey || s.apiKey || '').trim()
        : String(s.apiKey || '').trim(),
      endpoint: String(s.endpoint || '').trim(),
      defaultModel: String(s.defaultModel || '').trim() || entry.defaultModel || ''
    };
  }
  const seen = new Set();
  const order = (Array.isArray(platformConfig?.aiFallbackOrder) ? platformConfig.aiFallbackOrder : [])
    .map((id) => String(id || '').trim().toLowerCase())
    .filter((id) => providerById(id) && !seen.has(id) && seen.add(id));
  return {
    providers,
    fallbackOrder: order.length ? order : [...DEFAULT_FALLBACK_ORDER],
    paidApproved: platformConfig?.aiPaidApproved === true
  };
}

// Why a provider cannot be attempted right now ('' = it can). Config
// reasons only — quota/exhaustion is usageBlockReason below.
export function providerBlockReason(entry, cfg, config) {
  if (!entry) return 'unknown provider';
  if (entry.freeStatus === 'paid-only' && !config?.paidApproved) return 'paid provider not approved';
  if (!cfg || cfg.enabled === false) return 'provider is disabled';
  if (entry.needsKey !== false && !cfg.apiKey) return 'no API key saved';
  return '';
}

export function usageBlockReason(entry, usage, now = Date.now()) {
  if (!entry || !usage) return '';
  if (usage.exhaustedUntil && usage.exhaustedUntil > now) return 'rate-limited earlier today';
  if (entry.dailyCap != null && (usage.calls || 0) >= entry.dailyCap) return 'daily free cap reached';
  return '';
}

// True when at least one provider could actually be attempted (has a
// key / endpoint and is not gated off) — the runner uses this to decide
// whether a total generation failure is worth a warning log line.
export function anyProviderConfigured(config) {
  if (!config) return false;
  return AI_PROVIDERS.some((entry) => {
    const cfg = config.providers?.[entry.id];
    return cfg && !providerBlockReason(entry, cfg, config);
  });
}

// ---------------------------------------------------------------------
// Usage counters (per provider, per day). The day key is Dhaka time —
// the platform's home timezone — formatted yyyy-mm-dd.
// ---------------------------------------------------------------------
export function dhakaDayKey(now = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
    const get = (type) => parts.find((p) => p.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}

export function emptyProviderUsage() {
  return { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, exhaustedUntil: 0 };
}

export function normaliseUsageMap(raw) {
  const out = {};
  for (const entry of AI_PROVIDERS) {
    const u = raw && typeof raw === 'object' ? raw[entry.id] : null;
    out[entry.id] = {
      calls: Number(u?.calls) || 0,
      errors: Number(u?.errors) || 0,
      promptTokens: Number(u?.promptTokens) || 0,
      completionTokens: Number(u?.completionTokens) || 0,
      exhaustedUntil: Number(u?.exhaustedUntil) || 0
    };
  }
  return out;
}

export function usageTotals(providers) {
  let calls = 0; let tokens = 0; let errors = 0;
  for (const u of Object.values(providers || {})) {
    calls += Number(u?.calls) || 0;
    errors += Number(u?.errors) || 0;
    tokens += (Number(u?.promptTokens) || 0) + (Number(u?.completionTokens) || 0);
  }
  return { calls, tokens, errors };
}

// ---------------------------------------------------------------------
// Adapters. Each returns { ok: true, text, model, usage } or
// { ok: false, status, message } with the provider's own error message
// sanitised the same way gemini.js does it (whitespace collapsed, ~120
// chars, cut at the API key if it somehow appears). Never throws.
// ---------------------------------------------------------------------
function sanitiseProviderMessage(raw, key) {
  let msg = String(raw || '').replace(/\s+/g, ' ').trim();
  if (key) {
    const at = msg.indexOf(key);
    if (at !== -1) msg = msg.slice(0, at).trim();
  }
  return msg.slice(0, 120);
}

async function fetchWithTimeout(doFetch, url, opts, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await doFetch(url, { ...opts, ...(controller ? { signal: controller.signal } : {}) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function openAiUsage(json) {
  const u = json?.usage;
  if (!u) return null;
  const promptTokens = Number(u.prompt_tokens);
  const completionTokens = Number(u.completion_tokens);
  if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens)) return null;
  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0
  };
}

async function attemptOpenAiCompat({ entry, cfg, model, prompt, doFetch, timeoutMs }) {
  const base = String(entry.endpointField ? (cfg.endpoint || entry.baseUrl) : entry.baseUrl).replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  // OpenRouter asks apps to identify themselves; harmless elsewhere.
  if (entry.id === 'openrouter' && typeof location !== 'undefined' && location.origin) {
    headers['HTTP-Referer'] = location.origin;
    headers['X-OpenRouter-Title'] = 'MeetBook';
  }
  let res;
  try {
    res = await fetchWithTimeout(doFetch, `${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] })
    }, timeoutMs);
  } catch (err) {
    return { ok: false, status: 0, message: String(err?.name || err?.message || 'network error') };
  }
  if (!res) return { ok: false, status: 0, message: 'no response' };
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok) {
    return { ok: false, status: res.status, message: sanitiseProviderMessage(json?.error?.message || json?.message, cfg.apiKey) };
  }
  const content = json?.choices?.[0]?.message?.content;
  const text = (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p?.text || '').join('') : '').trim();
  if (!text) return { ok: false, status: 0, message: 'empty response' };
  return { ok: true, text, model: typeof json?.model === 'string' && json.model ? json.model : model, usage: openAiUsage(json) };
}

// The Gemini adapter reuses gemini.js wholesale: its internal model
// chain (bot model → platform default → lite backup) IS the Gemini
// attempt, so the router must never queue a second Gemini pair for the
// same request (that would resend to the same targets).
async function attemptGeminiRouted({ cfg, model, prompt, bot, doFetch, timeoutMs }) {
  const r = await generateGeminiDetailed({ apiKey: cfg.apiKey, bot: { ...bot, model }, prompt, fetchImpl: doFetch, timeoutMs });
  if (r) return { ok: true, text: r.text, model: r.model, usage: r.usage, attempts: r.attempts || 1 };
  const detail = getLastGeminiFailure();
  const status = Number(/^HTTP (\d+)/.exec(detail || '')?.[1]) || 0;
  return { ok: false, status, message: detail, attempts: getLastGeminiAttempts() || 1 };
}

// ---------------------------------------------------------------------
// Router.
// ---------------------------------------------------------------------
let lastRoutedFailure = '';
export function getLastRoutedFailure() {
  return lastRoutedFailure;
}
export function resetLastRoutedFailure() {
  lastRoutedFailure = '';
}

function formatRoutedFailure({ entry, status, message }) {
  // Gemini's recorded failure already reads "HTTP 400 (model): ..." —
  // don't stack a second status in front of it.
  if (message && /^HTTP \d+/.test(message)) return `${entry.label} — ${message}`;
  const head = status ? `HTTP ${status}` : 'request failed';
  return message ? `${entry.label} — ${head}: ${message}` : `${entry.label} — ${head}`;
}

// Generate one bot text through the provider chain:
//   1. the bot's own provider+model (or the head of the fallback order
//      with the bot's model, when the bot names no provider),
//   2. the admin's fallback order, each with its default model.
// A (provider, model) pair is attempted at most once per call, and
// Gemini at most once in any form (its adapter walks models itself).
// Providers that are disabled, keyless, paid-locked, cap-reached or
// rate-limit-exhausted are skipped WITHOUT a request. onAttempt fires
// once per real attempt so the caller can persist usage counters.
// Returns { text, provider, model, usage } or null when every attempt
// failed (lastRoutedFailure then holds the last failure, formatted for
// the runner summary). Never throws.
export async function generateRouted({ bot, memories = [], context = {}, config, usageToday = {}, fetchImpl, timeoutMs = AI_ROUTER_TIMEOUT_MS, now = Date.now(), onAttempt } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch || !config) return null;
  const b = normaliseBot(bot);
  const prompt = buildGeminiPrompt(b, memories, context);

  const chain = [];
  const seenPairs = new Set();
  let geminiQueued = false;
  const push = (providerId, model) => {
    const entry = providerById(providerId);
    if (!entry) return;
    if (entry.id === 'gemini') {
      if (geminiQueued) return;
      geminiQueued = true;
    }
    const m = String(model || '').trim() || entry.defaultModel || '';
    const pairKey = `${entry.id}::${m}`;
    if (seenPairs.has(pairKey)) return;
    seenPairs.add(pairKey);
    chain.push({ entry, model: m });
  };
  const primaryId = b.provider || config.fallbackOrder[0] || 'gemini';
  // The bot's own model belongs to its own provider's namespace. A bot
  // with no provider set carries a legacy Gemini model name, so apply
  // it only when the primary attempt is Gemini itself — never send a
  // Gemini model id to Groq/OpenRouter by mistake.
  const ownModel = (b.provider || primaryId === 'gemini') ? b.model : '';
  push(primaryId, ownModel || config.providers[primaryId]?.defaultModel);
  for (const id of config.fallbackOrder) push(id, config.providers[id]?.defaultModel);

  const usage = normaliseUsageMap(usageToday);
  let lastFailure = null;
  for (const { entry, model } of chain) {
    const cfg = config.providers[entry.id] || {};
    if (providerBlockReason(entry, cfg, config)) continue;
    if (usageBlockReason(entry, usage[entry.id], now)) continue;
    const r = entry.kind === 'gemini-native'
      ? await attemptGeminiRouted({ cfg, model, prompt, bot: b, doFetch, timeoutMs })
      : await attemptOpenAiCompat({ entry, cfg, model, prompt, doFetch, timeoutMs });
    if (r.ok) {
      onAttempt?.(entry.id, { ok: true, usage: r.usage || null, status: 200, attempts: r.attempts || 1 });
      lastRoutedFailure = '';
      return { text: r.text, provider: entry.id, model: r.model || model, usage: r.usage || null };
    }
    const exhausted = r.status === 429;
    onAttempt?.(entry.id, { ok: false, usage: null, status: r.status || 0, exhausted, attempts: r.attempts || 1 });
    if (exhausted) {
      // Counters are per-day maps, so a +24h stamp means "the rest of
      // today" — tomorrow's fresh map starts un-exhausted.
      usage[entry.id] = { ...usage[entry.id], exhaustedUntil: now + 24 * 3600_000 };
    }
    lastFailure = { entry, status: r.status || 0, message: r.message || '' };
  }
  if (lastFailure) lastRoutedFailure = formatRoutedFailure(lastFailure);
  return null;
}

// One minimal REAL generation call against a provider ("Reply with
// exactly: OK") — the Admin panel's Test connection button. Config
// problems (no key, disabled, paid-locked) are reported without any
// network call, so a "failure" here always means what it says.
export async function testProvider(providerId, { config, fetchImpl, timeoutMs = AI_ROUTER_TIMEOUT_MS } = {}) {
  const entry = providerById(providerId);
  if (!entry) return { ok: false, detail: 'Unknown provider.' };
  const cfg = config?.providers?.[entry.id] || {};
  const blocked = providerBlockReason(entry, cfg, config || {});
  if (blocked) return { ok: false, detail: `Cannot test: ${blocked}.` };
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, detail: 'No network available in this browser.' };
  const model = cfg.defaultModel || entry.defaultModel || '';
  const prompt = 'Reply with exactly: OK';
  const r = entry.kind === 'gemini-native'
    ? await attemptGeminiRouted({ cfg, model, prompt, bot: { name: 'MeetBook', model }, doFetch, timeoutMs })
    : await attemptOpenAiCompat({ entry, cfg, model, prompt, doFetch, timeoutMs });
  if (r.ok) return { ok: true, detail: `Connected — ${entry.label} replied via ${r.model || model || 'default model'}.`, usage: r.usage || null, attempts: r.attempts || 1 };
  return { ok: false, detail: formatRoutedFailure({ entry, status: r.status || 0, message: r.message || '' }), attempts: r.attempts || 1 };
}
