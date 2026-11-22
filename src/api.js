// Unified data/API layer. Two backends behind one interface:
//  - Live mode (Supabase config present): Supabase Auth + PostgREST +
//    Realtime (postgres_changes / broadcast / presence channels).
//  - Demo mode (no config): the local seeded store in store.js.
// Views always read from data() and write through these functions, so the UI
// code is identical in both modes.
import {
  getState, mutate, findUser, userByUsername, friendIdsOf, blockedIdsOf, notify, resetDemo
} from './store.js';
import { supabase, supabaseReady } from './supabase.js';
import { uid as genId, validateUsername, extractMentions, normaliseGroup, normalisePage, normaliseEvent, postAudience, castPollVote, tsToMs, normaliseTimeFields, friendlyAuthError, isAdminRole, isSuperAdmin, canManageUser, canChangeRole, ASSIGNABLE_ROLES, isStaff, canModerate, REPORT_CATEGORIES, countPostComments, truncate, mergePostLists, toggleEmojiReaction, replySnapshot, chatTheme, canEditMessage, chatPollVote, VANISH_TTL_MS, TYPING_FRESH_MS } from './utils.js';
import { generateTemplatePost, generateTemplateComment, templateBotMessageReply, decideBotAction, memoryFromConversation, normaliseBot, findBotReplyTargets, pickFriendRequestsToAccept, emptyBotCounters, counterDayKey, botCountersForDay, pickBotCommentTarget, pickBotReplyTarget, appendBotDecision, memoryFromActivity, isDuplicateBotText, isNearDuplicateBotText, threadContextText, freshTemplatePost } from './botLogic.js';
import { canAccessBotSecrets, botModel } from './gemini.js';
import { providerById, resolveAiConfig, generateRouted, testProvider as testAiProvider, getLastRoutedFailure, resetLastRoutedFailure, anyProviderConfigured, dhakaDayKey, normaliseUsageMap, usageTotals } from './aiProviders.js';
import { isCloudinaryConfigured, uploadToCloudinary, uploadFileToCloudinary } from './cloudinary.js';

// Live-mode switch: every `if (live)` branch below is the Supabase path,
// every fall-through is the demo store — the same split the Firebase
// version of this module had, function for function.
const live = supabaseReady;

// -------------------------------------------------------------------------
// Supabase data-access helpers (live mode). Each helper throws an Error
// carrying the PostgREST error code on failure — the throw-on-error
// contract the Firestore SDK gave the call sites below. Row shapes are
// the Firestore document shapes: the schema's quoted camelCase columns
// make supabase-js return rows already shaped like documents.
// -------------------------------------------------------------------------
function sbError(error, context) {
  const err = new Error(error?.message || `Supabase request failed${context ? ` (${context})` : ''}`);
  if (error?.code) err.code = error.code;
  if (error?.details) err.details = error.details;
  return err;
}

async function sbSelect(table, build) {
  let q = supabase.from(table).select('*');
  if (build) q = build(q);
  const { data, error } = await q;
  if (error) throw sbError(error, table);
  return data || [];
}

async function sbGet(table, id) {
  const { data, error } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw sbError(error, table);
  return data || null;
}

async function sbInsert(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select();
  if (error) throw sbError(error, table);
  return data?.[0] || row;
}

// Upsert with Firestore setDoc semantics: with merge, only the given
// columns are written (existing columns survive); without merge the
// given columns still replace only themselves — every setDoc call site
// in this module passes complete documents or deliberate partial
// patches, exactly as it did against Firestore.
async function sbUpsert(table, row, opts = {}) {
  const { data, error } = await supabase.from(table).upsert(row, opts).select();
  if (error) throw sbError(error, table);
  return data?.[0] || row;
}

// PostgREST update: an RLS USING denial surfaces as zero affected rows
// (not an error), a WITH CHECK denial as error 42501. Zero rows is
// therefore NOT thrown here — the optimistic-mirror rollback call sites
// rely on thrown errors only for hard failures, and a row the caller
// may not touch simply keeps its server truth for the next refetch.
async function sbUpdate(table, id, patch) {
  const { data, error } = await supabase.from(table).update(patch).eq('id', id).select();
  if (error) throw sbError(error, table);
  return data?.[0] || null;
}

async function sbDelete(table, id) {
  const { error } = await supabase.from(table).delete().eq('id', id);
  if (error) throw sbError(error, table);
}

async function sbCount(table, build) {
  let q = supabase.from(table).select('*', { count: 'exact', head: true });
  if (build) q = build(q);
  const { count, error } = await q;
  if (error) throw sbError(error, table);
  return count || 0;
}

async function sbRpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw sbError(error, name);
  return data;
}

// Map a Supabase Auth error onto the Firebase-style codes utils'
// friendlyAuthError already translates, so every user-facing auth
// string stays exactly what it was ("Wrong email or password.", …).
function friendlySupabaseAuthError(err) {
  const raw = String(err?.message || '');
  const code = String(err?.code || '');
  const mapped =
    code === 'invalid_credentials' || /invalid login credentials/i.test(raw) ? 'auth/invalid-credential'
    : code === 'user_already_exists' || code === 'email_exists' || /already registered/i.test(raw) ? 'auth/email-already-in-use'
    : code === 'weak_password' || /password.*(weak|short|characters)/i.test(raw) ? 'auth/weak-password'
    : code === 'user_not_found' ? 'auth/user-not-found'
    : code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || /rate limit/i.test(raw) ? 'auth/too-many-requests'
    : code === 'validation_failed' || /invalid.*email|email.*invalid/i.test(raw) ? 'auth/invalid-email'
    : '';
  if (mapped) return friendlyAuthError({ code: mapped, message: raw });
  if (/provider.*not enabled|unsupported provider/i.test(raw)) return 'That sign-in method is not enabled for this app.';
  return friendlyAuthError({ message: raw });
}

// -------------------------------------------------------------------------
let remote = null; // Firestore-mirrored dataset (same shape as demo state)
let remoteUid = '';
let emptyRemoteCache = null;

// Optimistic local echo for live-mode post creation: a freshly created
// post is inserted into the mirror IMMEDIATELY (under a temporary id)
// so the composer doesn't wait for the Firestore snapshot round-trip;
// when the insert resolves, the echo adopts the real id, and the posts
// merge prunes the echo as soon as a listener delivers the server copy.
let localEchoPosts = [];

// Re-runs the posts merge (assigned inside startRemoteSync): after an
// optimistic echo adopts its real server id, the merge must run again —
// the snapshot listener can deliver the server copy BEFORE addDoc
// resolves (Firestore fires from the local cache first, and the fake
// flushes on a microtask), so a plain re-render would show the echo
// and the server copy side by side until the next listener event.
let remergePosts = null;

// The same optimistic-echo pattern for groups / events / stories:
// their create paths insert remotely and (unlike posts) had no local
// echo, so the creator's own lists and pages — which render from the
// mirror — showed nothing until the realtime refetch landed, which
// in practice lagged minutes behind the success toast ("Group
// created." → "This group could not be found."). Each merge below
// unions these in and prunes an echo as soon as a slice delivers the
// server copy, exactly like localEchoPosts.
let localEchoGroups = [];
let localEchoEvents = [];
let localEchoStories = [];
let remergeGroups = null;
let remergeEvents = null;
let remergeStories = null;

// Canonical JSON (object keys sorted at every depth) so two mapped
// copies of the same Firestore document compare equal regardless of
// the key order the document was written with.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function emitData() {
  document.dispatchEvent(new CustomEvent('meetbook:data'));
}

// Apply a mutation to a post in the live mirror and notify listeners.
// The mirror shares object references with the sync listeners' arrays,
// so the optimistic change survives merges until the next snapshot
// replaces it with server truth. Returns the post (or null when the
// post is not mirrored / not in live mode).
// opts.silent skips the emit: engagement actions (like/react/save/poll)
// patch silently and main.js refreshes just that post's card in place —
// a full-page re-render per tap reads as a screen shake on phones.
function patchRemotePost(postId, apply, opts = {}) {
  if (!live || !remote) return null;
  const post = remote.posts.find((p) => p.id === postId);
  if (!post) return null;
  apply(post);
  if (!opts.silent) emitData();
  return post;
}

// Same optimistic-mirror pattern for messages and conversations (Chat
// Pack: reactions, pins, themes, typing heartbeats) — patch locally so
// the UI responds instantly, then let the snapshot listener confirm.
function patchRemoteMessage(messageId, apply) {
  if (!live || !remote) return null;
  const msg = remote.messages.find((m) => m.id === messageId);
  if (!msg) return null;
  apply(msg);
  emitData();
  return msg;
}

function patchRemoteConversation(convId, apply) {
  if (!live || !remote) return null;
  const conv = remote.conversations.find((c) => c.id === convId);
  if (!conv) return null;
  apply(conv);
  emitData();
  return conv;
}

// Single choke point for live-mode notification writes: an actor is
// never notified about their OWN action (Audit fix #10 — liking or
// commenting on your own post used to generate a notification to
// yourself; the demo store's notify() always had this guard, the
// direct Firestore writes did not). Returns the doc ref, or null when
// the write was suppressed as a self-notification.
async function createNotification(note) {
  if (!note || !note.userId || note.userId === note.actorId) return null;
  // The id is generated client-side (Firestore's addDoc generated it
  // server-side; the shape callers see — an object carrying the id —
  // is unchanged). The notifications insert policy pins actorId to
  // the caller, admins exempt — every real caller passes its own id,
  // and bot notifications ride the admin exemption.
  const row = { id: genId('n'), ...note };
  // Deliberately NOT sbInsert: sbInsert chains .select() (RETURNING),
  // and Postgres applies the notifications SELECT policy — recipient
  // or admin only — to returned rows, so writing a notification FOR
  // someone else fails the whole statement with 42501 ("new row
  // violates row-level security policy for table notifications")
  // even though the INSERT policy allows it. A plain insert with no
  // RETURNING is the correct write; the row is already fully known
  // client-side.
  const { error } = await supabase.from('notifications').insert(row);
  if (error) throw sbError(error, 'notifications');
  return row;
}

export function data() {
  if (live) {
    // Live mode must never fall through to demo data.
    if (remote) return remote;
    if (!emptyRemoteCache) emptyRemoteCache = blankRemote();
    return emptyRemoteCache;
  }
  return getState();
}

export function currentUid() {
  if (live) return remoteUid;
  return getState().sessionUid;
}

export function me() {
  const id = currentUid();
  return id ? (data().users.find((u) => u.id === id) || null) : null;
}

// "Admin" across the app means the admin tier of the Pack A role
// ladder: role 'admin' OR 'superadmin' (utils.isAdminRole). Moderators
// and analysts are staff but are NOT admins — gate them with
// utils.canModerate / utils.isStaff at the call site.
export function isAdmin(user = me()) {
  return isAdminRole(user);
}

function blankRemote() {
  return {
    users: [], sessionUid: '', posts: [], stories: [], groups: [], pages: [], friendships: [], blocks: [],
    conversations: [], messages: [], notifications: [], reports: [], supportReports: [], adminLogs: [], events: [], reviews: [], groupRequests: [],
    bots: [], botBrains: {}, botMemories: {}, botActivities: [], botLogs: [], botDecisions: {},
    announcements: [], // Pack C: platform announcements (admin-written, all read)
    botConvMeta: {}, // Pack C: per-bot conversation metadata (loadBotAdminData)
    healthProbe: null, // Pack C: last Firestore connectivity probe (probeFirestoreHealth)
    adminStats: null, // Pack B: staff-only server aggregates (loadAdminStats)
    botSettings: { global: { enabled: true }, counters: {} },
    botSecrets: { geminiApiKey: '', providers: {} },
    providerHealth: {}, // Stage A: last Test-connection result per provider
    botRunner: { live: true, active: false, lastCycleAt: 0, lastSummary: '', lastDetails: [] },
    config: { maintenanceMode: false },
    aiUsage: { callsToday: 0, tokensToday: 0, updatedAt: 0, day: '', providers: {} }
  };
}

// -------------------------------------------------------------------------
// AUTH
// -------------------------------------------------------------------------
export async function register({ name, username, email, password, dob = '', gender = '' }) {
  const v = validateUsername(username);
  if (!v.ok) throw new Error(v.error);
  // Platform settings (Pack C): closed registration refuses new
  // accounts. Client-side this reads the synced config (always
  // available in demo mode; in live mode the config listener only runs
  // after sign-in, so pre-auth it may be unknown) — the Firestore
  // users-create rule enforces the same gate server-side in live mode,
  // and its denial is mapped to the friendly message in the catch
  // below.
  if (data().config?.registrationOpen === false) {
    throw new Error('Registration is currently closed. Please try again later.');
  }
  if (live) {
    // Create the Auth account FIRST: the users table is only readable
    // by authenticated callers (RLS), so the username-uniqueness query
    // must run after sign-up (an anonymous query returns nothing). If
    // anything after account creation fails, sign the session out so
    // the app is not left half-registered. (Supabase has no client-side
    // auth-user delete without a service key, so the orphaned auth
    // account keeps the email reserved — the same caveat the Spark
    // plan imposed on admin deletions.)
    let authData;
    try {
      const res = await supabase.auth.signUp({ email: email.trim(), password });
      if (res.error) throw res.error;
      authData = res.data;
    } catch (err) {
      throw new Error(friendlySupabaseAuthError(err));
    }
    const authUser = authData?.user;
    if (!authUser) throw new Error('Something went wrong. Please try again.');
    if (!authData.session) {
      // Email confirmation is enabled on the project: without a
      // session the profile row cannot be written yet (RLS requires an
      // authenticated caller whose id matches the row). The auth
      // account exists; sign-in after confirmation completes it.
      throw new Error('Account created — please confirm your email, then sign in.');
    }
    remoteUid = authUser.id;
    const profile = {
      name: name.trim(), username: v.value, email: email.trim(), bio: '', avatar: '', cover: '',
      work: '', education: '', currentCity: '', hometown: '', relationship: '', website: '', nickname: '',
      dob: dob || '', gender: gender || '',
      role: 'user', isBot: false, online: true, lastSeen: Date.now(), createdAt: Date.now(), followers: [], following: [], closeFriends: [], settings: {}
    };
    try {
      const taken = await sbSelect('users', (q) => q.eq('username', v.value));
      if (taken.length) throw new Error('That username is already taken.');
      await sbInsert('users', { id: authUser.id, ...profile });
    } catch (err) {
      try { await supabase.auth.signOut(); } catch { /* rollback is best-effort */ }
      remoteUid = '';
      // The users insert policy denies the profile write when platform
      // registration is closed (Pack C) — RLS denials are error 42501;
      // surface that honestly instead of a raw permission error.
      if (err?.code === '42501') throw new Error('Registration is currently closed. Please try again later.');
      throw err;
    }
    return { id: authUser.id, ...profile };
  }
  let created = null;
  mutate((s) => {
    if (s.users.some((u) => u.username === v.value)) throw new Error('That username is already taken.');
    if (s.users.some((u) => u.email === email.trim().toLowerCase())) throw new Error('An account with that email already exists.');
    created = {
      id: genId('u'), name: name.trim(), username: v.value, email: email.trim().toLowerCase(), password,
      bio: '', avatar: '', cover: '', work: '', education: '', currentCity: '', hometown: '',
      relationship: '', website: '', nickname: '', dob: dob || '', gender: gender || '',
      role: 'user', isBot: false, online: true, lastSeen: Date.now(),
      createdAt: Date.now(), followers: [], following: [], closeFriends: [], settings: {}
    };
    s.users.push(created);
    s.sessionUid = created.id;
  });
  return created;
}

export async function login(email, password) {
  if (live) {
    let authData;
    try {
      const res = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (res.error) throw res.error;
      authData = res.data;
    } catch (err) {
      throw new Error(friendlySupabaseAuthError(err));
    }
    const user = authData?.user;
    if (!user) throw new Error('Something went wrong. Please try again.');
    remoteUid = user.id;
    // Presence: stamp online + lastSeen (the online rail freshness check
    // keys off lastSeen). Best-effort — never block the sign-in on it.
    sbUpdate('users', user.id, { online: true, lastSeen: Date.now() }).catch(() => {});
    return { id: user.id, uid: user.id, email: user.email || email.trim() };
  }
  let user = null;
  mutate((s) => {
    user = s.users.find((u) => u.email === email.trim().toLowerCase() && u.password === password && !u.isBot);
    if (!user) throw new Error('Invalid email or password. Demo accounts: admin@meetbook.app / admin123, ayesha@example.com / demo123');
    user.online = true;
    user.lastSeen = Date.now();
    s.sessionUid = user.id;
  });
  return user;
}

export async function loginWithGoogle() {
  if (!live) throw new Error('Google sign-in needs Supabase configuration. In demo mode, register or use a demo account.');
  // OAuth is a full-page redirect: signInWithOAuth sends the browser
  // to Google and the session returns on the redirect URL (PKCE, so
  // the app's hash routing is untouched). First-sign-in profile
  // creation therefore happens in ensureAuthProfile (onAuthReady)
  // when the session lands — the same profile the Firebase popup flow
  // created inline. If the Google provider is not configured in the
  // Supabase dashboard yet, the call returns an error and we surface
  // the friendly "not enabled" message instead of navigating away.
  const redirectTo = typeof window !== 'undefined' ? window.location.origin + window.location.pathname : undefined;
  const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if (error) throw new Error(friendlySupabaseAuthError(error));
  return { redirected: true };
}

// First-sign-in profile for OAuth users: email/password registration
// writes its profile row explicitly, but an OAuth session can land
// with no users row at all. Mirror of the old loginWithGoogle inline
// creation — probe the username (the email prefix is NOT unique
// across domains) and suffix until free, or @mentions and username
// lookups would conflate two people. Also stamps presence for an
// existing profile, like the old popup flow did. Best-effort: a
// missing profile reads as signed-out everywhere in the app.
async function ensureAuthProfile(user) {
  if (!live || !user?.id) return;
  try {
    const existing = await sbGet('users', user.id);
    if (existing) {
      sbUpdate('users', user.id, { online: true, lastSeen: Date.now() }).catch(() => {});
      return;
    }
    const provider = user.app_metadata?.provider || '';
    const providers = user.app_metadata?.providers || [];
    if (provider !== 'google' && !providers.includes('google')) return;
    const base = (user.email || 'user').split('@')[0].replace(/[^a-z0-9_.]/gi, '').toLowerCase() || 'user';
    let username = base.slice(0, 24);
    for (let i = 0; i < 5; i++) {
      const taken = await sbSelect('users', (q) => q.eq('username', username));
      if (!taken.length) break;
      username = `${base.slice(0, 20)}${Math.floor(100 + Math.random() * 900)}`;
    }
    await sbInsert('users', {
      id: user.id,
      name: user.user_metadata?.full_name || user.user_metadata?.name || 'MeetBook User', username, email: user.email || '',
      bio: '', avatar: user.user_metadata?.avatar_url || user.user_metadata?.picture || '', cover: '', work: '', education: '', currentCity: '',
      hometown: '', relationship: '', website: '', nickname: '', dob: '', gender: '', role: 'user', isBot: false, online: true,
      lastSeen: Date.now(), createdAt: Date.now(), followers: [], following: [], closeFriends: [], settings: {}
    });
  } catch { /* best-effort — see header note */ }
}

export async function resetPassword(email) {
  if (live) {
    try {
      const redirectTo = typeof window !== 'undefined' ? window.location.origin + window.location.pathname : undefined;
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
      if (error) throw error;
    } catch (err) {
      throw new Error(friendlySupabaseAuthError(err));
    }
    return;
  }
  const exists = getState().users.some((u) => u.email === email.trim().toLowerCase());
  if (!exists) throw new Error('No demo account uses that email.');
  // Demo mode cannot send real email; we surface a clear, honest message.
  throw new Error('Demo mode: password reset email cannot be sent. In demo mode sign in with the demo password, or wire Firebase config to enable real reset emails.');
}

export async function logout() {
  if (live) {
    // Best-effort presence stamp before the session ends.
    if (remoteUid) {
      try { await sbUpdate('users', remoteUid, { online: false, lastSeen: Date.now() }); } catch { /* best-effort */ }
    }
    await supabase.auth.signOut(); remoteUid = ''; return;
  }
  mutate((s) => {
    const u = s.users.find((x) => x.id === s.sessionUid);
    if (u) { u.online = false; u.lastSeen = Date.now(); }
    s.sessionUid = '';
  });
}

export async function deleteAccount() {
  const user = me();
  if (!user) throw new Error('Not signed in.');
  if (live) {
    // Delete the profile row (the users delete policy allows self),
    // then end the session. Supabase Auth offers no client-side
    // self-delete without a service key, so the auth record itself
    // remains — with no profile row the app treats the account as
    // signed-out everywhere and none of its content renders, the same
    // end state the Spark plan produced for admin deletions.
    await sbDelete('users', user.id);
    try { await supabase.auth.signOut(); } catch { /* session is over either way */ }
    remoteUid = '';
    return;
  }
  mutate((s) => {
    s.users = s.users.filter((u) => u.id !== user.id);
    s.posts = s.posts.filter((p) => p.authorId !== user.id);
    s.sessionUid = '';
  });
}

export function onAuthReady(cb) {
  if (live) {
    // onAuthStateChange fires once immediately with the restored
    // session (or null), then on every sign-in/out — the same cadence
    // the Firebase callback had. The handler is async (OAuth profile
    // ensure + sync start), and its ordering per event is preserved
    // because each event's work is self-contained.
    const { data } = supabase.auth.onAuthStateChange(async (event, session) => {
      const user = session?.user || null;
      remoteUid = user ? user.id : '';
      if (user) { await ensureAuthProfile(user); startRemoteSync(); }
      else { stopRemoteSync(); stopBotRunner(); } // no session -> no sync, no live bot runner, ever
      cb(user ? { id: user.id } : null);
    });
    return () => { try { data?.subscription?.unsubscribe(); } catch { /* already gone */ } };
  }
  cb(me());
  return () => {};
}

// -------------------------------------------------------------------------
// SUPABASE SYNC (mirrors Postgres into the shared dataset shape)
//
// RLS IS THE FILTER: unlike Firestore ("rules are not filters"), every
// PostgREST read below is row-filtered server-side by the policies in
// supabase/policies.sql, so a plain select returns exactly the rows
// this user may see. The denormalized audiences (audienceIds /
// participants snapshots) are still what the policies key off, and the
// client keeps the same slice-and-merge mirror the Firestore listeners
// fed, with the same emit discipline:
//  - posts/stories/events/groups: slices merged by id; posts go
//    through mergePosts (echo pruning by id) so a
//    refetch that changes nothing emits nothing — the anti-shake rule.
//  - friendships/groupRequests/supportReports: two slices merged by id.
//  - everything else: one slice, replaced only when its content
//    actually changed (setSlice compares canonical JSON), because a
//    realtime event for a row OUTSIDE a slice's filter (a stranger's
//    notification, someone else's block) must not re-render the page.
// Realtime (Phase 3): one postgres_changes channel per table; any
// change refetches that table's slices, RLS-filtered again on the way
// out. Admin-only tables (reports, botActivities, botLogs, adminLogs)
// simply return zero rows for non-admins — no error path needed.
// Typing indicators and presence ride broadcast/presence channels
// instead of document writes: they are heartbeat-only state, and RLS
// does not govern channels — see setTyping / startPresenceChannel.
// -------------------------------------------------------------------------
let syncStarted = false;
let syncUid = '';
let syncChannels = [];
const channelByTable = new Map();
const tableRefetchers = new Map();
// Broadcast typing state per conversation ({ uid: epochMs }), merged
// over the conversations rows on every fetch: a conversations refetch
// must never wipe an in-flight "typing…" indicator.
const typingState = new Map();
let typingChannel = null;
let presenceChannel = null;

function patchMirror(fn) {
  if (!remote) return;
  fn(remote);
  emitData();
}

// Replace a single-query slice of the mirror, emitting ONLY when the
// content actually changed (canonical-JSON compare).
function setSlice(key, rows) {
  if (!remote) return;
  const prev = remote[key] || [];
  if (prev.length === rows.length && stableStringify(prev) === stableStringify(rows)) {
    // Equal content: rebind SILENTLY to the fresh row objects anyway,
    // so the mirror's objects stay the very objects the latest fetch
    // produced (optimistic patch helpers mutate mirror objects; a
    // stale binding would let a later merge resurrect pre-patch state).
    remote[key] = rows;
    return;
  }
  patchMirror((r) => { r[key] = rows; });
}

// Content-compare for merged slices: sort a COPY by id (mirror order
// follows merge order, which is slice order, so an order-insensitive
// compare is the honest one) and canonicalise.
function sameRowsById(a, b) {
  if (a.length !== b.length) return false;
  const key = (arr) => stableStringify([...arr].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)));
  return key(a) === key(b);
}

// ---------------------------------------------------------------------------
// Realtime refetch coalescing (Speed Pack). A postgres_changes burst on
// one table (a bot cycle writing a dozen rows, a like-storm) used to
// fire one FULL refetch per event, and the herd contended for the
// free-tier PostgREST pool until every slice crawled. Refetches for a
// table are now SERIALISED: while one is in flight, further events
// collapse into a single trailing refetch that runs when it settles —
// a burst costs at most one extra refetch instead of one per event,
// and on the Nano pool (where a refetch takes hundreds of ms) that
// window is exactly when the pile-up happened. An event that arrives
// while no refetch is in flight still refetches immediately, so an
// isolated change is as instant as it always was. The fetchers
// themselves are unchanged: presence-only users snapshots still apply
// silently and every merge still compare-and-suppresses, so
// coalescing never changes what renders, only how often the pool is
// hit. (A timer-based trailing debounce was tried first and broke the
// pinned immediacy of sequential changes; in-flight coalescing gets
// the same burst collapse from the refetch's own duration.)
// ---------------------------------------------------------------------------
const REFETCH_STUCK_MS = 15000; // a hung fetch must not wedge a table forever
const refetchState = new Map(); // table -> { inFlight, pending, since }

function runTableRefetchers(table, st) {
  st.inFlight = true;
  st.since = Date.now();
  const runs = [];
  for (const fn of tableRefetchers.get(table) || []) {
    try { runs.push(fn()); } catch { /* a failed refetch leaves the mirror untouched */ }
  }
  Promise.allSettled(runs).then(() => {
    st.inFlight = false;
    if (st.pending) { st.pending = false; runTableRefetchers(table, st); }
  });
}

function scheduleTableRefetch(table) {
  let st = refetchState.get(table);
  if (!st) { st = { inFlight: false, pending: false, since: 0 }; refetchState.set(table, st); }
  if (st.inFlight && Date.now() - st.since < REFETCH_STUCK_MS) { st.pending = true; return; }
  runTableRefetchers(table, st);
}

function clearRefetchWindows() {
  refetchState.clear();
}

function watchTable(table, refetch) {
  if (!tableRefetchers.has(table)) tableRefetchers.set(table, new Set());
  tableRefetchers.get(table).add(refetch);
  if (channelByTable.has(table)) return;
  const ch = supabase.channel(`mb-sync-${table}`)
    .on('postgres_changes', { event: '*', schema: 'public', table }, () => scheduleTableRefetch(table))
    .subscribe();
  channelByTable.set(table, ch);
  syncChannels.push(ch);
}

