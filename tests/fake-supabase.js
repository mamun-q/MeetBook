// In-memory fake for the @supabase/supabase-js client surface src/api.js
// uses, so live-mode (supabaseReady) code paths can be tested end to
// end without a network. Deliberately small: PostgREST-style query
// builder (eq / contains / order / limit / count-head / single /
// maybeSingle), insert with PK-conflict errors, upsert with
// ignoreDuplicates, update/delete by filter, postgres_changes channel
// bindings that re-fire only when a table's contents actually change,
// broadcast + presence channels, Supabase-Auth-shaped auth methods, and
// the four SECURITY DEFINER RPCs (file_appeal / accept_friendship /
// join_via_invite / group_discovery) implemented with the same
// validations as the SQL.
// No RLS enforcement — policies are reviewed, not executed.

const tables = new Map(); // name -> Map(id -> row)
const pgBindings = []; // { table, cb, lastJson }
const channels = new Set();
let flushScheduled = false;

function tableMap(name) {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name);
}

function tableJson(name) {
  return JSON.stringify([...tableMap(name).entries()]);
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    for (const b of [...pgBindings]) {
      const json = tableJson(b.table);
      // Realtime delivers on change; a write outside this table (or a
      // no-op write) must not re-fire the binding — the same delivery
      // discipline the Firestore fake's snapshot compare provided.
      if (b.lastJson === json) continue;
      b.lastJson = json;
      try { b.cb({ eventType: 'UPDATE', schema: 'public', table: b.table, new: {}, old: {} }); } catch { /* listener errors are the app's problem */ }
    }
  });
}

// PostgREST rejects undefined values in payloads; walk deeply and
// throw so the bug class the Firestore fake caught (a payload field
// silently undefined) keeps failing tests.
function assertNoUndefined(value, path) {
  if (value === undefined) {
    throw new Error(`Supabase payload contains undefined (field ${path || '(root)'})`);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${path}[${i}]`));
  } else if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, path ? `${path}.${k}` : k);
  }
}

function matches(row, filters) {
  for (const f of filters) {
    const v = row[f.col];
    if (f.type === 'eq' && v !== f.value) return false;
    if (f.type === 'neq' && v === f.value) return false;
    if (f.type === 'in' && !f.value.includes(v)) return false;
    if (f.type === 'contains') {
      if (!Array.isArray(v)) return false;
      for (const item of f.value) if (!v.includes(item)) return false;
    }
  }
  return true;
}

class Builder {
  constructor(table) {
    this.table = table;
    this.op = 'select';
    this.filters = [];
    this.orders = [];
    this.limitN = null;
    this.payload = null;
    this.upsertOpts = {};
    this.countHead = false;
    this.singleMode = null;
    this.returning = false;
  }
  select(_cols, opts) {
    if (opts?.count) this.countHead = true;
    // A .select() chained AFTER a write op is PostgREST's RETURNING:
    // Postgres then applies the table's SELECT policy to the rows
    // being returned (see the notifications check in execute()).
    if (this.op === 'insert' || this.op === 'update' || this.op === 'upsert') this.returning = true;
    return this;
  }
  insert(row) { this.op = 'insert'; this.payload = Array.isArray(row) ? row : [row]; return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  upsert(row, opts = {}) { this.op = 'upsert'; this.payload = Array.isArray(row) ? row : [row]; this.upsertOpts = opts; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col, v) { this.filters.push({ type: 'eq', col, value: v }); return this; }
  neq(col, v) { this.filters.push({ type: 'neq', col, value: v }); return this; }
  in(col, v) { this.filters.push({ type: 'in', col, value: v }); return this; }
  contains(col, v) { this.filters.push({ type: 'contains', col, value: v }); return this; }
  order(col, opts = {}) { this.orders.push({ col, ascending: opts.ascending !== false }); return this; }
  limit(n) { this.limitN = n; return this; }
  single() { this.singleMode = 'single'; return this; }
  maybeSingle() { this.singleMode = 'maybe'; return this; }
  then(resolve, reject) { return this.execute().then(resolve, reject); }
  async execute() {
    const map = tableMap(this.table);
    if (this.op === 'insert' || this.op === 'upsert') {
      // Postgres RETURNING visibility (notifications): the SELECT
      // policy is recipient-or-admin, so an INSERT ... RETURNING a
      // notification addressed to SOMEONE ELSE fails the whole
      // statement with 42501 — this is real Postgres behaviour, and
      // the reason createNotification must insert without .select().
      if (this.op === 'insert' && this.table === 'notifications' && this.returning) {
        const callerId = session?.user?.id || null;
        const callerRole = callerId ? tableMap('users').get(callerId)?.role : null;
        const callerIsAdmin = callerRole === 'admin' || callerRole === 'superadmin';
        for (const row of this.payload) {
          if (!callerIsAdmin && row.userId !== callerId) {
            return { data: null, error: { code: '42501', message: 'new row violates row-level security policy for table "notifications"' } };
          }
        }
      }
      const out = [];
      for (const row of this.payload) {
        assertNoUndefined(row, '');
        const id = row.id;
        const existing = map.get(id);
        if (existing && this.op === 'insert') {
          return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${this.table}_pkey"` } };
        }
        if (existing && this.upsertOpts.ignoreDuplicates) continue;
        const stored = existing ? { ...existing, ...structuredClone(row) } : structuredClone(row);
        map.set(id, stored);
        out.push(structuredClone(stored));
      }
      scheduleFlush();
      return { data: out, error: null };
    }
    if (this.op === 'update') {
      assertNoUndefined(this.payload, '');
      const out = [];
      for (const [id, row] of [...map.entries()]) {
        if (!matches(row, this.filters)) continue;
        const next = { ...row, ...structuredClone(this.payload) };
        map.set(id, next);
        out.push(structuredClone(next));
      }
      scheduleFlush();
      return { data: out, error: null };
    }
    if (this.op === 'delete') {
      for (const [id, row] of [...map.entries()]) {
        if (matches(row, this.filters)) map.delete(id);
      }
      scheduleFlush();
      return { data: null, error: null };
    }
    // select
    let rows = [...map.values()].filter((row) => matches(row, this.filters));
    const total = rows.length;
    for (const o of [...this.orders].reverse()) {
      const dir = o.ascending ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const av = a[o.col]; const bv = b[o.col];
        if (typeof av === 'string' && typeof bv === 'string') return av < bv ? -dir : av > bv ? dir : 0;
        return ((av ?? 0) - (bv ?? 0)) * dir;
      });
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    if (this.countHead) return { data: null, error: null, count: total };
    if (this.singleMode === 'single') {
      if (rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      return { data: structuredClone(rows[0]), error: null };
    }
    if (this.singleMode === 'maybe') {
      if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      return { data: rows.length ? structuredClone(rows[0]) : null, error: null };
    }
    return { data: rows.map((r) => structuredClone(r)), error: null };
  }
}

