// Users lockdown (fix-user-email-exposure.sql) — the app side that
// makes the SQL safe to (re-)apply. The SQL revokes table-level
// SELECT on users from `authenticated` and re-grants it
// column-by-column (every column EXCEPT email). Verified live:
// under those column-only grants PostgREST rejects select=* on
// users ENTIRELY (42501 "permission denied for table users") — it
// does not omit the column — and the same holds for a write's
// RETURNING *. The first application therefore broke every users
// read and was rolled back. This file pins the fix:
//
//   - tests/fake-supabase.js now models the lockdown for the users
//     table (select=* / RETURNING * / naming an ungranted column ->
//     42501; an explicit granted-column list succeeds and returns
//     rows projected to those columns, email never included).
//   - src/api.js's sb* helpers substitute the granted column list
//     for every users read and write-returning select, so the full
//     app — boot, users mirror, profile render, admin users flow,
//     registration — runs against the lockdown-shaped fake.
//
// The seeded users rows here DO carry email (the database truth —
// the column still exists and still stores addresses); only reads
// are locked down, and the admin_user_emails() RPC still sees them.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';

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
let fakeClient;
let V;
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };

const ROW = (name, username, role, email) => ({
  name, username, email, role, isBot: false, bio: '', avatar: '', followers: [], following: [],
  closeFriends: [], settings: {}, createdAt: Date.now() - 86_400_000
});

// The granted column list, extracted from the SQL itself so this
// file pins the SQL, the fake and the app to the same list.
const sqlText = readFileSync(new URL('../supabase/fix-user-email-exposure.sql', import.meta.url), 'utf8');
const grantBlock = sqlText.match(/grant select \(([\s\S]*?)\) on public\.users to authenticated;/)[1];
const GRANTED = grantBlock.split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
const GRANTED_LIST = GRANTED.map((c) => (/^[a-z_]+$/.test(c) ? c : `"${c}"`)).join(',');

beforeAll(async () => {
  const fakeMod = await import('./fake-supabase.js');
  fake = fakeMod.fakeControl;
  fakeClient = fakeMod.fakeClient;
  fake.reset();
  fake.usersByEmail = { 'boss@example.com': 'boss1', 'asha@example.com': 'asha1' };
  fake.seed('users', 'boss1', ROW('Boss Admin', 'boss', 'superadmin', 'boss@example.com'));
  fake.seed('users', 'asha1', ROW('Asha User', 'asha', 'user', 'asha@example.com'));
  api = await import('../src/api.js');
  V = await import('../src/views.js');
  api.onAuthReady(() => {});
});