function stopRemoteSync() {
  for (const ch of syncChannels) {
    try { supabase.removeChannel(ch); } catch { /* already gone */ }
  }
  syncChannels = [];
  channelByTable.clear();
  tableRefetchers.clear();
  clearRefetchWindows();
  typingChannel = null;
  presenceChannel = null;
  typingState.clear();
  syncStarted = false;
  syncUid = '';
  // Per-session state must not leak into the next account on this tab:
  // the bot-secrets loaded flag (a fresh admin would never re-read the
  // keys) and optimistic post echoes (the previous account's just-made
  // post could render in the next account's feed).
  botSecretsLoaded = false;
  localEchoPosts = [];
  remergePosts = null;
  localEchoGroups = [];
  localEchoEvents = [];
  localEchoStories = [];
  remergeGroups = null;
  remergeEvents = null;
  remergeStories = null;
  remote = blankRemote();
  emitData();
}

// ---------------------------------------------------------------------------
// Presence (Phase 3): one shared channel keyed by the signed-in uid.
// Subscribers learn who is online from the channel's presence state —
// no per-heartbeat database write at all. The users-row online/lastSeen
// columns still carry the durable record (login/logout stamps + the
// throttled setOnline writes); the channel is the live overlay, and
// like presence-only users snapshots in the Firestore era it is applied
// SILENTLY (shake-fix discipline: presence never triggers a render).
// ---------------------------------------------------------------------------
function startPresenceChannel() {
  if (!supabase || !remoteUid) return;
  presenceChannel = supabase.channel('meetbook-presence', { config: { presence: { key: remoteUid } } });
  presenceChannel.on('presence', { event: 'sync' }, () => applyPresenceState());
  presenceChannel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      presenceChannel.track({ online_at: Date.now() }).catch(() => {});
    }
  });
  syncChannels.push(presenceChannel);
}

function applyPresenceState() {
  if (!remote || !presenceChannel) return;
  let state;
  try { state = presenceChannel.presenceState(); } catch { return; }
  const onlineIds = new Set(Object.keys(state || {}));
  if (!onlineIds.size) return;
  const now = Date.now();
  for (const u of remote.users || []) {
    if (onlineIds.has(u.id)) { u.online = true; u.lastSeen = now; }
  }
  // Deliberately no emitData() — see the header note.
}

// ---------------------------------------------------------------------------
// Typing indicators (Phase 3): broadcast on a shared channel instead of
// document writes. setTyping records the local state and broadcasts;
// receivers fold remote state into the same typingState map, and the
// conversations mapper overlays it — so the freshness window views
// already use (TYPING_FRESH_MS) works unchanged: an indicator expires
// when its last broadcast ages out, exactly as a stale typing
// timestamp did. Broadcasts carry no persistence and no RLS — a
// spoofed typing event can only light up a "typing…" label in a
// conversation the receiver already sees.
// ---------------------------------------------------------------------------
function startTypingChannel() {
  if (!supabase) return;
  typingChannel = supabase.channel('meetbook-typing');
  typingChannel.on('broadcast', { event: 'typing' }, ({ payload }) => handleTypingBroadcast(payload));
  typingChannel.subscribe();
  syncChannels.push(typingChannel);
}

function handleTypingBroadcast(payload) {
  const conversationId = payload?.conversationId;
  const userId = payload?.userId;
  if (!conversationId || !userId || userId === remoteUid || !remote) return;
  const conv = (remote.conversations || []).find((c) => c.id === conversationId);
  if (!conv) return;
  const next = { ...(typingState.get(conversationId) || conv.typing || {}) };
  if (payload.isTyping) next[userId] = Date.now(); else delete next[userId];
  typingState.set(conversationId, next);
  if (stableStringify(conv.typing || {}) !== stableStringify(next)) {
    patchRemoteConversation(conversationId, (c) => { c.typing = next; });
  }
}

function startRemoteSync() {
  if (!live) return;
  // Account-switch guard: onAuthStateChanged can fire again (token
  // refresh, a second sign-in) while listeners are already running for
  // THIS user — restarting them would churn the UI. But if the
  // signed-in user CHANGED, the previous user's listeners (some
  // user-scoped) must be replaced.
  if (syncStarted && syncUid === remoteUid) return;
  if (syncStarted) stopRemoteSync();
  syncStarted = true;
  syncUid = remoteUid;
  remote = blankRemote();
  const uid = remoteUid;
  // A fetch started under a previous session must never land in the
  // new session's mirror (the Firestore version got this for free by
  // unsubscribing; an in-flight PostgREST read cannot be cancelled).
  const stale = () => !syncStarted || syncUid !== uid;

  // SPEED PACK — tiered boot. This function used to fire ~32 PostgREST
  // queries in the same tick, and the boot gate in main.js (which
  // needs only MY user row to lift the splash) raced the whole herd
  // for the free-tier connection pool — the 30–50s "Loading
  // MeetBook…" stall. Now the initial fetches below are collected
  // into tiers and run by the boot sequence at the bottom: (0) my own
  // profile row alone (fetchOwnProfile), so me() resolves after ONE
  // single-row request; (1) the feed-critical slices; (2) everything
  // else, fired once tier 1 settles. The watchTable registrations
  // still happen immediately — only the INITIAL fetches are tiered —
  // so a realtime event can pull any slice forward at any time, and
  // no view can be left permanently empty, just loaded seconds later.
  const tier1 = [];
  const tier2 = [];
  // Staff-only slices (Reports Center, admin log, bot activity/log):
  // RLS returns zero rows for everyone else, so a non-staff boot
  // skips the initial fetch entirely — the mirror holds [] either
  // way. The role is read at fire time (tier 2 runs after the users
  // fetch lands), and the watchers stay registered for everyone, so
  // a mid-session promotion self-heals on the next realtime event.
  const staffTier2 = (fn) => () => (isStaff(me()) ? fn() : undefined);

  // TIME NORMALISATION: PostgREST returns bigint epoch-ms as numbers,
  // so times arrive already normalised; the normaliseTimeFields pass
  // stays as a belt-and-braces guard so a Timestamp-shaped value can
  // never leak into a view.
  const mapUser = (row) => {
    const u = { ...normaliseTimeFields(row, ['createdAt', 'lastSeen']) };
    // Firestore documents omit the key entirely for human users;
    // Postgres stores NULL — drop it so consumers see the same shape.
    if (u.botId == null) delete u.botId;
    return u;
  };
  const fetchUsers = async () => {
    if (stale()) return;
    try {
      // Ordered by id so the canonical compare below is stable.
      const rows = await sbSelect('users', (q) => q.order('id', { ascending: true }).limit(300));
      const mapped = rows.map(mapUser);
      // PRESENCE-ONLY snapshots (an online/lastSeen heartbeat — the
      // login/logout stamps and setOnline writes land here) must not
      // re-render the page: applying them silently into the mirror
      // keeps presence fresh while a heartbeat can never shake the
      // feed (Limon's like-shake report, round 2). Any REAL change
      // (name, avatar, role, followers…) goes through the normal
      // patch+emit path.
      const stripPresence = (u) => { const c = { ...u }; delete c.lastSeen; delete c.online; return c; };
      const prevUsers = remote.users || [];
      const presenceOnly = prevUsers.length > 0 && prevUsers.length === mapped.length
        && mapped.every((u) => {
          const p = prevUsers.find((x) => x.id === u.id);
          return p && stableStringify(stripPresence(p)) === stableStringify(stripPresence(u));
        });
      if (presenceOnly) {
        remote.users = mapped;
      } else if (stableStringify(prevUsers) !== stableStringify(mapped)) {
        patchMirror((r) => { r.users = mapped; });
      }
    } catch { /* leave the mirrored set untouched */ }
    // Load this user's bot secrets (admin-gated inside) once users
    // are known, and the admin platform stats (staff-gated inside).
    void loadBotSecrets();
    void loadAdminStats();
    syncLiveBotRunner();
  };
  // FAST GATE (Speed Pack): my own row, fetched alone before the
  // herd. Seeding it into the still-empty users mirror resolves me()
  // — and with it main.js's boot gate — after a single-row request
  // instead of after the 300-row users select has fought ~31 other
  // boot queries for the pool. The full fetchUsers (tier 1) then
  // replaces the seed with the whole list; if this get fails or the
  // row is missing, the gate simply falls back to waiting for it.
  const fetchOwnProfile = async () => {
    if (stale() || !uid) return;
    try {
      const row = await sbGet('users', uid);
      if (stale() || !row || !remote) return;
      // Never clobber a list that already landed (a realtime refetch
      // could in theory beat us here); the seed only fills the void.
      if ((remote.users || []).length === 0) {
        patchMirror((r) => { if (r.users.length === 0) r.users = [mapUser(row)]; });
      }
    } catch { /* the full users fetch remains the fallback */ }
  };
  tier1.push(fetchUsers);
  watchTable('users', fetchUsers);

  // ---- post slices ---------------------------------------------------
  const mapPost = (row) => {
    const raw = normaliseTimeFields(row, ['createdAt', 'editedAt']);
    if (!raw.createdAt) raw.createdAt = Date.now();
    const comments = (raw.comments || []).map((c) => ({
      ...normaliseTimeFields(c, ['createdAt']),
      replies: (c.replies || []).map((rep) => normaliseTimeFields(rep, ['createdAt']))
    }));
    return { comments: [], likes: [], reactions: {}, savedBy: [], groupId: '', pageId: '', audienceIds: [], ...raw, comments };
  };
  let publicPosts = [];
  let ownPosts = [];
  let audiencePosts = [];
  // THREE post slices (public / mine / audience) must merge by id: any
  // one alone is incomplete, and a naive "latest wins" loses posts
  // whenever an out-of-scope event fires.
  const mergePosts = () => {
    const serverPosts = mergePostLists(publicPosts, ownPosts, audiencePosts);
    const serverIds = new Set(serverPosts.map((p) => p.id));
    // Prune echoes the server has confirmed (the merge is by id, so a
    // confirmed echo and its server copy could never duplicate — the
    // prune just retires the echo object); echoes older than a minute
    // that never landed are dropped as a leak guard (their write path
    // already removes them on failure).
    const cutoff = Date.now() - 60000;
    localEchoPosts = localEchoPosts.filter((p) => !serverIds.has(p.id) && p.createdAt > cutoff);
    const next = mergePostLists(serverPosts, localEchoPosts);
    // NO-OP GUARD: a realtime event that changes nothing visible (a
    // presence heartbeat landing in another slice, an out-of-scope
    // edit) must not re-render the page — that full re-render was the
    // "posts shake while scrolling" bug.
    if (!sameRowsById(remote.posts || [], next)) patchMirror((r) => { r.posts = next; });
    else remote.posts = next; // silent rebind — see setSlice's note
  };
  remergePosts = mergePosts;
  const fetchPublicPosts = async () => { if (stale()) return; try { publicPosts = (await sbSelect('posts', (q) => q.eq('visibility', 'public').order('createdAt', { ascending: false }).limit(100))).map(mapPost); mergePosts(); } catch { /* leave the mirrored set untouched */ } };
  const fetchOwnPosts = async () => { if (stale()) return; try { ownPosts = (await sbSelect('posts', (q) => q.eq('authorId', uid))).map(mapPost); mergePosts(); } catch { /* leave untouched */ } };
  const fetchAudiencePosts = async () => { if (stale()) return; try { audiencePosts = (await sbSelect('posts', (q) => q.contains('audienceIds', [uid]))).map(mapPost); mergePosts(); } catch { /* leave untouched */ } };
  tier1.push(fetchPublicPosts);
  watchTable('posts', fetchPublicPosts);
  if (uid) { tier1.push(fetchOwnPosts); tier1.push(fetchAudiencePosts); watchTable('posts', fetchOwnPosts); watchTable('posts', fetchAudiencePosts); }

  // ---- story slices --------------------------------------------------
  const mapStory = (row) => ({ image: '', text: '', bg: 'sunset', audienceIds: [], views: [], ...row, createdAt: tsToMs(row.createdAt) || Date.now() });
  let publicStories = [];
  let ownStories = [];
  let audienceStories = [];
  const mergeStories = () => {
    const byIdMap = new Map();
    for (const s of [...publicStories, ...audienceStories, ...ownStories]) byIdMap.set(s.id, s);
    const serverStories = [...byIdMap.values()];
    const serverIds = new Set(serverStories.map((s) => s.id));
    // Local echoes (see mergePosts): a just-created story is mirrored
    // at once and pruned as soon as a slice delivers the server copy;
    // echoes older than a minute that never landed are dropped.
    const cutoff = Date.now() - 60000;
    localEchoStories = localEchoStories.filter((s) => !serverIds.has(s.id) && s.createdAt > cutoff);
    const next = [...serverStories, ...localEchoStories];
    if (sameRowsById(remote.stories || [], next)) { remote.stories = next; return; } // silent rebind — see setSlice's note
    patchMirror((r) => { r.stories = next; });
  };
  remergeStories = mergeStories;
  const fetchPublicStories = async () => { if (stale()) return; try { publicStories = (await sbSelect('stories', (q) => q.eq('visibility', 'public').order('createdAt', { ascending: false }).limit(100))).map(mapStory); mergeStories(); } catch { /* leave untouched */ } };
  const fetchOwnStories = async () => { if (stale()) return; try { ownStories = (await sbSelect('stories', (q) => q.eq('authorId', uid))).map(mapStory); mergeStories(); } catch { /* leave untouched */ } };
  const fetchAudienceStories = async () => { if (stale()) return; try { audienceStories = (await sbSelect('stories', (q) => q.contains('audienceIds', [uid]))).map(mapStory); mergeStories(); } catch { /* leave untouched */ } };
  tier1.push(fetchPublicStories);
  watchTable('stories', fetchPublicStories);
  if (uid) { tier1.push(fetchOwnStories); tier1.push(fetchAudienceStories); watchTable('stories', fetchOwnStories); watchTable('stories', fetchAudienceStories); }

  // ---- event slices --------------------------------------------------
  const mapEvent = (row) => {
    const raw = normaliseTimeFields(row, ['createdAt', 'dateTime']);
    return { going: [], interested: [], audienceIds: [], ...raw };
  };
  let publicEvents = [];
  let ownEvents = [];
  let audienceEvents = [];
  const mergeEvents = () => {
    const byIdMap = new Map();
    for (const e of [...publicEvents, ...audienceEvents, ...ownEvents]) byIdMap.set(e.id, e);
    const serverEvents = [...byIdMap.values()];
    const serverIds = new Set(serverEvents.map((e) => e.id));
    // Local echoes (see mergePosts): pruned once a slice delivers
    // the server copy, or after a minute as a leak guard.
    const cutoff = Date.now() - 60000;
    localEchoEvents = localEchoEvents.filter((e) => !serverIds.has(e.id) && e.createdAt > cutoff);
    const next = [...serverEvents, ...localEchoEvents];
    if (sameRowsById(remote.events || [], next)) { remote.events = next; return; } // silent rebind — see setSlice's note
    patchMirror((r) => { r.events = next; });
  };
  remergeEvents = mergeEvents;
  const fetchPublicEvents = async () => { if (stale()) return; try { publicEvents = (await sbSelect('events', (q) => q.eq('visibility', 'public').order('dateTime', { ascending: true }).limit(100))).map(mapEvent); mergeEvents(); } catch { /* leave untouched */ } };
  const fetchOwnEvents = async () => { if (stale()) return; try { ownEvents = (await sbSelect('events', (q) => q.eq('createdBy', uid))).map(mapEvent); mergeEvents(); } catch { /* leave untouched */ } };
  const fetchAudienceEvents = async () => { if (stale()) return; try { audienceEvents = (await sbSelect('events', (q) => q.contains('audienceIds', [uid]))).map(mapEvent); mergeEvents(); } catch { /* leave untouched */ } };
  tier2.push(fetchPublicEvents);
  watchTable('events', fetchPublicEvents);
  if (uid) { tier2.push(fetchOwnEvents); tier2.push(fetchAudienceEvents); watchTable('events', fetchOwnEvents); watchTable('events', fetchAudienceEvents); }

  // ---- single-slice tables -------------------------------------------
  const fetchReviews = async () => { if (stale()) return; try { setSlice('reviews', (await sbSelect('reviews', (q) => q.order('createdAt', { ascending: false }).limit(500))).map((row) => normaliseTimeFields(row, ['createdAt']))); } catch { /* leave untouched */ } };
  tier2.push(fetchReviews);
  watchTable('reviews', fetchReviews);

  const fetchPages = async () => { if (stale()) return; try { setSlice('pages', (await sbSelect('pages', (q) => q.order('id', { ascending: true }).limit(200))).map((row) => normaliseTimeFields(row, ['createdAt']))); } catch { /* leave untouched */ } };
  tier2.push(fetchPages);
  watchTable('pages', fetchPages);

  const mapGroup = (row) => ({ id: row.id, ...normaliseGroup(normaliseTimeFields(row, ['createdAt'])) });
  let publicGroups = [];
  let memberGroups = [];
  const mergeGroups = () => {
    const byIdMap = new Map();
    for (const g of [...publicGroups, ...memberGroups]) byIdMap.set(g.id, g);
    const serverGroups = [...byIdMap.values()];
    const serverIds = new Set(serverGroups.map((g) => g.id));
    // Local echoes (see mergePosts): pruned once a slice delivers
    // the server copy, or after a minute as a leak guard.
    const cutoff = Date.now() - 60000;
    localEchoGroups = localEchoGroups.filter((g) => !serverIds.has(g.id) && g.createdAt > cutoff);
    const next = [...serverGroups, ...localEchoGroups];
    if (sameRowsById(remote.groups || [], next)) { remote.groups = next; return; } // silent rebind — see setSlice's note
    patchMirror((r) => { r.groups = next; });
  };
  remergeGroups = mergeGroups;
  const fetchPublicGroups = async () => { if (stale()) return; try { publicGroups = (await sbSelect('groups', (q) => q.eq('privacy', 'public').limit(200))).map(mapGroup); mergeGroups(); } catch { /* leave untouched */ } };
  const fetchMemberGroups = async () => { if (stale()) return; try { memberGroups = (await sbSelect('groups', (q) => q.contains('members', [uid]))).map(mapGroup); mergeGroups(); } catch { /* leave untouched */ } };
  tier2.push(fetchPublicGroups);
  watchTable('groups', fetchPublicGroups);
  if (uid) { tier2.push(fetchMemberGroups); watchTable('groups', fetchMemberGroups); }

  const fetchBots = async () => { if (stale()) return; try { setSlice('bots', (await sbSelect('bots', (q) => q.order('id', { ascending: true }).limit(100))).map((row) => normaliseBot(normaliseTimeFields(row, ['createdAt'])))); } catch { /* leave untouched */ } };
  tier2.push(fetchBots);
  watchTable('bots', fetchBots);

  // Admin-only in RLS (non-admins simply read zero rows) — the boot
  // fetch is staff-gated (see staffTier2); the watcher stays live.
  const fetchBotActivities = async () => { if (stale()) return; try { setSlice('botActivities', (await sbSelect('botActivities', (q) => q.order('createdAt', { ascending: false }).limit(100))).map((row) => normaliseTimeFields(row, ['createdAt']))); } catch { /* leave untouched */ } };
  tier2.push(staffTier2(fetchBotActivities));
  watchTable('botActivities', fetchBotActivities);

  const fetchBotLogs = async () => { if (stale()) return; try { setSlice('botLogs', (await sbSelect('botLogs', (q) => q.order('createdAt', { ascending: false }).limit(100))).map((row) => normaliseTimeFields(row, ['createdAt']))); } catch { /* leave untouched */ } };
  tier2.push(staffTier2(fetchBotLogs));
  watchTable('botLogs', fetchBotLogs);

  const fetchBotSettings = async () => {
    if (stale()) return;
    try {
      const row = await sbGet('botSettings', 'global');
      if (row && remote && remote.botSettings.global.enabled !== (row.enabled !== false)) {
        patchMirror((r) => { r.botSettings.global = { enabled: row.enabled !== false }; });
      }
    } catch { /* leave untouched */ }
  };
  tier2.push(fetchBotSettings);
  watchTable('botSettings', fetchBotSettings);

  const fetchConfig = async () => {
    if (stale()) return;
    try {
      const row = await sbGet('config', 'app');
      if (!row || !remote) return;
      // The config row spreads its overflow jsonb first, then the
      // named columns (NULL columns are absent keys, exactly as a
      // Firestore document would omit them) — the same merged shape
      // config consumers read in the Firestore era.
      const { id: _ignored, extra, ...cols } = row;
      const docData = { ...(extra || {}) };
      for (const [k, v] of Object.entries(cols)) if (v !== null && v !== undefined) docData[k] = v;
      const merged = { ...remote.config, ...docData };
      if (stableStringify(remote.config) !== stableStringify(merged)) {
        patchMirror((r) => { r.config = merged; });
      }
    } catch { /* leave untouched */ }
  };
  tier2.push(fetchConfig);
  watchTable('config', fetchConfig);

  const fetchAnnouncements = async () => { if (stale()) return; try { setSlice('announcements', (await sbSelect('announcements', (q) => q.order('createdAt', { ascending: false }).limit(50))).map((row) => normaliseTimeFields(row, ['createdAt']))); } catch { /* leave untouched */ } };
  tier2.push(fetchAnnouncements);
  watchTable('announcements', fetchAnnouncements);

  if (uid) {
    // Friendships: rows I sent (from == me) + rows sent to me
    // (to == me), merged by id.
    let sentFriendships = [];
    let receivedFriendships = [];
    const mergeFriendships = () => {
      const byIdMap = new Map();
      for (const f of [...sentFriendships, ...receivedFriendships]) byIdMap.set(f.id, f);
      const next = [...byIdMap.values()];
      if (sameRowsById(remote.friendships || [], next)) { remote.friendships = next; return; } // silent rebind — see setSlice's note
      patchMirror((r) => { r.friendships = next; });
    };
    const fetchSentFriendships = async () => { if (stale()) return; try { sentFriendships = await sbSelect('friendships', (q) => q.eq('from', uid)); mergeFriendships(); } catch { /* leave untouched */ } };
    const fetchReceivedFriendships = async () => { if (stale()) return; try { receivedFriendships = await sbSelect('friendships', (q) => q.eq('to', uid)); mergeFriendships(); } catch { /* leave untouched */ } };
    tier1.push(fetchSentFriendships);
    tier1.push(fetchReceivedFriendships);
    watchTable('friendships', fetchSentFriendships);
    watchTable('friendships', fetchReceivedFriendships);

    const fetchNotifications = async () => { if (stale()) return; try { setSlice('notifications', (await sbSelect('notifications', (q) => q.eq('userId', uid).order('createdAt', { ascending: false }).limit(100))).map((row) => normaliseTimeFields(row, ['createdAt']))); } catch { /* leave untouched */ } };
    tier1.push(fetchNotifications);
    watchTable('notifications', fetchNotifications);

    // Conversations I take part in. RLS already restricts rows to
    // participants (+ staff); the participants filter mirrors the
    // Firestore query and keeps staff mirrors conversation-free.
    // Broadcast typing state overlays the stored column (which stays
    // at its default — typing is channel state now, Phase 3).
    const mapConversation = (row) => {
      const c = normaliseTimeFields(row, ['createdAt']);
      const liveTyping = typingState.get(c.id);
      if (liveTyping) c.typing = liveTyping;
      return c;
    };
    const fetchConversations = async () => { if (stale()) return; try { setSlice('conversations', (await sbSelect('conversations', (q) => q.contains('participants', [uid]))).map(mapConversation)); } catch { /* leave untouched */ } };
    tier1.push(fetchConversations);
    watchTable('conversations', fetchConversations);

    // Messages: NEWEST 500 across all my conversations (desc +
    // limit; the view sorts ascending for display). RLS restricts to
    // conversations I participate in; the participants filter is the
    // query the Firestore version used, kept for parity.
    const fetchMessages = async () => { if (stale()) return; try { setSlice('messages', (await sbSelect('messages', (q) => q.contains('participants', [uid]).order('createdAt', { ascending: false }).limit(500))).map((row) => normaliseTimeFields(row, ['createdAt']))); } catch { /* leave the mirrored set untouched */ } };
    tier1.push(fetchMessages);
    watchTable('messages', fetchMessages);

    const fetchBlocks = async () => { if (stale()) return; try { setSlice('blocks', await sbSelect('blocks', (q) => q.eq('blockerId', uid))); } catch { /* leave untouched */ } };
    tier1.push(fetchBlocks);
    watchTable('blocks', fetchBlocks);

    // Group join requests: mine + requests to groups I admin,
    // merged by id.
    let myGroupRequests = [];
    let adminGroupRequests = [];
    const mergeGroupRequests = () => {
      const byIdMap = new Map();
      for (const g of [...myGroupRequests, ...adminGroupRequests]) byIdMap.set(g.id, g);
      const next = [...byIdMap.values()];
      if (sameRowsById(remote.groupRequests || [], next)) { remote.groupRequests = next; return; } // silent rebind — see setSlice's note
      patchMirror((r) => { r.groupRequests = next; });
    };
    const fetchMyGroupRequests = async () => { if (stale()) return; try { myGroupRequests = await sbSelect('groupRequests', (q) => q.eq('userId', uid)); mergeGroupRequests(); } catch { /* leave untouched */ } };
    const fetchAdminGroupRequests = async () => { if (stale()) return; try { adminGroupRequests = await sbSelect('groupRequests', (q) => q.eq('groupAdminId', uid)); mergeGroupRequests(); } catch { /* leave untouched */ } };
    tier1.push(fetchMyGroupRequests);
    tier2.push(fetchAdminGroupRequests);
    watchTable('groupRequests', fetchMyGroupRequests);
    watchTable('groupRequests', fetchAdminGroupRequests);

    // Support Inbox (Support Pack): reports I filed + reports ABOUT
    // my content (the notices), merged by id. RLS already restricts
    // report reads to reporter / target author / staff, so these two
    // slices are belt-and-braces scoping identical to the Firestore
    // queries; the staff slice below keeps the Reports Center full.
    let filedReports = [];
    let aboutReports = [];
    const mergeSupportReports = () => {
      const byIdMap = new Map();
      for (const r of [...filedReports, ...aboutReports]) byIdMap.set(r.id, r);
      const next = [...byIdMap.values()];
      if (sameRowsById(remote.supportReports || [], next)) { remote.supportReports = next; return; } // silent rebind — see setSlice's note
      patchMirror((r) => { r.supportReports = next; });
    };
    const fetchFiledReports = async () => { if (stale()) return; try { filedReports = (await sbSelect('reports', (q) => q.eq('reporterId', uid))).map((row) => normaliseTimeFields(row, ['createdAt'])); mergeSupportReports(); } catch { /* leave untouched */ } };
    const fetchAboutReports = async () => { if (stale()) return; try { aboutReports = (await sbSelect('reports', (q) => q.eq('targetAuthorId', uid))).map((row) => normaliseTimeFields(row, ['createdAt'])); mergeSupportReports(); } catch { /* leave untouched */ } };
    tier1.push(fetchFiledReports);
    tier1.push(fetchAboutReports);
    watchTable('reports', fetchFiledReports);
    watchTable('reports', fetchAboutReports);
  }

  // Staff-only mirrors (RLS returns zero rows for non-staff, so these
  // are safe to run for everyone): the Reports Center and the admin
  // activity log.
  const fetchStaffReports = async () => { if (stale()) return; try { setSlice('reports', (await sbSelect('reports', (q) => q.order('createdAt', { ascending: false }).limit(100))).map((row) => normaliseTimeFields(row, ['createdAt']))); } catch { /* leave untouched */ } };
  tier2.push(staffTier2(fetchStaffReports));
  watchTable('reports', fetchStaffReports);

  const fetchAdminLogs = async () => { if (stale()) return; try { setSlice('adminLogs', (await sbSelect('adminLogs', (q) => q.order('createdAt', { ascending: false }).limit(200))).map((row) => normaliseTimeFields(row, ['createdAt']))); } catch { /* leave untouched */ } };
  tier2.push(staffTier2(fetchAdminLogs));
  watchTable('adminLogs', fetchAdminLogs);

  // Phase 3 channels: presence + typing (see their sections above).
  startPresenceChannel();
  startTypingChannel();

  // SPEED PACK — run the boot tiers (see the tier note at the top of
  // this function): the gate fetch first and ALONE, then tier 1, then
  // tier 2 once tier 1 settles. Every fetcher catches its own errors,
  // so allSettled is purely a sequencing device; the stale() checks
  // keep a superseded session's boot from firing its later tiers.
  void (async () => {
    await fetchOwnProfile();
    if (stale()) return;
    await Promise.allSettled(tier1.map((fn) => { try { return fn(); } catch { return undefined; } }));
    if (stale()) return;
    for (const fn of tier2) { try { void fn(); } catch { /* a failed fetch leaves the mirror untouched */ } }
  })();
}

