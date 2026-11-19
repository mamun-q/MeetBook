import { describe, it, expect } from 'vitest';
import {
  normaliseBot, selectMemories, buildBotPrompt, generateTemplatePost,
  generateTemplateComment, decideBotAction, memoryFromConversation, DEFAULT_BOT_LIMITS
} from '../src/botLogic.js';

const nova = {
  id: 'bot_nova', name: 'Nova', username: 'nova.bot', active: true,
  personality: { traits: ['curious', 'witty'], tone: 'bright', interests: ['space', 'science'], systemPrompt: 'You are Nova.' },
  limits: { postsPerDay: 2, commentsPerDay: 2, likesPerDay: 2, messagesPerDay: 1, minIntervalMs: 0 }
};
const sage = {
  id: 'bot_sage', name: 'Sage', username: 'sage.bot', active: true,
  personality: { traits: ['calm'], tone: 'calm and wise', interests: ['books'], systemPrompt: 'You are Sage.' }
};

describe('normaliseBot', () => {
  it('gives every bot its own defaults and keeps its identity separate', () => {
    const a = normaliseBot(nova);
    const b = normaliseBot(sage);
    expect(a.personality.systemPrompt).toContain('Nova');
    expect(b.personality.systemPrompt).toContain('Sage');
    expect(a.limits.postsPerDay).toBe(2);
    expect(b.limits.postsPerDay).toBe(DEFAULT_BOT_LIMITS.postsPerDay);
    expect(a.isBot).toBe(true);
  });
});

describe('selectMemories (per-bot memory retrieval)', () => {
  const memories = [
    { id: '1', text: 'Loves talking about space and telescopes', createdAt: Date.now(), pinned: false },
    { id: '2', text: 'Favourite food is spicy noodles', createdAt: Date.now(), pinned: false },
    { id: '3', text: 'General small talk note', createdAt: Date.now(), pinned: true }
  ];
  it('ranks keyword-relevant memories first and honours the cap', () => {
    const picked = selectMemories(memories, 'tell me about space', 2);
    expect(picked.length).toBeLessThanOrEqual(2);
    expect(picked[0].text).toContain('space');
  });
  it('buildBotPrompt includes only that bot prompt + its memories', () => {
    const prompt = buildBotPrompt(nova, memories, 'space chat');
    expect(prompt).toContain('You are Nova.');
    expect(prompt).toContain('space and telescopes');
    expect(prompt).not.toContain('You are Sage.');
  });
});

describe('template generation (no-key fallback)', () => {
  it('generates posts flavoured by the bot own interests', () => {
    const texts = new Set();
    for (let i = 0; i < 20; i++) texts.add(generateTemplatePost(nova, i / 20));
    expect([...texts].some((x) => /space|science|curious/i.test(x))).toBe(true);
    expect(generateTemplateComment(sage, 0.1).length).toBeGreaterThan(3);
  });
});

describe('decideBotAction', () => {
  it('respects the global kill switch and deactivation', () => {
    expect(decideBotAction(nova, {}, false).action).toBe('none');
    expect(decideBotAction({ ...nova, active: false }, {}, true).action).toBe('none');
  });
  it('walks post -> comment -> like -> message as limits fill', () => {
    expect(decideBotAction(nova, { postsToday: 0 }).action).toBe('post');
    expect(decideBotAction(nova, { postsToday: 2, commentsToday: 0 }).action).toBe('comment');
    expect(decideBotAction(nova, { postsToday: 2, commentsToday: 2, likesToday: 0 }).action).toBe('like');
    expect(decideBotAction(nova, { postsToday: 2, commentsToday: 2, likesToday: 2, messagesToday: 0 }).action).toBe('message');
    expect(decideBotAction(nova, { postsToday: 2, commentsToday: 2, likesToday: 2, messagesToday: 1 }).action).toBe('none');
  });
  it('honours the minimum interval between actions', () => {
    const bot = { ...nova, limits: { ...nova.limits, minIntervalMs: 60_000 } };
    expect(decideBotAction(bot, { lastActionAt: Date.now() }, true).reason).toContain('interval');
  });
});

describe('memoryFromConversation', () => {
  it('appends a note to that bot memory and caps the store', () => {
    const before = Array.from({ length: 100 }, (_, i) => ({ id: String(i), text: `m${i}`, createdAt: i, updatedAt: i }));
    const after = memoryFromConversation(before, 'hello space', 'hi there');
    expect(after.length).toBe(100);
    expect(after[after.length - 1].text).toContain('hello space');
  });
});
