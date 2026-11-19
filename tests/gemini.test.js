import { describe, it, expect, vi } from 'vitest';
import { buildGeminiPrompt, generateGeminiText, canAccessBotSecrets, GEMINI_MODEL } from '../src/gemini.js';

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
  const okResponse = (text) => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] })
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