// -------------------------------------------------------------------------
// PROFILES
// -------------------------------------------------------------------------
export async function updateProfile(userId, patch) {
  if (patch.username) {
    const v = validateUsername(patch.username);
    if (!v.ok) throw new Error(v.error);
    patch.username = v.value;
    const clash = data().users.some((u) => u.username === v.value && u.id !== userId);
    if (clash) throw new Error('That username is already taken.');
    if (live) {
      // The local mirror is capped (~300 users) and may not have
      // loaded — verify against Supabase itself before writing.
      const taken = await sbSelect('users', (q) => q.eq('username', v.value));
      if (taken.some((d) => d.id !== userId)) throw new Error('That username is already taken.');
    }
  }
  if (live) {
    const updated = await sbUpdate('users', userId, patch);
    // Zero affected rows (sbUpdate returns null) means the write
    // never landed — surface that instead of letting the caller
    // toast "Profile updated." over an unchanged profile.
    if (!updated) throw new Error('Your profile could not be updated — please try again.');
    // Mirror the confirmed write at once: profile pages render from
    // the mirror, and the realtime refetch can lag far behind the
    // success toast (a saved bio used to "revert" on reload until
    // the refetch caught up — or forever, on a zero-row write).
    patchMirror((r) => { const u = r.users.find((x) => x.id === userId); if (u) Object.assign(u, patch); });
    return;
  }
  mutate((s) => {
    const u = s.users.find((x) => x.id === userId);
    if (u) Object.assign(u, patch);
  });
}

// Compress an image file to a JPEG data URL of at most ~maxBytes by drawing
// it to a canvas and stepping down dimensions/quality. Browser-only helper.
export async function compressImageToDataUrl(file, maxBytes = 200 * 1024, maxDim = 1280) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    // Last-resort fallback if the browser cannot decode the image.
    // CAPPED: the raw file as a data URL has no size limit, and stored
    // into a Firestore document anything over ~1 MB makes the WRITE
    // fail with a confusing size error — fail here, clearly, instead.
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        if (url.length > 900_000) reject(new Error('That image could not be processed — please try a smaller or standard image file.'));
        else resolve(url);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  let scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  let quality = 0.82;
  let out = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    out = canvas.toDataURL('image/jpeg', quality);
    // data URL length * 0.75 ≈ decoded byte size; compare against budget.
    if (out.length * 0.75 <= maxBytes) break;
    if (quality > 0.45) quality -= 0.12; else scale *= 0.75;
  }
  if (typeof bitmap.close === 'function') bitmap.close();
  return out;
}

export async function uploadImage(file, path) {
  if (!file) return '';
  if (!String(file.type || '').startsWith('image/')) throw new Error('Please choose an image file.');
  // 1) Cloudinary first when configured (free tier): Cloudinary is the
  //    working hosted storage; the database then stores only the URL.
  if (isCloudinaryConfigured()) {
    try {
      return await uploadToCloudinary(file);
    } catch (err) {
      console.warn('Cloudinary upload failed, falling back:', err?.message || err);
    }
  }
  // 2) Demo mode / no hosted storage: compressed data URL stored
  //    locally (demo store) or in the row itself (live mode).
  return compressImageToDataUrl(file);
}

const presenceWriteAt = new Map();
export function setOnline(userId, online) {
  // Every presence write also stamps lastSeen: the online rail treats a
  // user as online only when the flag is set AND lastSeen is fresh
  // (older docs without lastSeen fall back to the flag alone).
  // Heartbeat calls arrive every 60s; writing every one churns a
  // Firestore write plus a users snapshot on every connected client.
  // The rail treats lastSeen as fresh for 10 minutes, so a 2-minute
  // write throttle is invisible to it. Going offline is never throttled.
  const now = Date.now();
  if (online && now - (presenceWriteAt.get(userId) || 0) < 120_000) return;
  presenceWriteAt.set(userId, now);
  if (live) { sbUpdate('users', userId, { online, lastSeen: now }).catch(() => {}); return; }
  mutate((s) => { const u = s.users.find((x) => x.id === userId); if (u) { u.online = online; u.lastSeen = now; } });
}

export function updateSettings(userId, settingsPatch) {
  const user = data().users.find((u) => u.id === userId);
  const merged = { ...(user?.settings || {}), ...settingsPatch };
  return updateProfile(userId, { settings: merged });
}

// -------------------------------------------------------------------------
// POSTS
// -------------------------------------------------------------------------
const postLimiter = { map: new Map() };

// Accepted-friend ids for a user, computed from the mirrored dataset so
// it works identically in live and demo mode (store.friendIdsOf only sees
// the demo store).
function friendIdsFromData(userId) {
  const ids = new Set();
  for (const f of data().friendships || []) {
    if (f.status !== 'accepted') continue;
    if (f.from === userId) ids.add(f.to);
    if (f.to === userId) ids.add(f.from);
  }
  return [...ids];
}

export async function createPost({ text, image, visibility, groupId = '', pageId = '', pageName = '', pageAvatar = '', poll = null, location = '', feeling = '' }) {
  const author = me();
  if (!author) throw new Error('Sign in to post.');
  // groupId: the post belongs to a group feed (visibility is then governed
  // by the group's privacy, not this field). pageId: the post is authored
  // "as" a page — authorId stays the page owner's uid (so Firestore rules
  // can verify authorship) and pageName/pageAvatar snapshot the page's
  // identity at post time for rendering.
  // The audience is denormalized onto the post (see postAudience): the
  // stored visibility/audienceIds pair is what the Firestore read rule and
  // the live listeners key off, since rules cannot join to friendships or
  // groups during a feed query. Close-friends posts snapshot the author's
  // closeFriends list the same way.
  const group = groupId ? (data().groups || []).find((g) => g.id === groupId) || null : null;
  const audience = postAudience({
    visibility: visibility || 'public', group,
    authorFriendIds: friendIdsFromData(author.id),
    authorCloseFriendIds: author.closeFriends || []
  });
  const post = {
    authorId: author.id, text: String(text || '').trim(), image: image || '',
    visibility: audience.visibility, audienceIds: audience.audienceIds,
    createdAt: Date.now(), editedAt: 0,
    likes: [], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [],
    groupId: groupId || '', pageId: pageId || '', pageName: pageName || '', pageAvatar: pageAvatar || '',
    // Optional extras: a poll (votes map starts empty), a check-in
    // location, a feeling key (see FEELINGS in utils.js) and the group
    // announcement pin (only meaningful for group posts).
    poll: poll || null, location: String(location || '').trim().slice(0, 120),
    feeling: String(feeling || ''), pinned: false
  };
  if (!post.text && !post.image && !post.poll) throw new Error('Write something or add a photo first.');
  if (live) {
    // Optimistic echo: show the post in the feed at once under a temp
    // id; the echo adopts the real id when the write lands and the
    // posts merge prunes it once the refetch delivers the server copy.
    // (The real id is generated client-side — PostgREST has no
    // addDoc — but it is only revealed once the insert succeeds, so a
    // failed write never leaves a "real-looking" phantom behind.)
    const echo = { id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ...post };
    localEchoPosts = [echo, ...localEchoPosts];
    // Rebuild the mirror now (not just emit): the echo only becomes
    // visible once the merge runs, and the refetch may not land until
    // the server copy arrives.
    if (remergePosts) remergePosts(); else emitData();
    try {
      const postId = genId('p');
      await sbInsert('posts', { id: postId, ...post });
      echo.id = postId;
      if (remergePosts) remergePosts(); else emitData();
      fanOutMentions(post.text, author, postId).catch(() => { /* mention notifications are best-effort; an unhandled rejection here used to be the only trace */ });
      return { id: postId, ...post };
    } catch (err) {
      localEchoPosts = localEchoPosts.filter((p) => p !== echo);
      if (remergePosts) remergePosts(); else emitData();
      throw err;
    }
  }
  const full = { id: genId('p'), ...post };
  mutate((s) => { s.posts.unshift(full); notifyMentions(s, full, author); });
  return full;
}

function notifyMentions(s, post, author) {
  for (const uname of extractMentions(post.text)) {
    const target = s.users.find((u) => u.username === uname);
    // Never notify the author about their own mention (Audit fix #10;
    // store.notify has the same guard, this direct write bypassed it).
    if (target && target.id !== author.id) {
      s.notifications.unshift({ id: genId('n'), userId: target.id, type: 'mention', actorId: author.id, text: `${author.name} mentioned you in a post.`, postId: post.id, conversationId: '', read: false, createdAt: Date.now() });
    }
  }
}

async function fanOutMentions(text, author, postId) {
  for (const uname of extractMentions(text)) {
    const rows = await sbSelect('users', (q) => q.eq('username', uname));
    for (const d of rows) {
      await createNotification({ userId: d.id, type: 'mention', actorId: author.id, text: `${author.name} mentioned you in a post.`, postId, conversationId: '', read: false, createdAt: Date.now() });
    }
  }
}

export async function editPost(postId, text) {
  if (live) {
    const updated = await sbUpdate('posts', postId, { text, editedAt: Date.now() });
    // sbUpdate returns null when the update matched zero rows (an
    // RLS USING denial, or a stale local-echo id whose server row
    // does not exist yet). That used to fall through silently, so
    // the UI toasted "Post updated." for a write that never landed
    // and the old text survived every reload.
    if (!updated) throw new Error('That post could not be updated — it may have been deleted, or is still publishing.');
    // Patch the mirror with the confirmed row so the new text shows
    // now, not whenever the realtime refetch lands.
    patchRemotePost(postId, (p) => { p.text = updated.text; p.editedAt = updated.editedAt; });
    return;
  }
  mutate((s) => { const p = s.posts.find((x) => x.id === postId); if (p) { p.text = text; p.editedAt = Date.now(); } });
}

export async function deletePost(postId) {
  if (live) {
    await sbDelete('posts', postId);
    // Drop the post from the mirror (and any local echo) at once:
    // the Firestore SDK's local cache hid deletes instantly, but
    // the Supabase mirror only learns about them from the realtime
    // refetch, which left deleted posts on screen for minutes.
    localEchoPosts = localEchoPosts.filter((p) => p.id !== postId);
    patchMirror((r) => { r.posts = (r.posts || []).filter((p) => p.id !== postId); });
    return;
  }
  mutate((s) => { s.posts = s.posts.filter((p) => p.id !== postId); });
}

export async function toggleLike(postId) {
  const user = me(); if (!user) throw new Error('Sign in to like posts.');
  if (live) {
    const post = data().posts.find((p) => p.id === postId);
    const has = post?.likes?.includes(user.id);
    // Optimistic: flip the mirror first so the heart/count update in
    // the same frame as the tap; roll back if the write fails.
    const applyLike = (p) => { p.likes = has ? (p.likes || []).filter((id) => id !== user.id) : [...(p.likes || []), user.id]; };
    const undoLike = (p) => { p.likes = has ? [...(p.likes || []), user.id] : (p.likes || []).filter((id) => id !== user.id); };
    // Capture the write payload BEFORE the optimistic patch: the patch
    // mutates the very object `post` points at, so reading post.likes
    // afterwards would double-count (Firestore's arrayUnion hid this —
    // a whole-array write cannot).
    const nextLikes = has ? (post?.likes || []).filter((id) => id !== user.id) : [...(post?.likes || []), user.id];
    patchRemotePost(postId, applyLike, { silent: true });
    try {
      await sbUpdate('posts', postId, { likes: nextLikes });
    } catch (err) { patchRemotePost(postId, undoLike, { silent: true }); throw err; }
    if (!has && post) { try { await createNotification({ userId: post.authorId, type: 'like', actorId: user.id, text: `${user.name} liked your post.`, postId, conversationId: '', read: false, createdAt: Date.now() }); } catch { /* the like itself already succeeded */ } }
    return;
  }
  mutate((s) => {
    const p = s.posts.find((x) => x.id === postId);
    if (!p) return;
    const i = p.likes.indexOf(user.id);
    if (i >= 0) p.likes.splice(i, 1); else { p.likes.push(user.id); notify(p.authorId, 'like', user.id, `${user.name} liked your post.`, { postId }); }
  });
}

export async function toggleReaction(postId, emoji) {
  const user = me(); if (!user) throw new Error('Sign in to react.');
  if (live) {
    const post = data().posts.find((p) => p.id === postId);
    const prevReactions = post ? { ...(post.reactions || {}) } : null;
    const reactions = { ...(post?.reactions || {}) };
    if (reactions[user.id] === emoji) delete reactions[user.id]; else reactions[user.id] = emoji;
    patchRemotePost(postId, (p) => { p.reactions = reactions; }, { silent: true });
    try {
      await sbUpdate('posts', postId, { reactions });
    } catch (err) { if (prevReactions) patchRemotePost(postId, (p) => { p.reactions = prevReactions; }, { silent: true }); throw err; }
    return;
  }
  mutate((s) => {
    const p = s.posts.find((x) => x.id === postId);
    if (!p) return;
    p.reactions = p.reactions || {};
    if (p.reactions[user.id] === emoji) delete p.reactions[user.id]; else p.reactions[user.id] = emoji;
  });
}

export async function toggleSave(postId) {
  const user = me(); if (!user) throw new Error('Sign in to save posts.');
  if (live) {
    const post = data().posts.find((p) => p.id === postId);
    const has = post?.savedBy?.includes(user.id);
    const applySave = (p) => { p.savedBy = has ? (p.savedBy || []).filter((id) => id !== user.id) : [...(p.savedBy || []), user.id]; };
    const undoSave = (p) => { p.savedBy = has ? [...(p.savedBy || []), user.id] : (p.savedBy || []).filter((id) => id !== user.id); };
    // Payload captured before the optimistic patch — see toggleLike.
    const nextSavedBy = has ? (post?.savedBy || []).filter((id) => id !== user.id) : [...(post?.savedBy || []), user.id];
    patchRemotePost(postId, applySave, { silent: true });
    try {
      await sbUpdate('posts', postId, { savedBy: nextSavedBy });
    } catch (err) { patchRemotePost(postId, undoSave, { silent: true }); throw err; }
    return;
  }
  mutate((s) => {
    const p = s.posts.find((x) => x.id === postId);
    if (!p) return;
    p.savedBy = p.savedBy || [];
    const i = p.savedBy.indexOf(user.id);
    if (i >= 0) p.savedBy.splice(i, 1); else p.savedBy.push(user.id);
  });
}

// Cast (or change) the signed-in user's poll vote. Votes live in a
// { uid: optionId } map on the post, so this is an engagement update —
// the posts rule pins body/visibility/audience but not the poll.
export async function votePoll(postId, optionId) {
  const user = me(); if (!user) throw new Error('Sign in to vote.');
  const post = data().posts.find((p) => p.id === postId);
  if (!post?.poll) throw new Error('This post has no poll.');
  const votes = castPollVote(post.poll, user.id, optionId);
  if (live) {
    const prevPoll = post.poll;
    patchRemotePost(postId, (p) => { p.poll = { options: prevPoll.options, votes }; }, { silent: true });
    try {
      await sbUpdate('posts', postId, { poll: { options: post.poll.options, votes } });
    } catch (err) { patchRemotePost(postId, (p) => { p.poll = prevPoll; }, { silent: true }); throw err; }
    return;
  }
  mutate((s) => {
    const p = s.posts.find((x) => x.id === postId);
    if (p?.poll) p.poll = { options: p.poll.options, votes };
  });
}

// Pin/unpin a group post as an announcement. Only the group creator may
// do this (enforced here for the UI and by the creator check; the write
// itself rides the normal post update path — `pinned` is not one of the
// fields the engagement branch of the posts rule pins).
export async function togglePinPost(postId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const post = data().posts.find((p) => p.id === postId);
  if (!post?.groupId) throw new Error('Only group posts can be pinned.');
  const group = (data().groups || []).find((g) => g.id === post.groupId);
  if (!group || group.createdBy !== user.id) throw new Error('Only the group creator can pin announcements.');
  const pinned = !post.pinned;
  if (live) { await sbUpdate('posts', postId, { pinned }); return pinned; }
  mutate((s) => { const p = s.posts.find((x) => x.id === postId); if (p) p.pinned = pinned; });
  return pinned;
}

export async function sharePost(postId) {
  const user = me(); if (!user) throw new Error('Sign in to share posts.');
  const original = data().posts.find((p) => p.id === postId);
  if (!original) throw new Error('Post not found.');
  const shared = {
    authorId: user.id, text: original.text, image: original.image, visibility: 'public', audienceIds: [],
    createdAt: Date.now(), editedAt: 0, likes: [], reactions: {}, comments: [], shares: 0,
    sharedFrom: original.authorId, savedBy: [], groupId: '', pageId: '', pageName: '', pageAvatar: ''
  };
  if (live) {
    // Same optimistic echo as createPost, plus the original's share
    // count flips locally at once. NOTE: nextShares is captured BEFORE
    // the optimistic patch — the patch mutates the shared `original`
    // object, so reading original.shares again at write time would
    // double-count.
    const nextShares = (original.shares || 0) + 1;
    const echo = { id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ...shared };
    localEchoPosts = [echo, ...localEchoPosts];
    patchRemotePost(postId, (p) => { p.shares = nextShares; });
    if (remergePosts) remergePosts(); else emitData();
    try {
      const shareId = genId('p');
      await sbInsert('posts', { id: shareId, ...shared });
      echo.id = shareId;
      if (remergePosts) remergePosts(); else emitData();
      await sbUpdate('posts', postId, { shares: nextShares });
    } catch (err) {
      localEchoPosts = localEchoPosts.filter((p) => p !== echo);
      patchRemotePost(postId, (p) => { p.shares = Math.max(0, nextShares - 1); });
      if (remergePosts) remergePosts(); else emitData();
      throw err;
    }
    // Demo mode notifies the original author of a share; live mode
    // never did. Best-effort — the share itself is already committed.
    try { await createNotification({ userId: original.authorId, type: 'share', actorId: user.id, text: `${user.name} shared your post.`, postId, conversationId: '', read: false, createdAt: Date.now() }); } catch { /* share already saved */ }
    return;
  }
  mutate((s) => {
    const p = s.posts.find((x) => x.id === postId);
    if (p) p.shares = (p.shares || 0) + 1;
    s.posts.unshift({ id: genId('p'), ...shared });
    notify(original.authorId, 'share', user.id, `${user.name} shared your post.`, { postId });
  });
}

export async function addComment(postId, text, parentCommentId = '') {
  const user = me(); if (!user) throw new Error('Sign in to comment.');
  const comment = { id: genId('c'), authorId: user.id, text: String(text).trim(), createdAt: Date.now(), replies: [] };
  if (!comment.text) throw new Error('Comment cannot be empty.');
  if (live) {
    const post = data().posts.find((p) => p.id === postId);
    const prevComments = post?.comments || [];
    // Build the next comments array immutably, apply it to the mirror
    // at once (the comment shows under the post in the same frame),
    // then persist the identical array; roll back on failure.
    let comments;
    if (parentCommentId) {
      comments = prevComments.map((c) => (c.id === parentCommentId ? { ...c, replies: [...(c.replies || []), comment] } : c));
    } else comments = [...prevComments, comment];
    patchRemotePost(postId, (p) => { p.comments = comments; });
    try {
      await sbUpdate('posts', postId, { comments });
    } catch (err) { patchRemotePost(postId, (p) => { p.comments = prevComments; }); throw err; }
    // Notification parity with demo mode: a REPLY notifies the parent
    // comment's author (not the post author), a top-level comment
    // notifies the post author, and @mentions in the comment fan out.
    if (post) {
      const parent = parentCommentId ? prevComments.find((c) => c.id === parentCommentId) : null;
      if (parent) {
        try { await createNotification({ userId: parent.authorId, type: 'reply', actorId: user.id, text: `${user.name} replied to your comment.`, postId, conversationId: '', read: false, createdAt: Date.now() }); } catch { /* comment already saved */ }
      } else {
        try { await createNotification({ userId: post.authorId, type: 'comment', actorId: user.id, text: `${user.name} commented on your post.`, postId, conversationId: '', read: false, createdAt: Date.now() }); } catch { /* comment already saved */ }
      }
      fanOutMentions(comment.text, user, postId).catch(() => { /* mentions are best-effort */ });
    }
    return comment;
  }
  mutate((s) => {
    const p = s.posts.find((x) => x.id === postId);
    if (!p) return;
    if (parentCommentId) {
      const parent = p.comments.find((c) => c.id === parentCommentId);
      if (parent) {
        parent.replies = parent.replies || [];
        parent.replies.push(comment);
        notify(parent.authorId, 'reply', user.id, `${user.name} replied to your comment.`, { postId });
      }
    } else {
      p.comments.push(comment);
      notify(p.authorId, 'comment', user.id, `${user.name} commented on your post.`, { postId });
    }
    notifyMentions(s, { text: comment.text, id: postId }, user);
  });
  return comment;
}

export async function deleteComment(postId, commentId) {
  if (live) {
    const post = data().posts.find((p) => p.id === postId);
    const prevComments = post?.comments || [];
    const comments = prevComments.filter((c) => c.id !== commentId)
      .map((c) => ({ ...c, replies: (c.replies || []).filter((r) => r.id !== commentId) }));
    patchRemotePost(postId, (p) => { p.comments = comments; });
    try {
      await sbUpdate('posts', postId, { comments });
    } catch (err) { patchRemotePost(postId, (p) => { p.comments = prevComments; }); throw err; }
    return;
  }
  mutate((s) => {
    const p = s.posts.find((x) => x.id === postId);
    if (!p) return;
    p.comments = p.comments.filter((c) => c.id !== commentId);
    for (const c of p.comments) c.replies = (c.replies || []).filter((r) => r.id !== commentId);
  });
}

// Human-readable snapshot of WHAT was reported, stamped onto the
// report at creation: after a 'content-removed' decision the target
// doc is hard-deleted, so neither the Reports Center nor the Support
// Inbox could otherwise say what the report was about (they used to
// degrade to the stats label "Total posts" and the raw doc id).
// Text-bearing targets stamp a ≤120-char snippet; a photo-only post
// stamps targetPhoto instead and the views render the localised
// "Photo post" label.
function reportTargetLabel(rep) {
  const d = data();
  if (rep.targetType === 'post') {
    const p = (d.posts || []).find((x) => x.id === rep.targetId);
    return p ? truncate(String(p.text || '').trim(), 120) : '';
  }
  if (rep.targetType === 'comment') {
    for (const p of d.posts || []) {
      for (const c of p.comments || []) {
        if (c.id === rep.targetId) return truncate(String(c.text || '').trim(), 120);
        for (const r of c.replies || []) if (r.id === rep.targetId) return truncate(String(r.text || '').trim(), 120);
      }
    }
    return '';
  }
  if (rep.targetType === 'user') return (d.users || []).find((u) => u.id === rep.targetId)?.name || '';
  if (rep.targetType === 'message') return truncate(String(rep.evidence?.text || '').trim(), 120);
  return '';
}

export async function reportContent(targetType, targetId, reason, opts = {}) {
  const user = me(); if (!user) throw new Error('Sign in to report content.');
  const category = REPORT_CATEGORIES.includes(opts.category) ? opts.category : 'other';
  const report = {
    reporterId: user.id, targetType, targetId,
    reason: String(reason || 'Inappropriate content'),
    category, status: 'pending', decision: null, appeal: { status: 'none' },
    createdAt: Date.now()
  };
  // MESSAGE reports carry evidence: ONLY the single message the user
  // submitted (its id, a text snapshot and its sender) — never the
  // surrounding conversation, which stays private (see Pack B spec §6).
  if (targetType === 'message') {
    const msg = data().messages.find((m) => m.id === targetId);
    report.evidence = {
      messageId: targetId,
      text: String(msg?.text || ''),
      senderId: msg?.senderId || '',
      conversationId: msg?.conversationId || ''
    };
  }
  // Stamp the content author onto the report itself: the author's
  // Support Inbox finds it with a single-field query, and the stamp
  // must happen NOW — content removal is a hard delete, so by the
  // time a decision lands the post/message doc no longer exists to
  // derive the author from.
  report.targetAuthorId = reportTargetUserId(report) || '';
  // Same "stamp it NOW" reasoning for the readable target snapshot
  // (see reportTargetLabel): a photo-only post has no text to stamp,
  // so it flags targetPhoto and the views localise the label.
  report.targetLabel = reportTargetLabel(report);
  if (targetType === 'post' && !report.targetLabel) {
    const p = data().posts.find((x) => x.id === targetId);
    if (p?.image) report.targetPhoto = true;
  }
  if (live) { await sbInsert('reports', { id: genId('rep'), ...report }); return report; }
  let saved = null;
  mutate((s) => { saved = { id: genId('rep'), ...report }; s.reports.unshift(saved); });
  return saved;
}

// -------------------------------------------------------------------------
// STORIES (photo/text only — never video; each story lives for 24 hours)
// -------------------------------------------------------------------------
export async function createStory({ text, image, bg, visibility }) {
  const author = me();
  if (!author) throw new Error('Sign in to post a story.');
  // The audience is denormalized exactly like posts (postAudience with no
  // group): friends stories snapshot the author's current friend ids so
  // the Firestore read rule and the live listeners stay provable.
  const audience = postAudience({ visibility: visibility || 'public', authorFriendIds: friendIdsFromData(author.id) });
  const story = {
    authorId: author.id, image: image || '', text: String(text || '').trim(),
    bg: bg || 'sunset', visibility: audience.visibility, audienceIds: audience.audienceIds,
    views: [], createdAt: Date.now()
  };
  if (!story.text && !story.image) throw new Error('Add a photo or some text to your story first.');
  if (live) {
    const storyId = genId('story');
    await sbInsert('stories', { id: storyId, ...story });
    // Mirror the confirmed story at once (see localEchoStories):
    // the stories rail renders from the mirror, and the realtime
    // refetch can lag minutes behind the success toast — the
    // creator's own rail kept saying "No stories yet" while other
    // users already saw the story.
    localEchoStories = [{ id: storyId, ...story }, ...localEchoStories];
    if (remergeStories) remergeStories(); else emitData();
    return { id: storyId, ...story };
  }
  const full = { id: genId('story'), ...story };
  mutate((s) => { (s.stories = s.stories || []).unshift(full); });
  return full;
}

