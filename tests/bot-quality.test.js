// Bot output quality pack (2026-11-23): the quality gate, the stronger
// near-duplicate detector, and the loss-proof counters merge. Each test
// is one of the live failures Limon reported that morning:
//  - Nova posted the same "shooting star" post twice in 20 minutes
//    (Jaccard ~0.28 slipped under the old 0.55 threshold).
//  - Arif's post reached the feed with Hebrew + Chinese fragments and
//    a literal "\n" printed in the text.
//  - The shared counters doc said Nova had 0 posts while 2 of her
//    posts were already on the feed (stale-writer overwrite).
import { describe, it, expect } from 'vitest';
import assert from 'node:assert/strict';
import {
  sanitizeBotOutput, isNearDuplicateBotText, textOverlap, sharesTopicPhrase,
  mergeBotCountersMax, botPostPacing, BOT_POST_GAP_MS,
  selectMemories, memoryFromConversation, ownCommentTexts, freshTemplateComment
} from '../src/botLogic.js';
import { mergeUsageMapsMax } from '../src/aiProviders.js';

describe('sanitizeBotOutput', () => {
  it('rejects text containing a foreign script (Hebrew/CJK/Cyrillic)', () => {
    assert.equal(sanitizeBotOutput('আসসালামু আলাইকום MeetBook family! আজকের আড্ডাটা একদম জম纪要 হবে'), '');
    assert.equal(sanitizeBotOutput('Good morning друзья'), '');
    assert.equal(sanitizeBotOutput('오늘은 좋은 날'), '');
  });

  it('repairs literal escaped newlines instead of printing them', () => {
    assert.equal(sanitizeBotOutput('প্রথম লাইন\\n\\nদ্বিতীয় লাইন'), 'প্রথম লাইন\n\nদ্বিতীয় লাইন');
    assert.equal(sanitizeBotOutput('one\\ntwo'), 'one\ntwo');
  });

  it('keeps normal Bangla, English, emoji and punctuation untouched', () => {
    const bn = 'আজ বিকেলে রবি গানের প্লেলিস্ট চালিয়ে বই পড়ছি... মধুর সুরে মনের শান্তি। 🎧📚💖';
    assert.equal(sanitizeBotOutput(bn), bn);
    const en = 'Just spotted a shooting star while stargazing! 🌠 What a night.';
    assert.equal(sanitizeBotOutput(en), en);
  });

  it('returns empty for non-strings and blank text', () => {
    assert.equal(sanitizeBotOutput(null), '');
    assert.equal(sanitizeBotOutput(undefined), '');
    assert.equal(sanitizeBotOutput('   '), '');
  });
});

describe('near-duplicate detection v2', () => {
  const novaOld = 'Just spotted a shooting star while wrapping up my edit—tiny spark, big galaxy vibes. ✨🚀 What little wonder made your day shine today?';
  const novaNew = 'Just spotted a shooting star while stargazing! 🌠 Made me wonder: if we could bottle a comet’s tail, what flavor would it be? 🚀✨ #SpaceThoughts';

  it('catches the Nova shooting-star repeat via the shared topic phrase', () => {
    assert.equal(sharesTopicPhrase(novaNew, novaOld), true);
    assert.equal(isNearDuplicateBotText(novaNew, [novaOld], 0.55, [novaOld]), true);
  });

  it('catches a reworded repeat via the overlap coefficient', () => {
    // NOTE (2026-11-23 audit): the original pair here only scored
    // >= 0.62 because the old tokenizer split Bangla words at vowel
    // signs into shared letter fragments. With correct word tokens
    // that pair is a same-topic rewrite with mostly different words
    // (overlap 0.31) — this pair is the realistic repeat shape: same
    // opening, same content words, reworded tail.
    const a = 'আজ সকালে সিলেটের চা বাগানে হাঁটতে গিয়ে মনটা একদম শান্ত হয়ে গেল, চারদিকে শুধু সবুজ আর পাখির ডাক।';
    const b = 'আজ সকালে সিলেটের চা বাগানে হাঁটতে গিয়ে মনটা শান্ত হয়ে গেল, চারদিকে সবুজ আর পাখির ডাক শুনলাম।';
    assert.ok(textOverlap(a, b) >= 0.62, `overlap was ${textOverlap(a, b)}`);
    assert.equal(isNearDuplicateBotText(b, [a]), true);
  });

  it('catches template-skeleton repeats via character n-grams', () => {
    const a = 'Thinking about space today. What has everyone else been up to?';
    const b = 'Thinking about cooking today. What has everyone else been up to?';
    assert.equal(isNearDuplicateBotText(b, [a]), true);
  });

  it('does not flag genuinely different posts', () => {
    const other = 'Backyard football drill done, now catching the cricket highlights with friends and some jhalmuri.';
    assert.equal(isNearDuplicateBotText(other, [novaOld], 0.55, [novaOld]), false);
    const bn = 'আজ সন্ধ্যায় গ্রাম্য আম গাছের ছায়ায় বসে পুরনো গান শুনছি।';
    assert.equal(isNearDuplicateBotText(bn, [novaOld], 0.55, [novaOld]), false);
  });

  it('still catches exact duplicates', () => {
    assert.equal(isNearDuplicateBotText(novaOld, [novaOld]), true);
  });
});