// ------------------------------------------------------------- channels
function firePresenceSync(name) {
  for (const ch of [...channels]) {
    if (ch.name !== name) continue;
    for (const b of ch.bindings) {
      if (b.type === 'presence' && b.filter?.event === 'sync') {
        try { b.cb(); } catch { /* app's problem */ }
      }
    }
  }
}

function makeChannel(name, opts = {}) {
  const ch = {
    name,
    opts,
    bindings: [],
    presenceKey: opts?.config?.presence?.key || '',
    tracked: null,
    on(type, filter, cb) { this.bindings.push({ type, filter, cb }); return this; },
    subscribe(cb) {
      channels.add(ch);
      for (const b of ch.bindings) {
        if (b.type === 'postgres_changes') {
          b.table = b.filter.table;
          b.lastJson = tableJson(b.table);
          pgBindings.push(b);
        }
      }
      queueMicrotask(() => { if (cb) cb('SUBSCRIBED'); });
      return ch;
    },
    async track(state) {
      ch.tracked = state;
      firePresenceSync(name);
      return 'ok';
    },
    async untrack() { ch.tracked = null; firePresenceSync(name); return 'ok'; },
    presenceState() {
      const out = {};
      for (const other of channels) {
        if (other.name !== name || !other.tracked) continue;
        const key = other.presenceKey || 'unknown';
        (out[key] ||= []).push({ ...other.tracked });
      }
      return out;
    },
    async send(payload) {
      // Broadcast: self=false by default — other channels on the same
      // name receive it, the sender does not.
      for (const other of [...channels]) {
        if (other === ch || other.name !== name) continue;
        for (const b of other.bindings) {
          if (b.type === 'broadcast' && b.filter?.event === payload.event) {
            try { b.cb({ payload: payload.payload }); } catch { /* app's problem */ }
          }
        }
      }
      return 'ok';
    }
  };
  return ch;
}

// ----------------------------------------------------------------- auth
let session = null;
const authCallbacks = new Set();
let authCounter = 0;

function fireAuth(event) {
  for (const cb of [...authCallbacks]) {
    try { cb(event, session); } catch { /* app's problem */ }
  }
}

function makeUser(id, email, provider = 'email') {
  return { id, email, app_metadata: { provider, providers: [provider] }, user_metadata: {} };
}

const fakeAuth = {
  async signInWithPassword({ email }) {
    const uid = fakeControl.usersByEmail[String(email).trim().toLowerCase()];
    if (!uid) return { data: { user: null, session: null }, error: { message: 'Invalid login credentials', code: 'invalid_credentials' } };
    session = { user: makeUser(uid, email), access_token: 'fake-token' };
    fireAuth('SIGNED_IN');
    return { data: { user: session.user, session }, error: null };
  },
  async signUp({ email }) {
    const key = String(email).trim().toLowerCase();
    if (fakeControl.usersByEmail[key]) {
      return { data: { user: null, session: null }, error: { message: 'User already registered', code: 'user_already_exists' } };
    }
    const uid = `authuser_${(++authCounter).toString(36)}`;
    fakeControl.usersByEmail[key] = uid;
    session = { user: makeUser(uid, email), access_token: 'fake-token' };
    fireAuth('SIGNED_IN');
    return { data: { user: session.user, session }, error: null };
  },
  async signInWithOAuth() {
    return { data: { url: '' }, error: { message: 'Unsupported provider: provider is not enabled', code: 'provider_not_enabled' } };
  },
  async resetPasswordForEmail() { return { data: {}, error: null }; },
  async signOut() { session = null; fireAuth('SIGNED_OUT'); return { error: null }; },
  async getSession() { return { data: { session }, error: null }; },
  onAuthStateChange(cb) {
    authCallbacks.add(cb);
    queueMicrotask(() => { try { cb('INITIAL_SESSION', session); } catch { /* app's problem */ } });
    return { data: { subscription: { unsubscribe: () => authCallbacks.delete(cb) } } };
  }
};