// Records that the signed-in user has seen a story. Authors never count
// as viewers of their own stories, and repeat views are no-ops. In live
// mode this is the views-only update the stories rule allows.
export async function markStoryViewed(storyId) {
  const user = me(); if (!user) return;
  const story = (data().stories || []).find((s) => s.id === storyId);
  if (!story || story.authorId === user.id || (story.views || []).includes(user.id)) return;
  if (live) { await sbUpdate('stories', storyId, { views: [...(story.views || []), user.id] }); return; }
  mutate((s) => {
    const st = (s.stories || []).find((x) => x.id === storyId);
    if (st && !(st.views || []).includes(user.id)) st.views = [...(st.views || []), user.id];
  });
}

export async function deleteStory(storyId) {
  if (live) { await sbDelete('stories', storyId); return; }
  mutate((s) => { s.stories = (s.stories || []).filter((x) => x.id !== storyId); });
}

// -------------------------------------------------------------------------
// GROUPS
// -------------------------------------------------------------------------
export async function createGroup({ name, description, privacy, cover }) {
  const user = me(); if (!user) throw new Error('Sign in to create a group.');
  const group = normaliseGroup({ name, description, privacy, cover }, user.id);
  if (!group.name) throw new Error('Give your group a name.');
  if (live) {
    const groupId = genId('g');
    await sbInsert('groups', { id: groupId, ...group });
    // Mirror the confirmed group at once (see localEchoGroups):
    // the group page and the Groups list render from the mirror,
    // and the realtime refetch can lag minutes behind the success
    // toast — the creator navigated straight to "This group could
    // not be found."
    localEchoGroups = [{ id: groupId, ...group }, ...localEchoGroups];
    if (remergeGroups) remergeGroups(); else emitData();
    return { id: groupId, ...group };
  }
  const full = { id: genId('g'), ...group };
  mutate((s) => { (s.groups = s.groups || []).unshift(full); });
  return full;
}

export async function updateGroup(groupId, patch) {
  if (live) { await sbUpdate('groups', groupId, patch); return { id: groupId, ...patch }; }
  let updated = null;
  mutate((s) => {
    const g = (s.groups || []).find((x) => x.id === groupId);
    if (g) { Object.assign(g, patch); updated = g; }
  });
  return updated;
}

export async function deleteGroup(groupId) {
  if (live) {
    // Remove the group's posts first so no orphaned group posts remain.
    // Per-doc catch: the posts delete rule is author-or-admin, so a
    // non-admin creator cannot delete OTHER members' posts — one such
    // post used to abort the whole delete halfway (some posts gone,
    // group still there). Now every deletable post goes, the group doc
    // is deleted, and any undeletable posts become unreachable orphans
    // (their group no longer exists, so no surface renders them).
    const rows = await sbSelect('posts', (q) => q.eq('groupId', groupId));
    for (const d of rows) { try { await sbDelete('posts', d.id); } catch { /* foreign post — see note above */ } }
    await sbDelete('groups', groupId);
    return true;
  }
  mutate((s) => {
    s.groups = (s.groups || []).filter((g) => g.id !== groupId);
    s.posts = s.posts.filter((p) => p.groupId !== groupId);
  });
  return true;
}

// Join/leave a group. PUBLIC groups: instant membership toggle, as
// before. PRIVATE groups: joining now goes through the approval queue —
// a `groupRequests` doc ({groupId, groupOwnerId, userId, status}) is
// created instead of instant membership, and the group creator approves
// or rejects it (respondGroupRequest). Toggling again while a request is
// pending withdraws it. Returns 'joined' | 'left' | 'requested' |
// 'withdrawn' so the UI can toast accurately.
export async function toggleGroupMembership(groupId) {
  const user = me(); if (!user) throw new Error('Sign in to join groups.');
  const group = (data().groups || []).find((g) => g.id === groupId);
  if (!group) throw new Error('Group not found.');
  const isMember = (group.members || []).includes(user.id);
  if (group.createdBy === user.id) {
    if (!isMember) return 'joined'; // the creator always counts as a member
    throw new Error('Group creators cannot leave their own group — delete the group instead.');
  }
  if (!isMember && group.privacy === 'private') {
    const pending = (data().groupRequests || []).find((r) => r.groupId === groupId && r.userId === user.id && r.status === 'pending');
    const requestId = `${groupId}_${user.id}`;
    if (pending) {
      // Withdraw the pending request.
      if (live) { await sbDelete('groupRequests', requestId); return 'withdrawn'; }
      mutate((s) => { s.groupRequests = (s.groupRequests || []).filter((r) => r.id !== requestId); });
      return 'withdrawn';
    }
    // groupOwnerId is denormalized onto the request so the creator's
    // queue listener + read rule stay provable (no join to the group).
    // groupAdminId is stored alongside groupOwnerId (the schema keeps
    // both spellings; the RLS insert check keys off groupAdminId).
    const request = { groupId, groupOwnerId: group.createdBy, groupAdminId: group.createdBy, userId: user.id, status: 'pending', createdAt: Date.now() };
    if (live) {
      await sbUpsert('groupRequests', { id: requestId, ...request });
      await createNotification({ userId: group.createdBy, type: 'group_request', actorId: user.id, text: `${user.name} asked to join your private group "${group.name}".`, postId: '', conversationId: '', groupId: group.id, read: false, createdAt: Date.now() });
      return 'requested';
    }
    mutate((s) => {
      s.groupRequests = (s.groupRequests || []).filter((r) => r.id !== requestId);
      s.groupRequests.unshift({ id: requestId, ...request });
      notify(group.createdBy, 'group_request', user.id, `${user.name} asked to join your private group "${group.name}".`);
    });
    return 'requested';
  }
  if (live) {
    await sbUpdate('groups', groupId, { members: isMember ? (group.members || []).filter((m) => m !== user.id) : [...(group.members || []), user.id] });
    if (!isMember) await createNotification({ userId: group.createdBy, type: 'group_join', actorId: user.id, text: `${user.name} joined your group "${group.name}".`, postId: '', conversationId: '', groupId: group.id, read: false, createdAt: Date.now() });
    return isMember ? 'left' : 'joined';
  }
  let result = 'left';
  mutate((s) => {
    const g = (s.groups || []).find((x) => x.id === groupId);
    if (!g) return;
    g.members = g.members || [];
    const i = g.members.indexOf(user.id);
    if (i >= 0) g.members.splice(i, 1);
    else { g.members.push(user.id); result = 'joined'; notify(group.createdBy, 'group_join', user.id, `${user.name} joined your group "${group.name}".`); }
  });
  return result;
}

// Creator decision on a pending join request. Approving adds the user to
// group.members through the normal members update (creator branch of the
// groups rule) and marks the request approved; rejecting just marks it.
export async function respondGroupRequest(requestId, approve) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const request = (data().groupRequests || []).find((r) => r.id === requestId);
  if (!request) throw new Error('Request not found.');
  const group = (data().groups || []).find((g) => g.id === request.groupId);
  if (!group || group.createdBy !== user.id) throw new Error('Only the group creator can review join requests.');
  if (request.status !== 'pending') return request.status;
  const status = approve ? 'approved' : 'rejected';
  if (live) {
    if (approve) await sbUpdate('groups', group.id, { members: [...new Set([...(group.members || []), request.userId])] });
    await sbUpdate('groupRequests', requestId, { status });
    await createNotification({ userId: request.userId, type: 'group_request_result', actorId: user.id, text: approve ? `Your request to join "${group.name}" was approved.` : `Your request to join "${group.name}" was declined.`, postId: '', conversationId: '', groupId: group.id, read: false, createdAt: Date.now() });
    return status;
  }
  mutate((s) => {
    const r = (s.groupRequests || []).find((x) => x.id === requestId);
    if (r) r.status = status;
    if (approve) {
      const g = (s.groups || []).find((x) => x.id === request.groupId);
      if (g && !(g.members || []).includes(request.userId)) g.members = [...(g.members || []), request.userId];
    }
    notify(request.userId, 'group_request_result', user.id, approve ? `Your request to join "${group.name}" was approved.` : `Your request to join "${group.name}" was declined.`);
  });
  return status;
}

export async function removeGroupMember(groupId, memberId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const group = (data().groups || []).find((g) => g.id === groupId);
  if (!group) throw new Error('Group not found.');
  if (group.createdBy !== user.id) throw new Error('Only the group creator can remove members.');
  if (memberId === group.createdBy) throw new Error('The group creator cannot be removed.');
  if (live) { await sbUpdate('groups', groupId, { members: (group.members || []).filter((m) => m !== memberId) }); return true; }
  mutate((s) => {
    const g = (s.groups || []).find((x) => x.id === groupId);
    if (g) g.members = (g.members || []).filter((m) => m !== memberId);
  });
  return true;
}

// -------------------------------------------------------------------------
// PAGES
// -------------------------------------------------------------------------
export async function createPage({ name, category, about, avatar, cover }) {
  const user = me(); if (!user) throw new Error('Sign in to create a page.');
  const page = normalisePage({ name, category, about, avatar, cover }, user.id);
  if (!page.name) throw new Error('Give your page a name.');
  if (live) {
    const pageId = genId('pg');
    await sbInsert('pages', { id: pageId, ...page });
    return { id: pageId, ...page };
  }
  const full = { id: genId('pg'), ...page };
  mutate((s) => { (s.pages = s.pages || []).unshift(full); });
  return full;
}

export async function updatePage(pageId, patch) {
  if (live) { await sbUpdate('pages', pageId, patch); return { id: pageId, ...patch }; }
  let updated = null;
  mutate((s) => {
    const p = (s.pages || []).find((x) => x.id === pageId);
    if (p) { Object.assign(p, patch); updated = p; }
  });
  return updated;
}

export async function deletePage(pageId) {
  if (live) {
    const rows = await sbSelect('posts', (q) => q.eq('pageId', pageId));
    for (const d of rows) await sbDelete('posts', d.id);
    await sbDelete('pages', pageId);
    return true;
  }
  mutate((s) => {
    s.pages = (s.pages || []).filter((p) => p.id !== pageId);
    s.posts = s.posts.filter((p) => p.pageId !== pageId);
  });
  return true;
}

export async function toggleFollowPage(pageId) {
  const user = me(); if (!user) throw new Error('Sign in to follow pages.');
  const page = (data().pages || []).find((p) => p.id === pageId);
  if (!page) throw new Error('Page not found.');
  if (page.ownerId === user.id) return true; // owners always count as following
  const following = (page.followers || []).includes(user.id);
  if (live) {
    // The followers delta is computed from the FRESH server row, not
    // the mirror: pages_update_followers pins the delta to exactly ±
    // the caller's uid against the STORED array (same hazard as
    // toggleFollow — a stale-mirror patch can be a no-op against the
    // server and return a raw 42501). The toggle decision rides the
    // server state too, so the delta is a real ±1 by construction.
    const fresh = await sbGet('pages', pageId);
    const serverFollowers = fresh?.followers || page.followers || [];
    const wasFollowing = serverFollowers.includes(user.id);
    const nextFollowers = wasFollowing ? serverFollowers.filter((id) => id !== user.id) : [...serverFollowers, user.id];
    await sbUpdate('pages', pageId, { followers: nextFollowers });
    if (!wasFollowing) {
      // Wrapped like every other notification call site: a failed
      // notification must never masquerade as a failed follow.
      try { await createNotification({ userId: page.ownerId, type: 'page_follow', actorId: user.id, text: `${user.name} started following your page "${page.name}".`, postId: '', conversationId: '', pageId: page.id, read: false, createdAt: Date.now() }); } catch { /* the follow itself already succeeded */ }
    }
    patchMirror((r) => { const mp = (r.pages || []).find((p) => p.id === pageId); if (mp) mp.followers = nextFollowers; });
    return !wasFollowing;
  }
  let nowFollowing = false;
  mutate((s) => {
    const p = (s.pages || []).find((x) => x.id === pageId);
    if (!p) return;
    p.followers = p.followers || [];
    const i = p.followers.indexOf(user.id);
    if (i >= 0) p.followers.splice(i, 1);
    else { p.followers.push(user.id); nowFollowing = true; notify(page.ownerId, 'page_follow', user.id, `${user.name} started following your page "${page.name}".`); }
  });
  return nowFollowing;
}

// Post "as" a page: only the page owner may do this (also enforced by the
// posts create rule, since authorId must be the signed-in user).
export async function createPagePost(pageId, { text, image }) {
  const user = me(); if (!user) throw new Error('Sign in to post.');
  const page = (data().pages || []).find((p) => p.id === pageId);
  if (!page) throw new Error('Page not found.');
  if (page.ownerId !== user.id) throw new Error('Only the page owner can post as this page.');
  return createPost({ text, image, visibility: 'public', pageId: page.id, pageName: page.name, pageAvatar: page.avatar || '' });
}

// -------------------------------------------------------------------------
// EVENTS
// -------------------------------------------------------------------------
export async function createEvent({ title, description, dateTime, location, cover, visibility }) {
  const user = me(); if (!user) throw new Error('Sign in to create an event.');
  // Same denormalized-audience pattern as posts: friends events snapshot
  // the creator's current friend ids into audienceIds.
  const audience = postAudience({ visibility: visibility || 'public', authorFriendIds: friendIdsFromData(user.id) });
  const event = normaliseEvent({
    title, description, dateTime, location, cover,
    visibility: audience.visibility, audienceIds: audience.audienceIds
  }, user.id);
  if (!event.title) throw new Error('Give your event a title.');
  if (!event.dateTime) throw new Error('Pick a date and time for your event.');
  if (live) {
    const eventId = genId('ev');
    await sbInsert('events', { id: eventId, ...event });
    // Mirror the confirmed event at once (see localEchoEvents) —
    // same creator-invisibility lag as groups/stories.
    localEchoEvents = [{ id: eventId, ...event }, ...localEchoEvents];
    if (remergeEvents) remergeEvents(); else emitData();
    return { id: eventId, ...event };
  }
  const full = { id: genId('ev'), ...event };
  mutate((s) => { (s.events = s.events || []).unshift(full); });
  return full;
}

export async function deleteEvent(eventId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const event = (data().events || []).find((e) => e.id === eventId);
  if (!event) throw new Error('Event not found.');
  if (event.createdBy !== user.id && !isAdmin(user)) throw new Error('Only the event creator can delete this event.');
  if (live) { await sbDelete('events', eventId); return true; }
  mutate((s) => { s.events = (s.events || []).filter((e) => e.id !== eventId); });
  return true;
}

// RSVP toggle: 'going' and 'interested' are mutually exclusive — joining
// one list removes the user from the other; toggling the active state
// clears it. The write only touches going/interested, which the events
// rule's engagement branch allows for any signed-in user.
export async function toggleEventRsvp(eventId, kind) {
  const user = me(); if (!user) throw new Error('Sign in to RSVP.');
  if (kind !== 'going' && kind !== 'interested') throw new Error('Unknown RSVP kind.');
  const event = (data().events || []).find((e) => e.id === eventId);
  if (!event) throw new Error('Event not found.');
  const other = kind === 'going' ? 'interested' : 'going';
  const active = (event[kind] || []).includes(user.id);
  const next = {
    [kind]: active ? (event[kind] || []).filter((id) => id !== user.id) : [...(event[kind] || []), user.id],
    [other]: (event[other] || []).filter((id) => id !== user.id)
  };
  if (live) {
    await sbUpdate('events', eventId, next);
    if (!active && event.createdBy !== user.id) {
      await createNotification({ userId: event.createdBy, type: 'event_rsvp', actorId: user.id, text: `${user.name} is ${kind === 'going' ? 'going to' : 'interested in'} your event "${event.title}".`, postId: '', conversationId: '', eventId: event.id, read: false, createdAt: Date.now() });
    }
    return !active;
  }
  mutate((s) => {
    const e = (s.events || []).find((x) => x.id === eventId);
    if (!e) return;
    e[kind] = next[kind];
    e[other] = next[other];
    if (!active) notify(event.createdBy, 'event_rsvp', user.id, `${user.name} is ${kind === 'going' ? 'going to' : 'interested in'} your event "${event.title}".`);
  });
  return !active;
}

// -------------------------------------------------------------------------
// PAGE REVIEWS (one review per user per page; owners cannot review their
// own page)
// -------------------------------------------------------------------------
export async function saveReview(pageId, { rating, text }) {
  const user = me(); if (!user) throw new Error('Sign in to write a review.');
  const page = (data().pages || []).find((p) => p.id === pageId);
  if (!page) throw new Error('Page not found.');
  if (page.ownerId === user.id) throw new Error('You cannot review your own page.');
  const value = Math.round(Number(rating) || 0);
  if (value < 1 || value > 5) throw new Error('Pick a star rating between 1 and 5.');
  const existing = (data().reviews || []).find((r) => r.pageId === pageId && r.authorId === user.id);
  const review = { pageId, authorId: user.id, rating: value, text: String(text || '').trim().slice(0, 500), createdAt: existing?.createdAt || Date.now() };
  if (live) {
    if (existing) { await sbUpdate('reviews', existing.id, { rating: review.rating, text: review.text }); return { id: existing.id, ...review }; }
    const reviewId = genId('rev');
    await sbInsert('reviews', { id: reviewId, ...review });
    return { id: reviewId, ...review };
  }
  let saved = null;
  mutate((s) => {
    s.reviews = s.reviews || [];
    if (existing) {
      const r = s.reviews.find((x) => x.id === existing.id);
      if (r) { r.rating = review.rating; r.text = review.text; saved = r; }
    } else {
      saved = { id: genId('rev'), ...review };
      s.reviews.unshift(saved);
    }
  });
  return saved;
}

export async function deleteReview(reviewId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const review = (data().reviews || []).find((r) => r.id === reviewId);
  if (!review) throw new Error('Review not found.');
  if (review.authorId !== user.id && !isAdmin(user)) throw new Error('You can only delete your own review.');
  if (live) { await sbDelete('reviews', reviewId); return true; }
  mutate((s) => { s.reviews = (s.reviews || []).filter((r) => r.id !== reviewId); });
  return true;
}

// -------------------------------------------------------------------------
// FRIENDS / FOLLOWS / BLOCKS
// -------------------------------------------------------------------------
export function relationship(viewerId, otherId) {
  const d = data();
  const f = d.friendships.find((x) => (x.from === viewerId && x.to === otherId) || (x.from === otherId && x.to === viewerId));
  return f || null;
}

export async function sendFriendRequest(toId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  if (live) {
    // Guard (mirrors the demo branch): if ANY friendship already links
    // the pair — friends, or a request already pending in either
    // direction — do nothing. Without this, every repeated tap wrote
    // another identical friend_request notification document.
    const existing = data().friendships.find((f) => (f.from === user.id && f.to === toId) || (f.from === toId && f.to === user.id));
    if (existing) return;
    // Deterministic doc id ({from}_{to}) so firestore.rules can verify a
    // friendship with a single exists() check for friends-only posts.
    const row = { id: `${user.id}_${toId}`, from: user.id, to: toId, status: 'pending', createdAt: Date.now() };
    await sbUpsert('friendships', row);
    // Mirror the confirmed write at once: the profile button reads
    // relationship() from the mirror, and the realtime refetch can
    // lag far behind — without this the button stayed on "Add
    // Friend" until a full reload even though the request had sent.
    patchMirror((r) => {
      const i = r.friendships.findIndex((f) => f.id === row.id);
      if (i >= 0) r.friendships[i] = { ...r.friendships[i], ...row }; else r.friendships.push(row);
    });
    await createNotification({ userId: toId, type: 'friend_request', actorId: user.id, text: `${user.name} sent you a friend request.`, postId: '', conversationId: '', read: false, createdAt: Date.now() });
    return;
  }
  mutate((s) => {
    if (s.friendships.some((f) => (f.from === user.id && f.to === toId) || (f.from === toId && f.to === user.id))) return;
    s.friendships.push({ id: genId('f'), from: user.id, to: toId, status: 'pending', createdAt: Date.now() });
    notify(toId, 'friend_request', user.id, `${user.name} sent you a friend request.`);
  });
}

export async function respondFriendRequest(friendshipId, accept) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  // Only the RECIPIENT may accept (or decline) a request. The sender
  // flipping their own request to "accepted" would bypass consent —
  // the rules pin the same thing, this check gives a clean error.
  const rel = data().friendships.find((x) => x.id === friendshipId);
  if (accept && rel && rel.to !== user.id && !isAdminRole(user)) {
    throw new Error('Only the person who received this request can accept it.');
  }
  if (live) {
    if (accept) {
      if (rel && rel.status === 'accepted') { /* already friends — nothing to write */ }
      else if (rel && rel.to !== user.id) {
        // Staff accepting on someone else's behalf rides the
        // friendships_update_admin policy.
        await sbUpdate('friendships', friendshipId, { status: 'accepted' });
      } else {
        // The recipient path: RLS deliberately gives friendships NO
        // recipient UPDATE policy — the accept_friendship() RPC flips
        // the row after validating recipient + pending server-side.
        await sbRpc('accept_friendship', { p_friendship_id: friendshipId });
      }
      // The sender deserves to hear it — live mode never sent this
      // notification (only the demo branch did), so accepted requests
      // used to vanish silently for the person who sent them.
      if (rel && rel.from && rel.from !== user.id) {
        try { await createNotification({ userId: rel.from, type: 'friend_accept', actorId: user.id, text: `${user.name} accepted your friend request.`, postId: '', conversationId: '', read: false, createdAt: Date.now() }); } catch { /* the accept itself already succeeded */ }
      }
      // Mirror the accept at once (see sendFriendRequest): the
      // Friends page and profile buttons read the mirror, and the
      // realtime refetch can lag far behind the tap.
      patchMirror((r) => { const f = r.friendships.find((x) => x.id === friendshipId); if (f) f.status = 'accepted'; });
    }
    else {
      await sbDelete('friendships', friendshipId);
      patchMirror((r) => { r.friendships = r.friendships.filter((x) => x.id !== friendshipId); });
    }
    return;
  }
  mutate((s) => {
    const f = s.friendships.find((x) => x.id === friendshipId);
    if (!f) return;
    if (accept) { f.status = 'accepted'; notify(f.from, 'friend_accept', me()?.id, `${me()?.name} accepted your friend request.`); }
    else s.friendships = s.friendships.filter((x) => x.id !== friendshipId);
  });
}

export async function removeFriendship(friendshipId) {
  if (live) {
    await sbDelete('friendships', friendshipId);
    // Mirror the delete at once (see sendFriendRequest) so the
    // "Request sent" / Friends UI updates without a reload.
    patchMirror((r) => { r.friendships = r.friendships.filter((x) => x.id !== friendshipId); });
    return;
  }
  mutate((s) => { s.friendships = s.friendships.filter((x) => x.id !== friendshipId); });
}

// Cancel a pending OUTGOING friend request (Friends page "Requests sent"
// and the profile "Request sent" button). The write is the same delete
// as removeFriendship — kept as its own entry point for those call sites.
export async function cancelFriendRequest(friendshipId) {
  return removeFriendship(friendshipId);
}

export async function toggleFollow(targetId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const following = (user.following || []).includes(targetId);
  if (live) {
    const target = data().users.find((u) => u.id === targetId);
    // Both writes are computed from FRESH server rows, never the
    // local mirror: the users_update_followers policy accepts only a
    // followers delta of exactly ± the caller's uid against the
    // STORED array, so a patch computed from a stale mirror can be a
    // no-op against the server (a second tap before the refetch
    // lands, or a follow another session already recorded) and comes
    // back as a raw 42501 RLS error — even though the follow itself
    // had already landed, leaving the UI and the database
    // disagreeing. Reading both rows first makes each side
    // idempotent: a side is only written when it actually has to
    // change, so the toggle can never send a no-diff followers patch.
    const [freshMe, freshTarget] = await Promise.all([sbGet('users', user.id), sbGet('users', targetId)]);
    const myFollowing = freshMe?.following || user.following || [];
    const nowFollowing = !myFollowing.includes(targetId);
    const nextFollowing = nowFollowing ? [...myFollowing, targetId] : myFollowing.filter((id) => id !== targetId);
    await sbUpdate('users', user.id, { following: nextFollowing });
    // The followers write touches ANOTHER user's row — the policy
    // allows exactly this one-field delta (adding/removing only yourself).
    const serverFollowers = freshTarget?.followers || target?.followers || [];
    const hasMe = serverFollowers.includes(user.id);
    let nextFollowers = serverFollowers;
    if (nowFollowing && !hasMe) nextFollowers = [...serverFollowers, user.id];
    if (!nowFollowing && hasMe) nextFollowers = serverFollowers.filter((id) => id !== user.id);
    if (nextFollowers !== serverFollowers) await sbUpdate('users', targetId, { followers: nextFollowers });
    if (nowFollowing) {
      try { await createNotification({ userId: targetId, type: 'follow', actorId: user.id, text: `${user.name} started following you.`, postId: '', conversationId: '', read: false, createdAt: Date.now() }); } catch { /* the follow itself already succeeded */ }
    }
    // Reflect the confirmed state in the mirror at once — the button
    // and the follower count must not wait for the realtime refetch.
    patchMirror((r) => {
      const mine = r.users.find((u) => u.id === user.id);
      if (mine) mine.following = nextFollowing;
      const theirs = r.users.find((u) => u.id === targetId);
      if (theirs) theirs.followers = nextFollowers;
    });
    return nowFollowing;
  }
  mutate((s) => {
    const u = s.users.find((x) => x.id === user.id);
    const t = s.users.find((x) => x.id === targetId);
    if (!u || !t) return;
    u.following = u.following || []; t.followers = t.followers || [];
    const i = u.following.indexOf(targetId);
    if (i >= 0) { u.following.splice(i, 1); t.followers = t.followers.filter((x) => x !== user.id); }
    else { u.following.push(targetId); t.followers.push(user.id); notify(targetId, 'follow', user.id, `${user.name} started following you.`); }
  });
  return !following;
}

export async function toggleBlock(targetId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  if (live) {
    // Deterministic row id ({blocker}_{blocked}); both field spellings
    // are stored — the RLS helpers key off blockerId/blockedId, the
    // app reads by/target.
    const blockId = `${user.id}_${targetId}`;
    const existingBlock = await sbGet('blocks', blockId);
    if (existingBlock) { await sbDelete('blocks', blockId); return false; }
    await sbInsert('blocks', { id: blockId, by: user.id, target: targetId, blockerId: user.id, blockedId: targetId, createdAt: Date.now() });
    return true;
  }
  let blocked = false;
  mutate((s) => {
    const i = s.blocks.findIndex((b) => b.by === user.id && b.target === targetId);
    if (i >= 0) { s.blocks.splice(i, 1); blocked = false; }
    else { s.blocks.push({ by: user.id, target: targetId }); blocked = true; }
  });
  return blocked;
}