describe('botPostPacing (owner rule: one post, then another bot 30 min later)', () => {
  const now = 1_800_000_000_000;
  const post = (authorId, ageMs) => ({ authorId, createdAt: now - ageMs, text: 'x' });

  it('allows the very first post when no bot has posted yet', () => {
    expect(botPostPacing([], 'bot_a', now).allowed).toBe(true);
    expect(botPostPacing([{ authorId: 'human1', createdAt: now - 1000 }], 'bot_a', now).allowed).toBe(true);
  });

  it('blocks any bot post inside the 30-minute gap', () => {
    const posts = [post('bot_a', 10 * 60_000)];
    expect(botPostPacing(posts, 'bot_b', now).allowed).toBe(false);
    expect(botPostPacing(posts, 'bot_a', now).allowed).toBe(false);
  });

  it('after the gap, a DIFFERENT bot may post but the last poster may not', () => {
    const posts = [post('bot_a', BOT_POST_GAP_MS + 60_000)];
    expect(botPostPacing(posts, 'bot_b', now).allowed).toBe(true);
    expect(botPostPacing(posts, 'bot_a', now).allowed).toBe(false);
  });

  it('the rotation block expires after two gaps so the feed never deadlocks', () => {
    const posts = [post('bot_a', 2 * BOT_POST_GAP_MS + 60_000)];
    expect(botPostPacing(posts, 'bot_a', now).allowed).toBe(true);
  });

  it('judges by the NEWEST bot post, not older ones', () => {
    const posts = [post('bot_a', 5 * 60_000), post('bot_b', 90 * 60_000)];
    const r = botPostPacing(posts, 'bot_c', now);
    expect(r.allowed).toBe(false);
    expect(r.lastAuthorId).toBe('bot_a');
  });
});

