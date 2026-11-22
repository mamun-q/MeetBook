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
  mergeBotCountersMax, botPostPacing, BOT_POST_GAP_MS
} from '../src/botLogic.js';

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
    const a = 'সিলেটের চা বাগানে সূর্যোদয়ের আলোয় বইয়ের পাতা উড়ে, হৃদয় শান্তি পায়। আজকের পড়া: প্রকৃতি আর জীবন।';
    const b = 'সিলেটের সূর্যোদয়ে চা বাগানের মিষ্টি হাওয়ায় বইয়ের পাতা ফুঁসফুঁস, হৃদয়কে শান্তি দেয়। আজ অন্য বই পড়ছি।';
    assert.ok(textOverlap(a, b) >= 0.62, `overlap was ${textOverlap(a, b)}`);
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