// Mark/unmark an accepted friend as a CLOSE friend. The list lives on the
// user document (closeFriends: [uid]); new close-friends posts snapshot it
// into audienceIds at creation time (see createPost/postAudience).
export async function toggleCloseFriend(friendId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const current = user.closeFriends || [];
  const isClose = current.includes(friendId);
  const next = isClose ? current.filter((id) => id !== friendId) : [...current, friendId];
  await updateProfile(user.id, { closeFriends: next });
  return !isClose;
}

// -------------------------------------------------------------------------
// MESSAGING
// -------------------------------------------------------------------------
export async function openConversation(otherId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  // The pair test is a SET test (exactly the two of us, either stored
  // order, never a group) — the same predicate for the local mirror,
  // the live query below and demo state.
  const isPair = (c) => Boolean(c) && !c.isGroup
    && (c.participants || []).length === 2
    && c.participants.includes(user.id) && c.participants.includes(otherId);
  const existing = data().conversations.find(isPair);
  if (existing) return existing;
  const conv = { participants: [user.id, otherId], createdAt: Date.now() };
  if (live) {
    // Idempotent get-or-create (Audit fix #2): the local mirror alone
    // is NOT a safe existence check in live mode — it only holds what
    // the listener has delivered so far, so opening a chat before the
    // first snapshot (or right after creating one in another tab, or
    // when the other side created the thread first) minted a SECOND
    // conversation row for the same pair. Ask the server directly:
    // every conversation I belong to, filtered by the pair predicate.
    const rows = await sbSelect('conversations', (q) => q.contains('participants', [user.id]));
    const found = rows
      .map((row) => normaliseTimeFields(row, ['createdAt']))
      .find(isPair);
    if (found) {
      mirrorConversation(found);
      return found;
    }
    // Create under a DETERMINISTIC id (the sorted uid pair): two
    // simultaneous opens — double-tap, two tabs, both sides at once —
    // write the SAME row instead of minting two threads. The
    // insert-if-absent upsert leaves an existing row untouched, and
    // the payload is identical either way.
    const convId = `dm_${[user.id, otherId].sort().join('_')}`;
    await sbUpsert('conversations', { id: convId, ...conv }, { onConflict: 'id', ignoreDuplicates: true });
    const created = { id: convId, ...conv };
    // Mirror it at once: until the listener delivers the server copy,
    // a second open (double-tap, another entry point) must find this
    // conversation locally instead of creating a duplicate.
    mirrorConversation(created);
    return created;
  }
  const full = { id: genId('conv'), ...conv };
  mutate((s) => { s.conversations.push(full); });
  return full;
}

// Insert a conversation into the live mirror if it is not there yet
// (openConversation's get-or-create; the snapshot listener replaces
// the mirror wholesale when it delivers, so this only bridges the
// gap until then). No-op outside live mode.
function mirrorConversation(conv) {
  if (!live || !remote || !conv?.id) return;
  if (remote.conversations.some((c) => c.id === conv.id)) return;
  remote.conversations = [...remote.conversations, conv];
  emitData();
}

// Create a GROUP conversation (3+ participants including the creator).
// Group docs carry isGroup/title/createdBy; messages work unchanged
// because they denormalize the full participants array at send time.
export async function createGroupConversation({ title, memberIds }) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const others = [...new Set((memberIds || []).filter((id) => id && id !== user.id))];
  if (others.length < 2) throw new Error('Pick at least two friends for a group chat.');
  const conv = {
    participants: [user.id, ...others], isGroup: true,
    title: String(title || '').trim().slice(0, 60) || 'Group chat',
    createdBy: user.id, createdAt: Date.now()
  };
  if (live) {
    const convId = genId('conv');
    await sbInsert('conversations', { id: convId, ...conv });
    return { id: convId, ...conv };
  }
  const full = { id: genId('conv'), ...conv };
  mutate((s) => { s.conversations.push(full); });
  return full;
}

export async function sendMessage(conversationId, { text, image, audio = '', replyToId = '', forwarded = false, sticker = '', location = null, poll = null, file = null }) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const conv = data().conversations.find((c) => c.id === conversationId);
  // Participants are DENORMALIZED onto the message: the messages read
  // rule and the live listener filter on this array, because a get() join
  // to the conversation document is not provable for list queries.
  // `audio` is a base64 data URL for voice messages (recorded client-side,
  // capped at ~60s / ~700KB by the composer before it gets here).
  const msg = { conversationId, participants: conv ? [...conv.participants] : [], senderId: user.id, text: String(text || '').trim(), image: image || '', audio: audio || '', createdAt: Date.now(), status: 'sent', readBy: [user.id] };
  if (forwarded) msg.forwarded = true;
  // Fun Pack payloads: a sticker (one big emoji), a shared location
  // pin, or a chat poll. Each is a complete message on its own.
  if (sticker) msg.sticker = String(sticker);
  if (location) msg.location = { lat: Number(location.lat), lng: Number(location.lng) };
  if (poll) msg.poll = poll;
  if (file) msg.file = { name: String(file.name || 'file').slice(0, 120), size: Number(file.size) || 0, type: String(file.type || ''), url: String(file.url || '') };
  if (!msg.text && !msg.image && !msg.audio && !msg.sticker && !msg.location && !msg.poll && !msg.file) throw new Error('Message cannot be empty.');
  // Vanish mode (Useful Pack): while the conversation's vanish flag is
  // on, new messages self-hide for everyone VANISH_TTL_MS after sending.
  if (conv?.vanish) { msg.vanish = true; msg.expiresAt = msg.createdAt + VANISH_TTL_MS; }
  // @mentions in group chats: resolve @usernames in the text against
  // the participant list; mentioned members get a mention notification.
  if (conv?.isGroup && msg.text) {
    const handles = extractMentions(msg.text);
    if (handles.length) {
      const usersByIdMap = Object.fromEntries(data().users.map((u) => [u.id, u]));
      const mentioned = (conv.participants || []).filter((pid) => pid !== user.id && handles.includes(String(usersByIdMap[pid]?.username || '').toLowerCase()));
      if (mentioned.length) msg.mentions = mentioned;
    }
  }
  // Reply/quote (Chat Pack): snapshot the quoted message onto the new
  // one — its id, its author's name and a ≤120-char snippet — but only
  // when the original really belongs to this conversation.
  if (replyToId) {
    const original = data().messages.find((m) => m.id === replyToId && m.conversationId === conversationId);
    const snap = original ? replySnapshot(original, data().users.find((u) => u.id === original.senderId)?.name || '') : null;
    if (snap) Object.assign(msg, snap);
  }
  const others = (conv?.participants || []).filter((p) => p !== user.id);
  const noteText = msg.sticker ? `${user.name} sent you a sticker.`
    : msg.location ? `${user.name} shared their location with you.`
    : msg.poll ? `${user.name} created a poll in your chat.`
    : msg.file ? `${user.name} sent you a file.`
    : msg.audio && !msg.text ? `${user.name} sent you a voice message.` : `${user.name} sent you a message.`;
  const noteFor = (other) => msg.mentions?.includes(other)
    ? { type: 'mention', text: `${user.name} mentioned you in ${conv?.title || 'a group chat'}.` }
    : { type: 'message', text: noteText };
  // Replying to a message request accepts it (Messenger behaviour).
  const acceptIfRequest = async () => {
    if (conv && !conv.isGroup && !(conv.acceptedBy || []).includes(user.id)) {
      try { await patchConversationFields(conversationId, { acceptedBy: [...(conv.acceptedBy || []), user.id] }, ['acceptedBy']); } catch { /* best effort */ }
    }
  };
  if (live) {
    const msgId = genId('m');
    await sbInsert('messages', { id: msgId, ...msg });
    // Mirror my own message at once (same id the refetch will deliver):
    // the sender must see it immediately, even before realtime lands.
    if (remote && !remote.messages.some((m) => m.id === msgId)) {
      remote.messages = [...remote.messages, { id: msgId, ...msg }];
      emitData();
    }
    // Notifications are best-effort from here: the message is already
    // committed and mirrored, so a notification failure must not make
    // the sender see "send failed" and resend a duplicate.
    for (const other of others) {
      const n = noteFor(other);
      try { await createNotification({ userId: other, type: n.type, actorId: user.id, text: n.text, postId: '', conversationId, read: false, createdAt: Date.now() }); } catch { /* message already sent */ }
    }
    await acceptIfRequest();
    return { id: msgId, ...msg };
  }
  const full = { id: genId('m'), ...msg };
  mutate((s) => {
    s.messages.push(full);
    for (const other of others) { const n = noteFor(other); notify(other, n.type, user.id, n.text, { conversationId }); }
  });
  await acceptIfRequest();
  return full;
}

export async function markConversationRead(conversationId) {
  const user = me(); if (!user) return;
  if (live) {
    const mine = data().messages.filter((m) => m.conversationId === conversationId && !m.readBy?.includes(user.id));
    for (const m of mine) await sbUpdate('messages', m.id, { readBy: [...new Set([...(m.readBy || []), user.id])], status: 'read' });
    return;
  }
  mutate((s) => {
    for (const m of s.messages) {
      if (m.conversationId === conversationId && m.senderId !== user.id) {
        m.readBy = [...new Set([...(m.readBy || []), user.id])];
        m.status = 'read';
      }
    }
  });
}

// ------------------------------------------------------- Chat Pack (chat)
// Typing heartbeat (Phase 3): typing state is a { uid: epochMs } map
// held in typingState and carried on a broadcast channel — no database
// write per heartbeat any more. The client refreshes its own entry
// while typing (throttled in main.js) and clears it on send/blur;
// readers only honour entries younger than TYPING_FRESH_MS (utils),
// so a vanished client stops "typing" within seconds. Best-effort by
// design — a failed broadcast is swallowed, never surfaced over the
// conversation itself.
export async function setTyping(conversationId, isTyping) {
  const user = me(); if (!user) return;
  const conv = data().conversations.find((c) => c.id === conversationId);
  if (!conv || !conv.participants?.includes(user.id)) return;
  const next = { ...(conv.typing || {}) };
  if (isTyping) next[user.id] = Date.now(); else delete next[user.id];
  if (live) {
    typingState.set(conversationId, next);
    patchRemoteConversation(conversationId, (c) => { c.typing = next; });
    try { typingChannel?.send({ type: 'broadcast', event: 'typing', payload: { conversationId, userId: user.id, isTyping } }); } catch { /* heartbeat — best effort */ }
    return;
  }
  mutate((s) => { const c = s.conversations.find((x) => x.id === conversationId); if (c) c.typing = next; });
}

// Message reactions (Chat Pack): toggle my uid in the message's
// reactions[emoji] list. Optimistic in live mode with rollback, exactly
// like toggleReaction for posts.
export async function toggleMessageReaction(messageId, emoji) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const msg = data().messages.find((m) => m.id === messageId);
  if (!msg) throw new Error('Message not found.');
  const prev = msg.reactions ? structuredClone(msg.reactions) : null;
  const next = toggleEmojiReaction(msg.reactions || {}, emoji, user.id);
  if (live) {
    patchRemoteMessage(messageId, (m) => { m.reactions = next; });
    try {
      await sbUpdate('messages', messageId, { reactions: next });
    } catch (err) {
      // Roll back even when there was no previous reactions object
      // (first-ever reaction): the original state is "no key at all".
      patchRemoteMessage(messageId, (m) => { if (prev) m.reactions = prev; else delete m.reactions; });
      throw err;
    }
    return next;
  }
  mutate((s) => { const m = s.messages.find((x) => x.id === messageId); if (m) m.reactions = next; });
  return next;
}

// Pin/unpin a message (Chat Pack): any participant may pin; the pin
// carries who pinned it and when, so the pinned bar/list can order by
// pinnedAt. Returns the new pinned state.
export async function togglePinMessage(messageId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const msg = data().messages.find((m) => m.id === messageId);
  if (!msg) throw new Error('Message not found.');
  const pinned = !msg.pinned;
  const patch = pinned
    ? { pinned: true, pinnedBy: user.id, pinnedAt: Date.now() }
    : { pinned: false, pinnedBy: '', pinnedAt: 0 };
  if (live) {
    const prev = { pinned: Boolean(msg.pinned), pinnedBy: msg.pinnedBy || '', pinnedAt: msg.pinnedAt || 0 };
    patchRemoteMessage(messageId, (m) => Object.assign(m, patch));
    try {
      await sbUpdate('messages', messageId, patch);
    } catch (err) {
      patchRemoteMessage(messageId, (m) => Object.assign(m, prev));
      throw err;
    }
    return pinned;
  }
  mutate((s) => { const m = s.messages.find((x) => x.id === messageId); if (m) Object.assign(m, patch); });
  return pinned;
}

// Chat theme (Chat Pack): stored on the conversation doc so every
// participant sees the same theme. Unknown ids resolve to 'default'.
export async function setConversationTheme(conversationId, themeId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const conv = data().conversations.find((c) => c.id === conversationId);
  if (!conv || !conv.participants?.includes(user.id)) throw new Error('Conversation not found.');
  const theme = chatTheme(themeId).id;
  if (live) {
    patchRemoteConversation(conversationId, (c) => { c.theme = theme; });
    try {
      await sbUpdate('conversations', conversationId, { theme });
    } catch (err) {
      patchRemoteConversation(conversationId, (c) => { c.theme = conv.theme; });
      throw err;
    }
    return theme;
  }
  mutate((s) => { const c = s.conversations.find((x) => x.id === conversationId); if (c) c.theme = theme; });
  return theme;
}

// ------------------------------------------------ Messenger Complete Pack
// Edit / unsend / hide / forward for messages, per-user conversation
// flags (archive, mute), the thread quick-emoji, and group management.
// All follow the Chat Pack pattern: optimistic mirror patch in live
// mode with rollback, plain mutate() in demo mode.

// Shared live/demo message patch with rollback for the simple cases.
async function patchMessageFields(messageId, patch, prevKeys) {
  const msg = data().messages.find((m) => m.id === messageId);
  if (!msg) throw new Error('Message not found.');
  if (live) {
    const prev = {};
    for (const k of prevKeys) prev[k] = msg[k];
    patchRemoteMessage(messageId, (m) => Object.assign(m, patch));
    try {
      await sbUpdate('messages', messageId, patch);
    } catch (err) {
      patchRemoteMessage(messageId, (m) => Object.assign(m, prev));
      throw err;
    }
    return;
  }
  mutate((s) => { const m = s.messages.find((x) => x.id === messageId); if (m) Object.assign(m, patch); });
}

// Edit my own text message inside the 15-minute window (utils guard).
export async function editMessage(messageId, newText) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const msg = data().messages.find((m) => m.id === messageId);
  if (!canEditMessage(msg, user.id)) throw new Error('This message can no longer be edited.');
  const text = String(newText || '').trim();
  if (!text) throw new Error('Message cannot be empty.');
  if (text === msg.text) return msg;
  await patchMessageFields(messageId, { text, editedAt: Date.now() }, ['text', 'editedAt']);
  return data().messages.find((m) => m.id === messageId);
}

// Unsend: remove the message for EVERYONE. The document stays as a
// tombstone (text/media cleared) so the thread keeps its shape and the
// other side sees "unsent" instead of a silent gap.
export async function unsendMessage(messageId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const msg = data().messages.find((m) => m.id === messageId);
  if (!msg) throw new Error('Message not found.');
  if (msg.senderId !== user.id) throw new Error('You can only unsend your own messages.');
  if (msg.unsent) return msg;
  await patchMessageFields(messageId,
    { unsent: true, text: '', image: '', audio: '', reactions: {}, pinned: false, pinnedBy: '', pinnedAt: 0 },
    ['unsent', 'text', 'image', 'audio', 'reactions', 'pinned', 'pinnedBy', 'pinnedAt']);
  return data().messages.find((m) => m.id === messageId);
}

// Remove for me only: the message disappears from MY view; everyone
// else still sees it. Rides the hiddenFor uid array on the message.
export async function hideMessage(messageId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const msg = data().messages.find((m) => m.id === messageId);
  if (!msg) throw new Error('Message not found.');
  const hiddenFor = [...new Set([...(msg.hiddenFor || []), user.id])];
  await patchMessageFields(messageId, { hiddenFor }, ['hiddenFor']);
}

// Forward a copy of a message into another conversation I belong to.
export async function forwardMessage(messageId, targetConversationId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const src = data().messages.find((m) => m.id === messageId);
  if (!src || src.unsent) throw new Error('Message not found.');
  const target = data().conversations.find((c) => c.id === targetConversationId);
  if (!target || !target.participants?.includes(user.id)) throw new Error('Conversation not found.');
  if (!src.text && !src.image && !src.sticker) throw new Error('Only text, photo and sticker messages can be forwarded.');
  return sendMessage(targetConversationId, { text: src.text || '', image: src.image || '', sticker: src.sticker || '', forwarded: true });
}

// Archive / mute are per-user: uid arrays on the conversation doc
// (archivedBy / mutedBy), so they follow the user across devices.
export async function setConversationFlag(conversationId, flag, on) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  if (!['archivedBy', 'mutedBy', 'pinnedBy'].includes(flag)) throw new Error('Unknown flag.');
  const conv = data().conversations.find((c) => c.id === conversationId);
  if (!conv || !conv.participants?.includes(user.id)) throw new Error('Conversation not found.');
  const next = on
    ? [...new Set([...(conv[flag] || []), user.id])]
    : (conv[flag] || []).filter((id) => id !== user.id);
  if (live) {
    const prev = conv[flag] || [];
    patchRemoteConversation(conversationId, (c) => { c[flag] = next; });
    try {
      await sbUpdate('conversations', conversationId, { [flag]: next });
    } catch (err) {
      patchRemoteConversation(conversationId, (c) => { c[flag] = prev; });
      throw err;
    }
    return next;
  }
  mutate((s) => { const c = s.conversations.find((x) => x.id === conversationId); if (c) c[flag] = next; });
  return next;
}

// The thread's quick-emoji (Facebook's 👍 button, changeable per chat).
export async function setConversationEmoji(conversationId, emoji) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const conv = data().conversations.find((c) => c.id === conversationId);
  if (!conv || !conv.participants?.includes(user.id)) throw new Error('Conversation not found.');
  const value = String(emoji || '👍').slice(0, 8);
  if (live) {
    patchRemoteConversation(conversationId, (c) => { c.emoji = value; });
    try {
      await sbUpdate('conversations', conversationId, { emoji: value });
    } catch (err) {
      patchRemoteConversation(conversationId, (c) => { c.emoji = conv.emoji; });
      throw err;
    }
    return value;
  }
  mutate((s) => { const c = s.conversations.find((x) => x.id === conversationId); if (c) c.emoji = value; });
  return value;
}

// Group management: rename, add members, remove a member, leave.
// Membership lives on the conversation doc; messages keep their
// send-time participant snapshot, so a removed member loses the
// conversation (and future messages) but the rules keep old history
// readable only through documents they already had — the conversation
// itself disappears from their list.
async function patchConversationFields(conversationId, patch, prevKeys) {
  const conv = data().conversations.find((c) => c.id === conversationId);
  if (!conv) throw new Error('Conversation not found.');
  if (live) {
    const prev = {};
    for (const k of prevKeys) prev[k] = conv[k];
    patchRemoteConversation(conversationId, (c) => Object.assign(c, patch));
    try {
      await sbUpdate('conversations', conversationId, patch);
    } catch (err) {
      patchRemoteConversation(conversationId, (c) => Object.assign(c, prev));
      throw err;
    }
    return;
  }
  mutate((s) => { const c = s.conversations.find((x) => x.id === conversationId); if (c) Object.assign(c, patch); });
}

export async function voteChatPoll(messageId, optionId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const msg = data().messages.find((m) => m.id === messageId);
  if (!msg?.poll || msg.unsent) throw new Error('Poll not found.');
  const next = chatPollVote(msg.poll, optionId, user.id);
  await patchMessageFields(messageId, { poll: next }, ['poll']);
  return next;
}

// Nicknames live on the conversation doc (nicknames: { uid: name });
// any participant may set one for anyone in the chat, Messenger-style.
export async function setNickname(conversationId, userId, nickname) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const conv = data().conversations.find((c) => c.id === conversationId);
  if (!conv?.participants?.includes(user.id) || !conv.participants?.includes(userId)) throw new Error('Conversation not found.');
  const next = { ...(conv.nicknames || {}) };
  const clean = String(nickname || '').trim().slice(0, 40);
  if (clean) next[userId] = clean; else delete next[userId];
  await patchConversationFields(conversationId, { nicknames: next }, ['nicknames']);
  return next;
}

// ------------------------------------------------------- Useful Pack
// Message requests: accepting adds me to the conversation's
// acceptedBy; replying accepts automatically (inside sendMessage).
export async function acceptConversationRequest(conversationId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const conv = data().conversations.find((c) => c.id === conversationId);
  if (!conv?.participants?.includes(user.id)) throw new Error('Conversation not found.');
  if ((conv.acceptedBy || []).includes(user.id)) return conv.acceptedBy;
  const next = [...(conv.acceptedBy || []), user.id];
  await patchConversationFields(conversationId, { acceptedBy: next }, ['acceptedBy']);
  return next;
}

// Vanish mode toggle — a plain conversation flag any participant can
// flip; sendMessage stamps expiresAt on messages sent while it is on.
export async function setConversationVanish(conversationId, on) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const conv = data().conversations.find((c) => c.id === conversationId);
  if (!conv?.participants?.includes(user.id)) throw new Error('Conversation not found.');
  await patchConversationFields(conversationId, { vanish: Boolean(on) }, ['vanish']);
  return Boolean(on);
}

// Timed mute: durationMs null = unmute, Infinity = mute forever,
// otherwise mute until Date.now() + durationMs.
export async function setConversationMute(conversationId, durationMs) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const conv = data().conversations.find((c) => c.id === conversationId);
  if (!conv?.participants?.includes(user.id)) throw new Error('Conversation not found.');
  const mutedBy = new Set(conv.mutedBy || []);
  const mutedUntil = { ...(conv.mutedUntil || {}) };
  if (durationMs === null) { mutedBy.delete(user.id); delete mutedUntil[user.id]; }
  else {
    mutedBy.add(user.id);
    if (Number.isFinite(durationMs)) mutedUntil[user.id] = Date.now() + durationMs; else delete mutedUntil[user.id];
  }
  await patchConversationFields(conversationId, { mutedBy: [...mutedBy], mutedUntil }, ['mutedBy', 'mutedUntil']);
  return { mutedBy: [...mutedBy], mutedUntil };
}

// Chat file attachments: Cloudinary `auto` upload (verified against
// the free unsigned preset), with the small-file data-URL fallback the
// photo pipeline used before Cloudinary. Hard cap 10 MB.
export async function uploadMessageFile(file) {
  if (!file) throw new Error('No file selected.');
  if (file.size > 10 * 1024 * 1024) throw new Error('That file is over the 10 MB chat limit.');
  const meta = { name: file.name || 'file', size: file.size, type: file.type || '' };
  if (isCloudinaryConfigured()) {
    try { return { ...meta, url: await uploadFileToCloudinary(file) }; } catch { /* fall through to the fallback */ }
  }
  if (file.size <= 700 * 1024) {
    const url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
    return { ...meta, url };
  }
  throw new Error('That file could not be uploaded — it is too large for the free fallback.');
}

// Group invite links: the code is the id of an `invites` row pointing
// at the conversation; joining rides the join_via_invite() RPC, which
// validates the code and adds only the caller (see the note in
// joinConversationByCode for why a plain RLS update cannot do this).
export async function createConversationInvite(conversationId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const conv = data().conversations.find((c) => c.id === conversationId);
  if (!conv?.isGroup || !conv.participants?.includes(user.id)) throw new Error('Conversation not found.');
  if (conv.joinCode) return conv.joinCode;
  const code = genId('inv');
  if (live) {
    await sbInsert('invites', { id: code, conversationId, createdBy: user.id, createdAt: Date.now() });
    patchRemoteConversation(conversationId, (c) => { c.joinCode = code; });
    try {
      await sbUpdate('conversations', conversationId, { joinCode: code });
    } catch (err) {
      // Roll the mirror back and drop the invite row: a mirror that
      // KEEPS the code would make every retry return this same link
      // forever, and an orphaned invite would outlive the failed
      // pairing — a retry mints a fresh, consistent pair instead.
      patchRemoteConversation(conversationId, (c) => { c.joinCode = ''; });
      try { await sbDelete('invites', code); } catch { /* best-effort */ }
      throw err;
    }
    return code;
  }
  mutate((s) => { const c = s.conversations.find((x) => x.id === conversationId); if (c) c.joinCode = code; });
  return code;
}

export async function joinConversationByCode(code) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const clean = String(code || '').trim();
  if (!clean) throw new Error('That invite link is not valid.');
  if (live) {
    // The applied RLS self-join policy cannot work for a
    // non-participant (RLS filters the policy's own subqueries, so
    // its pin comparisons read null), so joining rides the SECURITY
    // DEFINER join_via_invite() RPC: it validates the code, appends
    // ONLY the caller, and returns the conversation id — being
    // already a member is a no-op success there too, exactly like
    // the branch this replaces.
    try {
      return await sbRpc('join_via_invite', { p_code: clean });
    } catch (err) {
      if (/invite code not found|conversation not found/i.test(String(err?.message || ''))) {
        throw new Error('That invite link is not valid.');
      }
      throw err;
    }
  }
  const conv = data().conversations.find((c) => c.joinCode === clean);
  if (!conv) throw new Error('That invite link is not valid.');
  if (!conv.participants.includes(user.id)) {
    mutate((s) => { const c = s.conversations.find((x) => x.id === conv.id); if (c) c.participants = [...c.participants, user.id]; });
  }
  return conv.id;
}

export async function renameGroupConversation(conversationId, title) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const conv = data().conversations.find((c) => c.id === conversationId);
  if (!conv?.isGroup || !conv.participants?.includes(user.id)) throw new Error('Conversation not found.');
  const next = String(title || '').trim().slice(0, 60);
  if (!next) throw new Error('Group name cannot be empty.');
  await patchConversationFields(conversationId, { title: next }, ['title']);
  return next;
}

export async function addGroupMembers(conversationId, memberIds) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const conv = data().conversations.find((c) => c.id === conversationId);
  if (!conv?.isGroup || !conv.participants?.includes(user.id)) throw new Error('Conversation not found.');
  const next = [...new Set([...conv.participants, ...(memberIds || [])])];
  if (next.length === conv.participants.length) return conv.participants;
  await patchConversationFields(conversationId, { participants: next }, ['participants']);
  return next;
}

export async function removeGroupChatMember(conversationId, memberId) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const conv = data().conversations.find((c) => c.id === conversationId);
  if (!conv?.isGroup || !conv.participants?.includes(user.id)) throw new Error('Conversation not found.');
  const isSelf = memberId === user.id;
  const canRemove = isSelf || conv.createdBy === user.id || isAdminRole(user);
  if (!canRemove) throw new Error('Only the group creator can remove members.');
  const next = conv.participants.filter((id) => id !== memberId);
  if (next.length < 2) throw new Error('A group needs at least two members.');
  await patchConversationFields(conversationId, { participants: next }, ['participants']);
  return next;
}