describe('audit fixes (2026-11-23 deep code audit)', () => {
  it('selectMemories matches Bangla keywords, not just English ones', () => {
    const memories = [
      { id: 'm1', text: 'সিলেটের চা বাগান আর বৃষ্টি আমার খুব প্রিয়', createdAt: 1, updatedAt: 1, pinned: false },
      { id: 'm2', text: 'কোয়ান্টাম কম্পিউটিং নিয়ে পড়াশোনা করছি আজকাল', createdAt: 1, updatedAt: 1, pinned: false }
    ];
    const picked = selectMemories(memories, 'আজ চা বাগানে বৃষ্টি হচ্ছে', 1);
    expect(picked.length).toBe(1);
    expect(picked[0].id).toBe('m1');
  });

  it('the memory cap never evicts a pinned memory', () => {
    const fillers = Array.from({ length: 99 }, (_, i) => ({
      id: `f${i}`, text: `filler note number ${i} about topic${i} zebra${i} quokka${i}`, createdAt: i + 2, updatedAt: i + 2, pinned: false
    }));
    const existing = [{ id: 'pin', text: 'Pinned: the owner prefers evening chats', createdAt: 1, updatedAt: 1, pinned: true }, ...fillers];
    const next = memoryFromConversation(existing, 'একটি সম্পূর্ণ নতুন বিষয় নিয়ে কথা', 'জবাব দিলাম অন্য প্রসঙ্গে', Date.now());
    expect(next.some((m) => m.id === 'pin')).toBe(true);
    expect(next.filter((m) => !m.pinned).length).toBeLessThanOrEqual(100);
  });

  it('near-duplicate detection works on Bangla text (words stay intact, not split at vowel signs)', () => {
    const a = 'আজ সকালে চা বাগানে হাঁটতে গিয়ে বৃষ্টিতে ভিজে গেলাম, মনটা একদম ফ্রেশ হয়ে গেল';
    const b = 'আজ সকালে চা বাগানে হাঁটতে গিয়ে বৃষ্টিতে ভিজে গেলাম, সত্যিই মনটা ফ্রেশ হয়ে গেল';
    expect(isNearDuplicateBotText(b, [a])).toBe(true);
    const unrelated = 'ক্রিকেট খেলায় বাংলাদেশ জিতলে সবাই খুব খুশি হয়, রাস্তায় মিছিল বের হয়';
    expect(isNearDuplicateBotText(unrelated, [a])).toBe(false);
  });

  it('mergeUsageMapsMax never loses a writer\'s counts or exhaustion stamps', () => {
    const stored = { groq: { calls: 30, errors: 2, promptTokens: 900, completionTokens: 800, exhaustedUntil: 0 }, openrouter: { calls: 40, errors: 0, promptTokens: 100, completionTokens: 100, exhaustedUntil: 9999 } };
    const staleWriter = { groq: { calls: 25, errors: 1, promptTokens: 700, completionTokens: 600, exhaustedUntil: 5555 }, openrouter: { calls: 10, errors: 0, promptTokens: 0, completionTokens: 0, exhaustedUntil: 0 } };
    const merged = mergeUsageMapsMax(stored, staleWriter);
    expect(merged.groq.calls).toBe(30);
    expect(merged.groq.exhaustedUntil).toBe(5555); // the fresher rate-limit stamp survives
    expect(merged.openrouter.calls).toBe(40);
    expect(merged.openrouter.exhaustedUntil).toBe(9999);
  });

  it('ownCommentTexts + freshTemplateComment: all templates used -> null (skip)', () => {
    const bot = { id: 'bot_x', name: 'X', personality: { traits: [], tone: 'warm', interests: [], systemPrompt: '' }, limits: {} };
    const posts = [{
      id: 'p1', authorId: 'human1', comments: [
        { id: 'c1', authorId: 'bot_x', text: 'Love this — thanks for sharing!', createdAt: 1, replies: [] },
        { id: 'c2', authorId: 'bot_x', text: 'This made me smile. Thanks for posting it!', createdAt: 2, replies: [] },
        { id: 'c3', authorId: 'bot_x', text: 'Great point, I had not thought of it that way.', createdAt: 3, replies: [] },
        { id: 'c4', authorId: 'bot_x', text: 'Welcome! Glad you posted this.', createdAt: 4, replies: [] }
      ]
    }];
    const texts = ownCommentTexts(posts, 'bot_x');
    expect(texts.length).toBe(4);
    expect(freshTemplateComment(bot, texts)).toBe(null);
    expect(freshTemplateComment(bot, texts.slice(0, 2))).toBe('Great point, I had not thought of it that way.');
  });
});

describe('mergeBotCountersMax', () => {
  it('never loses an increment from a concurrent writer', () => {
    const current = { bot_a: { postsToday: 2, commentsToday: 1, likesToday: 0, messagesToday: 6, lastActionAt: 200 } };
    const staleWriter = { bot_a: { postsToday: 0, commentsToday: 1, likesToday: 3, messagesToday: 6, lastActionAt: 100 } };
    const merged = mergeBotCountersMax(current, staleWriter);
    assert.equal(merged.bot_a.postsToday, 2); // the stale 0 must not erase the real 2
    assert.equal(merged.bot_a.likesToday, 3); // the fresher like count survives too
    assert.equal(merged.bot_a.lastActionAt, 200);
  });

  it('unions bots that appear on only one side', () => {
    const merged = mergeBotCountersMax({ bot_a: { postsToday: 1 } }, { bot_b: { postsToday: 4 } });
    assert.equal(merged.bot_a.postsToday, 1);
    assert.equal(merged.bot_b.postsToday, 4);
  });
});
