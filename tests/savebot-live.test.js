// Regression: bot creation in LIVE mode. saveBot used to write
// `{ ...saved, id: undefined }` into bots/{id}; real Firestore rejects
// undefined field values, so creating any bot failed live. The fake
// Firestore now rejects undefined exactly like the SDK, and this suite
// drives the REAL api.saveBot through it.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../src/firebase.js', () => ({
  firebaseReady: true, isFirebaseConfigured: true, firebaseConfig: {},
  app: {}, auth: { fake: 'auth' }, db: { fake: 'db' }, storage: null, googleProvider: null
}));
vi.mock('firebase/firestore', async () => await import('./fake-firestore.js'));
vi.mock('firebase/auth', async () => (await import('./fake-firestore.js')).fakeAuth);
vi.mock('firebase/storage', () => ({
  ref: () => ({}), uploadBytes: async () => ({}), getDownloadURL: async () => ''
}));

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};
globalThis.document = { dispatchEvent: () => true };

let api;
let fake;
let firestore;
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };

const ADMIN = { name: 'MeetBook Admin', username: 'admin', email: 'admin@meetbook.app', role: 'admin', isBot: false, followers: [], following: [], closeFriends: [], settings: {} };

beforeAll(async () => {
  firestore = await import('./fake-firestore.js');
  fake = firestore.fakeControl;
  fake.reset();
  fake.usersByEmail = { 'admin@meetbook.app': 'admin1' };
  fake.seed('users', 'admin1', ADMIN);
  fake.seed('botSettings', 'global', { enabled: true });
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('admin@meetbook.app', 'admin123');
  await settle();
});

describe('fake Firestore undefined guard', () => {
  it('rejects undefined field values like the real SDK, at any depth', async () => {
    await expect(firestore.setDoc(firestore.doc(null, 'bots', 'x'), { name: 'X', id: undefined })).rejects.toThrow(/Unsupported field value: undefined/);
    await expect(firestore.setDoc(firestore.doc(null, 'bots', 'x'), { personality: { tone: undefined } })).rejects.toThrow(/personality\.tone/);
    await expect(firestore.addDoc(firestore.collection(null, 'bots'), { tags: ['a', undefined] })).rejects.toThrow(/Unsupported field value: undefined/);
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
    // The doc id belongs to the path only — no `id` field is stored,
    // and nothing in the payload is undefined (the fake would have
    // thrown, exactly like production Firestore did before the fix).
    expect('id' in stored).toBe(false);
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
    expect('id' in fake.get('bots', existing.id)).toBe(false);
  });
});