export async function leaveGroupConversation(conversationId) {
  return removeGroupChatMember(conversationId, me()?.id || '');
}

// -------------------------------------------------------------------------
// NOTIFICATIONS
// -------------------------------------------------------------------------
export async function markAllNotificationsRead() {
  const user = me(); if (!user) return;
  if (live) {
    const mine = data().notifications.filter((n) => n.userId === user.id && !n.read);
    // Patch the mirror first so the badge clears in ONE click — waiting
    // for each update's snapshot round-trip left stale unread counts
    // behind (audit 2026-11-20: badge went 5 → 1 on the first click).
    // The listener confirms with server truth on its next snapshot.
    if (remote) {
      for (const n of remote.notifications) if (n.userId === user.id) n.read = true;
      emitData();
    }
    await Promise.all(mine.map((n) => sbUpdate('notifications', n.id, { read: true })));
    return;
  }
  mutate((s) => { for (const n of s.notifications) if (n.userId === user.id) n.read = true; });
}

export async function markNotificationRead(id) {
  if (live) {
    if (remote) {
      const n = remote.notifications.find((x) => x.id === id);
      if (n && !n.read) { n.read = true; emitData(); }
    }
    await sbUpdate('notifications', id, { read: true });
    return;
  }
  mutate((s) => { const n = s.notifications.find((x) => x.id === id); if (n) n.read = true; });
}

// -------------------------------------------------------------------------
// ADMIN
// -------------------------------------------------------------------------
// PLATFORM AGGREGATES (Pack B): the mirrored dataset only holds the
// signed-in user's own messages and a subset of posts, so Overview
// totals that must be platform-wide come from one-shot server queries
// — head-count queries for posts/messages, plus a bounded posts scan
// (newest 500) for the comments/likes sums. Staff-only: the load is
// gated on utils.isStaff(me()) and each query settles independently,
// so a tier that may not read a collection (e.g. an analyst scanning
// posts) simply falls back to mirror numbers for that metric —
// utils.platformStats flags the source per metric and the UI labels
// fallbacks "from loaded data". Nothing is ever estimated.
const ADMIN_STATS_POST_SCAN = 500;
let adminStatsLoadedFor = '';
export async function loadAdminStats() {
  if (!live) return null;
  const user = me();
  if (!user || !isStaff(user)) return null;
  if (adminStatsLoadedFor === user.id && remote?.adminStats) return remote.adminStats;
  adminStatsLoadedFor = user.id;
  const settle = async (p) => { try { return await p; } catch { return null; } };
  const [postsCount, messagesCount, postsRows] = await Promise.all([
    settle(sbCount('posts')),
    settle(sbCount('messages')),
    settle(sbSelect('posts', (q) => q.order('createdAt', { ascending: false }).limit(ADMIN_STATS_POST_SCAN)))
  ]);
  let commentsTotal = null;
  let likesTotal = null;
  if (postsRows) {
    commentsTotal = 0;
    likesTotal = 0;
    for (const p of postsRows) {
      commentsTotal += countPostComments(p);
      likesTotal += (p.likes || []).length;
    }
  }
  const stats = {
    postsTotal: postsCount ?? null,
    messagesTotal: messagesCount ?? null,
    commentsTotal,
    likesTotal,
    scannedPosts: postsRows ? postsRows.length : 0,
    loadedAt: Date.now()
  };
  if (!remote) return stats;
  remote.adminStats = stats;
  document.dispatchEvent(new CustomEvent('meetbook:data'));
  return stats;
}


// AUDIT LOG (Pack A): every privileged admin mutation in this module —
// and in later Super Admin packs — records what happened through
// logAdminAction(). Entries land in the adminLogs collection
// { adminId, adminName, action, targetType, targetId, targetLabel,
// reason, createdAt }: readable by admins/superadmins only, append-only
// (rules), deletable by superadmins. The write is best-effort in live
// mode: a failed audit write must never mask the action's own outcome,
// but in demo mode it is part of the same atomic mutation.
//   target: { type: 'user'|'post'|'report'|'config'|…, id, label }
export async function logAdminAction(action, target = {}, reason = '') {
  const actor = me();
  if (!actor) return null;
  const entry = {
    adminId: actor.id,
    adminName: actor.name || '',
    action: String(action || ''),
    targetType: String(target.type || ''),
    targetId: String(target.id || ''),
    targetLabel: String(target.label || ''),
    reason: String(reason || ''),
    createdAt: Date.now()
  };
  if (live) {
    try {
      const entryId = genId('alog');
      await sbInsert('adminLogs', { id: entryId, ...entry });
      return { id: entryId, ...entry };
    } catch { return null; /* audit is best-effort live; the action already happened */ }
  }
  let saved = null;
  mutate((s) => {
    if (!Array.isArray(s.adminLogs)) s.adminLogs = [];
    saved = { id: genId('alog'), ...entry };
    s.adminLogs.unshift(saved);
  });
  return saved;
}

// Shared guard for user-management actions. Throws a clear error when
// the signed-in actor may not manage the target at all; the specific
// gates (superadmin-only, self-protection, superadmin protection, bots
// excluded) live in utils.canManageUser / utils.canChangeRole so the UI
// hides exactly what the API would refuse.
function requireUserManager(userId, { superOnly = false } = {}) {
  const actor = me();
  if (!actor) throw new Error('Sign in first.');
  const target = data().users.find((u) => u.id === userId);
  if (!target) throw new Error('User not found.');
  const allowed = superOnly ? canChangeRole(actor, target) : canManageUser(actor, target);
  if (!allowed) {
    if (target.isBot) throw new Error('Bot accounts are managed in the Bot panel.');
    if (actor.id === target.id) throw new Error('You cannot manage your own account.');
    if (target.role === 'superadmin') throw new Error('Super admin accounts cannot be managed.');
    if (superOnly) throw new Error('Only super admins can do that.');
    throw new Error('Admins only.');
  }
  return { actor, target };
}

async function writeUserPatch(userId, patch) {
  if (live) { await sbUpdate('users', userId, patch); return; }
  mutate((s) => { const u = s.users.find((x) => x.id === userId); if (u) Object.assign(u, patch); });
}

// Change a user's role. SUPERADMIN ONLY (the Firestore users rule pins
// role changes to superadmins as well) — plain admins can no longer
// grant or revoke roles. Logged as 'set-role'.
export async function adminSetRole(userId, role, reason = '') {
  const { target } = requireUserManager(userId, { superOnly: true });
  if (!ASSIGNABLE_ROLES.includes(role)) throw new Error('Unknown role.');
  await writeUserPatch(userId, { role });
  await logAdminAction('set-role', { type: 'user', id: userId, label: `${target.name} → ${role}` }, reason);
}

// Suspend / ban / restore a user (status: 'suspended' | 'banned' |
// 'active'). Enforcement is real: the Firestore create rules refuse new
// content from non-active writers (writerStatusOk) and the client shows
// a full-screen status notice instead of the app. Logged with the
// caller-supplied action label ('suspend-user', 'ban-user', …).
export async function adminSetUserStatus(userId, status, reason = '', action = '') {
  const { target } = requireUserManager(userId);
  if (!['active', 'suspended', 'banned'].includes(status)) throw new Error('Unknown account status.');
  await writeUserPatch(userId, { status });
  await logAdminAction(action || `set-status-${status}`, { type: 'user', id: userId, label: target.name }, reason);
}

// Toggle the verified flag (users.verified). The ✓ badge renders
// app-wide from userNameHtml. Logged as 'verify-user'/'unverify-user'.
export async function adminSetVerified(userId, verified, reason = '') {
  const { target } = requireUserManager(userId);
  await writeUserPatch(userId, { verified: Boolean(verified) });
  await logAdminAction(verified ? 'verify-user' : 'unverify-user', { type: 'user', id: userId, label: target.name }, reason);
}

// Delete a user account (SUPERADMIN ONLY): removes the users doc and
// the user's own posts. NOTE: on the Spark plan the Firebase Auth
// record itself cannot be deleted from the client (that needs the
// Admin SDK / Cloud Functions), so a deleted user could still
// authenticate — but with no profile doc the app treats them as
// signed-out, and their content is gone. Logged as 'delete-user'.
export async function adminDeleteUser(userId, reason = '') {
  const { target } = requireUserManager(userId, { superOnly: true });
  if (live) {
    // Query the server DIRECTLY for the user's posts: the admin mirror
    // only holds a synced subset (public + audience + own, capped),
    // so filtering it left the deleted user's older/friends-only posts
    // orphaned in other people's feeds.
    const rows = await sbSelect('posts', (q) => q.eq('authorId', userId));
    for (const d of rows) { try { await sbDelete('posts', d.id); } catch { /* best-effort cleanup */ } }
    await sbDelete('users', userId);
  } else {
    mutate((s) => {
      s.users = s.users.filter((u) => u.id !== userId);
      s.posts = s.posts.filter((p) => p.authorId !== userId);
    });
  }
  await logAdminAction('delete-user', { type: 'user', id: userId, label: target.name }, reason);
}

// -------------------------------------------------------------------------
// CONTENT MODERATION + REPORTS CENTER (Pack B)
// -------------------------------------------------------------------------
// Delete a post as a moderator action (the Content module and report
// outcomes route here): the deletion itself is the ordinary deletePost
// path; this wrapper adds the moderator gate + the audit entry.
export async function adminDeletePost(postId, reason = '') {
  const actor = me();
  if (!actor || !canModerate(actor)) throw new Error('Moderators only.');
  const post = data().posts.find((p) => p.id === postId);
  await deletePost(postId);
  await logAdminAction('delete-post', { type: 'post', id: postId, label: truncate(post?.text || '', 60) }, reason);
}

// Delete a comment or reply as a moderator action: deleteComment already
// rebuilds the post's comments array without the entry (the posts update
// rule allows admin updates; in live mode a moderator who is neither the
// comment author nor the post author may be refused by that rule, and
// the error surfaces to the UI). Adds the gate + audit entry.
export async function adminDeleteComment(postId, commentId, reason = '') {
  const actor = me();
  if (!actor || !canModerate(actor)) throw new Error('Moderators only.');
  const post = data().posts.find((p) => p.id === postId);
  let label = '';
  for (const c of post?.comments || []) {
    if (c.id === commentId) label = c.text || '';
    for (const r of c.replies || []) if (r.id === commentId) label = r.text || '';
  }
  await deleteComment(postId, commentId);
  await logAdminAction('delete-comment', { type: 'post', id: postId, label: truncate(label, 60) }, reason);
}

// Send a moderation warning to a user through the ordinary notifications
// path (the same collection/prefs pipeline as likes and comments).
async function sendModerationWarning(userId, actor, reason) {
  const text = reason
    ? `A moderator warned you about a community-guideline violation: ${reason}`
    : 'A moderator warned you about a community-guideline violation. Please review the community guidelines.';
  if (live) {
    await createNotification({ userId, type: 'warning', actorId: actor.id, text, postId: '', conversationId: '', read: false, createdAt: Date.now() });
    return;
  }
  notify(userId, 'warning', actor.id, text);
}

// The user a report decision acts on: the reported user themselves, the
// author of a reported post, or the sender of a reported message
// (from the evidence snapshot — never by reading the conversation).
// The author stamped at creation wins: after a hard delete the target
// document is gone and derivation would return ''.
function reportTargetUserId(rep) {
  if (!rep) return '';
  if (rep.targetAuthorId) return rep.targetAuthorId;
  if (rep.targetType === 'user') return rep.targetId;
  if (rep.targetType === 'post') return data().posts.find((p) => p.id === rep.targetId)?.authorId || '';
  if (rep.targetType === 'message') return rep.evidence?.senderId || '';
  return '';
}

// Staff read the full reports mirror; ordinary users only ever hold
// their Support Inbox slice (supportReports). Decision/appeal code
// looks in both so it works for whoever is signed in.
function findReport(reportId) {
  const d = data();
  return (d.reports || []).find((r) => r.id === reportId)
    || (d.supportReports || []).find((r) => r.id === reportId)
    || null;
}

// Support Inbox doorbell: same dual-mode pattern as moderation
// warnings — live writes go through createNotification (which also
// suppresses self-notifications), demo through the store's notify().
async function sendSupportNotification(userId, actor, type, text) {
  if (!userId || userId === actor.id) return;
  if (live) {
    await createNotification({ userId, type, actorId: actor.id, text, postId: '', conversationId: '', read: false, createdAt: Date.now() });
    return;
  }
  notify(userId, type, actor.id, text);
}

async function writeReportPatch(reportId, patch) {
  if (live) { await sbUpdate('reports', reportId, patch); return; }
  mutate((s) => { const r = s.reports.find((x) => x.id === reportId); if (r) Object.assign(r, patch); });
}

// Record a moderator decision on a report. decision ∈
// 'review' | 'resolve' | 'reject' | 'escalate'; 'resolve' carries an
// outcome ∈ REPORT_OUTCOMES. Side effects run BEFORE the decision is
// saved, so a refused side effect (e.g. a moderator choosing
// 'user-suspended' — suspension is gated by canManageUser inside
// adminSetUserStatus) fails the whole decision instead of recording a
// decision that never happened. Every successful decision updates the
// report doc (status + decision record) AND writes an audit entry.
export async function adminDecideReport(reportId, decision, { reason = '', outcome = 'none' } = {}) {
  const actor = me();
  if (!actor || !canModerate(actor)) throw new Error('Moderators only.');
  const rep = findReport(reportId);
  if (!rep) throw new Error('Report not found.');
  if (!['review', 'resolve', 'reject', 'escalate'].includes(decision)) throw new Error('Unknown decision.');
  const finalOutcome = decision === 'resolve' && ['content-removed', 'user-warned', 'user-suspended'].includes(outcome) ? outcome : 'none';
  // Capture the content author BEFORE any side effect runs: a
  // 'content-removed' outcome hard-deletes the target, after which
  // the author can no longer be derived from it.
  const targetAuthorId = reportTargetUserId(rep);
  if (decision === 'resolve') {
    if (finalOutcome === 'content-removed') {
      if (rep.targetType === 'post') await deletePost(rep.targetId);
      else if (rep.targetType === 'message') {
        if (live) await sbDelete('messages', rep.targetId);
        else mutate((s) => { s.messages = s.messages.filter((m) => m.id !== rep.targetId); });
      }
    } else if (finalOutcome === 'user-warned') {
      const targetId = reportTargetUserId(rep);
      if (targetId && targetId !== actor.id) await sendModerationWarning(targetId, actor, reason);
    } else if (finalOutcome === 'user-suspended') {
      // Spec: suspension applies when the target is a user, and stays
      // behind the existing user-management guards.
      if (rep.targetType === 'user') await adminSetUserStatus(rep.targetId, 'suspended', reason, 'suspend-user');
    }
  }
  const status = { review: 'review', resolve: 'resolved', reject: 'rejected', escalate: 'escalated' }[decision];
  const record = { byId: actor.id, byName: actor.name || '', at: Date.now(), reason: String(reason || ''), outcome: finalOutcome, action: decision };
  const patch = { status, decision: record };
  // Backfill the author stamp on reports filed before it existed, so
  // the author's Support Inbox picks the decision up.
  if (targetAuthorId && !rep.targetAuthorId) patch.targetAuthorId = targetAuthorId;
  await writeReportPatch(reportId, patch);
  await logAdminAction(`report-${decision}`, { type: 'report', id: reportId, label: `${rep.targetType}: ${truncate(rep.reason || '', 60)}` }, reason);
  // Support Inbox doorbells on FINAL decisions only (review/escalate
  // are interim): the reporter always hears the outcome; the content
  // author hears it when action was taken on their content (the
  // user-warned outcome already sends its own warning notification,
  // which now routes to the Support Inbox too). Best-effort — the
  // decision itself is already saved and audited above.
  if (decision === 'resolve' || decision === 'reject') {
    const reporterText = decision === 'reject'
      ? 'We reviewed your report and found no violation of the community guidelines. Details are in your Support Inbox.'
      : finalOutcome !== 'none'
        ? 'We reviewed your report and took action. Details are in your Support Inbox.'
        : 'We reviewed your report and closed it with no further action. Details are in your Support Inbox.';
    try { await sendSupportNotification(rep.reporterId, actor, 'report_decision', reporterText); } catch { /* doorbell only */ }
    if (decision === 'resolve' && finalOutcome === 'content-removed') {
      try { await sendSupportNotification(targetAuthorId, actor, 'moderation_notice', 'A moderator removed your content after reviewing a report. See your Support Inbox for details and appeal options.'); } catch { /* doorbell only */ }
    } else if (decision === 'resolve' && finalOutcome === 'user-suspended') {
      try { await sendSupportNotification(targetAuthorId, actor, 'moderation_notice', 'Your account was suspended after a moderation review. See your Support Inbox for details and appeal options.'); } catch { /* doorbell only */ }
    }
  }
  return { status, decision: record };
}

// Set a report's appeal status ('requested' | 'accepted' | 'declined' |
// 'none'). Accepting an appeal does NOT restore removed content — the
// UI says so; restoration is a separate manual act. The user's own
// appeal text (filed from the Support Inbox) is preserved across the
// staff decision, and a user-filed appeal that gets decided rings the
// author's Support Inbox doorbell.
// GUARD (2026-11-21): an accept/decline is only meaningful against an
// appeal that was actually FILED (current status 'requested'). From
// any other state it is a safe no-op returning null — the
// guard-failure convention used across this module (cf. loadAdmin-
// Stats) — and writes NOTHING: no patch, no audit entry, no doorbell.
// A stray staff tap once set 'accepted' on a live no-action report
// with no appeal behind it. Marking 'requested' by hand stays allowed
// from 'none' (appeals received outside the app). This one function
// serves both modes — writeReportPatch branches live/demo — so the
// guard holds identically in demo mode.
export async function adminSetReportAppeal(reportId, appealStatus, reason = '') {
  const actor = me();
  if (!actor || !canModerate(actor)) throw new Error('Moderators only.');
  const rep = findReport(reportId);
  if (!rep) throw new Error('Report not found.');
  if (!['requested', 'accepted', 'declined', 'none'].includes(appealStatus)) throw new Error('Unknown appeal status.');
  if ((appealStatus === 'accepted' || appealStatus === 'declined') && rep.appeal?.status !== 'requested') return null;
  const wasUserAppeal = rep.appeal?.status === 'requested' && rep.appeal?.byId && rep.appeal.byId !== actor.id;
  const appeal = { status: appealStatus, byId: actor.id, byName: actor.name || '', at: Date.now(), reason: String(reason || ''), text: rep.appeal?.text || '' };
  await writeReportPatch(reportId, { appeal });
  await logAdminAction('report-appeal', { type: 'report', id: reportId, label: `${rep.targetType}: ${truncate(rep.reason || '', 60)}` }, reason || appealStatus);
  if (wasUserAppeal && (appealStatus === 'accepted' || appealStatus === 'declined')) {
    const text = appealStatus === 'accepted'
      ? 'Your appeal was accepted. Note: removed content is not restored automatically.'
      : 'Your appeal was reviewed and declined. Details are in your Support Inbox.';
    try { await sendSupportNotification(reportTargetUserId(rep), actor, 'appeal_decision', text); } catch { /* doorbell only */ }
  }
  return appeal;
}

// User-side appeal (Support Inbox): the author of acted-on content
// files ONE appeal against a decided report. Writes ONLY the appeal
// object — the file_appeal() RPC pins exactly that server-side.
export async function appealReport(reportId, text = '') {
  const user = me(); if (!user) throw new Error('Sign in to appeal.');
  const rep = findReport(reportId);
  if (!rep) throw new Error('Report not found.');
  if (reportTargetUserId(rep) !== user.id) throw new Error('You can only appeal decisions about your own content.');
  if (!rep.decision || !rep.decision.outcome || rep.decision.outcome === 'none') throw new Error('There is no action on your content to appeal.');
  if (rep.appeal && rep.appeal.status && rep.appeal.status !== 'none') throw new Error('You have already appealed this decision.');
  const appeal = { status: 'requested', text: String(text || '').slice(0, 500), byId: user.id, byName: user.name || '', at: Date.now(), reason: '' };
  if (live) {
    // Non-staff have NO reports UPDATE policy by design — the appeal
    // is filed through the file_appeal() RPC, which re-validates
    // caller == target author, a real decision, and a not-yet-filed
    // appeal server-side, then writes ONLY the appeal object. It
    // returns the appeal it stored (same shape as the local one).
    const filed = await sbRpc('file_appeal', { p_report_id: reportId, p_text: appeal.text });
    return filed || appeal;
  }
  await writeReportPatch(reportId, { appeal });
  return appeal;
}

export async function adminSetMaintenance(enabled) {
  if (live) { await sbUpsert('config', { id: 'app', maintenanceMode: enabled }); }
  else mutate((s) => { s.config.maintenanceMode = enabled; });
  await logAdminAction(enabled ? 'maintenance-on' : 'maintenance-off', { type: 'config', id: 'app', label: 'Maintenance mode' });
}

// -------------------------------------------------------------------------
// BOTS — admin + demo simulation
// -------------------------------------------------------------------------
// The public users/{botId} profile every bot account needs in live mode
// so it can author posts, appear in search and hold conversations. The
// users rules let an admin create exactly this shape (isBot == true,
// role 'bot'); the matching update rides the admin branch.
function botUserProfile(bot) {
  return {
    name: bot.name, username: bot.username, email: '', bio: bot.bio, avatar: bot.avatar, cover: '',
    work: '', education: '', currentCity: '', hometown: '', relationship: '', website: '', nickname: '',
    dob: '', gender: '', role: 'bot', isBot: true, botId: bot.id, online: true, lastSeen: Date.now(),
    createdAt: bot.createdAt || Date.now(), followers: [], following: [], closeFriends: [], settings: {}
  };
}

// Create the bot's users doc if missing; if it exists, only sync the
// identity fields (never clobber followers/following that accumulated).
async function ensureBotUserDoc(bot) {
  const existing = data().users.find((u) => u.id === bot.id);
  if (!existing) {
    await sbInsert('users', { id: bot.id, ...botUserProfile(bot) });
    return;
  }
  if (existing.name !== bot.name || existing.username !== bot.username || existing.avatar !== bot.avatar || existing.bio !== bot.bio) {
    await sbUpdate('users', bot.id, { name: bot.name, username: bot.username, avatar: bot.avatar, bio: bot.bio });
  }
}

export async function saveBot(bot) {
  const b = normaliseBot(bot);
  const existed = Boolean(b.id) && data().bots.some((x) => x.id === b.id);
  if (live) {
    const id = b.id || genId('bot');
    const saved = { ...b, id };
    // Postgres rows carry their id as a column (unlike Firestore doc
    // paths), so the saved bot is upserted whole, id included.
    await sbUpsert('bots', saved);
    // Preserve the REAL last-used provider/model stamps: recordBotBrain
    // maintains them after every generation, and stamping placeholder
    // values here made the Bot Center claim "template-fallback" for a
    // bot actually answering via a live provider.
    const prevBrain = data().botBrains?.[id] || {};
    await sbUpsert('botBrains', { id, botId: id, systemPrompt: saved.personality.systemPrompt, provider: prevBrain.provider || saved.provider || '', model: prevBrain.model || saved.model || '', updatedAt: Date.now() });
    // Best-effort: the live runner re-ensures the user doc every cycle,
    // so a hiccup here (e.g. rules not yet republished) must not break
    // saving the bot's configuration.
    try { await ensureBotUserDoc(saved); } catch { /* healed by the runner */ }
    await logAdminAction(existed ? 'bot-update' : 'bot-create', { type: 'bot', id, label: saved.name });
    return saved;
  }
  mutate((s) => {
    const i = s.bots.findIndex((x) => x.id === b.id);
    if (i >= 0) s.bots[i] = b; else s.bots.push(b);
    if (!s.users.some((u) => u.id === b.id)) {
      s.users.push({ id: b.id, name: b.name, username: b.username, email: '', password: '', bio: b.bio, avatar: b.avatar, cover: '', work: '', education: '', currentCity: '', hometown: '', relationship: '', website: '', nickname: '', dob: '', gender: '', role: 'bot', isBot: true, botId: b.id, online: true, createdAt: Date.now(), followers: [], following: [], closeFriends: [], settings: {} });
    } else {
      const u = s.users.find((x) => x.id === b.id);
      Object.assign(u, { name: b.name, username: b.username, bio: b.bio, avatar: b.avatar });
    }
    s.botBrains[b.id] = { botId: b.id, systemPrompt: b.personality.systemPrompt, provider: s.botBrains[b.id]?.provider || b.provider || '', model: s.botBrains[b.id]?.model || b.model || '', updatedAt: Date.now() };
    if (!s.botMemories[b.id]) s.botMemories[b.id] = [];
    s.botLogs.unshift({ id: genId('log'), botId: b.id, level: 'info', message: `Bot ${b.name} saved by admin.`, createdAt: Date.now() });
  });
  await logAdminAction(existed ? 'bot-update' : 'bot-create', { type: 'bot', id: b.id, label: b.name });
  return b;
}

// Full bot teardown (Pack C): the bots doc, its brain, its memories
// and its public users profile. Live deletes of botMemories/users ride
// the admin branches of their rules and are best-effort individually,
// so one missing doc cannot strand the rest. Audited as 'bot-delete'.
export async function deleteBot(botId, reason = '') {
  const bot = data().bots.find((b) => b.id === botId);
  if (live) {
    await sbDelete('bots', botId);
    await sbDelete('botBrains', botId);
    try { await sbDelete('botMemories', botId); } catch { /* best-effort */ }
    try { await sbDelete('users', botId); } catch { /* best-effort */ }
  } else {
    mutate((s) => {
      s.bots = s.bots.filter((b) => b.id !== botId);
      s.users = s.users.filter((u) => u.id !== botId);
      delete s.botBrains[botId];
      delete s.botMemories[botId];
    });
  }
  await logAdminAction('bot-delete', { type: 'bot', id: botId, label: bot?.name || botId }, reason);
}

export async function setGlobalBotEnabled(enabled) {
  if (live) { await sbUpsert('botSettings', { id: 'global', enabled }); }
  else mutate((s) => { s.botSettings.global.enabled = enabled; });
  await logAdminAction(enabled ? 'bots-enabled' : 'bots-stopped', { type: 'config', id: 'botSettings', label: 'Global bot kill switch' });
}

export async function addBotMemory(botId, text) {
  const entry = { id: genId('mem'), text, createdAt: Date.now(), updatedAt: Date.now(), pinned: false };
  if (live) {
    const row = await sbGet('botMemories', botId);
    const items = row ? (row.items || []) : [];
    await sbUpsert('botMemories', { id: botId, botId, items: [...items, entry] });
  } else {
    mutate((s) => { (s.botMemories[botId] = s.botMemories[botId] || []).push(entry); });
  }
  await logAdminAction('bot-memory-add', { type: 'bot', id: botId, label: data().bots.find((b) => b.id === botId)?.name || botId });
  return entry;
}

