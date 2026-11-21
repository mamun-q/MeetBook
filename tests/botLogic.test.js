import { describe, it, expect } from 'vitest';
import {
  normaliseBot, selectMemories, buildBotPrompt, generateTemplatePost,
  generateTemplateComment, decideBotAction, memoryFromConversation, DEFAULT_BOT_LIMITS,
  templateBotMessageReply, findBotReplyTargets, emptyBotCounters, counterDayKey, botCountersForDay,
  botAlreadyCommented, pickBotCommentTarget, normaliseBotText, isDuplicateBotText,
  freshTemplatePost, freshTemplateComment
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

describe('templateBotMessageReply', () => {
  it('riffs on a mentioned interest', () => {
    const text = templateBotMessageReply(nova, 'tell me about space please');
    expect(text).toContain('space');
    expect(text).toContain('AI bot');
  });
  it('falls back to an introduction naming the bot and its topics', () => {
    const text = templateBotMessageReply(sage, 'hello there');
    expect(text).toContain('Sage');
    expect(text).toContain('books');
  });
});

describe('findBotReplyTargets', () => {
  const convs = [
    { id: 'c1', participants: ['human1', 'bot_nova'], isGroup: false },
    { id: 'c2', participants: ['human2', 'bot_nova'], isGroup: false },
    { id: 'c3', participants: ['human1', 'bot_nova', 'human2'], isGroup: true },
    { id: 'c4', participants: ['human1', 'human2'], isGroup: false },
    { id: 'c5', participants: ['human3', 'bot_nova'], isGroup: false }
  ];
  const latest = {
    c1: { id: 'm1', senderId: 'human1', text: 'hi', createdAt: 300 },
    c2: { id: 'm2', senderId: 'bot_nova', text: 'already answered', createdAt: 100 },
    c3: { id: 'm3', senderId: 'human1', text: 'group msg', createdAt: 50 },
    c4: { id: 'm4', senderId: 'human1', text: 'not for the bot', createdAt: 10 },
    c5: { id: 'm5', senderId: 'human3', text: 'older unanswered', createdAt: 200 }
  };
  it('picks only unreplied human-last 1-1 conversations, oldest first', () => {
    const targets = findBotReplyTargets(convs, latest, 'bot_nova');
    expect(targets.map((x) => x.conversationId)).toEqual(['c5', 'c1']);
    expect(targets[0].humanId).toBe('human3');
    expect(targets[1].lastMessage.text).toBe('hi');
  });
  it('accepts a Map for latest messages and skips empty conversations', () => {
    const map = new Map(Object.entries(latest));
    map.set('c1', null);
    const targets = findBotReplyTargets(convs, map, 'bot_nova');
    expect(targets.map((x) => x.conversationId)).toEqual(['c5']);
  });
});

describe('live runner counters', () => {
  it('counterDayKey uses the Asia/Dhaka calendar day on any runtime', () => {
    // 2026-01-05 19:30 UTC is already 2026-01-06 01:30 in Dhaka.
    expect(counterDayKey(Date.UTC(2026, 0, 5, 19, 30))).toBe('2026-01-06');
    // 2026-01-05 12:00 UTC is 18:00 the same day in Dhaka.
    expect(counterDayKey(Date.UTC(2026, 0, 5, 12, 0))).toBe('2026-01-05');
  });
  it('botCountersForDay keeps same-day counters and resets stale days', () => {
    const stored = { day: '2026-01-05', counters: { bot_nova: { postsToday: 2, lastActionAt: 9 } } };
    const today = botCountersForDay(stored, '2026-01-05');
    expect(today.bot_nova.postsToday).toBe(2);
    expect(today.bot_nova.messagesToday).toBe(0); // defaults filled in
    expect(botCountersForDay(stored, '2026-01-06')).toEqual({});
    expect(botCountersForDay(null, '2026-01-05')).toEqual({});
    expect(emptyBotCounters()).toEqual({ postsToday: 0, commentsToday: 0, likesToday: 0, messagesToday: 0, lastActionAt: 0 });
  });
});

describe('anti-repetition guards (Audit #3)', () => {
  const post = (id, authorId, comments = []) => ({ id, authorId, comments });

  it('botAlreadyCommented sees only the bot\'s own top-level comments', () => {
    expect(botAlreadyCommented(post('p1', 'u1', [{ authorId: 'bot_sage' }]), 'bot_sage')).toBe(true);
    expect(botAlreadyCommented(post('p1', 'u1', [{ authorId: 'u2' }]), 'bot_sage')).toBe(false);
    expect(botAlreadyCommented(post('p1', 'u1'), 'bot_sage')).toBe(false);
    expect(botAlreadyCommented(null, 'bot_sage')).toBe(false);
  });

  it('pickBotCommentTarget skips own + already-commented posts, else null (NO fallback)', () => {
    const posts = [
      post('own', 'bot_sage'),
      post('done', 'u1', [{ authorId: 'bot_sage', text: 'Great point, I had not thought of it that way.' }]),
      post('fresh', 'u2'),
    ];
    expect(pickBotCommentTarget(posts, 'bot_sage')?.id).toBe('fresh');
    // Every candidate exhausted -> null, never a second comment on 'done'.
    expect(pickBotCommentTarget(posts.slice(0, 2), 'bot_sage')).toBeNull();
    expect(pickBotCommentTarget([], 'bot_sage')).toBeNull();
  });

  it('normaliseBotText strips the stored prefix and folds case/space', () => {
    expect(normaliseBotText('AI Bot post · Hello   Brave   World')).toBe('hello brave world');
    expect(normaliseBotText('  Plain text ')).toBe('plain text');
    expect(normaliseBotText('')).toBe('');
  });

  it('isDuplicateBotText matches a stored post against generated text', () => {
    const stored = ['AI Bot post · Thinking about books today. What has everyone else been up to?'];
    expect(isDuplicateBotText('Thinking about books today. What has everyone else been up to?', stored)).toBe(true);
    expect(isDuplicateBotText('Something entirely new', stored)).toBe(false);
    expect(isDuplicateBotText('', stored)).toBe(false);
  });

  it('freshTemplatePost returns a non-repeating template, or null when all repeat', () => {
    const all = [0.01, 0.21, 0.41, 0.61, 0.81].map((s) => generateTemplatePost(sage, s));
    expect(new Set(all).size).toBe(5);
    expect(freshTemplatePost(sage, [])).toBeTruthy();
    const fresh = freshTemplatePost(sage, [all[0]]);
    expect(fresh).toBeTruthy();
    expect(isDuplicateBotText(fresh, [all[0]])).toBe(false);
    expect(freshTemplatePost(sage, all)).toBeNull();
    // Stored shape (with prefix) must also count as repetition.
    expect(freshTemplatePost(sage, all.map((t) => `AI Bot post · ${t}`))).toBeNull();
  });

  it('freshTemplateComment avoids texts the bot already used', () => {
    const all = [0.01, 0.26, 0.51, 0.76].map((s) => generateTemplateComment(sage, s));
    expect(new Set(all).size).toBe(4);
    expect(freshTemplateComment(sage, all)).toBeNull();
    expect(freshTemplateComment(sage, [])).toBeTruthy();
  });
});
