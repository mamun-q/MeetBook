import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildGeminiPrompt, generateGeminiText, canAccessBotSecrets, GEMINI_MODEL, GEMINI_FALLBACK_MODEL, geminiAttemptModels, getLastGeminiFailure, resetLastGeminiFailure } from '../src/gemini.js';

const nova = {
  id: 'bot_nova', name: 'Nova', username: 'nova.bot', active: true,
  personality: { traits: ['curious', 'witty'], tone: 'bright and playful', interests: ['space', 'science'], systemPrompt: 'You are Nova, a curious AI bot on MeetBook.' },
  limits: { postsPerDay: 3, commentsPerDay: 10, likesPerDay: 20, messagesPerDay: 5, minIntervalMs: 0 }
};
const memories = [
  { id: 'm1', text: 'Nova enjoys talking about telescopes and exoplanets.', createdAt: Date.now(), pinned: true },
  { id: 'm2', text: 'People respond warmly to questions at the end of a post.', createdAt: Date.now(), pinned: false }
];

describe('buildGeminiPrompt (mirrors functions/botEngine.js gemini provider)', () => {
  it('includes the bot identity, its own memories and the context', () => {
    const prompt = buildGeminiPrompt(nova, memories, { kind: 'comment', text: 'আমার নতুন টেলিস্কোপ কিনেছি!' });
    expect(prompt).toContain('You are Nova');
    expect(prompt).toContain('curious, witty');
    expect(prompt).toContain('bright and playful');
    expect(prompt).toContain('telescopes and exoplanets');
    expect(prompt).toContain('আমার নতুন টেলিস্কোপ কিনেছি!');
  });
  it('states the task, the never-human rule, the word cap and the language rule', () => {
    const prompt = buildGeminiPrompt(nova, memories, { kind: 'message', text: 'hello there' });
    expect(prompt).toContain('message reply');
    expect(prompt).toContain('never claim to be human');
    expect(prompt).toContain('under 60 words');
    expect(prompt).toContain('Bangla');
    expect(prompt).toContain('same language as the context');
  });
  it('works with no memories and no context text', () => {
    const prompt = buildGeminiPrompt(nova, [], { kind: 'post' });
    expect(prompt).toContain('(none)');
    expect(prompt).toContain('write a short post');
  });
});