export async function deleteBotMemory(botId, memoryId) {
  if (live) {
    const row = await sbGet('botMemories', botId);
    if (row) await sbUpsert('botMemories', { id: botId, botId, items: (row.items || []).filter((m) => m.id !== memoryId) });
  } else {
    mutate((s) => { if (s.botMemories[botId]) s.botMemories[botId] = s.botMemories[botId].filter((m) => m.id !== memoryId); });
  }
  await logAdminAction('bot-memory-delete', { type: 'bot', id: botId, label: data().bots.find((b) => b.id === botId)?.name || botId });
}

// -------------------------------------------------------------------------
// BOT CONTROL CENTER (Pack C) — the bot details page needs the bot's
// brain, memories, today's counters and conversation metadata. In live
// mode none of those ride the realtime mirror (brains/memories are
// per-bot docs; the mirror only holds the admin's own chats), so an
// admin opening the details page loads them on demand here and mirrors
// them into the dataset (botBrains / botMemories / botSettings.counters
// / botConvMeta). Demo mode already holds everything — no-op there.
// -------------------------------------------------------------------------
let botAdminDataLoadedFor = '';
export async function loadBotAdminData(botId) {
  if (!live || !botId) return;
  const user = me();
  if (!user || !isAdminRole(user)) return; // brains/memories are admin-only reads
  if (botAdminDataLoadedFor === botId) return;
  botAdminDataLoadedFor = botId;
  const settle = async (p) => { try { return await p; } catch { return null; } };
  const [brainRow, memRow, countersRow, convRows, msgRows, decRow] = await Promise.all([
    settle(sbGet('botBrains', botId)),
    settle(sbGet('botMemories', botId)),
    settle(sbGet('botSettings', 'counters')),
    settle(sbSelect('conversations', (q) => q.contains('participants', [botId]).limit(50))),
    settle(sbSelect('messages', (q) => q.contains('participants', [botId]).order('createdAt', { ascending: true }).limit(500))),
    settle(sbGet('botRunners', `decisions_${botId}`))
  ]);
  if (!remote) return;
  if (decRow) remote.botDecisions[botId] = decRow.items || [];
  if (brainRow) { const { id: _brainRowId, ...brainData } = brainRow; remote.botBrains[botId] = { botId, ...normaliseTimeFields(brainData, ['updatedAt']) }; }
  if (memRow) remote.botMemories[botId] = memRow.items || [];
  if (countersRow) remote.botSettings.counters = botCountersForDay(countersRow, counterDayKey());
  if (convRows) {
    const counts = new Map();
    const lastAt = new Map();
    for (const m of msgRows || []) {
      counts.set(m.conversationId, (counts.get(m.conversationId) || 0) + 1);
      lastAt.set(m.conversationId, Math.max(lastAt.get(m.conversationId) || 0, tsToMs(m.createdAt) || 0));
    }
    remote.botConvMeta[botId] = convRows
      .filter((c) => !c.isGroup && (c.participants || []).length === 2)
      .map((c) => ({
        id: c.id,
        otherId: (c.participants || []).find((p) => p !== botId) || '',
        isGroup: false,
        count: counts.get(c.id) || 0,
        lastAt: lastAt.get(c.id) || tsToMs(c.createdAt) || 0
      }));
  }
  document.dispatchEvent(new CustomEvent('meetbook:data'));
}

// -------------------------------------------------------------------------
// ANNOUNCEMENTS (Pack C) — platform announcements in the `announcements`
// collection { title, body, createdBy, createdByName, createdAt,
// active }: readable by every signed-in user (the home feed renders
// active ones as a dismissible banner), writable by admins only
// (rules). Plus a one-to-one admin notification that rides the normal
// notifications collection. Every action is audited; announcement
// creation is rate-guarded to one per minute per admin session so the
// banner cannot be spammed by a stuck script or a double-click.
// -------------------------------------------------------------------------
const ANNOUNCEMENT_MIN_INTERVAL_MS = 60_000;
let lastAnnouncementAt = 0;

function requireAnnouncementAdmin() {
  const actor = me();
  if (!actor || !isAdminRole(actor)) throw new Error('Admins only.');
  return actor;
}

export async function createAnnouncement({ title, body }) {
  const actor = requireAnnouncementAdmin();
  const cleanTitle = String(title || '').trim();
  const cleanBody = String(body || '').trim();
  if (!cleanTitle || !cleanBody) throw new Error('An announcement needs a title and a message.');
  const nowMs = Date.now();
  if (nowMs - lastAnnouncementAt < ANNOUNCEMENT_MIN_INTERVAL_MS) {
    throw new Error('Please wait a minute between announcements.');
  }
  lastAnnouncementAt = nowMs;
  const ann = { title: cleanTitle, body: cleanBody, createdBy: actor.id, createdByName: actor.name || '', createdAt: nowMs, active: true };
  if (live) {
    const annId = genId('ann');
    await sbInsert('announcements', { id: annId, ...ann });
    await logAdminAction('announcement-create', { type: 'announcement', id: annId, label: cleanTitle });
    return { id: annId, ...ann };
  }
  const saved = { id: genId('ann'), ...ann };
  mutate((s) => { if (!Array.isArray(s.announcements)) s.announcements = []; s.announcements.unshift(saved); });
  await logAdminAction('announcement-create', { type: 'announcement', id: saved.id, label: cleanTitle });
  return saved;
}

export async function setAnnouncementActive(id, active) {
  requireAnnouncementAdmin();
  const ann = data().announcements.find((a) => a.id === id);
  if (live) await sbUpdate('announcements', id, { active: Boolean(active) });
  else mutate((s) => { const a = (s.announcements || []).find((x) => x.id === id); if (a) a.active = Boolean(active); });
  await logAdminAction(active ? 'announcement-activate' : 'announcement-deactivate', { type: 'announcement', id, label: ann?.title || id });
}

export async function deleteAnnouncement(id, reason = '') {
  requireAnnouncementAdmin();
  const ann = data().announcements.find((a) => a.id === id);
  if (live) await sbDelete('announcements', id);
  else mutate((s) => { s.announcements = (s.announcements || []).filter((a) => a.id !== id); });
  await logAdminAction('announcement-delete', { type: 'announcement', id, label: ann?.title || id }, reason);
}

// One-to-one admin notification: a normal notifications doc for a
// single user (type 'admin'), so it lands in their bell like any other
// notification. Audited — targeted messages are never sent silently.
export async function adminNotifyUser(userId, { title = '', body = '' } = {}) {
  const actor = requireAnnouncementAdmin();
  const target = data().users.find((u) => u.id === userId);
  if (!target || target.isBot) throw new Error('Pick a person to notify.');
  const text = [String(title || '').trim(), String(body || '').trim()].filter(Boolean).join(' — ');
  if (!text) throw new Error('Write a message first.');
  const note = { userId, type: 'admin', actorId: actor.id, text, postId: '', conversationId: '', read: false, createdAt: Date.now() };
  if (live) {
    const noteId = genId('n');
    await sbInsert('notifications', { id: noteId, ...note });
    await logAdminAction('notify-user', { type: 'user', id: userId, label: target.name });
    return { id: noteId, ...note };
  }
  const saved = { id: genId('n'), ...note };
  mutate((s) => { s.notifications.unshift(saved); });
  await logAdminAction('notify-user', { type: 'user', id: userId, label: target.name });
  return saved;
}

// -------------------------------------------------------------------------
// PLATFORM SETTINGS (Pack C) — the config/app document the client
// already mirrors: platform name, registration gate, default language,
// alongside the existing maintenanceMode (adminSetMaintenance). Saves
// are validated here and audited; the registration gate is ALSO
// enforced by the Firestore users-create rule, so this page is the
// control, not the only barrier.
// -------------------------------------------------------------------------
export async function adminSavePlatformSettings(patch = {}, reason = '') {
  const actor = me();
  if (!actor || !isAdminRole(actor)) throw new Error('Admins only.');
  const clean = {};
  if (patch.platformName !== undefined) {
    const name = String(patch.platformName || '').trim().slice(0, 40);
    if (!name) throw new Error('Platform name cannot be empty.');
    clean.platformName = name;
  }
  if (patch.registrationOpen !== undefined) clean.registrationOpen = Boolean(patch.registrationOpen);
  if (patch.defaultLanguage !== undefined) {
    if (!['en', 'bn'].includes(patch.defaultLanguage)) throw new Error('Unknown language.');
    clean.defaultLanguage = patch.defaultLanguage;
  }
  // Stage A multi-provider: the router's fallback order + the paid
  // approval gate live in the same config/app doc (admin-writable,
  // arbitrary fields — no rules change needed).
  if (patch.aiFallbackOrder !== undefined) {
    if (!Array.isArray(patch.aiFallbackOrder)) throw new Error('Fallback order must be a list of provider ids.');
    const order = [];
    for (const id of patch.aiFallbackOrder) {
      const cleanId = String(id || '').trim().toLowerCase();
      if (providerById(cleanId) && !order.includes(cleanId)) order.push(cleanId);
    }
    if (!order.length) throw new Error('Fallback order needs at least one known provider.');
    clean.aiFallbackOrder = order;
  }
  if (patch.aiPaidApproved !== undefined) clean.aiPaidApproved = Boolean(patch.aiPaidApproved);
  if (!Object.keys(clean).length) throw new Error('Nothing to save.');
  if (live) await sbUpsert('config', { id: 'app', ...clean });
  else mutate((s) => { s.config = { ...s.config, ...clean }; });
  await logAdminAction('settings-save', { type: 'config', id: 'app', label: Object.keys(clean).join(', ') }, reason);
  return clean;
}

// -------------------------------------------------------------------------
// SYSTEM HEALTH (Pack C) — a one-shot backend connectivity probe:
// time a single lightweight read (config/app) and mirror the outcome
// into the dataset for the Health page. Nothing is fabricated: a
// failed probe reports the failure, and demo mode never probes (the
// Health page labels demo as a local store instead).
// -------------------------------------------------------------------------
export async function probeFirestoreHealth() {
  if (!live) return null;
  const started = Date.now();
  let probe;
  try {
    await sbGet('config', 'app');
    probe = { ok: true, ms: Date.now() - started, at: Date.now(), error: '' };
  } catch (err) {
    probe = { ok: false, ms: Date.now() - started, at: Date.now(), error: String(err?.code || err?.message || 'read failed') };
  }
  if (remote) {
    remote.healthProbe = probe;
    document.dispatchEvent(new CustomEvent('meetbook:data'));
  }
  return probe;
}

// -------------------------------------------------------------------------
// PROVIDER SECRETS + AI USAGE (Spark-plan browser wiring, Stage A) —
// admins save provider API keys in the Bot Admin Panel. Live mode:
// stored ONLY in the admin-only Firestore doc botSecrets/config and
// fetched ONLY when the signed-in user is an admin (rules enforce the
// same). Gemini keeps its original top-level geminiApiKey field; the
// other providers live in a providers map in the same doc
// ({ groq: { apiKey, enabled, defaultModel }, ollama: { endpoint,
// enabled }, … }). Demo mode: kept in local demo state. Keys are never
// rendered back into the UI — the panel shows set/not-set status only.
//
// AI USAGE counters (per provider, per Dhaka day) ride inside the SAME
// doc under an `aiUsage` field: a dedicated aiUsage collection has no
// match in firestore.rules, so the catch-all would deny every write,
// while botSecrets is admin read/write — exactly the runner's access.
// No rules change is needed for any of Stage A.
// -------------------------------------------------------------------------
let botSecretsLoaded = false;
export async function loadBotSecrets() {
  if (!live || botSecretsLoaded) return;
  if (!canAccessBotSecrets(me())) return; // non-admins never read botSecrets
  botSecretsLoaded = true;
  try {
    const row = await sbGet('botSecrets', 'config');
    if (remote) {
      const stored = row || {};
      remote.botSecrets = {
        geminiApiKey: String(stored.geminiApiKey || ''),
        providers: stored.providers && typeof stored.providers === 'object' ? stored.providers : {}
      };
      const storedUsage = stored.aiUsage;
      if (storedUsage && storedUsage.day === dhakaDayKey()) {
        const providers = normaliseUsageMap(storedUsage.providers);
        const totals = usageTotals(providers);
        remote.aiUsage = { day: storedUsage.day, providers, callsToday: totals.calls, tokensToday: totals.tokens, updatedAt: Date.now() };
      }
      document.dispatchEvent(new CustomEvent('meetbook:data'));
    }
  } catch {
    botSecretsLoaded = false; // permission/network hiccup — retry on next sync tick
  }
}

// One write path for every botSecrets field: live mode merges into the
// Firestore doc (setDoc merge deep-merges the providers map, so one
// provider's patch never clobbers another's), demo mode mutates the
// local store. `applyLocal` performs the same change on a botSecrets
// object (the remote mirror or the demo state's).
async function patchBotSecrets(patchObj, applyLocal) {
  if (live) {
    // Firestore's setDoc merge DEEP-merged the providers map; a
    // PostgREST upsert replaces the providers jsonb wholesale, so a
    // provider patch is read-merged here first (per-provider shallow
    // merge — the same granularity the deep merge produced). Other
    // fields are plain column patches and need no read.
    const row = { id: 'config', ...patchObj, updatedAt: Date.now() };
    if (patchObj.providers) {
      const current = await sbGet('botSecrets', 'config');
      const merged = { ...(current?.providers || {}) };
      for (const [pid, pPatch] of Object.entries(patchObj.providers)) {
        merged[pid] = { ...(merged[pid] || {}), ...pPatch };
      }
      row.providers = merged;
    }
    await sbUpsert('botSecrets', row);
    botSecretsLoaded = true;
    if (remote) {
      remote.botSecrets ||= { geminiApiKey: '', providers: {} };
      applyLocal(remote.botSecrets);
      document.dispatchEvent(new CustomEvent('meetbook:data'));
    }
    return;
  }
  mutate((s) => {
    s.botSecrets ||= { geminiApiKey: '', providers: {} };
    applyLocal(s.botSecrets);
  });
}

export async function saveGeminiApiKey(key) {
  const value = String(key || '').trim();
  if (!value) throw new Error('Paste a Gemini API key first.');
  if (!isAdmin()) throw new Error('Only admins can manage the Gemini API key.');
  await patchBotSecrets({ geminiApiKey: value }, (s) => { s.geminiApiKey = value; });
}

export async function removeGeminiApiKey() {
  if (!isAdmin()) throw new Error('Only admins can manage the Gemini API key.');
  // Clear ONLY the key field (this used to delete the whole doc — the
  // doc now also holds the other providers' keys and the usage
  // counters, which must survive a Gemini key removal).
  await patchBotSecrets({ geminiApiKey: '' }, (s) => { s.geminiApiKey = ''; });
}

function assertProvider(providerId) {
  const entry = providerById(providerId);
  if (!entry) throw new Error('Unknown AI provider.');
  return entry;
}

function assertPaidGate(entry) {
  if (entry.freeStatus === 'paid-only' && data().config?.aiPaidApproved !== true) {
    throw new Error(`${entry.label} is a paid provider with no free tier — turn on paid-provider approval in the AI Providers section first.`);
  }
}

export async function saveProviderKey(providerId, key) {
  const entry = assertProvider(providerId);
  const value = String(key || '').trim();
  if (!value) throw new Error(`Paste a ${entry.label} API key first.`);
  if (!isAdmin()) throw new Error('Only admins can manage provider API keys.');
  if (entry.id === 'gemini') return saveGeminiApiKey(value);
  if (entry.endpointField) throw new Error(`${entry.label} uses an endpoint URL, not an API key.`);
  assertPaidGate(entry);
  await patchBotSecrets(
    { providers: { [entry.id]: { apiKey: value } } },
    (s) => { (s.providers ||= {})[entry.id] = { ...(s.providers[entry.id] || {}), apiKey: value }; }
  );
}

export async function removeProviderKey(providerId) {
  const entry = assertProvider(providerId);
  if (!isAdmin()) throw new Error('Only admins can manage provider API keys.');
  if (entry.id === 'gemini') return removeGeminiApiKey();
  if (entry.endpointField) throw new Error(`${entry.label} uses an endpoint URL, not an API key.`);
  await patchBotSecrets(
    { providers: { [entry.id]: { apiKey: '' } } },
    (s) => { (s.providers ||= {})[entry.id] = { ...(s.providers[entry.id] || {}), apiKey: '' }; }
  );
}

