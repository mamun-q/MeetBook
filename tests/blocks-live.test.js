// Regression — Block feature dead in live mode (bug hunt, 2026-11-22):
// the live blocks table's columns are exactly id/by/target/createdAt
// (supabase/schema.sql), but the client filtered the boot fetch on a
// Firestore-era twin key for the blocker id (Postgres 42703 on every
// boot, swallowed by the fetch's catch) and inserted BOTH spellings
// (PostgREST PGRST204), so blocking always failed and block state
// never loaded. The fake now enforces the canonical column set (see
// tests/fake-supabase.js), so every test here fails on the old code:
// the boot fetch errors out and leaves the mirror empty, and
// toggleBlock's insert is rejected outright.
// The twin keys are assembled from parts so a repo-wide grep for them
// stays at zero — their absence from src/ IS the invariant.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../src/supabase.js', async () => {
  const fake = await import('./fake-supabase.js');
  return {
    supabaseReady: true, isSupabaseConfigured: true,
    supabaseConfig: { url: 'https://fake.supabase.co', publishableKey: 'fake', projectRef: 'fake' },
    supabase: fake.fakeClient
  };
});

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};
globalThis.document = { dispatchEvent: () => true };

const PHANTOM_BLOCKER_KEY = ['block', 'erId'].join('');
const PHANTOM_BLOCKED_KEY = ['block', 'edId'].join('');

let api;
let fake;
let blockedIdsOfData;
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };
const settleDeep = async () => { await settle(); await settle(); };

const userRow = (name, username, email) => ({
  name, username, email, role: 'user', isBot: false, bio: '', avatar: '', cover: '',
  followers: [], following: [], closeFriends: [], settings: {}
});

beforeAll(async () => {
  fake = (await import('./fake-supabase.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = {
    'me@example.com': 'human1', 'friend@example.com': 'human2', 'third@example.com': 'human3'
  };
  fake.seed('users', 'human1', userRow('Mamun Hossen', 'your.name', 'me@example.com'));
  fake.seed('users', 'human2', userRow('Ayesha Khan', 'ayesha', 'friend@example.com'));
  fake.seed('users', 'human3', userRow('Tanvir Ahmed', 'tanvir', 'third@example.com'));
  // A block that already exists server-side before this session boots:
  // the boot fetch must load it into the mirror.
  fake.seed('blocks', 'human1_human3', { by: 'human1', target: 'human3', createdAt: Date.now() - 60_000 });

  api = await import('../src/api.js');
  ({ blockedIdsOfData } = await import('../src/views.js'));
  api.onAuthReady(() => {});
  await api.login('me@example.com', 'password123');
  await settleDeep();
});

describe('blocks — live mode against the canonical column set', () => {
  it('the fake enforces exactly the schema.sql blocks columns', () => {
    expect([...fake.blocksColumns].sort()).toEqual(['by', 'createdAt', 'id', 'target']);
  });

  it('boot fetch loads existing blocks into the mirror (no 42703)', () => {
    const row = api.data().blocks.find((b) => b.id === 'human1_human3');
    expect(row).toBeTruthy();
    expect(row.by).toBe('human1');
    expect(row.target).toBe('human3');
    // The consumer every view uses sees the block.
    expect(blockedIdsOfData(api.data(), 'human1').has('human3')).toBe(true);
  });

  it('toggleBlock blocks: stored row carries exactly the real columns', async () => {
    expect(await api.toggleBlock('human2')).toBe(true);
    const stored = fake.get('blocks', 'human1_human2');
    expect(stored).toBeTruthy();
    expect(Object.keys(stored).sort()).toEqual(['by', 'createdAt', 'id', 'target']);
    expect(stored.by).toBe('human1');
    expect(stored.target).toBe('human2');
    expect(api.data().blocks.some((b) => b.by === 'human1' && b.target === 'human2')).toBe(true);
    expect(blockedIdsOfData(api.data(), 'human1').has('human2')).toBe(true);
  });

  it('toggleBlock again unblocks: row deleted server-side and in the mirror', async () => {
    expect(await api.toggleBlock('human2')).toBe(false);
    expect(fake.get('blocks', 'human1_human2')).toBeUndefined();
    expect(api.data().blocks.some((b) => b.target === 'human2')).toBe(false);
    expect(blockedIdsOfData(api.data(), 'human1').has('human2')).toBe(false);
  });

  it('unblocking a block loaded at boot works too', async () => {
    expect(await api.toggleBlock('human3')).toBe(false);
    expect(fake.get('blocks', 'human1_human3')).toBeUndefined();
    expect(blockedIdsOfData(api.data(), 'human1').has('human3')).toBe(false);
  });
});

// Pin the fake's hardening itself (same discipline as the
// groupRequests PGRST204 pins): if the column enforcement is ever
// removed, these fail — and with it removed, the tests above would
// pass even against the old broken client.
describe('fake blocks schema fidelity', () => {
  it('rejects a filter on a non-canonical column with the production 42703', async () => {
    const { fakeClient } = await import('./fake-supabase.js');
    const res = await fakeClient.from('blocks').select('*').eq(PHANTOM_BLOCKER_KEY, 'human1');
    expect(res.error?.code).toBe('42703');
    expect(res.error?.message).toContain(`column blocks.${PHANTOM_BLOCKER_KEY} does not exist`);
  });

  it('rejects a write carrying a non-canonical column with PGRST204 and stores nothing', async () => {
    const { fakeClient } = await import('./fake-supabase.js');
    const res = await fakeClient.from('blocks').insert({
      id: 'human1_human9', by: 'human1', target: 'human9', [PHANTOM_BLOCKED_KEY]: 'human9', createdAt: Date.now()
    });
    expect(res.error?.code).toBe('PGRST204');
    expect(res.error?.message).toContain(`Could not find the '${PHANTOM_BLOCKED_KEY}' column of 'blocks'`);
    expect(fake.get('blocks', 'human1_human9')).toBeUndefined();
  });
});
