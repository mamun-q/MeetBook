// Users column-grants lockdown (supabase/fix-user-email-exposure.sql
// section 2) — the app-side pin. Once the SQL is applied, the
// `authenticated` role holds SELECT on users column-by-column (every
// column EXCEPT email) and PostgREST rejects select=* on users
// outright (42501 "permission denied for table users" — verified
// live; it broke every users read until the app stopped asking for
// '*'), rejects naming email explicitly, and holds a write's
// RETURNING clause to the same rule. tests/fake-supabase.js models
// exactly that for the users table, always on.
//
// This file pins the app's side of the contract:
//  - the fake's lockdown itself bites on raw '*' / email selects and
//    on RETURNING * (so the green paths below are not vacuous);
//  - every users read/write the app performs goes through the sb*
//    helpers with the explicit granted-column list — asserted on the
//    ACTUAL select strings the builders carried, across boot,
//    profile update, follow toggles and registration;
//  - the column list in src/api.js, the grant list in the SQL file
//    and the fake's granted set are the same set of columns.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { await sleep(15); await sleep(15); await sleep(15); };

// ---- request instrumentation -------------------------------------------
// Every PostgREST execute() on the users table is recorded with the
// select list its builder carried (and whether a write chained a
// RETURNING select), so the pin below asserts on what the app
// actually sent, not on what the code looks like.
const records = [];
function instrument() {
  const origFrom = fakeClient.from;
  fakeClient.from = (table) => {
    const b = origFrom(table);
    const ex = b.execute.bind(b);
    b.execute = async () => {
      records.push({ table, op: b.op, selectCols: b.selectCols, returning: b.returning });
      return ex();
    };
    return b;
  };
}

const EXPECTED_COLUMNS = 'id,name,username,bio,avatar,cover,work,education,"currentCity",hometown,relationship,website,nickname,dob,gender,role,"isBot","botId",status,verified,online,"lastSeen","createdAt",followers,following,"closeFriends",settings';
const columnSet = (list) => new Set(
  String(list).split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
);

// Stored rows carry email (the database truth — INSERT privilege is
// untouched by the SQL); the lockdown only governs what reads return.
const ROW = (name, username, email, role) => ({
  name, username, email, role, isBot: false, bio: '', avatar: '', cover: '',
  work: '', education: '', currentCity: '', hometown: '', relationship: '',
  website: '', nickname: '', dob: '', gender: '', status: 'active', verified: false,
  online: false, lastSeen: Date.now() - 60_000, createdAt: Date.now() - 86_400_000,
  followers: [], following: [], closeFriends: [], settings: {}
});

beforeAll(async () => {
  const fakeMod = await import('./fake-supabase.js');
  fake = fakeMod.fakeControl;
  fakeClient = fakeMod.fakeClient;
  fake.reset();
  fake.usersByEmail = { 'boss@example.com': 'boss1', 'asha@example.com': 'asha1' };
  fake.seed('users', 'boss1', ROW('Boss Admin', 'boss', 'boss@example.com', 'superadmin'));
  fake.seed('users', 'asha1', ROW('Asha User', 'asha', 'asha@example.com', 'user'));
  fake.seed('users', 'pal1', ROW('Pal User', 'pal', 'pal@example.com', 'user'));
  instrument();
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
});

describe('the fake lockdown itself (the pin is not vacuous)', () => {
  it('rejects select=* and explicit email selects on users with 42501', async () => {
    const star = await fakeClient.from('users').select('*');
    expect(star.error?.code).toBe('42501');
    const named = await fakeClient.from('users').select('id,email');
    expect(named.error?.code).toBe('42501');
  });

  it('rejects RETURNING * on a users insert and persists nothing', async () => {
    const res = await fakeClient.from('users').insert({ id: 'nope1', name: 'Nope', username: 'nope' }).select();
    expect(res.error?.code).toBe('42501');
    expect(fake.get('users', 'nope1')).toBeUndefined();
  });

  it('an explicit granted-column select succeeds and projects email away', async () => {
    const { data, error } = await fakeClient.from('users').select('id,username').order('id', { ascending: true });
    expect(error).toBeNull();
    expect(data.length).toBe(3);
    expect(data[0]).toEqual({ id: 'asha1', username: 'asha' });
  });
});