export async function saveProviderEndpoint(providerId, endpoint) {
  // Back-compat: the original signature was saveProviderEndpoint(url)
  // and always wrote Ollama's endpoint (the only endpoint-based
  // provider). Accept that shape, but honour an explicit provider id
  // when the caller passes one (the endpoint form carries it).
  if (endpoint === undefined) { endpoint = providerId; providerId = 'ollama'; }
  const entry = assertProvider(providerId || 'ollama');
  if (!isAdmin()) throw new Error('Only admins can manage provider settings.');
  const value = String(endpoint || '').trim().replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Enter a valid endpoint URL (e.g. http://localhost:11434/v1).'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('The endpoint must start with http:// or https://.');
  await patchBotSecrets(
    { providers: { [entry.id]: { endpoint: value } } },
    (s) => { (s.providers ||= {})[entry.id] = { ...(s.providers[entry.id] || {}), endpoint: value }; }
  );
  return entry;
}

export async function setProviderEnabled(providerId, enabled) {
  const entry = assertProvider(providerId);
  if (!isAdmin()) throw new Error('Only admins can manage provider settings.');
  await patchBotSecrets(
    { providers: { [entry.id]: { enabled: Boolean(enabled) } } },
    (s) => { (s.providers ||= {})[entry.id] = { ...(s.providers[entry.id] || {}), enabled: Boolean(enabled) }; }
  );
}

export async function saveProviderDefaultModel(providerId, model) {
  const entry = assertProvider(providerId);
  if (!isAdmin()) throw new Error('Only admins can manage provider settings.');
  const value = String(model || '').trim();
  await patchBotSecrets(
    { providers: { [entry.id]: { defaultModel: value } } },
    (s) => { (s.providers ||= {})[entry.id] = { ...(s.providers[entry.id] || {}), defaultModel: value }; }
  );
}

// Test connection: one minimal real generation through the router's
// own adapter (api.testProvider), result mirrored for the panel.
export async function testProviderConnection(providerId) {
  const entry = assertProvider(providerId);
  if (!isAdmin()) throw new Error('Only admins can test providers.');
  await loadBotSecrets();
  const result = await testAiProvider(entry.id, { config: resolveAiConfig(data().botSecrets || {}, data().config || {}) });
  // A test connection is a REAL generation — count it, or repeated
  // test clicks silently burn the provider's free daily quota while
  // the panel (and the router's cap guard) see nothing.
  recordAiUsage(entry.id, { ok: result.ok, usage: result.usage || null, status: result.ok ? 200 : 0, attempts: result.attempts || 1 });
  const health = { ok: result.ok, detail: result.detail, at: Date.now() };
  if (live) {
    if (remote) {
      (remote.providerHealth ||= {})[entry.id] = health;
      document.dispatchEvent(new CustomEvent('meetbook:data'));
    }
  } else {
    mutate((s) => { (s.providerHealth ||= {})[entry.id] = health; });
  }
  return health;
}

// -------------------------------------------------------------------------
// AI USAGE ACCOUNTING — every routed attempt (success or failure) is
// counted per provider with the provider's OWN reported token usage.
// Live mode persists into botSecrets/config (see the section header);
// demo mode into the local store. A 429 stamps exhaustedUntil (+24h on
// a per-day map = "the rest of today") so the router skips the
// provider until tomorrow's fresh counters.
// -------------------------------------------------------------------------
function bumpAiUsage(usage, providerId, attempt) {
  const day = dhakaDayKey();
  const base = usage && usage.day === day ? usage : { day, providers: {} };
  const providers = normaliseUsageMap(base.providers);
  const p = providers[providerId];
  if (p) {
    // One routed call can be several REAL provider requests (Gemini's
    // model chain tries up to 3 models); the router reports the true
    // count in attempt.attempts so calls/errors are never understated.
    const attempts = Math.max(1, Number(attempt.attempts) || 1);
    p.calls += attempts;
    p.errors += attempt.ok ? attempts - 1 : attempts;
    if (attempt.usage) {
      p.promptTokens += attempt.usage.promptTokens || 0;
      p.completionTokens += attempt.usage.completionTokens || 0;
    }
    if (attempt.exhausted) p.exhaustedUntil = Date.now() + 24 * 3600_000;
  }
  const totals = usageTotals(providers);
  return { day, providers, callsToday: totals.calls, tokensToday: totals.tokens, updatedAt: Date.now() };
}

function recordAiUsage(providerId, attempt) {
  if (live) {
    if (!remote) return;
    remote.aiUsage = bumpAiUsage(remote.aiUsage, providerId, attempt);
    document.dispatchEvent(new CustomEvent('meetbook:data'));
    sbUpsert('botSecrets', {
      id: 'config',
      aiUsage: { day: remote.aiUsage.day, providers: remote.aiUsage.providers }, updatedAt: Date.now()
    }).catch(() => { /* counters are bookkeeping — never fail a cycle */ });
    return;
  }
  mutate((s) => { s.aiUsage = bumpAiUsage(s.aiUsage, providerId, attempt); });
}

function aiUsageTodayMap() {
  const u = data().aiUsage || {};
  return u.day === dhakaDayKey() ? normaliseUsageMap(u.providers) : normaliseUsageMap(null);
}

// Demo-mode botLogs write — the existing client-side log channel (the
// same one saveBot uses). Live-mode botLogs are Functions-only per the
// rules, so this is a no-op there.
function logBotEvent(botId, level, message) {
  if (live) return;
  mutate((s) => { s.botLogs.unshift({ id: genId('log'), botId, level, message, createdAt: Date.now() }); });
}

// Brain bookkeeping: record which provider produced the bot's latest
// text, mirroring the botBrains doc saveBot maintains. Live mode writes
// the botBrains doc directly — its rules are admin-writable (unlike
// botActivities/botLogs, which stay Functions-only, so those are
// skipped silently in live mode). Best-effort: never fail a cycle.
// `model` is the model that actually answered (the router reports it);
// template output keeps the 'template-fallback' stamp.
function recordBotBrain(bot, provider, model) {
  const stampedModel = model || (provider === 'template-fallback' ? 'template-fallback' : botModel(bot));
  if (live) {
    sbUpsert('botBrains', {
      id: bot.id, botId: bot.id, systemPrompt: bot.personality.systemPrompt, provider,
      model: stampedModel, updatedAt: Date.now()
    }).catch(() => { /* bookkeeping only */ });
    return;
  }
  mutate((s) => {
    const prev = s.botBrains[bot.id] || {};
    s.botBrains[bot.id] = {
      ...prev,
      botId: bot.id,
      systemPrompt: bot.personality.systemPrompt,
      provider,
      model: stampedModel,
      updatedAt: Date.now()
    };
  });
}

// One bot text through the multi-provider router (aiProviders.js):
// the bot's own provider+model first, then the admin's fallback order
// — personality and memory ride in the shared prompt, identical for
// every provider. ANY total failure falls back silently to the
// template text the caller prepared. Returns { text, provider } where
// provider is the registry id that answered ('gemini', 'groq', …) or
// 'template-fallback'.
async function generateBotText(bot, memories, context, templateText) {
  const config = resolveAiConfig(data().botSecrets || {}, data().config || {});
  const res = await generateRouted({
    bot, memories, context, config,
    usageToday: aiUsageTodayMap(),
    onAttempt: (providerId, attempt) => recordAiUsage(providerId, attempt)
  });
  if (res) {
    recordBotBrain(bot, res.provider, res.model);
    return { text: res.text, provider: res.provider };
  }
  if (anyProviderConfigured(config)) {
    logBotEvent(bot.id, 'warn', `AI generation failed for ${bot.name} (${getLastRoutedFailure() || 'no provider available'}), using template fallback.`);
  }
  recordBotBrain(bot, 'template-fallback');
  return { text: templateText, provider: 'template-fallback' };
}

// Client-side demo bot simulation: one runner cycle against local state.
// In Firebase mode the real engine lives in Cloud Functions (botRunner);
// this simulation is used only for demo mode so bot activity is visible.
export async function runDemoBotCycle() {
  if (live) return { ran: false, reason: 'Bot engine runs in Cloud Functions when Firebase is configured.' };
  const s = getState();
  if (!s.botSettings.global.enabled) return { ran: false, reason: 'Global bot kill switch is off.' };
  const results = [];
  // Plan phase: decide each bot's action from its counters (same gating
  // as before) and generate its text up front — a routed AI provider
  // when one is configured, template otherwise — because generation is
  // async while the state mutation below must stay atomic.
  const plan = [];
  for (const bot of s.bots) {
    const counters = { ...(s.botSettings.counters?.[bot.id] || { postsToday: 0, commentsToday: 0, likesToday: 0, messagesToday: 0, lastActionAt: 0 }) };
    const decision = decideBotAction(bot, { ...counters, lastActionAt: 0 }, true);
    if (decision.action === 'none') { results.push({ bot: bot.name, action: 'none', reason: decision.reason }); continue; }
    const entry = { bot, counters, action: decision.action, gen: null, targetId: '' };
    if (decision.action === 'post') {
      entry.gen = await generateBotText(bot, s.botMemories[bot.id] || [], { kind: 'post' }, generateTemplatePost(bot));
      // Anti-duplicate set: this bot's recent posts AND other bots'
      // recent posts (Master Vision: compare across the ecosystem).
      const botIds = new Set(s.bots.map((b) => b.id));
      const recentTexts = [
        ...s.posts.filter((p) => p.authorId === bot.id).slice(0, 10),
        ...s.posts.filter((p) => p.authorId !== bot.id && botIds.has(p.authorId)).slice(0, 10)
      ].map((p) => p.text);
      if (entry.gen && isNearDuplicateBotText(entry.gen.text, recentTexts)) {
        const fresh = freshTemplatePost(bot, recentTexts);
        entry.gen = fresh ? { ...entry.gen, text: fresh, provider: 'template' } : null;
      }
    } else if (decision.action === 'comment') {
      // Phase 2: reply before a new top-level comment (thread budgets).
      const botIds = new Set(s.bots.map((b) => b.id));
      const replyTarget = pickBotReplyTarget(s.posts, bot, botIds);
      if (replyTarget) {
        entry.replyTo = { postId: replyTarget.post.id, commentId: replyTarget.comment.id, authorId: replyTarget.comment.authorId };
        entry.gen = await generateBotText(bot, s.botMemories[bot.id] || [], { kind: 'comment', text: replyTarget.comment.text }, generateTemplateComment(bot));
      } else {
        const target = pickBotCommentTarget(s.posts, bot);
        if (target) {
          entry.targetId = target.id;
          entry.gen = await generateBotText(bot, s.botMemories[bot.id] || [], { kind: 'comment', text: target.text }, generateTemplateComment(bot));
        }
      }
    }
    plan.push(entry);
    results.push({ bot: bot.name, action: decision.action });
  }
  // Apply phase: one mutation, same writes/counters as the old cycle.
  mutate((st) => {
    st.botSettings.counters = st.botSettings.counters || {};
    for (const entry of plan) {
      const { bot, counters } = entry;
      if (entry.action === 'post' && entry.gen) {
        const text = entry.gen.text;
        st.posts.unshift({ id: genId('p'), authorId: bot.id, text, image: '', visibility: 'public', audienceIds: [], createdAt: Date.now(), editedAt: 0, likes: [], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [], groupId: '', pageId: '', pageName: '', pageAvatar: '', generatedBy: entry.gen.provider });
        counters.postsToday += 1;
        st.botMemories[bot.id] = memoryFromActivity(st.botMemories[bot.id] || [], bot, { kind: 'post', text });
        st.botActivities.unshift({ id: genId('act'), botId: bot.id, action: 'post', detail: text.slice(0, 90), createdAt: Date.now(), status: 'ok' });
      } else if (entry.action === 'comment' && entry.gen) {
        const text = entry.gen.text;
        if (entry.replyTo) {
          const hostPost = st.posts.find((p) => p.id === entry.replyTo.postId);
          const host = hostPost?.comments.find((cm) => cm.id === entry.replyTo.commentId);
          if (host) {
            host.replies = [...(host.replies || []), { id: genId('c'), authorId: bot.id, text, createdAt: Date.now() }];
            counters.commentsToday += 1;
            st.botMemories[bot.id] = memoryFromActivity(st.botMemories[bot.id] || [], bot, { kind: 'comment', text: hostPost.text });
            st.botActivities.unshift({ id: genId('act'), botId: bot.id, action: 'comment', detail: text.slice(0, 90), createdAt: Date.now(), status: 'ok' });
            const author = st.users.find((u) => u.id === entry.replyTo.authorId);
            if (author && !author.isBot) {
              st.notifications.unshift({ id: genId('n'), userId: author.id, type: 'comment', actorId: bot.id, text: `${bot.name} replied to your comment.`, postId: hostPost.id, conversationId: '', read: false, createdAt: Date.now() });
            }
          }
        } else {
          const target = st.posts.find((p) => p.id === entry.targetId);
          if (target) {
            target.comments.push({ id: genId('c'), authorId: bot.id, text, createdAt: Date.now(), replies: [] });
            counters.commentsToday += 1;
            st.botMemories[bot.id] = memoryFromActivity(st.botMemories[bot.id] || [], bot, { kind: 'comment', text: target.text });
            st.botActivities.unshift({ id: genId('act'), botId: bot.id, action: 'comment', detail: text.slice(0, 90), createdAt: Date.now(), status: 'ok' });
            const author = st.users.find((u) => u.id === target.authorId);
            if (author && !author.isBot) {
              st.notifications.unshift({ id: genId('n'), userId: author.id, type: 'comment', actorId: bot.id, text: `${bot.name} commented on your post.`, postId: target.id, conversationId: '', read: false, createdAt: Date.now() });
            }
          }
        }
      } else if (entry.action === 'like') {
        const target = st.posts.find((p) => p.authorId !== bot.id && !p.likes.includes(bot.id));
        if (target) { target.likes.push(bot.id); counters.likesToday += 1; st.botActivities.unshift({ id: genId('act'), botId: bot.id, action: 'like', detail: 'Liked a post.', createdAt: Date.now(), status: 'ok' }); }
      }
      counters.lastActionAt = Date.now();
      st.botSettings.counters[bot.id] = counters;
    }
    // aiUsage is owned by recordAiUsage now (real per-provider
    // counters, bumped on every routed attempt during the plan phase).
  });
  // Phase 3: decision history (demo parity with the live store).
  mutate((st) => {
    st.botDecisions = st.botDecisions || {};
    for (const r of results) {
      const b = s.bots.find((x) => x.name === r.bot);
      if (b) st.botDecisions[b.id] = appendBotDecision(st.botDecisions[b.id] || [], { action: r.action, reason: r.reason || '', at: Date.now() });
    }
  });
  return { ran: true, results };
}

// Bot reply in a 1-1 conversation (demo mode): uses the bot's OWN
// memories. Routed through the AI providers when any is configured
// (the user's message is the context, so a Bangla message earns a
// Bangla reply); the personality template below is the silent fallback.
export async function demoBotReply(botUserId, userText) {
  if (live) return null;
  const s = getState();
  const bot = s.bots.find((b) => b.id === botUserId);
  if (!bot || !bot.active || !s.botSettings.global.enabled) return null;
  const memories = s.botMemories[bot.id] || [];
  const { text: reply } = await generateBotText(bot, memories, { kind: 'message', text: String(userText) }, templateBotMessageReply(bot, userText));
  mutate((st) => {
    st.botMemories[bot.id] = memoryFromConversation(st.botMemories[bot.id] || memories, userText, reply);
    st.botActivities.unshift({ id: genId('act'), botId: bot.id, action: 'message', detail: 'Replied to a message.', createdAt: Date.now(), status: 'ok' });
  });
  return reply;
}

// -------------------------------------------------------------------------
// LIVE BOT RUNNER (Spark plan) — the Cloud Functions engine
// (functions/botEngine.js) needs Blaze, so on Spark bots act from an
// ADMIN's signed-in browser instead: this client runs bot cycles and
// writes on behalf of bot accounts, which the Firestore rules allow
// only through the narrow admin-as-bot branches (the author/sender
// must be a users doc with isBot == true). Text generation is the same
// routed multi-provider path as demo mode (generateBotText). LIMITATION, by
// design: bots only act while an admin browser session is open — the
// runner starts when an admin signs in, runs one cycle shortly after,
// then on BOT_RUNNER_INTERVAL_MS, and stops on sign-out. Non-admin
// sessions never run it. Daily counters persist in the admin-writable
// botSettings/counters doc (botActivities/botLogs are Functions-only
// writes per the rules, so live bookkeeping lands in botBrains + the
// panel's last-cycle status instead).
// -------------------------------------------------------------------------
export const BOT_RUNNER_INTERVAL_MS = 3 * 60 * 1000;
export const BOT_RUNNER_INITIAL_DELAY_MS = 20 * 1000;

let liveRunnerTimer = null;
let liveRunnerInitialTimer = null;
let botCycleInFlight = false;

function setLiveRunnerState(patchObj) {
  if (!remote) return;
  const next = { live: true, active: Boolean(liveRunnerTimer), ...(remote.botRunner || {}), ...patchObj };
  // No-change writes stay silent: syncLiveBotRunner runs on every
  // users delivery (presence heartbeats included), and an unconditional
  // dispatch here would re-render the page on every heartbeat — the
  // exact shake the presence discipline exists to prevent.
  if (remote.botRunner && stableStringify(remote.botRunner) === stableStringify(next)) return;
  remote.botRunner = next;
  document.dispatchEvent(new CustomEvent('meetbook:data'));
}

export function botRunnerIsActive() {
  return Boolean(liveRunnerTimer);
}

export function startBotRunner() {
  if (!live || !isAdmin() || liveRunnerTimer) return botRunnerIsActive();
  liveRunnerInitialTimer = setTimeout(() => { void runScheduledBotCycle(); }, BOT_RUNNER_INITIAL_DELAY_MS);
  liveRunnerTimer = setInterval(() => { void runScheduledBotCycle(); }, BOT_RUNNER_INTERVAL_MS);
  setLiveRunnerState({ active: true });
  return true;
}

export function stopBotRunner() {
  if (liveRunnerInitialTimer) { clearTimeout(liveRunnerInitialTimer); liveRunnerInitialTimer = null; }
  if (liveRunnerTimer) { clearInterval(liveRunnerTimer); liveRunnerTimer = null; }
  setLiveRunnerState({ active: false });
}

// Called on every users snapshot: the runner exists exactly while the
// signed-in user is an admin.
function syncLiveBotRunner() {
  if (!live) return;
  if (isAdmin()) startBotRunner();
  else stopBotRunner();
}

// Auto cycles claim their interval window in botRunners (admin-only
// collection) so two admin tabs don't both post for the same window —
// the same duplicate-task protection the Functions engine uses.
async function runScheduledBotCycle() {
  if (!live || !isAdmin()) return;
  try {
    const windowKey = Math.floor(Date.now() / BOT_RUNNER_INTERVAL_MS);
    // Atomic claim via insert-if-absent: PostgREST has no client
    // transaction, so the claim is a single upsert with
    // ignoreDuplicates — exactly one session's insert lands a row and
    // returns it; every other session's returns an empty result. (The
    // old get-then-set let two admin tabs both observe "not claimed"
    // and both run the window.) The GitHub Actions runner claims the
    // same window row the same way, so browser and runner can never
    // run a cycle over each other.
    const { data: claimedRows, error: claimError } = await supabase.from('botRunners')
      .upsert({ id: `autocycle_${windowKey}`, kind: 'live-autocycle', window: windowKey, by: currentUid(), createdAt: Date.now(), status: 'claimed' }, { onConflict: 'id', ignoreDuplicates: true })
      .select();
    if (claimError) throw claimError;
    if (!claimedRows?.length) return; // another session already ran this window
  } catch { return; /* cannot claim — skip this window quietly */ }
  await runLiveBotCycle();
}

async function loadLiveBotCounters() {
  const day = counterDayKey();
  try {
    const row = await sbGet('botSettings', 'counters');
    if (row) return { day, counters: botCountersForDay(row, day) };
  } catch { /* fall through: a fresh day of counters */ }
  return { day, counters: {} };
}

// Phase 3: per-bot decision history lives in botRunners/decisions_<botId>
// (admin read/write per the rules — botActivities is Functions-only, so
// it cannot hold live records on Spark). Capped at 50 entries per bot;
// best-effort: a failed write never fails the cycle.
async function persistBotDecisions(list) {
  if (!live || !list?.length) return;
  const byBot = new Map();
  for (const dcn of list) {
    if (!byBot.has(dcn.botId)) byBot.set(dcn.botId, []);
    byBot.get(dcn.botId).push(dcn);
  }
  for (const [botId, entries] of byBot) {
    try {
      const rowId = `decisions_${botId}`;
      const row = await sbGet('botRunners', rowId);
      let items = row ? (row.items || []) : [];
      for (const e of entries) items = appendBotDecision(items, e);
      await sbUpsert('botRunners', { id: rowId, botId, items, updatedAt: Date.now() });
      if (remote) remote.botDecisions[botId] = items;
    } catch { /* best-effort */ }
  }
}

async function saveLiveBotCounters(day, counters) {
  // The counters map merges per bot, so a cycle never wipes another
  // writer's increments for OTHER bots (a naive whole-row overwrite
  // would be last-writer-wins): read the stored row and merge this
  // cycle's counters over it — same-day only; a stale-day row is
  // replaced wholesale, matching botCountersForDay's reset semantics.
  try {
    const current = await sbGet('botSettings', 'counters');
    const merged = current && current.day === day ? { ...(current.counters || {}), ...counters } : counters;
    await sbUpsert('botSettings', { id: 'counters', day, counters: merged, updatedAt: Date.now() });
  } catch { /* best-effort */ }
}

async function loadLiveBotMemories(botId) {
  try {
    const row = await sbGet('botMemories', botId);
    if (row) return row.items || [];
  } catch { /* fall through to the mirrored copy */ }
  return data().botMemories[botId] || [];
}

// Find this bot's unreplied 1-1 conversations straight from the
// server: the admin's mirrored state only contains the ADMIN's own
// chats, so the runner queries for the bot (the conversations/messages
// read policies allow admins). Latest message per conversation
// decides — a conversation whose latest message is the human's is
// unreplied.
async function findLiveReplyTargets(bot) {
  const convRows = await sbSelect('conversations', (q) => q.contains('participants', [bot.id]).limit(50));
  const convs = convRows.map((row) => normaliseTimeFields(row, ['createdAt'])).slice(0, 20);
  const latestByConv = new Map();
  for (const conv of convs) {
    if (conv.isGroup) continue;
    const msgRows = await sbSelect('messages', (q) => q.eq('conversationId', conv.id).order('createdAt', { ascending: false }).limit(1));
    const latest = msgRows[0];
    latestByConv.set(conv.id, latest ? normaliseTimeFields(latest, ['createdAt']) : null);
  }
  return findBotReplyTargets(convs, latestByConv, bot.id);
}

async function latestLiveMessage(conversationId) {
  const rows = await sbSelect('messages', (q) => q.eq('conversationId', conversationId).order('createdAt', { ascending: false }).limit(1));
  const d = rows[0];
  return d ? normaliseTimeFields(d, ['createdAt']) : null;
}

// One live bot cycle: for every active bot, first answer at most one
// unreplied 1-1 conversation (messages/day counter), then take the
// decideBotAction-driven autonomous action (post/comment/like) under
// the same counters + kill switch as the demo cycle and the Functions
// engine. Returns the demo cycle's { ran, results } shape.
export async function runLiveBotCycle() {
  if (!live) return { ran: false, reason: 'The live bot runner needs Firebase mode.' };
  if (!isAdmin()) return { ran: false, reason: 'Only admins can run bot cycles.' };
  if (botCycleInFlight) return { ran: false, reason: 'A bot cycle is already running.' };
  if (data().botSettings.global.enabled === false) {
    setLiveRunnerState({ lastCycleAt: Date.now(), lastSummary: 'Skipped: global bot kill switch is off.' });
    return { ran: false, reason: 'Global bot kill switch is off.' };
  }
  botCycleInFlight = true;
  const results = [];
  const cycleDecisions = [];
  try {
    resetLastRoutedFailure(); // the summary reports only THIS cycle's AI outcome
    await loadBotSecrets(); // make sure the provider keys are in memory
    const { day, counters } = await loadLiveBotCounters();
    let actions = 0;
    const details = [];
    for (const bot of data().bots) {
      const c = { ...emptyBotCounters(), ...(counters[bot.id] || {}) };
      const rBefore = results.length;
      // Reply-target discovery runs for EVERY bot, BEFORE the active
      // and daily-cap gates (Audit fix #1): those gates used to skip
      // discovery entirely, so a bot sitting on unanswered DMs still
      // reported a clean "no actions" — the panel could not tell a
      // quiet bot from a blocked one, and the per-bot reason described
      // only the autonomous decision. Discovery is read-only; the
      // gates below still decide whether a reply may be SENT (the
      // designed daily cap is never silently raised).
      let targets = [];
      let targetError = '';
      try { targets = await findLiveReplyTargets(bot); } catch (err) { targetError = String(err?.message || err); }
      const dmDetail = {
        bot: bot.name,
        pendingDMs: targets.length,
        lastUnansweredAt: targets.length ? Math.max(...targets.map((t) => t.lastMessage?.createdAt || 0)) : 0,
        note: ''
      };
      details.push(dmDetail);
      if (!bot.active) {
        dmDetail.note = targets.length
          ? `bot is deactivated — ${targets.length} unanswered DM(s) waiting`
          : 'bot is deactivated';
        results.push({ bot: bot.name, action: 'none', reason: dmDetail.note, pendingDMs: targets.length });
        continue;
      }
      counters[bot.id] = c;
      try {
        try { await ensureBotUserDoc(bot); } catch { /* rules may lag a deploy — actions below will surface real errors */ }
        let memories = await loadLiveBotMemories(bot.id);
        let acted = false;
        let dmNote = targetError ? `could not scan DMs: ${targetError}` : '';

        // --- chat reply (does not consume the min-interval pacing;
        // the messages/day counter is its gate) ---
        if (targets.length && c.messagesToday >= bot.limits.messagesPerDay) {
          dmNote = `${targets.length} unanswered DM(s) — daily message limit reached (${c.messagesToday}/${bot.limits.messagesPerDay})`;
        } else if (targets.length) {
          const target = targets[0];
          // Re-check the latest message right before writing, so two
          // cycles (or a fast human) never produce a double reply.
          const fresh = await latestLiveMessage(target.conversationId);
          if (fresh && fresh.senderId === target.humanId) {
            // Short-term memory: the recent thread rides along so the
            // reply continues the conversation instead of answering
            // one message in a vacuum.
            const threadMsgs = (data().messages || []).filter((m) => m.conversationId === target.conversationId).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
            const gen = await generateBotText(bot, memories, { kind: 'message', text: fresh.text, thread: threadContextText(threadMsgs, bot.id) }, templateBotMessageReply(bot, fresh.text));
            await sbInsert('messages', {
              id: genId('m'),
              conversationId: target.conversationId, participants: [...target.participants],
              senderId: bot.id, text: gen.text, image: '', audio: '',
              createdAt: Date.now(), status: 'sent', readBy: [bot.id]
            });
            // Count the reply NOW, before the notification/memory
            // writes: if one of those throws, the delivered message
            // used to go uncounted and the daily cap leaked.
            c.messagesToday += 1;
            await createNotification({
              userId: target.humanId, type: 'message', actorId: bot.id,
              text: `${bot.name} sent you a message.`, postId: '', conversationId: target.conversationId,
              read: false, createdAt: Date.now()
            });
            const updatedMemories = memoryFromConversation(memories, fresh.text, gen.text);
            try { await sbUpsert('botMemories', { id: bot.id, botId: bot.id, items: updatedMemories }); memories = updatedMemories; } catch { /* memory is best-effort */ }
            actions += 1;
            acted = true;
            results.push({ bot: bot.name, action: 'message' });
          }
        }
        if (dmNote) {
          dmDetail.note = dmNote;
          results.push({ bot: bot.name, action: 'none', reason: dmNote, pendingDMs: targets.length });
        }

        // --- friend requests (accepted like an ordinary member's:
        // paced by pickFriendRequestsToAccept — a few minutes old,
        // at most a couple per cycle; no AI, no daily-cap cost) ---
        // The cycle runs as staff, so the accept rides the
        // friendships_update_admin policy (the same sbUpdate
        // respondFriendRequest uses when staff accept on someone's
        // behalf); the sender is then notified exactly as a human
        // accept notifies them. The mirror picks the new status up
        // via the friendships realtime refetch, like every other
        // cycle write.
        let pendingFriendships = [];
        try { pendingFriendships = await sbSelect('friendships', (q) => q.eq('to', bot.id).eq('status', 'pending')); } catch { /* read-only scan — a failure here must not cost the bot its autonomous action below */ }
        for (const rel of pickFriendRequestsToAccept(pendingFriendships, bot.id)) {
          const updated = await sbUpdate('friendships', rel.id, { status: 'accepted' });
          if (!updated) continue; // withdrawn or already handled since the read
          if (rel.from && rel.from !== bot.id) {
            try { await createNotification({ userId: rel.from, type: 'friend_accept', actorId: bot.id, text: `${bot.name} accepted your friend request.`, postId: '', conversationId: '', read: false, createdAt: Date.now() }); } catch { /* the accept itself already succeeded */ }
          }
          actions += 1;
          acted = true;
          results.push({ bot: bot.name, action: 'friend-accept' });
        }

        // --- autonomous action (post / comment / like) ---
        const decision = decideBotAction(bot, c, true);
        if (decision.action === 'post') {
          // Anti-duplicate set: this bot's recent posts AND other
          // bots' recent posts (Master Vision cross-bot comparison).
          const botIds = new Set([
            ...(data().users || []).filter((u) => u.isBot).map((u) => u.id),
            ...(data().bots || []).map((b) => b.id)
          ]);
          const recentTexts = [
            ...(data().posts || []).filter((p) => p.authorId === bot.id).slice(0, 10),
            ...(data().posts || []).filter((p) => p.authorId !== bot.id && botIds.has(p.authorId)).slice(0, 10)
          ].map((p) => p.text);
          let gen = await generateBotText(bot, memories, { kind: 'post' }, generateTemplatePost(bot));
          if (isNearDuplicateBotText(gen.text, recentTexts)) {
            // The provider (or the random template) repeated one of
            // the bot's recent posts — swap in a fresh template once;
            // if every variant repeats, skip the post entirely.
            const fresh = freshTemplatePost(bot, recentTexts);
            if (!fresh) { results.push({ bot: bot.name, action: 'none', reason: 'post would repeat a recent post' }); gen = null; }
            else gen = { ...gen, text: fresh, provider: 'template' };
          }
          if (gen) {
          // Same stored shape createPost writes: the audience pair is
          // denormalized via postAudience (public -> audienceIds []),
          // so the provable feed listeners pick the post up.
          const audience = postAudience({ visibility: 'public', authorFriendIds: friendIdsFromData(bot.id), authorCloseFriendIds: [] });
          await sbInsert('posts', {
            id: genId('p'),
            authorId: bot.id, text: gen.text, image: '',
            visibility: audience.visibility, audienceIds: audience.audienceIds,
            createdAt: Date.now(), editedAt: 0,
            likes: [], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [],
            groupId: '', pageId: '', pageName: '', pageAvatar: '',
            poll: null, location: '', feeling: '', pinned: false
          });
          c.postsToday += 1;
          c.lastActionAt = Date.now();
          const actMem = memoryFromActivity(memories, bot, { kind: 'post', text: gen.text });
          if (actMem !== memories) { try { await sbUpsert('botMemories', { id: bot.id, botId: bot.id, items: actMem }); memories = actMem; } catch { /* best-effort */ } }
          actions += 1;
          acted = true;
          results.push({ bot: bot.name, action: 'post' });
          }
        } else if (decision.action === 'comment') {
          const allPosts = data().posts || [];
          const botIds = new Set([
            ...(data().users || []).filter((u) => u.isBot).map((u) => u.id),
            ...(data().bots || []).map((b) => b.id)
          ]);
          // Phase 2: a REPLY comes before a new top-level comment —
          // answering a commenter on the bot's own post, or joining a
          // bot-to-bot thread, under the thread budgets.
          const replyTarget = pickBotReplyTarget(allPosts, bot, botIds);
          if (replyTarget) {
            const hostPost = replyTarget.post;
            const hostComment = replyTarget.comment;
            const blockRow = await sbGet('blocks', `${hostComment.authorId}_${bot.id}`);
            if (blockRow) {
              results.push({ bot: bot.name, action: 'none', reason: 'comment author blocked this bot' });
            } else {
              const gen = await generateBotText(bot, memories, { kind: 'comment', text: hostComment.text }, generateTemplateComment(bot));
              const postRow = await sbGet('posts', hostPost.id);
              const freshComments = postRow ? (postRow.comments || []) : (hostPost.comments || []);
              const host = freshComments.find((cm) => cm.id === hostComment.id);
              if (host) {
                host.replies = [...(host.replies || []), { id: genId('c'), authorId: bot.id, text: gen.text, createdAt: Date.now() }];
                await sbUpdate('posts', hostPost.id, { comments: freshComments });
                c.commentsToday += 1;
                c.lastActionAt = Date.now();
                const actMem = memoryFromActivity(memories, bot, { kind: 'comment', text: hostPost.text });
          if (actMem !== memories) { try { await sbUpsert('botMemories', { id: bot.id, botId: bot.id, items: actMem }); memories = actMem; } catch { /* best-effort */ } }
          if (!botIds.has(hostComment.authorId)) {
                  await createNotification({
                    userId: hostComment.authorId, type: 'comment', actorId: bot.id,
                    text: `${bot.name} replied to your comment.`, postId: hostPost.id, conversationId: '',
                    read: false, createdAt: Date.now()
                  });
                }
                actions += 1;
                acted = true;
                results.push({ bot: bot.name, action: 'comment-reply' });
              }
            }
          } else {
          const candidates = allPosts.filter((p) => p.visibility === 'public' && !p.groupId && !p.pageId && p.authorId !== bot.id);
          // One comment per post, ever: no fallback to a post the bot
          // already commented on (that fallback is what stacked
          // repeat comments onto the same post).
          const target = pickBotCommentTarget(candidates, bot);
          if (!target) results.push({ bot: bot.name, action: 'none', reason: 'no fresh post to comment on' });
          if (target) {
            const blockRow = await sbGet('blocks', `${target.authorId}_${bot.id}`);
            if (blockRow) {
              results.push({ bot: bot.name, action: 'none', reason: 'post author blocked this bot' });
            } else {
              const gen = await generateBotText(bot, memories, { kind: 'comment', text: target.text }, generateTemplateComment(bot));
              const postRow = await sbGet('posts', target.id);
              const freshComments = postRow ? (postRow.comments || []) : (target.comments || []);
              const comment = { id: genId('c'), authorId: bot.id, text: gen.text, createdAt: Date.now(), replies: [] };
              await sbUpdate('posts', target.id, { comments: [...freshComments, comment] });
              c.commentsToday += 1;
              c.lastActionAt = Date.now();
              const actMem = memoryFromActivity(memories, bot, { kind: 'comment', text: target.text });
          if (actMem !== memories) { try { await sbUpsert('botMemories', { id: bot.id, botId: bot.id, items: actMem }); memories = actMem; } catch { /* best-effort */ } }
          await createNotification({
                userId: target.authorId, type: 'comment', actorId: bot.id,
                text: `${bot.name} commented on your post.`, postId: target.id, conversationId: '',
                read: false, createdAt: Date.now()
              });
              actions += 1;
              acted = true;
              results.push({ bot: bot.name, action: 'comment' });
            }
          }
          }
        } else if (decision.action === 'like') {
          // PUBLIC posts only — the comment filter above always had
          // this check, the like filter did not, so bots could like
          // friends-only posts they were never in the audience for
          // (the admin-signed runner can READ every post).
          const target = (data().posts || []).find((p) => p.visibility === 'public' && !p.groupId && !p.pageId && p.authorId !== bot.id && !(p.likes || []).includes(bot.id));
          if (target) {
            await sbUpdate('posts', target.id, { likes: [...(target.likes || []), bot.id] });
            c.likesToday += 1;
            c.lastActionAt = Date.now();
            actions += 1;
            acted = true;
            results.push({ bot: bot.name, action: 'like' });
          }
        }
        if (!acted && !dmNote) results.push({ bot: bot.name, action: 'none', reason: decision.action === 'message' ? 'no unreplied conversations' : decision.reason });
      } catch (err) {
        results.push({ bot: bot.name, action: 'error', reason: String(err?.message || err) });
      }
      // Phase 3: collect this bot's decision(s) for the Admin history.
      for (const r of results.slice(rBefore)) {
        cycleDecisions.push({ botId: bot.id, action: r.action, reason: r.reason || '', at: Date.now() });
      }
    }
    await saveLiveBotCounters(day, counters);
    await persistBotDecisions(cycleDecisions);
    const aiFailure = getLastRoutedFailure();
    // Blocked-DM notes (pendingDMs > 0) are part of the summary even
    // though they are 'none' results: "no actions" must never hide
    // unanswered DMs (Audit fix #1).
    const dmNotes = results.filter((r) => r.pendingDMs > 0).map((r) => `${r.bot}: ${r.reason}`);
    const summary = (results.filter((r) => r.action !== 'none').map((r) => (r.action === 'error' ? `${r.bot} → error: ${r.reason}` : `${r.bot} → ${r.action}`)).join(', ') || 'no actions')
      + (dmNotes.length ? ` · ${dmNotes.join(' · ')}` : '')
      + (aiFailure ? ` · AI generation failed: ${aiFailure} (template fallback used)` : '');
    setLiveRunnerState({ lastCycleAt: Date.now(), lastSummary: summary, lastDetails: details });
    return { ran: true, results };
  } finally {
    botCycleInFlight = false;
  }
}

// The Bot panel's run button: demo mode keeps the local simulation,
// live mode runs the Spark runner above.
export async function runBotCycle() {
  if (!live) return runDemoBotCycle();
  return runLiveBotCycle();
}

export { resetDemo, findUser, userByUsername, friendIdsOf, blockedIdsOf };
export { postLimiter };
