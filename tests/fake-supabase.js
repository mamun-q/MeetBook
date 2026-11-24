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

// Canonical groupRequests columns (supabase/schema.sql). PostgREST
// rejects any write or filter naming another column with PGRST204
// ("Could not find the '<col>' column of 'groupRequests' in the
// schema cache"). The fake models that for this one table so a
// Firestore-era leftover field — the phantom second owner key that
// silently broke private-group join requests AND the admin request
// queue in production — fails tests instead of shipping again. (The
// key itself is spelled only in the regression test that proves its
// rejection, split so a repo-wide grep for it stays at zero.)
const GROUP_REQUESTS_COLUMNS = new Set(['id', 'groupId', 'groupOwnerId', 'userId', 'status', 'createdAt']);
const unknownColumnError = (table, col) => ({
  data: null,
  error: { code: 'PGRST204', message: `Could not find the '${col}' column of '${table}' in the schema cache` }
});

// Canonical blocks columns (supabase/schema.sql): id, by, target,
// createdAt — nothing else. The client once filtered and wrote with
// Firestore-era twin keys for the blocker/blocked ids; production
// answered the read with 42703 ("column blocks.<col> does not
// exist") and the write with PGRST204, so blocking was silently dead
// live while this fake — modelling no column set for the table —
// let every test pass. The fake now enforces the real set with the
// same two error shapes production returned. (The twin keys are
// spelled only in the regression test that proves their rejection,
// assembled from parts so a repo-wide grep for them stays at zero.)
const BLOCKS_COLUMNS = new Set(['id', 'by', 'target', 'createdAt']);
const unknownBlocksFilterError = (col) => ({
  data: null,
  error: { code: '42703', message: `column blocks.${col} does not exist` }
});

// Post-lockdown users reads (supabase/fix-user-email-exposure.sql):
// the SQL revokes table-level SELECT on users from `authenticated`
// and re-grants it column-by-column — every column EXCEPT email.
// Under column-only grants PostgREST does NOT quietly omit the
// ungranted column from select=*: the request fails outright with
// 42501 "permission denied for table users" (verified live — it
// briefly broke every users read when the app still used select=*).
// The same applies to a write's RETURNING * (Postgres needs SELECT
// privilege on every returned column) and to naming `email` (or any
// ungranted column) explicitly. The fake models exactly that for
// this one table: an explicit granted-column list succeeds and
// returns rows projected to those columns, so `email` never reaches
// the app; writes WITHOUT a chained .select() are unaffected
// (INSERT/UPDATE privileges are untouched by the SQL); and the
// SECURITY DEFINER admin_user_emails() RPC below still reads the
// stored addresses, exactly like production.
const USERS_GRANTED_COLUMNS = new Set([
  'id', 'name', 'username', 'bio', 'avatar', 'cover', 'work', 'education',
  'currentCity', 'hometown', 'relationship', 'website', 'nickname',
  'dob', 'gender', 'role', 'isBot', 'botId', 'status', 'verified',
  'online', 'lastSeen', 'createdAt', 'followers', 'following',
  'closeFriends', 'settings'
]);
const usersPermissionError = () => ({
  data: null,
  error: {
    code: '42501',
    message: 'permission denied for table users',
    hint: 'Grant the required privileges to the current role with: GRANT SELECT ON public.users TO authenticated'
  }
});

