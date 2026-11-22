// Email-exposure companion patch (2026-11-22) — the app side of
// supabase/fix-user-email-exposure.sql. The SQL (NOT yet applied)
// revokes the users.email column from non-staff SELECTs and adds the
// admin-only admin_user_emails() RPC. This patch must be safe to ship
// BEFORE the SQL: while the RPC does not exist, the Admin → Users
// table falls back to the mirrored emails exactly as today; once the
// RPC exists, its map wins over the mirror. Own-email displays source
// the address from the Supabase Auth user, so they keep working when
// the mirrored row stops carrying email.
//
// The live half runs against tests/fake-supabase.js: seeded users rows
// deliberately LACK the email field (the post-SQL mirror), while
// fakeControl.setRpcEmails() holds the addresses only the RPC can see
// (the post-SQL database truth), and fakeControl.failRpc() simulates
// the pre-SQL world where the function does not exist.
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
let V;
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };

// Post-SQL shape: NO email field on the mirrored users rows.
const ROW = (name, username, role) => ({
  name, username, role, isBot: false, followers: [], following: [], closeFriends: [], settings: {}, createdAt: Date.now() - 86_400_000
});
const RPC_EMAILS = { boss1: 'boss@example.com', asha1: 'asha@example.com' };

beforeAll(async () => {
  fake = (await import('./fake-supabase.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'boss@example.com': 'boss1', 'asha@example.com': 'asha1' };
  fake.seed('users', 'boss1', ROW('Boss Admin', 'boss', 'superadmin'));
  fake.seed('users', 'asha1', ROW('Asha User', 'asha', 'user'));
  fake.setRpcEmails(RPC_EMAILS);
  api = await import('../src/api.js');
  V = await import('../src/views.js');
  api.onAuthReady(() => {});
});

// The merge main.js adminRoute performs for #/admin/users.
const mergedData = () => {
  const d = api.data();
  const emails = api.adminUserEmails();
  return Object.keys(emails).length
    ? { ...d, users: d.users.map((u) => (emails[u.id] ? { ...u, email: emails[u.id] } : u)) }
    : d;
};

describe('admin email fetch (live, fake Supabase)', () => {
  it('(a) falls back cleanly when the RPC does not exist yet (pre-SQL world)', async () => {
    fake.failRpc('admin_user_emails');
    await api.login('boss@example.com', 'whatever');
    await settle();
    // The fetch resolves to an empty map instead of throwing, the
    // sync getter stays empty, and the Admin table renders from the
    // mirror alone (here: email-less rows -> empty cells, no crash).
    await expect(api.fetchAdminUserEmails()).resolves.toEqual({});
    expect(api.adminUserEmails()).toEqual({});
    const html = V.adminUsersView(mergedData(), api.me(), {});
    expect(html).toContain('Asha User');
    expect(html).toContain('Boss Admin');
    expect(html).not.toContain('undefined');
    fake.clearRpcFailures();
  });

  it('the RPC map wins over the mirror once the SQL exists (email cell + email search)', async () => {
    const map = await api.fetchAdminUserEmails();
    expect(map).toEqual(RPC_EMAILS);
    expect(api.adminUserEmails()).toEqual(RPC_EMAILS);
    const html = V.adminUsersView(mergedData(), api.me(), {});
    expect(html).toContain('asha@example.com');
    expect(html).toContain('boss@example.com');
    // Admin user search matches on the RPC email, not just name/username.
    const searched = V.adminUsersView(mergedData(), api.me(), { q: 'asha@example.com' });
    expect(searched).toContain('Asha User');
    expect(searched).not.toContain('Boss Admin');
  });

  it('own email comes from the Auth user while the mirrored row has none', async () => {
    expect(api.me()?.email).toBeUndefined();
    expect(api.ownEmail()).toBe('boss@example.com');
  });

  it('a non-admin session gets no email map (and no stale cache leaks across accounts)', async () => {
    await api.login('asha@example.com', 'whatever');
    await settle();
    await expect(api.fetchAdminUserEmails()).resolves.toEqual({});
    expect(api.adminUserEmails()).toEqual({});
    expect(api.me()?.email).toBeUndefined();
    expect(api.ownEmail()).toBe('asha@example.com');
  });
});

describe('(b) email-less mirror rows render in the main surfaces', () => {
  const boss = { id: 'boss1', name: 'Boss Admin', username: 'boss', role: 'superadmin', isBot: false, settings: {} };
  const asha = { id: 'asha1', name: 'Asha User', username: 'asha', role: 'user', isBot: false, settings: {} };
  const d = {
    users: [boss, asha], posts: [], friendships: [], groups: [], pages: [],
    conversations: [], messages: [], notifications: [], stories: [], events: [],
    bots: [], botBrains: {}, botSecrets: { geminiApiKey: '', providers: {} },
    botRunner: {}, adminStats: null, healthProbe: null
  };

  it('admin users table renders with empty email cells', () => {
    const html = V.adminUsersView(d, boss, {});
    expect(html).toContain('Asha User');
    expect(html).toContain('@asha');
    expect(html).not.toContain('undefined');
  });

  it('settings account card renders without an email', () => {
    const html = V.settingsView(d, asha, { theme: 'light' });
    expect(html).toContain('Asha User');
    expect(html).not.toContain('undefined');
  });

  it('admin health row renders the admin’s own (missing) email safely', () => {
    const html = V.adminHealthView(d, boss, { firebase: false, projectId: '' });
    expect(html).toContain('Boss Admin');
    expect(html).not.toContain('undefined');
  });

  it('a post card by an email-less author renders (profile/feed card surface)', async () => {
    const { postCardHtml } = await import('../src/components.js');
    const ctx = { me: boss, usersById: { boss1: boss, asha1: asha }, d: { groups: [], pages: [] } };
    const post = {
      id: 'p1', authorId: 'asha1', text: 'hello', image: '', visibility: 'public',
      likes: [], reactions: {}, comments: [], shares: 0, savedBy: [], createdAt: Date.now()
    };
    const html = postCardHtml(post, ctx);
    expect(html).toContain('Asha User');
    expect(html).not.toContain('undefined');
  });
});