// Records from the raw-probe describe above are deliberate
// violations; the pin covers only statements the APP makes, which
// start after this marker.
let appPhaseStart = 0;

describe('the app under the lockdown', () => {
  beforeAll(() => { appPhaseStart = records.length; });

  it('login + boot: fetchOwnProfile and fetchUsers fill the mirror, email-free', async () => {
    await api.login('boss@example.com', 'whatever');
    await settle();
    expect(api.me()?.username).toBe('boss');
    const users = api.data().users;
    expect(users.map((u) => u.id).sort()).toEqual(['asha1', 'boss1', 'pal1']);
    for (const u of users) expect(u).not.toHaveProperty('email');
  });

  it('updateProfile: the users UPDATE ... RETURNING lands and mirrors', async () => {
    await api.updateProfile('boss1', { bio: 'boss bio v2' });
    await settle();
    expect(fake.get('users', 'boss1').bio).toBe('boss bio v2');
    expect(api.data().users.find((u) => u.id === 'boss1').bio).toBe('boss bio v2');
  });

  it('toggleFollow: sbGet x2 + sbUpdate x2 on users all survive the grants', async () => {
    await api.login('asha@example.com', 'whatever');
    await settle();
    await api.toggleFollow('pal1');
    await settle();
    expect(fake.get('users', 'asha1').following).toContain('pal1');
    expect(fake.get('users', 'pal1').followers).toContain('asha1');
  });

  it('register: username probe select + profile insert RETURNING both land', async () => {
    const created = await api.register({
      name: 'New User', username: 'newuser', email: 'new@example.com', password: 'secret1'
    });
    await settle();
    expect(created.username).toBe('newuser');
    const stored = fake.all('users').find((u) => u.username === 'newuser');
    expect(stored).toBeTruthy();
    // The INSERT wrote the email (privilege untouched); reads still
    // project it away — the mirrored copy has no email field.
    expect(stored.email).toBe('new@example.com');
    expect(api.data().users.find((u) => u.username === 'newuser')).not.toHaveProperty('email');
  });
});

describe('the pin: no users statement ever asks for * or email', () => {
  it('every recorded users read and write-RETURNING used the explicit grant list', () => {
    const usersRecords = records.slice(appPhaseStart).filter((r) => r.table === 'users');
    const reads = usersRecords.filter((r) => r.op === 'select');
    const returningWrites = usersRecords.filter((r) => r.returning && ['insert', 'update', 'upsert'].includes(r.op));
    // Non-vacuous: the flows above really did read and write users.
    expect(reads.length).toBeGreaterThan(0);
    expect(returningWrites.some((r) => r.op === 'insert')).toBe(true);
    expect(returningWrites.some((r) => r.op === 'update')).toBe(true);
    for (const r of [...reads, ...returningWrites]) {
      expect(r.selectCols).toBe(EXPECTED_COLUMNS);
    }
  });

  it('api.js, the SQL grant list and the fake granted set name the same columns', () => {
    const apiSrc = readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');
    const apiList = apiSrc.match(/const USER_PUBLIC_COLUMNS = '([^']+)'/)?.[1];
    expect(apiList).toBeTruthy();
    const sql = readFileSync(new URL('../supabase/fix-user-email-exposure.sql', import.meta.url), 'utf8');
    const sqlList = sql.match(/grant select \(([^)]+)\) on public\.users/)?.[1];
    expect(sqlList).toBeTruthy();
    expect(columnSet(apiList)).toEqual(columnSet(sqlList));
    expect(columnSet(apiList)).toEqual(columnSet(EXPECTED_COLUMNS));
    expect(columnSet(apiList).has('email')).toBe(false);
  });
});