// Parse a PostgREST select list ('id,name,"currentCity"') into bare
// column names; null for '*' — and for an absent list, which
// supabase-js also sends as '*'.
function parseSelectColumns(cols) {
  if (cols == null) return null;
  const s = String(cols).trim();
  if (!s || s === '*') return null;
  return s.split(',').map((p) => p.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

// The 42501 the lockdown produces for a users read, or null when the
// requested columns are exactly within the granted set.
function usersReadViolation(cols) {
  const list = parseSelectColumns(cols);
  if (!list) return usersPermissionError(); // select=* / RETURNING *
  if (list.some((c) => !USERS_GRANTED_COLUMNS.has(c))) return usersPermissionError();
  return null;
}

function projectUsersRow(row, cols) {
  const list = parseSelectColumns(cols) || [];
  const out = {};
  for (const c of list) if (c in row) out[c] = row[c];
  return out;
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
  select(cols, opts) {
    this.selectCols = cols;
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
    // Users lockdown (see USERS_GRANTED_COLUMNS): validate the read
    // side of this statement BEFORE anything is written — a real
    // failed statement persists nothing. Reads are plain selects and
    // the RETURNING clause of writes; a write with no chained
    // .select() reads nothing and is always allowed.
    let usersProjection = null;
    if (this.table === 'users') {
      const readsRows = this.op === 'select'
        || ((this.op === 'insert' || this.op === 'update' || this.op === 'upsert') && this.returning);
      if (readsRows) {
        const violation = usersReadViolation(this.selectCols);
        if (violation) return violation;
        usersProjection = this.selectCols;
      }
    }
    if (this.table === 'groupRequests') {
      for (const f of this.filters) {
        if (!GROUP_REQUESTS_COLUMNS.has(f.col)) return unknownColumnError(this.table, f.col);
      }
      if (this.op === 'insert' || this.op === 'upsert' || this.op === 'update') {
        const rows = this.op === 'update' ? [this.payload] : (this.payload || []);
        for (const row of rows) {
          for (const k of Object.keys(row || {})) {
            if (!GROUP_REQUESTS_COLUMNS.has(k)) return unknownColumnError(this.table, k);
          }
        }
      }
    }
    if (this.table === 'blocks') {
      for (const f of this.filters) {
        if (!BLOCKS_COLUMNS.has(f.col)) return unknownBlocksFilterError(f.col);
      }
      if (this.op === 'insert' || this.op === 'upsert' || this.op === 'update') {
        const rows = this.op === 'update' ? [this.payload] : (this.payload || []);
        for (const row of rows) {
          for (const k of Object.keys(row || {})) {
            if (!BLOCKS_COLUMNS.has(k)) return unknownColumnError(this.table, k);
          }
        }
      }
    }
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
      return { data: usersProjection ? out.map((r) => projectUsersRow(r, usersProjection)) : out, error: null };
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
      return { data: usersProjection ? out.map((r) => projectUsersRow(r, usersProjection)) : out, error: null };
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
    if (usersProjection) rows = rows.map((r) => projectUsersRow(r, usersProjection));
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
      // The status callback is RETAINED (real supabase-js keeps it
      // for the channel's whole life) so tests can drive later
      // statuses — CHANNEL_ERROR / TIMED_OUT / CLOSED — through
      // fakeControl.emitChannelStatus.
      ch.statusCallback = typeof cb === 'function' ? cb : null;
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

// Test controls for the email-exposure companion patch: rpcFailures
// simulates a function that does not exist yet (the pre-SQL world);
// rpcEmailOverrides decouples the admin_user_emails() result from the
// users table, mirroring production after the SQL — the table SELECT
// hides the column while the SECURITY DEFINER RPC still returns it.
const rpcFailures = new Set();
let rpcEmailOverrides = null;

async function rpc(name, args = {}) {
  const caller = session?.user?.id || null;
  if (rpcFailures.has(name)) return rpcError(`function public.${name} does not exist`);
  if (name === 'admin_user_emails') {
    if (!caller) return rpcError('admin_user_emails: caller is not signed in');
    // Mirrors supabase/fix-user-email-exposure.sql: the is_admin()
    // gate means non-admins get an empty set, never an error.
    const callerRow = tableMap('users').get(caller);
    const isAdmin = Boolean(callerRow) && !callerRow.isBot && ['admin', 'superadmin'].includes(callerRow.role);
    if (!isAdmin) return { data: [], error: null };
    if (rpcEmailOverrides) {
      return { data: Object.entries(rpcEmailOverrides).map(([id, email]) => ({ id, email })), error: null };
    }
    const rows = [...tableMap('users').values()].map((u) => ({ id: u.id, email: u.email || '' }));
    return { data: structuredClone(rows), error: null };
  }
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
  if (name === 'leave_conversation') {
    // Mirrors supabase/fix-leave-rpc-2026-11-25.sql: group chats
    // only, caller must be a participant, >= 2 floor, and the ONLY
    // change is removing the caller's own uid.
    if (!caller) return rpcError('leave_conversation: caller is not signed in');
    const conv = tableMap('conversations').get(args.p_conversation_id);
    if (!conv) return rpcError('leave_conversation: conversation not found');
    if (!conv.isGroup) return rpcError('leave_conversation: only group chats can be left');
    if (!(conv.participants || []).includes(caller)) return rpcError('leave_conversation: caller is not a participant');
    const next = (conv.participants || []).filter((id) => id !== caller);
    if (next.length < 2) return rpcError('leave_conversation: a group needs at least two members');
    conv.participants = next;
    scheduleFlush();
    return { data: [...next], error: null };
  }
  if (name === 'leave_group') {
    // Mirrors supabase/fix-leave-rpc-2026-11-25.sql: the creator can
    // never leave, the caller must be a member, no members floor,
    // and the ONLY change is removing the caller's own uid.
    if (!caller) return rpcError('leave_group: caller is not signed in');
    const group = tableMap('groups').get(args.p_group_id);
    if (!group) return rpcError('leave_group: group not found');
    if (group.createdBy === caller) return rpcError('leave_group: group creators cannot leave their own group — delete the group instead');
    if (!(group.members || []).includes(caller)) return rpcError('leave_group: caller is not a member');
    const next = (group.members || []).filter((id) => id !== caller);
    group.members = next;
    scheduleFlush();
    return { data: [...next], error: null };
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
  // Live channel objects currently registered under a name — a
  // rebuild shows up here as a NEW object replacing the old one.
  channelsNamed(name) { return [...channels].filter((c) => c.name === name); },
  // Drive a realtime status (CHANNEL_ERROR / TIMED_OUT / CLOSED /
  // SUBSCRIBED) into every live channel with this name, the way a
  // dying websocket would deliver it in production.
  emitChannelStatus(name, status) {
    for (const ch of [...channels]) {
      if (ch.name !== name || typeof ch.statusCallback !== 'function') continue;
      try { ch.statusCallback(status); } catch { /* app's problem */ }
    }
  },
  seed(col, id, data) { tableMap(col).set(id, { id, ...structuredClone(data) }); scheduleFlush(); },
  get(col, id) { const d = tableMap(col).get(id); return d ? structuredClone(d) : undefined; },
  all(col) { return [...tableMap(col).entries()].map(([id, data]) => ({ id, ...structuredClone(data) })); },
  remove(col, id) { tableMap(col).delete(id); scheduleFlush(); },
  failRpc(name) { rpcFailures.add(name); },
  clearRpcFailures() { rpcFailures.clear(); },
  // The lockdown grant list this fake enforces on users reads, so a
  // test can pin it to supabase/fix-user-email-exposure.sql exactly.
  usersGrantedColumns: [...USERS_GRANTED_COLUMNS],
  // The canonical blocks column set this fake enforces, so a test
  // can pin it to supabase/schema.sql exactly.
  blocksColumns: [...BLOCKS_COLUMNS],
  setRpcEmails(map) { rpcEmailOverrides = map; },
  reset() {
    tables.clear();
    pgBindings.length = 0;
    channels.clear();
    authCallbacks.clear();
    session = null;
    authCounter = 0;
    rpcFailures.clear();
    rpcEmailOverrides = null;
    this.usersByEmail = {};
  }
};