// ------------------------------------------------------------------ rpc
const rpcError = (message) => ({ data: null, error: { message } });

async function rpc(name, args = {}) {
  const caller = session?.user?.id || null;
  if (name === 'file_appeal') {
    if (!caller) return rpcError('file_appeal: caller is not signed in');
    const rep = tableMap('reports').get(args.p_report_id);
    if (!rep) return rpcError('file_appeal: report not found');
    if (rep.targetAuthorId !== caller) return rpcError('file_appeal: only the content author may appeal');
    if (!rep.decision || !rep.decision.outcome || rep.decision.outcome === 'none') return rpcError('file_appeal: no moderator decision to appeal');
    if (rep.appeal && rep.appeal.status && rep.appeal.status !== 'none') return rpcError('file_appeal: appeal already filed');
    const callerRow = tableMap('users').get(caller);
    const appeal = { status: 'requested', text: String(args.p_text || ''), byId: caller, byName: callerRow?.name || '', at: Date.now(), reason: '' };
    rep.appeal = appeal;
    scheduleFlush();
    return { data: structuredClone(appeal), error: null };
  }
  if (name === 'accept_friendship') {
    if (!caller) return rpcError('accept_friendship: caller is not signed in');
    const row = tableMap('friendships').get(args.p_friendship_id);
    if (!row) return rpcError('accept_friendship: friendship not found');
    if (row.to !== caller) return rpcError('accept_friendship: only the recipient may accept a friend request');
    if (row.status !== 'pending') return rpcError('accept_friendship: request is not pending');
    row.status = 'accepted';
    scheduleFlush();
    return { data: structuredClone(row), error: null };
  }
  if (name === 'group_discovery') {
    if (!caller) return rpcError('group_discovery: caller is not signed in');
    // Mirrors supabase/group-discovery.sql: metadata ONLY — the
    // members array is never returned, just its cardinality, so a
    // test can pin that the app never receives member lists here.
    const rows = [...tableMap('groups').values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((g) => ({
        id: g.id, name: g.name, description: g.description, cover: g.cover,
        privacy: g.privacy, createdBy: g.createdBy, createdAt: g.createdAt,
        memberCount: (g.members || []).length
      }));
    return { data: structuredClone(rows), error: null };
  }
  if (name === 'join_via_invite') {
    if (!caller) return rpcError('join_via_invite: caller is not signed in');
    const invite = tableMap('invites').get(args.p_code);
    if (!invite) return rpcError('join_via_invite: invite code not found');
    const conv = tableMap('conversations').get(invite.conversationId);
    if (!conv) return rpcError('join_via_invite: conversation not found');
    if (!(conv.participants || []).includes(caller)) {
      conv.participants = [...(conv.participants || []), caller];
      scheduleFlush();
    }
    return { data: conv.id, error: null };
  }
  return rpcError(`function public.${name} does not exist`);
}

// -------------------------------------------------------------- client
export const fakeClient = {
  auth: fakeAuth,
  from: (table) => new Builder(table),
  channel: (name, opts) => makeChannel(name, opts),
  removeChannel: async (ch) => {
    channels.delete(ch);
    for (let i = pgBindings.length - 1; i >= 0; i--) {
      if (ch.bindings.includes(pgBindings[i])) pgBindings.splice(i, 1);
    }
    return 'ok';
  },
  rpc
};

// --------------------------------------------------------- test control
export const fakeControl = {
  usersByEmail: {},
  setAuthUser(user) {
    if (!user) { session = null; fireAuth('SIGNED_OUT'); return; }
    const id = user.id || user.uid;
    session = { user: makeUser(id, user.email || ''), access_token: 'fake-token' };
    fireAuth('SIGNED_IN');
  },
  seed(col, id, data) { tableMap(col).set(id, { id, ...structuredClone(data) }); scheduleFlush(); },
  get(col, id) { const d = tableMap(col).get(id); return d ? structuredClone(d) : undefined; },
  all(col) { return [...tableMap(col).entries()].map(([id, data]) => ({ id, ...structuredClone(data) })); },
  remove(col, id) { tableMap(col).delete(id); scheduleFlush(); },
  reset() {
    tables.clear();
    pgBindings.length = 0;
    channels.clear();
    authCallbacks.clear();
    session = null;
    authCounter = 0;
    this.usersByEmail = {};
  }
};