describe('generateGeminiText', () => {
  beforeEach(() => resetLastGeminiFailure());

  const okResponse = (text) => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] })
  });
  const errResponse = (status, message) => ({
    ok: false,
    status,
    json: async () => (message === undefined ? {} : { error: { message } })
  });

  it('returns the generated text on success and calls the configured model', async () => {
    const fetchImpl = vi.fn(async () => okResponse('  A brand new exoplanet!  '));
    const text = await generateGeminiText({ apiKey: 'KEY123', bot: nova, memories, context: { kind: 'post' }, fetchImpl });
    expect(text).toBe('A brand new exoplanet!');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toContain(`models/${GEMINI_MODEL}:generateContent`);
    expect(url).toContain('key=KEY123');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.contents[0].parts[0].text).toContain('You are Nova');
  });

  it('falls back (null) on an HTTP error', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    const text = await generateGeminiText({ apiKey: 'KEY123', bot: nova, memories, context: { kind: 'post' }, fetchImpl });
    expect(text).toBeNull();
  });

  it('falls back (null) on a network error', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    const text = await generateGeminiText({ apiKey: 'KEY123', bot: nova, memories, context: { kind: 'post' }, fetchImpl });
    expect(text).toBeNull();
  });

  it('falls back (null) when Gemini returns empty text', async () => {
    const fetchImpl = vi.fn(async () => okResponse('   '));
    const text = await generateGeminiText({ apiKey: 'KEY123', bot: nova, memories, context: { kind: 'post' }, fetchImpl });
    expect(text).toBeNull();
  });

  it('never calls fetch when there is no key', async () => {
    const fetchImpl = vi.fn(async () => okResponse('should not happen'));
    expect(await generateGeminiText({ apiKey: '', bot: nova, memories, context: { kind: 'post' }, fetchImpl })).toBeNull();
    expect(await generateGeminiText({ apiKey: '   ', bot: nova, memories, context: { kind: 'post' }, fetchImpl })).toBeNull();
    expect(await generateGeminiText({ bot: nova, memories, context: { kind: 'post' }, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('generateGeminiText model fallback + failure detail', () => {
  beforeEach(() => resetLastGeminiFailure());

  const okResponse = (text) => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] })
  });
  const errResponse = (status, message) => ({
    ok: false,
    status,
    json: async () => (message === undefined ? {} : { error: { message } })
  });
  // Route a mocked fetch by the model named in the request URL.
  const byModel = (handlers) => vi.fn(async (url) => {
    const model = /models\/([^:]+):generateContent/.exec(url)?.[1];
    const h = handlers[model];
    if (!h) throw new Error(`unexpected model ${model}`);
    return typeof h === 'function' ? h() : h;
  });

  it('builds a deduped attempt list: bot model, platform default, lite backup', () => {
    expect(geminiAttemptModels(nova)).toEqual([GEMINI_MODEL, GEMINI_FALLBACK_MODEL]);
    expect(geminiAttemptModels({ ...nova, model: GEMINI_FALLBACK_MODEL })).toEqual([GEMINI_FALLBACK_MODEL, GEMINI_MODEL]);
    expect(geminiAttemptModels({ ...nova, model: 'gemini-custom-x' })).toEqual(['gemini-custom-x', GEMINI_MODEL, GEMINI_FALLBACK_MODEL]);
  });

  it('falls back to the platform default when the bot\'s stored model fails (400 -> 200)', async () => {
    const bot = { ...nova, model: 'gemini-custom-x' };
    const fetchImpl = byModel({
      'gemini-custom-x': errResponse(400, 'Model not found or retired.'),
      [GEMINI_MODEL]: okResponse('Recovered by the default model!')
    });
    const text = await generateGeminiText({ apiKey: 'KEY123', bot, memories, context: { kind: 'post' }, fetchImpl });
    expect(text).toBe('Recovered by the default model!');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain('models/gemini-custom-x:generateContent');
    expect(fetchImpl.mock.calls[1][0]).toContain(`models/${GEMINI_MODEL}:generateContent`);
    expect(getLastGeminiFailure()).toBe(''); // success clears the recorded failure
  });

  it('falls back through a network error and an empty response too', async () => {
    const bot = { ...nova, model: 'gemini-custom-x' };
    const fetchImpl = byModel({
      'gemini-custom-x': () => { throw new Error('socket hang up'); },
      [GEMINI_MODEL]: okResponse('   '),
      [GEMINI_FALLBACK_MODEL]: okResponse('Third time lucky.')
    });
    const text = await generateGeminiText({ apiKey: 'KEY123', bot, context: { kind: 'post' }, fetchImpl });
    expect(text).toBe('Third time lucky.');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('records the LAST attempt\'s status and provider message when every model fails', async () => {
    const fetchImpl = byModel({
      [GEMINI_MODEL]: errResponse(500, 'Internal error encountered.'),
      [GEMINI_FALLBACK_MODEL]: errResponse(503, 'The model is currently overloaded. Please try again later.')
    });
    const text = await generateGeminiText({ apiKey: 'KEY123', bot: nova, context: { kind: 'post' }, fetchImpl });
    expect(text).toBeNull();
    expect(getLastGeminiFailure()).toBe(`HTTP 503 (${GEMINI_FALLBACK_MODEL}): The model is currently overloaded. Please try again later.`);
  });

  it('keeps just the status when the error body is not JSON', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } }));
    const text = await generateGeminiText({ apiKey: 'KEY123', bot: nova, context: { kind: 'post' }, fetchImpl });
    expect(text).toBeNull();
    expect(getLastGeminiFailure()).toBe(`HTTP 502 (${GEMINI_FALLBACK_MODEL})`);
  });

  it('sanitises a provider message that somehow embeds the API key', async () => {
    const fetchImpl = vi.fn(async () => errResponse(400, 'Invalid request; key KEY123 was rejected by the API.'));
    const text = await generateGeminiText({ apiKey: 'KEY123', bot: nova, context: { kind: 'post' }, fetchImpl });
    expect(text).toBeNull();
    const failure = getLastGeminiFailure();
    expect(failure).not.toContain('KEY123');
    expect(failure).toBe(`HTTP 400 (${GEMINI_FALLBACK_MODEL}): Invalid request; key`);
  });

  it('caps a long provider message at ~120 chars', async () => {
    const fetchImpl = vi.fn(async () => errResponse(400, 'x'.repeat(300)));
    await generateGeminiText({ apiKey: 'KEY123', bot: nova, context: { kind: 'post' }, fetchImpl });
    const failure = getLastGeminiFailure();
    expect(failure.startsWith(`HTTP 400 (${GEMINI_FALLBACK_MODEL}): `)).toBe(true);
    expect(failure.length).toBeLessThanOrEqual(`HTTP 400 (${GEMINI_FALLBACK_MODEL}): `.length + 120);
  });

  it('single-model success is unchanged: exactly one fetch, failure string cleared', async () => {
    const failing = vi.fn(async () => { throw new Error('offline'); });
    expect(await generateGeminiText({ apiKey: 'KEY123', bot: nova, context: { kind: 'post' }, fetchImpl: failing })).toBeNull();
    expect(getLastGeminiFailure()).not.toBe('');
    const ok = vi.fn(async () => okResponse('fresh text'));
    const text = await generateGeminiText({ apiKey: 'KEY123', bot: nova, context: { kind: 'post' }, fetchImpl: ok });
    expect(text).toBe('fresh text');
    expect(ok).toHaveBeenCalledTimes(1);
    expect(getLastGeminiFailure()).toBe('');
  });
});

describe('canAccessBotSecrets (botSecrets gating)', () => {
  it('allows only human admins', () => {
    expect(canAccessBotSecrets({ id: 'u1', role: 'admin', isBot: false })).toBe(true);
    expect(canAccessBotSecrets({ id: 'u2', role: 'user', isBot: false })).toBe(false);
    expect(canAccessBotSecrets({ id: 'b1', role: 'admin', isBot: true })).toBe(false);
    expect(canAccessBotSecrets({ id: 'b2', role: 'bot', isBot: true })).toBe(false);
    expect(canAccessBotSecrets(null)).toBe(false);
    expect(canAccessBotSecrets(undefined)).toBe(false);
  });
});
