import { describe, it, expect } from 'vitest';
import {
  normaliseBot, selectMemories, buildBotPrompt, generateTemplatePost,
  generateTemplateComment, decideBotAction, memoryFromConversation, DEFAULT_BOT_LIMITS,
  templateBotMessageReply, findBotReplyTargets, emptyBotCounters, counterDayKey, botCountersForDay,
  botAlreadyCommented, pickBotCommentTarget, normaliseBotText, isDuplicateBotText,
  freshTemplatePost, freshTemplateComment,
  textSimilarity, isNearDuplicateBotText, interestRelevance, threadContextText
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
  it('falls back to message when only message capacity remains; none when all full', () => {
    expect(decideBotAction(nova, { postsToday: 2, commentsToday: 2, likesToday: 2, messagesToday: 0 }).action).toBe('message');
    expect(decideBotAction(nova, { postsToday: 2, commentsToday: 2, likesToday: 2, messagesToday: 1 }).action).toBe('none');
  });
  it('chooses among open actions by personality weight (rng-stubbed)', () => {
    const rolls = (vals) => { let i = 0; return () => vals[Math.min(i++, vals.length - 1)]; };
    // nova weights: post 3, comment 4 (curious), like 2 — total 9.
    expect(decideBotAction(nova, {}, true, Date.now(), rolls([0.05])).action).toBe('post');
    expect(decideBotAction(nova, {}, true, Date.now(), rolls([0.5])).action).toBe('comment');
    expect(decideBotAction(nova, {}, true, Date.now(), rolls([0.95])).action).toBe('like');
    // an action at its cap is never chosen (wait roll passes, pick roll low)
    expect(decideBotAction(nova, { postsToday: 2 }, true, Date.now(), rolls([0.99, 0.05])).action).toBe('comment');
  });
  it('can decide to WAIT once it has acted today — calm bots wait more', () => {
    const rolls = (vals) => { let i = 0; return () => vals[Math.min(i++, vals.length - 1)]; };
    const waited = decideBotAction(nova, { postsToday: 1 }, true, Date.now(), rolls([0.01]));
    expect(waited.action).toBe('none');
    expect(waited.reason).toContain('wait');
    // sage (calm) has a higher wait chance: a 0.2 roll waits for sage…
    expect(decideBotAction(sage, { postsToday: 1 }, true, Date.now(), rolls([0.2])).action).toBe('none');
    // …but nova acts on the same roll, then picks by weight.
    expect(decideBotAction(nova, { postsToday: 1 }, true, Date.now(), rolls([0.2, 0.05])).action).toBe('post');
    // a bot that has not acted today never waits
    expect(decideBotAction(sage, {}, true, Date.now(), rolls([0.01, 0.05])).action).not.toBe('none');
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

describe('Master Vision Phase 1: similarity, relevance, thread context, memory dedup', () => {
  it('textSimilarity scores identical text 1 and unrelated text 0', () => {
    expect(textSimilarity('I love space science', 'I love space science')).toBe(1);
    expect(textSimilarity('I love space science', 'cooking tasty pasta recipes')).toBe(0);
    const s = textSimilarity('I love space and science today', 'I love space and science');
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(1);
  });
  it('isNearDuplicateBotText catches reworded repeats, passes fresh text', () => {
    const recent = ['Thinking about space today. What has everyone else been up to?'];
    expect(isNearDuplicateBotText('Thinking about space today — what has everyone else been up to lately?', recent)).toBe(true);
    expect(isNearDuplicateBotText('Just tried a new pasta recipe with basil and garlic', recent)).toBe(false);
  });
  it('interestRelevance scores interest mentions', () => {
    expect(interestRelevance(nova, 'A post about space exploration')).toBe(0.5);
    expect(interestRelevance(nova, 'Grandma cooking recipes')).toBe(0);
    expect(interestRelevance(nova, 'space and science news')).toBe(1);
  });
  it('pickBotCommentTarget prefers an interest-matching post when given the bot', () => {
    const posts = [
      { id: 'p1', authorId: 'u1', text: 'My garden tomatoes are finally ripe', comments: [] },
      { id: 'p2', authorId: 'u2', text: 'New telescope photo of a space nebula', comments: [] }
    ];
    expect(pickBotCommentTarget(posts, nova)?.id).toBe('p2');
    expect(pickBotCommentTarget(posts, 'bot_nova')?.id).toBe('p1'); // id-only: feed order
  });
  it('threadContextText formats the recent thread, newest last, skipping empties', () => {
    const msgs = [
      { senderId: 'u1', text: 'hi nova' },
      { senderId: 'bot_nova', text: 'hello! ask me about space' },
      { senderId: 'u1', text: 'what is a nebula?' },
      { senderId: 'u1', text: '' }
    ];
    const ctx = threadContextText(msgs, 'bot_nova');
    expect(ctx).toContain('Them: hi nova');
    expect(ctx).toContain('You: hello! ask me about space');
    expect(ctx.endsWith('Them: what is a nebula?')).toBe(true);
  });
  it('memoryFromConversation dedupes near-identical notes and stamps a category', () => {
    const first = memoryFromConversation([], 'tell me about space please', 'Space is vast and beautiful', 1000);
    expect(first).toHaveLength(1);
    expect(first[0].category).toBe('conversation');
    const second = memoryFromConversation(first, 'tell me about space please', 'Space is vast and beautiful', 2000);
    expect(second).toHaveLength(1);
    expect(second[0].updatedAt).toBe(2000);
    const third = memoryFromConversation(second, 'how do I bake bread at home', 'Mix flour water yeast', 3000);
    expect(third).toHaveLength(2);
  });
});
