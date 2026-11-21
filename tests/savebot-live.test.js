// Regression: bot creation in LIVE mode. saveBot used to write
// `{ ...saved, id: undefined }` into the bots payload; the real
// backend rejects undefined field values, so creating any bot failed
// live. The fake Supabase client rejects undefined exactly like the
// real PostgREST payload validation, and this suite drives the REAL
// api.saveBot through it. (Postgres rows DO carry their id as a
// column — unlike Firestore doc paths — so the stored-payload
// assertions check the id matches, not that it is absent.)
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

let api;
let fake;
let fakeSb;
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };

const ADMIN = { name: 'MeetBook Admin', username: 'admin', email: 'admin@meetbook.app', role: 'admin', isBot: false, followers: [], following: [], closeFriends: [], settings: {} };

beforeAll(async () => {
  fakeSb = await import('./fake-supabase.js');
  fake = fakeSb.fakeControl;
  fake.reset();
  fake.usersByEmail = { 'admin@meetbook.app': 'admin1' };
  fake.seed('users', 'admin1', ADMIN);
  fake.seed('botSettings', 'global', { enabled: true });
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('admin@meetbook.app', 'admin123');
  await settle();
});

describe('fake Supabase undefined guard', () => {
  it('rejects undefined field values like the real backend, at any depth', async () => {
    const client = fakeSb.fakeClient;
    await expect(client.from('bots').insert({ id: 'x', name: 'X', avatar: undefined })).rejects.toThrow(/undefined/);
    await expect(client.from('bots').upsert({ id: 'x', personality: { tone: undefined } })).rejects.toThrow(/personality\.tone/);
    await expect(client.from('bots').insert({ id: 'y', tags: ['a', undefined] })).rejects.toThrow(/undefined/);
  });
});

describe('saveBot (live mode)', () => {
  it('creates a bot without any undefined values in the stored payload', async () => {
    const saved = await api.saveBot({
      name: 'Pixel', username: 'pixel.bot', bio: 'Cheerful photo bot.', avatar: '',
      personality: { traits: ['cheerful'], tone: 'bright', interests: ['photography'], systemPrompt: 'You are Pixel.' }
    });
    expect(saved.id).toBeTruthy();
    const stored = fake.get('bots', saved.id);
    expect(stored).toBeTruthy();
    expect(stored.name).toBe('Pixel');
    // The row's id column is the bot's id (Postgres carries ids in
    // the row, unlike Firestore doc paths), and nothing in the
    // payload is undefined (the fake would have thrown, exactly like
    // the production backend did before the fix).
    expect(stored.id).toBe(saved.id);
    expect(JSON.stringify(stored)).not.toContain('undefined');
    // The brain doc and the public users doc were written too.
    expect(fake.get('botBrains', saved.id)).toMatchObject({ botId: saved.id });
    expect(fake.get('users', saved.id)).toMatchObject({ isBot: true, role: 'bot', username: 'pixel.bot' });
  });

  it('updates an existing bot through the same payload path', async () => {
    const bots = fake.all('bots');
    const existing = bots.find((b) => b.name === 'Pixel');
    const updated = await api.saveBot({ ...existing, id: existing.id, bio: 'Updated bio.' });
    expect(updated.id).toBe(existing.id);
    expect(fake.get('bots', existing.id).bio).toBe('Updated bio.');
    expect(fake.get('bots', existing.id).id).toBe(existing.id);
  });
});