describe('fake models the PostgREST lockdown on users', () => {
  it('the SQL grant list is every schema column except email', () => {
    expect(GRANTED).toContain('username');
    expect(GRANTED).toContain('settings');
    expect(GRANTED).not.toContain('email');
    expect(GRANTED.length).toBe(27); // 28 schema columns, email excluded
    // …and the fake enforces exactly the SQL's list, no more, no less.
    expect([...fake.usersGrantedColumns].sort()).toEqual([...GRANTED].sort());
  });

  it('select=* on users is rejected outright (42501), not column-trimmed', async () => {
    const res = await fakeClient.from('users').select('*');
    expect(res.data).toBeNull();
    expect(res.error?.code).toBe('42501');
  });

  it('select() with no columns (supabase-js sends *) is rejected too', async () => {
    const res = await fakeClient.from('users').select();
    expect(res.error?.code).toBe('42501');
  });

  it('naming the email column explicitly is rejected', async () => {
    const res = await fakeClient.from('users').select('id,username,email');
    expect(res.error?.code).toBe('42501');
  });

  it('the granted list succeeds and returns rows WITHOUT email', async () => {
    const res = await fakeClient.from('users').select(GRANTED_LIST).order('id', { ascending: true });
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(2);
    for (const row of res.data) {
      expect(row).not.toHaveProperty('email');
      expect(row.name).toBeTruthy();
      expect(row.username).toBeTruthy();
    }
    const one = await fakeClient.from('users').select(GRANTED_LIST).eq('id', 'asha1').maybeSingle();
    expect(one.error).toBeNull();
    expect(one.data.username).toBe('asha');
    expect(one.data).not.toHaveProperty('email');
  });

  it('every granted column is individually selectable; email is not', async () => {
    for (const col of GRANTED) {
      const res = await fakeClient.from('users').select(/^[a-z_]+$/.test(col) ? col : `"${col}"`);
      expect(res.error, `column ${col}`).toBeNull();
    }
  });

  it('a write WITHOUT .select() still works (INSERT privilege untouched)', async () => {
    const res = await fakeClient.from('users').insert({ id: 'plain1', name: 'Plain', username: 'plain', email: 'plain@example.com' });
    expect(res.error).toBeNull();
    expect(fake.get('users', 'plain1')?.email).toBe('plain@example.com');
    fake.remove('users', 'plain1');
  });

  it('insert with RETURNING * fails 42501 and persists nothing', async () => {
    const res = await fakeClient.from('users').insert({ id: 'ret1', name: 'Ret', username: 'ret', email: 'ret@example.com' }).select();
    expect(res.error?.code).toBe('42501');
    expect(fake.get('users', 'ret1')).toBeUndefined();
  });

  it('update with an explicit RETURNING list succeeds, row comes back email-less', async () => {
    const res = await fakeClient.from('users').update({ bio: 'locked down' }).eq('id', 'asha1').select(GRANTED_LIST);
    expect(res.error).toBeNull();
    expect(res.data[0].bio).toBe('locked down');
    expect(res.data[0]).not.toHaveProperty('email');
    // The stored row keeps its email — only the read was locked down.
    expect(fake.get('users', 'asha1')?.email).toBe('asha@example.com');
  });

  it('other tables keep their select=* behaviour (lockdown is users-only)', async () => {
    fake.seed('posts', 'p1', { authorId: 'asha1', text: 'hi', createdAt: Date.now() });
    const res = await fakeClient.from('posts').select('*');
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1);
  });
});

describe('the app runs against the lockdown-shaped fake', () => {
  it('boot + users mirror populate, and no mirrored row carries email', async () => {
    await api.login('boss@example.com', 'whatever');
    await settle();
    const users = api.data().users;
    expect(users.map((u) => u.id).sort()).toEqual(['asha1', 'boss1']);
    for (const u of users) expect(u).not.toHaveProperty('email');
    expect(api.me()?.username).toBe('boss');
    // Own email still available — from the Auth user, not the mirror.
    expect(api.ownEmail()).toBe('boss@example.com');
  });

  it('a profile renders from the email-less mirror (and never leaks the address)', async () => {
    const html = V.profileView(api.data(), api.me(), 'asha1');
    expect(html).toContain('Asha User');
    expect(html).toContain('@asha');
    expect(html).not.toContain('asha@example.com');
    expect(html).not.toContain('undefined');
  });

  it('admin users flow: emails arrive via the RPC merge, not the mirror', async () => {
    const map = await api.fetchAdminUserEmails();
    expect(map).toEqual({ boss1: 'boss@example.com', asha1: 'asha@example.com' });
    const d = api.data();
    const merged = { ...d, users: d.users.map((u) => (map[u.id] ? { ...u, email: map[u.id] } : u)) };
    const html = V.adminUsersView(merged, api.me(), {});
    expect(html).toContain('asha@example.com');
    expect(html).toContain('Asha User');
  });

  it('registration still works (users insert uses the explicit RETURNING list)', async () => {
    const created = await api.register({
      name: 'New Person', username: 'newperson', email: 'new@example.com', password: 'secret1'
    });
    await settle();
    // The database truth stores the address…
    expect(fake.get('users', created.id)?.email).toBe('new@example.com');
    // …while the mirrored copy of the new user is email-less.
    const mirrored = api.data().users.find((u) => u.id === created.id);
    expect(mirrored).toBeTruthy();
    expect(mirrored).not.toHaveProperty('email');
    expect(api.ownEmail()).toBe('new@example.com');
  });
});
