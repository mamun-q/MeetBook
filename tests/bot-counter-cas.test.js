// Counter drift root-cause fix (2026-11-25): the shared
// botSettings/counters doc was persisted by every writer (browser
// cycle, GitHub/local runner, instant responder) as a per-field MAX
// merge of a snapshot loaded at cycle start. MAX is monotonic but NOT
// additive: two writers starting from the same base and each adding
// +1 to the same bot+field stored base+1, not base+2 — the watchdog
// flagged the absorbed increment day after day (Anika messagesToday
// counter 3 vs actual 4; three bots' commentsToday the day before).
// The fix persists only per-writer DELTAS, applied additively under a
// compare-and-swap on the row's updatedAt. These tests pin the delta
// math (including the exact two-writer regression) and that all three
// writers use the CAS save.
import { describe, it, expect } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  botCounterDeltas, applyBotCounterDeltas, mergeBotCountersMax, emptyBotCounters
} from '../src/botLogic.js';

const base = () => ({ bot_a: { ...emptyBotCounters(), messagesToday: 2, lastActionAt: 100 } });

describe('botCounterDeltas', () => {
  it('reports only what this writer added', () => {
    const fin = { bot_a: { ...emptyBotCounters(), messagesToday: 4, commentsToday: 1, lastActionAt: 250 } };
    expect(botCounterDeltas(base(), fin)).toEqual({ bot_a: { messagesToday: 2, commentsToday: 1, lastActionAt: 250 } });
  });

  it('is empty when nothing changed', () => {
    expect(botCounterDeltas(base(), base())).toEqual({});
  });

  it('never goes negative against a stale final snapshot', () => {
    const fin = { bot_a: { ...emptyBotCounters(), messagesToday: 1 } };
    expect(botCounterDeltas(base(), fin)).toEqual({});
  });

  it('ignores bots present only in the base (another writer\'s entries)', () => {
    const b = { ...base(), bot_b: { ...emptyBotCounters(), postsToday: 3 } };
    const fin = { bot_a: { ...emptyBotCounters(), messagesToday: 3, lastActionAt: 100 } };
    expect(botCounterDeltas(b, fin)).toEqual({ bot_a: { messagesToday: 1 } });
  });
});

describe('applyBotCounterDeltas — the two-writer regression', () => {
  it('two writers adding +1 from the same base store base+2 (MAX merge stored base+1)', () => {
    const b = base(); // stored messagesToday = 2
    const writerA = { bot_a: { ...emptyBotCounters(), messagesToday: 3, lastActionAt: 200 } };
    const writerB = { bot_a: { ...emptyBotCounters(), messagesToday: 3, lastActionAt: 300 } };
    // The old behaviour, for the record: MAX merge absorbs one send.
    assert.equal(mergeBotCountersMax(mergeBotCountersMax(b, writerA), writerB).bot_a.messagesToday, 3);
    // The fix: each writer's delta lands, in either order.
    const afterA = applyBotCounterDeltas(b, botCounterDeltas(b, writerA));
    const afterBoth = applyBotCounterDeltas(afterA, botCounterDeltas(b, writerB));
    assert.equal(afterBoth.bot_a.messagesToday, 4);
    const afterB = applyBotCounterDeltas(b, botCounterDeltas(b, writerB));
    const afterBothReverse = applyBotCounterDeltas(afterB, botCounterDeltas(b, writerA));
    assert.equal(afterBothReverse.bot_a.messagesToday, 4);
    assert.equal(afterBoth.bot_a.lastActionAt, 300); // timestamps take max, never add
  });

  it('adds onto a map another writer already advanced past my base', () => {
    const storedNow = { bot_a: { ...emptyBotCounters(), messagesToday: 7, lastActionAt: 900 } };
    const myDelta = botCounterDeltas(base(), { bot_a: { ...emptyBotCounters(), messagesToday: 3, lastActionAt: 200 } });
    const out = applyBotCounterDeltas(storedNow, myDelta);
    assert.equal(out.bot_a.messagesToday, 8);
    assert.equal(out.bot_a.lastActionAt, 900);
  });

  it('creates entries for bots missing from the stored map', () => {
    const out = applyBotCounterDeltas({}, { bot_new: { postsToday: 1 } });
    assert.equal(out.bot_new.postsToday, 1);
    assert.equal(out.bot_new.messagesToday, 0);
  });
});

describe('all three counter writers use the CAS delta save', () => {
  const api = readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../runner/run-cycle.mjs', import.meta.url), 'utf8');

  it('browser cycle (api.js) snapshots its base and saves deltas under CAS', () => {
    assert.match(api, /botCounterDeltas\(baseMap, counters\)/);
    assert.match(api, /saveLiveBotCounters\(day, counters, countersBase\)/);
    assert.match(api, /eq\('updatedAt', row\.updatedAt\)/);
  });

  it('runner (run-cycle.mjs) saves via saveBotCountersCas', () => {
    assert.match(runner, /async function saveBotCountersCas\(day, baseMap, finalMap\)/);
    assert.match(runner, /saveBotCountersCas\(day, countersBase, counters\)/);
    assert.match(runner, /botCounterDeltas\(baseMap, finalMap\)/);
  });

  it('instant responder saves via saveBotCountersCas (when the sibling checkout is present)', () => {
    const url = new URL('../../meetbook-instant-responder/responder.mjs', import.meta.url);
    if (!existsSync(url)) return; // CI checks out the repo alone
    const responder = readFileSync(url, 'utf8');
    assert.match(responder, /async function saveBotCountersCas\(day, baseMap, finalMap\)/);
    assert.match(responder, /saveBotCountersCas\(day, counters, \{ \[bot\.id\]: c \}\)/);
  });
});
