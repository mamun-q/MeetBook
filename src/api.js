// Unified data/API layer. Two backends behind one interface:
//  - Firebase mode (env config present): Firebase Auth + Firestore + Storage.
//  - Demo mode (no config): the local seeded store in store.js.
// Views always read from data() and write through these functions, so the UI
// code is identical in both modes.
import {
  getState, mutate, findUser, userByUsername, friendIdsOf, blockedIdsOf, notify, resetDemo
} from './store.js';
import { firebaseReady, auth, db, storage, googleProvider } from './firebase.js';
import { uid as genId, validateUsername, extractMentions, normaliseGroup, normalisePage, normaliseEvent, postAudience, castPollVote, tsToMs, normaliseTimeFields, friendlyAuthError, isAdminRole, isSuperAdmin, canManageUser, canChangeRole, ASSIGNABLE_ROLES, isStaff, canModerate, REPORT_CATEGORIES, countPostComments, truncate, mergePostLists, toggleEmojiReaction, replySnapshot, chatTheme, canEditMessage } from './utils.js';
import { generateTemplatePost, generateTemplateComment, templateBotMessageReply, decideBotAction, memoryFromConversation, normaliseBot, findBotReplyTargets, emptyBotCounters, counterDayKey, botCountersForDay } from './botLogic.js';
import { canAccessBotSecrets, botModel } from './gemini.js';
import { providerById, resolveAiConfig, generateRouted, testProvider as testAiProvider, getLastRoutedFailure, resetLastRoutedFailure, anyProviderConfigured, dhakaDayKey, normaliseUsageMap, usageTotals } from './aiProviders.js';
import { isCloudinaryConfigured, uploadToCloudinary } from './cloudinary.js';

// --- Firebase imports are dynamic-free static imports of the SDK ---------
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signInWithPopup,
  sendPasswordResetEmail, signOut, deleteUser, onAuthStateChanged
} from 'firebase/auth';
import {
  collection, doc, setDoc, getDoc, getDocs, getCountFromServer, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot, serverTimestamp, arrayUnion, arrayRemove
} from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';

// -------------------------------------------------------------------------
let remote = null; // Firestore-mirrored dataset (same shape as demo state)
let remoteUid = '';
let emptyRemoteCache = null;

// Optimistic local echo for live-mode post creation: a freshly created
// post is inserted into the mirror IMMEDIATELY (under a temporary id)
// so the composer doesn't wait for the Firestore snapshot round-trip;
// when addDoc resolves, the echo adopts the real id, and the posts
// merge prunes the echo as soon as a listener delivers the server copy.
let localEchoPosts = [];

// Re-runs the posts merge (assigned inside startRemoteSync): after an
// optimistic echo adopts its real server id, the merge must run again —
// the snapshot listener can deliver the server copy BEFORE addDoc
// resolves (Firestore fires from the local cache first, and the fake
// flushes on a microtask), so a plain re-render would show the echo
// and the server copy side by side until the next listener event.
let remergePosts = null;

function emitData() {
  document.dispatchEvent(new CustomEvent('meetbook:data'));
}

// Apply a mutation to a post in the live mirror and notify listeners.
// The mirror shares object references with the sync listeners' arrays,
// so the optimistic change survives merges until the next snapshot
// replaces it with server truth. Returns the post (or null when the
// post is not mirrored / not in live mode).
function patchRemotePost(postId, apply) {
  if (!firebaseReady || !remote) return null;
  const post = remote.posts.find((p) => p.id === postId);
  if (!post) return null;
  apply(post);
  emitData();
  return post;
}

// Same optimistic-mirror pattern for messages and conversations (Chat
// Pack: reactions, pins, themes, typing heartbeats) — patch locally so
// the UI responds instantly, then let the snapshot listener confirm.
function patchRemoteMessage(messageId, apply) {
  if (!firebaseReady || !remote) return null;
  const msg = remote.messages.find((m) => m.id === messageId);
  if (!msg) return null;
  apply(msg);
  emitData();
  return msg;
}

function patchRemoteConversation(convId, apply) {
  if (!firebaseReady || !remote) return null;
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
  return addDoc(collection(db, 'notifications'), note);
}

export function data() {
  if (firebaseReady) {
    // Live mode must never fall through to demo data.
    if (remote) return remote;
    if (!emptyRemoteCache) emptyRemoteCache = blankRemote();
    return emptyRemoteCache;
  }
  return getState();
}

export function currentUid() {
  if (firebaseReady) return remoteUid;
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
    conversations: [], messages: [], notifications: [], reports: [], adminLogs: [], events: [], reviews: [], groupRequests: [],
    bots: [], botBrains: {}, botMemories: {}, botActivities: [], botLogs: [],
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
  if (firebaseReady) {
    // Create the Auth account FIRST: Firestore rules only allow signed-in
    // reads, so the username-uniqueness query must run after sign-up (an
    // unauthenticated query fails with "Missing or insufficient
    // permissions"). If anything after account creation fails, delete the
    // just-created Auth user so the email is not stranded.
    let cred;
    try {
      cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      throw new Error(friendlyAuthError(err));
    }
    const profile = {
      name: name.trim(), username: v.value, email: email.trim(), bio: '', avatar: '', cover: '',
      work: '', education: '', currentCity: '', hometown: '', relationship: '', website: '', nickname: '',
      dob: dob || '', gender: gender || '',
      role: 'user', isBot: false, online: true, lastSeen: Date.now(), createdAt: Date.now(), followers: [], following: [], closeFriends: [], settings: {}
    };
    try {
      const taken = await getDocs(query(collection(db, 'users'), where('username', '==', v.value)));
      if (!taken.empty) throw new Error('That username is already taken.');
      await setDoc(doc(db, 'users', cred.user.uid), profile);
    } catch (err) {
      try { await deleteUser(cred.user); } catch { /* rollback is best-effort */ }
      // The users-create rule denies the profile write when platform
      // registration is closed (Pack C) — surface that honestly
      // instead of a raw permission error.
      if (err?.code === 'permission-denied') throw new Error('Registration is currently closed. Please try again later.');
      throw err;
    }
    return { id: cred.user.uid, ...profile };
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
  if (firebaseReady) {
    let cred;
    try {
      cred = await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      throw new Error(friendlyAuthError(err));
    }
    remoteUid = cred.user.uid;
    // Presence: stamp online + lastSeen (the online rail freshness check
    // keys off lastSeen). Best-effort — never block the sign-in on it.
    updateDoc(doc(db, 'users', cred.user.uid), { online: true, lastSeen: Date.now() }).catch(() => {});
    return cred.user;
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
  if (!firebaseReady) throw new Error('Google sign-in needs Firebase configuration. In demo mode, register or use a demo account.');
  let cred;
  try {
    cred = await signInWithPopup(auth, googleProvider);
  } catch (err) {
    throw new Error(friendlyAuthError(err));
  }
  remoteUid = cred.user.uid;
  const ref = doc(db, 'users', cred.user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    const base = (cred.user.email || 'user').split('@')[0].replace(/[^a-z0-9_.]/gi, '').toLowerCase() || 'user';
    await setDoc(ref, {
      name: cred.user.displayName || 'MeetBook User', username: base.slice(0, 24), email: cred.user.email || '',
      bio: '', avatar: cred.user.photoURL || '', cover: '', work: '', education: '', currentCity: '',
      hometown: '', relationship: '', website: '', nickname: '', dob: '', gender: '', role: 'user', isBot: false, online: true,
      lastSeen: Date.now(), createdAt: Date.now(), followers: [], following: [], closeFriends: [], settings: {}
    });
  } else {
    updateDoc(ref, { online: true, lastSeen: Date.now() }).catch(() => {});
  }
  return cred.user;
}

export async function resetPassword(email) {
  if (firebaseReady) {
    try {
      await sendPasswordResetEmail(auth, email.trim());
    } catch (err) {
      throw new Error(friendlyAuthError(err));
    }
    return;
  }
  const exists = getState().users.some((u) => u.email === email.trim().toLowerCase());
  if (!exists) throw new Error('No demo account uses that email.');
  // Demo mode cannot send real email; we surface a clear, honest message.
  throw new Error('Demo mode: password reset email cannot be sent. In demo mode sign in with the demo password, or wire Firebase config to enable real reset emails.');
}

export async function logout() {
  if (firebaseReady) {
    // Best-effort presence stamp before the session ends.
    if (remoteUid) {
      try { await updateDoc(doc(db, 'users', remoteUid), { online: false, lastSeen: Date.now() }); } catch { /* best-effort */ }
    }
    await signOut(auth); remoteUid = ''; return;
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
  if (firebaseReady) {
    await deleteDoc(doc(db, 'users', user.id));
    await deleteUser(auth.currentUser);
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
  if (firebaseReady) {
    return onAuthStateChanged(auth, async (user) => {
      remoteUid = user ? user.uid : '';
      if (user) startRemoteSync();
      else { stopRemoteSync(); stopBotRunner(); } // no session -> no listeners, no live bot runner, ever
      cb(user ? { id: user.uid } : null);
    });
  }
  cb(me());
  return () => {};
}

// -------------------------------------------------------------------------
// FIREBASE SYNC (mirrors Firestore into the shared dataset shape)
//
// PROVABLE-QUERY DESIGN: Firestore rejects a list query unless the
// security rules are provable from the query's own constraints ("rules
// are not filters") — a listener whose read rule depends on per-document
// data the query doesn't constrain (or on get()/exists() joins) is denied
// silently. Every listener below is therefore shaped so one rule branch
// is guaranteed by its where() clauses, and audiences are DENORMALIZED
// onto documents at write time to make that possible:
//  - posts: three listeners merged by id — my own posts (authorId == me),
//    public posts (visibility == 'public'), and posts whose denormalized
//    `audienceIds` contain me (friends posts + private-group posts).
//  - stories: the same three-listener pattern as posts (public / mine /
//    audience), merged by id; expiry (24h) is filtered in the view layer.
//  - friendships: two listeners merged by id (from == me, to == me).
//  - messages: participants array-contains me (participants are copied
//    onto each message at send time).
//  - groups: two listeners merged by id (public + members contains me).
// Collections with signedIn-only read rules (users, pages, bots) can use
// plain listeners. Admin-only collections (reports, botActivities,
// botLogs) get silent error callbacks so non-admin sessions don't raise
// unhandled permission errors.
// -------------------------------------------------------------------------
let syncStarted = false;
let syncUid = '';
let unsubscribers = [];
// Register a listener under the current sync session so an account switch
// can tear every listener down (see stopRemoteSync).
function listen(...args) {
  const un = onSnapshot(...args);
  unsubscribers.push(un);
  return un;
}
function stopRemoteSync() {
  for (const un of unsubscribers) { try { un(); } catch { /* already gone */ } }
  unsubscribers = [];
  syncStarted = false;
  syncUid = '';
  remote = blankRemote();
  emitData();
}
function startRemoteSync() {
  if (!firebaseReady) return;
  // Account-switch guard: the per-user listeners below bake the uid into
  // their queries, so a sync started for a previous account must be torn
  // down and restarted — otherwise the new account keeps receiving the
  // OLD account's conversations/messages (or nothing, once rules deny the
  // stale listeners), which made sent DMs silently invisible.
  if (syncStarted && syncUid === remoteUid) return;
  if (syncStarted) stopRemoteSync();
  syncStarted = true;
  syncUid = remoteUid;
  remote = blankRemote();
  const patch = (fn) => { fn(remote); document.dispatchEvent(new CustomEvent('meetbook:data')); };
  // TIME NORMALISATION: every mirrored document passes its epoch-ms
  // fields through normaliseTimeFields — Firestore serverTimestamp()
  // values arrive as Timestamp objects, and any view that feeds one to
  // timeAgo() directly renders a 1970s date. (Stories/events mappers
  // below predate the helper and call tsToMs inline — same effect.)
  const mapUser = (d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt', 'lastSeen']) });
  listen(query(collection(db, 'users'), limit(300)), (snap) => { patch((r) => { r.users = snap.docs.map(mapUser); }); void loadBotSecrets(); void loadAdminStats(); syncLiveBotRunner(); });
  // Posts: three provable listeners merged by id (see header note).
  // Comment/reply timestamps are normalised too — they are written as
  // client-side ms today, but a Timestamp shape must never leak through.
  const mapPost = (d) => {
    const raw = normaliseTimeFields(d.data(), ['createdAt', 'editedAt']);
    // A pending serverTimestamp() reads back as null → 0 (epoch): the
    // post would flash at the bottom of the feed dated 1/1/1970 until
    // the resolved snapshot lands. Estimate it as "now" instead — the
    // resolved value replaces it a moment later.
    if (!raw.createdAt) raw.createdAt = Date.now();
    const comments = (raw.comments || []).map((c) => ({
      ...normaliseTimeFields(c, ['createdAt']),
      replies: (c.replies || []).map((rep) => normaliseTimeFields(rep, ['createdAt']))
    }));
    return { id: d.id, comments: [], likes: [], reactions: {}, savedBy: [], groupId: '', pageId: '', audienceIds: [], ...raw, comments };
  };
  let ownPosts = [];
  let publicPosts = [];
  let audiencePosts = [];
  const mergePosts = () => patch((r) => {
    // Dedupe by id across the three listeners (a public post by a
    // friend matches two of them) plus the optimistic echo list; the
    // server copies come last so they replace their echoes.
    const delivered = new Set([...publicPosts, ...audiencePosts, ...ownPosts].map((p) => p.id));
    localEchoPosts = localEchoPosts.filter((p) => !delivered.has(p.id));
    r.posts = mergePostLists(localEchoPosts, publicPosts, audiencePosts, ownPosts);
  });
  remergePosts = mergePosts;
  listen(query(collection(db, 'posts'), where('visibility', '==', 'public'), orderBy('createdAt', 'desc'), limit(100)),
    (snap) => { publicPosts = snap.docs.map(mapPost); mergePosts(); },
    () => { /* listener rejected — leave the mirrored set untouched */ });
  // Stories: same provable three-listener pattern as posts, merged by id.
  // createdAt is normalised to epoch ms (Firestore returns Timestamps) so
  // the 24h expiry filter in the view layer compares real numbers.
  const mapStory = (d) => {
    const raw = d.data();
    return { id: d.id, image: '', text: '', bg: 'sunset', audienceIds: [], views: [], ...raw, createdAt: tsToMs(raw.createdAt) || Date.now() };
  };
  let ownStories = [];
  let publicStories = [];
  let audienceStories = [];
  const mergeStories = () => patch((r) => {
    const byIdMap = new Map();
    for (const s of [...publicStories, ...audienceStories, ...ownStories]) byIdMap.set(s.id, s);
    r.stories = [...byIdMap.values()];
  });
  listen(query(collection(db, 'stories'), where('visibility', '==', 'public'), orderBy('createdAt', 'desc'), limit(100)),
    (snap) => { publicStories = snap.docs.map(mapStory); mergeStories(); },
    () => { /* listener rejected — leave the mirrored set untouched */ });
  // Events: same provable three-listener pattern as posts (public /
  // createdBy == me / audienceIds contains me), merged by id. dateTime is
  // normalised to epoch ms like story createdAt.
  const mapEvent = (d) => {
    const raw = d.data();
    return { id: d.id, description: '', location: '', cover: '', audienceIds: [], going: [], interested: [], ...raw, dateTime: tsToMs(raw.dateTime), createdAt: tsToMs(raw.createdAt) };
  };
  let ownEvents = [];
  let publicEvents = [];
  let audienceEvents = [];
  const mergeEvents = () => patch((r) => {
    const byIdMap = new Map();
    for (const e of [...publicEvents, ...audienceEvents, ...ownEvents]) byIdMap.set(e.id, e);
    r.events = [...byIdMap.values()];
  });
  listen(query(collection(db, 'events'), where('visibility', '==', 'public'), orderBy('dateTime', 'asc'), limit(100)),
    (snap) => { publicEvents = snap.docs.map(mapEvent); mergeEvents(); },
    () => { /* listener rejected — leave the mirrored set untouched */ });
  // Reviews: the read rule is signedIn-only (field-independent), so a
  // plain listener is provable — same as users/pages.
  listen(query(collection(db, 'reviews'), orderBy('createdAt', 'desc'), limit(500)),
    (snap) => patch((r) => { r.reviews = snap.docs.map((d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) })); }),
    () => { /* listener rejected — leave the mirrored set untouched */ });
  listen(query(collection(db, 'pages'), limit(200)), (snap) => patch((r) => { r.pages = snap.docs.map((d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) })); }));
  // Groups use two provably-readable queries merged by id (public groups +
  // groups I belong to): a single unfiltered listener would be rejected by
  // the rules because private groups I cannot see exist in the collection.
  let publicGroups = [];
  let memberGroups = [];
  const mergeGroups = () => patch((r) => {
    const byIdMap = new Map();
    for (const g of [...publicGroups, ...memberGroups]) byIdMap.set(g.id, g);
    r.groups = [...byIdMap.values()];
  });
  const mapGroup = (d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) });
  listen(query(collection(db, 'groups'), where('privacy', '==', 'public'), limit(200)), (snap) => { publicGroups = snap.docs.map(mapGroup); mergeGroups(); });
  // Friendships: two provable listeners merged by id (from == me, to == me).
  let friendshipsFrom = [];
  let friendshipsTo = [];
  const mergeFriendships = () => patch((r) => {
    const byIdMap = new Map();
    for (const f of [...friendshipsFrom, ...friendshipsTo]) byIdMap.set(f.id, f);
    r.friendships = [...byIdMap.values()];
  });
  const mapFriendship = (d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) });
  listen(query(collection(db, 'bots'), limit(100)), (snap) => patch((r) => { r.bots = snap.docs.map((d) => normaliseBot({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) })); }));
  listen(query(collection(db, 'botActivities'), orderBy('createdAt', 'desc'), limit(100)),
    (snap) => patch((r) => { r.botActivities = snap.docs.map((d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) })); }),
    () => { /* non-admins cannot read bot activities — ignore */ });
  listen(query(collection(db, 'botLogs'), orderBy('createdAt', 'desc'), limit(100)),
    (snap) => patch((r) => { r.botLogs = snap.docs.map((d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) })); }),
    () => { /* non-admins cannot read bot logs — ignore */ });
  listen(doc(db, 'botSettings', 'global'), (snap) => patch((r) => { if (snap.exists()) r.botSettings.global = snap.data(); }));
  listen(doc(db, 'config', 'app'), (snap) => patch((r) => { if (snap.exists()) r.config = { ...r.config, ...snap.data() }; }));
  // Announcements (Pack C): the read rule is signedIn-only
  // (field-independent), so a plain ordered listener is provable.
  listen(query(collection(db, 'announcements'), orderBy('createdAt', 'desc'), limit(50)),
    (snap) => patch((r) => { r.announcements = snap.docs.map((d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) })); }),
    () => { /* listener rejected — leave the mirrored set untouched */ });
  if (remoteUid) {
    listen(query(collection(db, 'posts'), where('authorId', '==', remoteUid)),
      (snap) => { ownPosts = snap.docs.map(mapPost); mergePosts(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    listen(query(collection(db, 'posts'), where('audienceIds', 'array-contains', remoteUid)),
      (snap) => { audiencePosts = snap.docs.map(mapPost); mergePosts(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    listen(query(collection(db, 'stories'), where('authorId', '==', remoteUid)),
      (snap) => { ownStories = snap.docs.map(mapStory); mergeStories(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    listen(query(collection(db, 'stories'), where('audienceIds', 'array-contains', remoteUid)),
      (snap) => { audienceStories = snap.docs.map(mapStory); mergeStories(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    listen(query(collection(db, 'events'), where('createdBy', '==', remoteUid)),
      (snap) => { ownEvents = snap.docs.map(mapEvent); mergeEvents(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    listen(query(collection(db, 'events'), where('audienceIds', 'array-contains', remoteUid)),
      (snap) => { audienceEvents = snap.docs.map(mapEvent); mergeEvents(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    // Group join requests: two provable listeners merged by id — requests
    // I made (userId == me) and requests for groups I own
    // (groupOwnerId == me, denormalized onto the request at creation).
    let myGroupRequests = [];
    let ownedGroupRequests = [];
    const mergeGroupRequests = () => patch((r) => {
      const byIdMap = new Map();
      for (const g of [...myGroupRequests, ...ownedGroupRequests]) byIdMap.set(g.id, g);
      r.groupRequests = [...byIdMap.values()];
    });
    const mapGroupRequest = (d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) });
    listen(query(collection(db, 'groupRequests'), where('userId', '==', remoteUid)),
      (snap) => { myGroupRequests = snap.docs.map(mapGroupRequest); mergeGroupRequests(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    listen(query(collection(db, 'groupRequests'), where('groupOwnerId', '==', remoteUid)),
      (snap) => { ownedGroupRequests = snap.docs.map(mapGroupRequest); mergeGroupRequests(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    listen(query(collection(db, 'friendships'), where('from', '==', remoteUid)),
      (snap) => { friendshipsFrom = snap.docs.map(mapFriendship); mergeFriendships(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    listen(query(collection(db, 'friendships'), where('to', '==', remoteUid)),
      (snap) => { friendshipsTo = snap.docs.map(mapFriendship); mergeFriendships(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    listen(query(collection(db, 'notifications'), where('userId', '==', remoteUid), orderBy('createdAt', 'desc'), limit(100)),
      (snap) => patch((r) => { r.notifications = snap.docs.map((d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) })); }));
    listen(query(collection(db, 'conversations'), where('participants', 'array-contains', remoteUid)),
      (snap) => patch((r) => { r.conversations = snap.docs.map((d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) })); }));
    const applyMessages = (snap) => patch((r) => { r.messages = snap.docs.map((d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) })); });
    listen(query(collection(db, 'messages'), where('participants', 'array-contains', remoteUid), orderBy('createdAt', 'asc'), limit(500)),
      applyMessages,
      () => {
        // The ordered query needs a composite index; if it is missing or
        // still building, the inbox must NOT silently stay empty (that
        // failure mode hid every DM while sends/posts/notifications all
        // worked). Fall back to the single-field query — its index is
        // automatic — and let the view layer sort by createdAt.
        listen(query(collection(db, 'messages'), where('participants', 'array-contains', remoteUid), limit(500)),
          applyMessages,
          () => { /* both queries rejected — leave the mirrored set untouched */ });
      });
    listen(query(collection(db, 'blocks'), where('by', '==', remoteUid)),
      (snap) => patch((r) => { r.blocks = snap.docs.map((d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) })); }));
    listen(query(collection(db, 'groups'), where('members', 'array-contains', remoteUid), limit(200)),
      (snap) => { memberGroups = snap.docs.map(mapGroup); mergeGroups(); });
    listen(query(collection(db, 'reports'), orderBy('createdAt', 'desc'), limit(100)),
      (snap) => patch((r) => { r.reports = snap.docs.map((d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) })); }), () => { /* non-admins cannot read reports — ignore */ });
    // Audit trail: readable by admins/superadmins only (rules), so the
    // listener simply never delivers for anyone else.
    listen(query(collection(db, 'adminLogs'), orderBy('createdAt', 'desc'), limit(200)),
      (snap) => patch((r) => { r.adminLogs = snap.docs.map((d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) })); }), () => { /* moderators/analysts cannot read the audit log — ignore */ });
  }
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
  }
  if (firebaseReady) { await updateDoc(doc(db, 'users', userId), patch); return; }
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
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
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
  // 1) Cloudinary first when configured (free tier): the Firebase project is
  //    on Spark, where Firebase Storage is unavailable, so Cloudinary is the
  //    working hosted storage and Firestore then stores only the image URL.
  if (isCloudinaryConfigured()) {
    try {
      return await uploadToCloudinary(file);
    } catch (err) {
      console.warn('Cloudinary upload failed, falling back:', err?.message || err);
    }
  }
  // 2) Firebase Storage (works once the project is on Blaze).
  if (firebaseReady && storage) {
    try {
      const r = storageRef(storage, path);
      await uploadBytes(r, file, { contentType: file.type });
      return await getDownloadURL(r);
    } catch (err) {
      // STORAGE FALLBACK: Firebase Storage is not enabled on this project yet
      // (it requires the Blaze plan; the project is on Spark). Degrade
      // gracefully instead of breaking posting/profile flows: store a
      // compressed image (canvas-resized, max ~200KB) as a data URL directly
      // in the Firestore document. Once Storage is enabled, new uploads use
      // Storage automatically and old data-URL images keep rendering.
      console.warn('Firebase Storage unavailable, using compressed data-URL fallback:', err?.code || err);
    }
  }
  // 3) Demo mode / all hosted storage unavailable: compressed data URL
  //    stored locally (demo store) or in the Firestore document (live mode).
  return compressImageToDataUrl(file);
}

export function setOnline(userId, online) {
  // Every presence write also stamps lastSeen: the online rail treats a
  // user as online only when the flag is set AND lastSeen is fresh
  // (older docs without lastSeen fall back to the flag alone).
  if (firebaseReady) { updateDoc(doc(db, 'users', userId), { online, lastSeen: Date.now() }).catch(() => {}); return; }
  mutate((s) => { const u = s.users.find((x) => x.id === userId); if (u) { u.online = online; u.lastSeen = Date.now(); } });
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
  if (firebaseReady) {
    // Optimistic echo: show the post in the feed at once under a temp
    // id; the echo adopts the real id when the write lands and the
    // posts merge prunes it once a listener delivers the server copy.
    const echo = { id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ...post };
    localEchoPosts = [echo, ...localEchoPosts];
    // Rebuild the mirror now (not just emit): the echo only becomes
    // visible once the merge runs, and the snapshot may not fire until
    // the server copy arrives.
    if (remergePosts) remergePosts(); else emitData();
    try {
      const ref = await addDoc(collection(db, 'posts'), { ...post, createdAt: serverTimestamp() });
      echo.id = ref.id;
      if (remergePosts) remergePosts(); else emitData();
      fanOutMentions(post.text, author, ref.id);
      return { id: ref.id, ...post };
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
    const snap = await getDocs(query(collection(db, 'users'), where('username', '==', uname)));
    for (const d of snap.docs) {
      await createNotification({ userId: d.id, type: 'mention', actorId: author.id, text: `${author.name} mentioned you in a post.`, postId, conversationId: '', read: false, createdAt: Date.now() });
    }
  }
}

export async function editPost(postId, text) {
  if (firebaseReady) { await updateDoc(doc(db, 'posts', postId), { text, editedAt: Date.now() }); return; }
  mutate((s) => { const p = s.posts.find((x) => x.id === postId); if (p) { p.text = text; p.editedAt = Date.now(); } });
}

export async function deletePost(postId) {
  if (firebaseReady) { await deleteDoc(doc(db, 'posts', postId)); return; }
  mutate((s) => { s.posts = s.posts.filter((p) => p.id !== postId); });
}

export async function toggleLike(postId) {
  const user = me(); if (!user) throw new Error('Sign in to like posts.');
  if (firebaseReady) {
    const post = data().posts.find((p) => p.id === postId);
    const has = post?.likes?.includes(user.id);
    // Optimistic: flip the mirror first so the heart/count update in
    // the same frame as the tap; roll back if the write fails.
    const applyLike = (p) => { p.likes = has ? (p.likes || []).filter((id) => id !== user.id) : [...(p.likes || []), user.id]; };
    const undoLike = (p) => { p.likes = has ? [...(p.likes || []), user.id] : (p.likes || []).filter((id) => id !== user.id); };
    patchRemotePost(postId, applyLike);
    try {
      await updateDoc(doc(db, 'posts', postId), { likes: has ? arrayRemove(user.id) : arrayUnion(user.id) });
    } catch (err) { patchRemotePost(postId, undoLike); throw err; }
    if (!has && post) await createNotification({ userId: post.authorId, type: 'like', actorId: user.id, text: `${user.name} liked your post.`, postId, conversationId: '', read: false, createdAt: Date.now() });
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
  if (firebaseReady) {
    const post = data().posts.find((p) => p.id === postId);
    const prevReactions = post ? { ...(post.reactions || {}) } : null;
    const reactions = { ...(post?.reactions || {}) };
    if (reactions[user.id] === emoji) delete reactions[user.id]; else reactions[user.id] = emoji;
    patchRemotePost(postId, (p) => { p.reactions = reactions; });
    try {
      await updateDoc(doc(db, 'posts', postId), { reactions });
    } catch (err) { if (prevReactions) patchRemotePost(postId, (p) => { p.reactions = prevReactions; }); throw err; }
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
  if (firebaseReady) {
    const post = data().posts.find((p) => p.id === postId);
    const has = post?.savedBy?.includes(user.id);
    const applySave = (p) => { p.savedBy = has ? (p.savedBy || []).filter((id) => id !== user.id) : [...(p.savedBy || []), user.id]; };
    const undoSave = (p) => { p.savedBy = has ? [...(p.savedBy || []), user.id] : (p.savedBy || []).filter((id) => id !== user.id); };
    patchRemotePost(postId, applySave);
    try {
      await updateDoc(doc(db, 'posts', postId), { savedBy: has ? arrayRemove(user.id) : arrayUnion(user.id) });
    } catch (err) { patchRemotePost(postId, undoSave); throw err; }
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
  if (firebaseReady) {
    const prevPoll = post.poll;
    patchRemotePost(postId, (p) => { p.poll = { options: prevPoll.options, votes }; });
    try {
      await updateDoc(doc(db, 'posts', postId), { poll: { options: post.poll.options, votes } });
    } catch (err) { patchRemotePost(postId, (p) => { p.poll = prevPoll; }); throw err; }
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
  if (firebaseReady) { await updateDoc(doc(db, 'posts', postId), { pinned }); return pinned; }
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
  if (firebaseReady) {
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
      const ref = await addDoc(collection(db, 'posts'), shared);
      echo.id = ref.id;
      if (remergePosts) remergePosts(); else emitData();
      await updateDoc(doc(db, 'posts', postId), { shares: nextShares });
    } catch (err) {
      localEchoPosts = localEchoPosts.filter((p) => p !== echo);
      patchRemotePost(postId, (p) => { p.shares = Math.max(0, nextShares - 1); });
      if (remergePosts) remergePosts(); else emitData();
      throw err;
    }
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
  if (firebaseReady) {
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
      await updateDoc(doc(db, 'posts', postId), { comments });
    } catch (err) { patchRemotePost(postId, (p) => { p.comments = prevComments; }); throw err; }
    if (post) await createNotification({ userId: post.authorId, type: parentCommentId ? 'reply' : 'comment', actorId: user.id, text: `${user.name} ${parentCommentId ? 'replied to a comment' : 'commented on your post.'}`, postId, conversationId: '', read: false, createdAt: Date.now() });
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
  if (firebaseReady) {
    const post = data().posts.find((p) => p.id === postId);
    const prevComments = post?.comments || [];
    const comments = prevComments.filter((c) => c.id !== commentId)
      .map((c) => ({ ...c, replies: (c.replies || []).filter((r) => r.id !== commentId) }));
    patchRemotePost(postId, (p) => { p.comments = comments; });
    try {
      await updateDoc(doc(db, 'posts', postId), { comments });
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
  if (firebaseReady) { await addDoc(collection(db, 'reports'), report); return report; }
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
  if (firebaseReady) {
    const ref = await addDoc(collection(db, 'stories'), { ...story, createdAt: serverTimestamp() });
    return { id: ref.id, ...story };
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
  if (firebaseReady) { await updateDoc(doc(db, 'stories', storyId), { views: arrayUnion(user.id) }); return; }
  mutate((s) => {
    const st = (s.stories || []).find((x) => x.id === storyId);
    if (st && !(st.views || []).includes(user.id)) st.views = [...(st.views || []), user.id];
  });
}

export async function deleteStory(storyId) {
  if (firebaseReady) { await deleteDoc(doc(db, 'stories', storyId)); return; }
  mutate((s) => { s.stories = (s.stories || []).filter((x) => x.id !== storyId); });
}

// -------------------------------------------------------------------------
// GROUPS
// -------------------------------------------------------------------------
export async function createGroup({ name, description, privacy, cover }) {
  const user = me(); if (!user) throw new Error('Sign in to create a group.');
  const group = normaliseGroup({ name, description, privacy, cover }, user.id);
  if (!group.name) throw new Error('Give your group a name.');
  if (firebaseReady) {
    const ref = await addDoc(collection(db, 'groups'), group);
    return { id: ref.id, ...group };
  }
  const full = { id: genId('g'), ...group };
  mutate((s) => { (s.groups = s.groups || []).unshift(full); });
  return full;
}

export async function updateGroup(groupId, patch) {
  if (firebaseReady) { await updateDoc(doc(db, 'groups', groupId), patch); return { id: groupId, ...patch }; }
  let updated = null;
  mutate((s) => {
    const g = (s.groups || []).find((x) => x.id === groupId);
    if (g) { Object.assign(g, patch); updated = g; }
  });
  return updated;
}

export async function deleteGroup(groupId) {
  if (firebaseReady) {
    // Remove the group's posts first so no orphaned group posts remain.
    const snap = await getDocs(query(collection(db, 'posts'), where('groupId', '==', groupId)));
    for (const d of snap.docs) await deleteDoc(doc(db, 'posts', d.id));
    await deleteDoc(doc(db, 'groups', groupId));
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
      if (firebaseReady) { await deleteDoc(doc(db, 'groupRequests', requestId)); return 'withdrawn'; }
      mutate((s) => { s.groupRequests = (s.groupRequests || []).filter((r) => r.id !== requestId); });
      return 'withdrawn';
    }
    // groupOwnerId is denormalized onto the request so the creator's
    // queue listener + read rule stay provable (no join to the group).
    const request = { groupId, groupOwnerId: group.createdBy, userId: user.id, status: 'pending', createdAt: Date.now() };
    if (firebaseReady) {
      await setDoc(doc(db, 'groupRequests', requestId), request);
      await createNotification({ userId: group.createdBy, type: 'group_request', actorId: user.id, text: `${user.name} asked to join your private group "${group.name}".`, postId: '', conversationId: '', read: false, createdAt: Date.now() });
      return 'requested';
    }
    mutate((s) => {
      s.groupRequests = (s.groupRequests || []).filter((r) => r.id !== requestId);
      s.groupRequests.unshift({ id: requestId, ...request });
      notify(group.createdBy, 'group_request', user.id, `${user.name} asked to join your private group "${group.name}".`);
    });
    return 'requested';
  }
  if (firebaseReady) {
    await updateDoc(doc(db, 'groups', groupId), { members: isMember ? arrayRemove(user.id) : arrayUnion(user.id) });
    if (!isMember) await createNotification({ userId: group.createdBy, type: 'group_join', actorId: user.id, text: `${user.name} joined your group "${group.name}".`, postId: '', conversationId: '', read: false, createdAt: Date.now() });
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
  if (firebaseReady) {
    if (approve) await updateDoc(doc(db, 'groups', group.id), { members: arrayUnion(request.userId) });
    await updateDoc(doc(db, 'groupRequests', requestId), { status });
    await createNotification({ userId: request.userId, type: 'group_request_result', actorId: user.id, text: approve ? `Your request to join "${group.name}" was approved.` : `Your request to join "${group.name}" was declined.`, postId: '', conversationId: '', read: false, createdAt: Date.now() });
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
  if (firebaseReady) { await updateDoc(doc(db, 'groups', groupId), { members: arrayRemove(memberId) }); return true; }
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
  if (firebaseReady) {
    const ref = await addDoc(collection(db, 'pages'), page);
    return { id: ref.id, ...page };
  }
  const full = { id: genId('pg'), ...page };
  mutate((s) => { (s.pages = s.pages || []).unshift(full); });
  return full;
}

export async function updatePage(pageId, patch) {
  if (firebaseReady) { await updateDoc(doc(db, 'pages', pageId), patch); return { id: pageId, ...patch }; }
  let updated = null;
  mutate((s) => {
    const p = (s.pages || []).find((x) => x.id === pageId);
    if (p) { Object.assign(p, patch); updated = p; }
  });
  return updated;
}

export async function deletePage(pageId) {
  if (firebaseReady) {
    const snap = await getDocs(query(collection(db, 'posts'), where('pageId', '==', pageId)));
    for (const d of snap.docs) await deleteDoc(doc(db, 'posts', d.id));
    await deleteDoc(doc(db, 'pages', pageId));
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
  if (firebaseReady) {
    await updateDoc(doc(db, 'pages', pageId), { followers: following ? arrayRemove(user.id) : arrayUnion(user.id) });
    if (!following) await createNotification({ userId: page.ownerId, type: 'page_follow', actorId: user.id, text: `${user.name} started following your page "${page.name}".`, postId: '', conversationId: '', read: false, createdAt: Date.now() });
    return !following;
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
  if (firebaseReady) {
    const ref = await addDoc(collection(db, 'events'), event);
    return { id: ref.id, ...event };
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
  if (firebaseReady) { await deleteDoc(doc(db, 'events', eventId)); return true; }
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
  if (firebaseReady) {
    await updateDoc(doc(db, 'events', eventId), next);
    if (!active && event.createdBy !== user.id) {
      await createNotification({ userId: event.createdBy, type: 'event_rsvp', actorId: user.id, text: `${user.name} is ${kind === 'going' ? 'going to' : 'interested in'} your event "${event.title}".`, postId: '', conversationId: '', read: false, createdAt: Date.now() });
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
  if (firebaseReady) {
    if (existing) { await updateDoc(doc(db, 'reviews', existing.id), { rating: review.rating, text: review.text }); return { id: existing.id, ...review }; }
    const ref = await addDoc(collection(db, 'reviews'), review);
    return { id: ref.id, ...review };
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
  if (firebaseReady) { await deleteDoc(doc(db, 'reviews', reviewId)); return true; }
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
  if (firebaseReady) {
    // Guard (mirrors the demo branch): if ANY friendship already links
    // the pair — friends, or a request already pending in either
    // direction — do nothing. Without this, every repeated tap wrote
    // another identical friend_request notification document.
    const existing = data().friendships.find((f) => (f.from === user.id && f.to === toId) || (f.from === toId && f.to === user.id));
    if (existing) return;
    // Deterministic doc id ({from}_{to}) so firestore.rules can verify a
    // friendship with a single exists() check for friends-only posts.
    await setDoc(doc(db, 'friendships', `${user.id}_${toId}`), { from: user.id, to: toId, status: 'pending', createdAt: Date.now() });
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
  if (firebaseReady) {
    if (accept) await updateDoc(doc(db, 'friendships', friendshipId), { status: 'accepted' });
    else await deleteDoc(doc(db, 'friendships', friendshipId));
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
  if (firebaseReady) { await deleteDoc(doc(db, 'friendships', friendshipId)); return; }
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
  if (firebaseReady) {
    await updateDoc(doc(db, 'users', user.id), { following: following ? arrayRemove(targetId) : arrayUnion(targetId) });
    await updateDoc(doc(db, 'users', targetId), { followers: following ? arrayRemove(user.id) : arrayUnion(user.id) });
    return !following;
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
  if (firebaseReady) {
    // Deterministic doc id ({by}_{target}) to match firestore.rules helpers.
    const ref = doc(db, 'blocks', `${user.id}_${targetId}`);
    const snap = await getDoc(ref);
    if (snap.exists()) { await deleteDoc(ref); return false; }
    await setDoc(ref, { by: user.id, target: targetId, createdAt: Date.now() });
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
  if (firebaseReady) {
    // Idempotent get-or-create (Audit fix #2): the local mirror alone
    // is NOT a safe existence check in live mode — it only holds what
    // the listener has delivered so far, so opening a chat before the
    // first snapshot (or right after creating one in another tab, or
    // when the other side created the thread first) minted a SECOND
    // conversation doc for the same pair. Ask Firestore directly:
    // every conversation I belong to, filtered by the pair predicate.
    const snap = await getDocs(query(collection(db, 'conversations'), where('participants', 'array-contains', user.id)));
    const found = snap.docs
      .map((d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) }))
      .find(isPair);
    if (found) {
      mirrorConversation(found);
      return found;
    }
    const ref = await addDoc(collection(db, 'conversations'), conv);
    const created = { id: ref.id, ...conv };
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
  if (!firebaseReady || !remote || !conv?.id) return;
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
  if (firebaseReady) {
    const ref = await addDoc(collection(db, 'conversations'), conv);
    return { id: ref.id, ...conv };
  }
  const full = { id: genId('conv'), ...conv };
  mutate((s) => { s.conversations.push(full); });
  return full;
}

export async function sendMessage(conversationId, { text, image, audio = '', replyToId = '', forwarded = false }) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const conv = data().conversations.find((c) => c.id === conversationId);
  // Participants are DENORMALIZED onto the message: the messages read
  // rule and the live listener filter on this array, because a get() join
  // to the conversation document is not provable for list queries.
  // `audio` is a base64 data URL for voice messages (recorded client-side,
  // capped at ~60s / ~700KB by the composer before it gets here).
  const msg = { conversationId, participants: conv ? [...conv.participants] : [], senderId: user.id, text: String(text || '').trim(), image: image || '', audio: audio || '', createdAt: Date.now(), status: 'sent', readBy: [user.id] };
  if (forwarded) msg.forwarded = true;
  if (!msg.text && !msg.image && !msg.audio) throw new Error('Message cannot be empty.');
  // Reply/quote (Chat Pack): snapshot the quoted message onto the new
  // one — its id, its author's name and a ≤120-char snippet — but only
  // when the original really belongs to this conversation.
  if (replyToId) {
    const original = data().messages.find((m) => m.id === replyToId && m.conversationId === conversationId);
    const snap = original ? replySnapshot(original, data().users.find((u) => u.id === original.senderId)?.name || '') : null;
    if (snap) Object.assign(msg, snap);
  }
  const others = (conv?.participants || []).filter((p) => p !== user.id);
  const noteText = msg.audio && !msg.text ? `${user.name} sent you a voice message.` : `${user.name} sent you a message.`;
  if (firebaseReady) {
    const ref = await addDoc(collection(db, 'messages'), msg);
    // Mirror my own message at once (same id the listener will deliver):
    // the sender must see it immediately, even before the snapshot lands.
    if (remote && !remote.messages.some((m) => m.id === ref.id)) {
      remote.messages = [...remote.messages, { id: ref.id, ...msg }];
      emitData();
    }
    for (const other of others) {
      await createNotification({ userId: other, type: 'message', actorId: user.id, text: noteText, postId: '', conversationId, read: false, createdAt: Date.now() });
    }
    return { id: ref.id, ...msg };
  }
  const full = { id: genId('m'), ...msg };
  mutate((s) => {
    s.messages.push(full);
    for (const other of others) notify(other, 'message', user.id, noteText, { conversationId });
  });
  return full;
}

export async function markConversationRead(conversationId) {
  const user = me(); if (!user) return;
  if (firebaseReady) {
    const mine = data().messages.filter((m) => m.conversationId === conversationId && !m.readBy?.includes(user.id));
    for (const m of mine) await updateDoc(doc(db, 'messages', m.id), { readBy: arrayUnion(user.id), status: 'read' });
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
// Typing heartbeat: conversations.typing is a { uid: epochMs } map. The
// client refreshes its own entry while typing (throttled in main.js)
// and clears it on send/blur; readers only honour entries younger than
// TYPING_FRESH_MS (utils), so a vanished client stops "typing" within
// seconds. Best-effort by design — a failed write is swallowed, never
// surfaced over the conversation itself.
export async function setTyping(conversationId, isTyping) {
  const user = me(); if (!user) return;
  const conv = data().conversations.find((c) => c.id === conversationId);
  if (!conv || !conv.participants?.includes(user.id)) return;
  const next = { ...(conv.typing || {}) };
  if (isTyping) next[user.id] = Date.now(); else delete next[user.id];
  if (firebaseReady) {
    patchRemoteConversation(conversationId, (c) => { c.typing = next; });
    try { await updateDoc(doc(db, 'conversations', conversationId), { typing: next }); } catch { /* heartbeat — best effort */ }
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
  if (firebaseReady) {
    patchRemoteMessage(messageId, (m) => { m.reactions = next; });
    try {
      await updateDoc(doc(db, 'messages', messageId), { reactions: next });
    } catch (err) {
      if (prev) patchRemoteMessage(messageId, (m) => { m.reactions = prev; });
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
  if (firebaseReady) {
    const prev = { pinned: Boolean(msg.pinned), pinnedBy: msg.pinnedBy || '', pinnedAt: msg.pinnedAt || 0 };
    patchRemoteMessage(messageId, (m) => Object.assign(m, patch));
    try {
      await updateDoc(doc(db, 'messages', messageId), patch);
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
  if (firebaseReady) {
    patchRemoteConversation(conversationId, (c) => { c.theme = theme; });
    await updateDoc(doc(db, 'conversations', conversationId), { theme });
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
  if (firebaseReady) {
    const prev = {};
    for (const k of prevKeys) prev[k] = msg[k];
    patchRemoteMessage(messageId, (m) => Object.assign(m, patch));
    try {
      await updateDoc(doc(db, 'messages', messageId), patch);
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
  if (!src.text && !src.image) throw new Error('Only text and photo messages can be forwarded.');
  return sendMessage(targetConversationId, { text: src.text || '', image: src.image || '', forwarded: true });
}

// Archive / mute are per-user: uid arrays on the conversation doc
// (archivedBy / mutedBy), so they follow the user across devices.
export async function setConversationFlag(conversationId, flag, on) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  if (!['archivedBy', 'mutedBy'].includes(flag)) throw new Error('Unknown flag.');
  const conv = data().conversations.find((c) => c.id === conversationId);
  if (!conv || !conv.participants?.includes(user.id)) throw new Error('Conversation not found.');
  const next = on
    ? [...new Set([...(conv[flag] || []), user.id])]
    : (conv[flag] || []).filter((id) => id !== user.id);
  if (firebaseReady) {
    const prev = conv[flag] || [];
    patchRemoteConversation(conversationId, (c) => { c[flag] = next; });
    try {
      await updateDoc(doc(db, 'conversations', conversationId), { [flag]: next });
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
  if (firebaseReady) {
    patchRemoteConversation(conversationId, (c) => { c.emoji = value; });
    await updateDoc(doc(db, 'conversations', conversationId), { emoji: value });
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
  if (firebaseReady) {
    const prev = {};
    for (const k of prevKeys) prev[k] = conv[k];
    patchRemoteConversation(conversationId, (c) => Object.assign(c, patch));
    try {
      await updateDoc(doc(db, 'conversations', conversationId), patch);
    } catch (err) {
      patchRemoteConversation(conversationId, (c) => Object.assign(c, prev));
      throw err;
    }
    return;
  }
  mutate((s) => { const c = s.conversations.find((x) => x.id === conversationId); if (c) Object.assign(c, patch); });
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
  if (firebaseReady) {
    const mine = data().notifications.filter((n) => n.userId === user.id && !n.read);
    // Patch the mirror first so the badge clears in ONE click — waiting
    // for each update's snapshot round-trip left stale unread counts
    // behind (audit 2026-11-20: badge went 5 → 1 on the first click).
    // The listener confirms with server truth on its next snapshot.
    if (remote) {
      for (const n of remote.notifications) if (n.userId === user.id) n.read = true;
      emitData();
    }
    await Promise.all(mine.map((n) => updateDoc(doc(db, 'notifications', n.id), { read: true })));
    return;
  }
  mutate((s) => { for (const n of s.notifications) if (n.userId === user.id) n.read = true; });
}

export async function markNotificationRead(id) {
  if (firebaseReady) {
    if (remote) {
      const n = remote.notifications.find((x) => x.id === id);
      if (n && !n.read) { n.read = true; emitData(); }
    }
    await updateDoc(doc(db, 'notifications', id), { read: true });
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
// — getCountFromServer for posts/messages, plus a bounded posts scan
// (newest 500) for the comments/likes sums. Staff-only: the load is
// gated on utils.isStaff(me()) and each query settles independently,
// so a tier that may not read a collection (e.g. an analyst scanning
// posts) simply falls back to mirror numbers for that metric —
// utils.platformStats flags the source per metric and the UI labels
// fallbacks "from loaded data". Nothing is ever estimated.
const ADMIN_STATS_POST_SCAN = 500;
let adminStatsLoadedFor = '';
export async function loadAdminStats() {
  if (!firebaseReady) return null;
  const user = me();
  if (!user || !isStaff(user)) return null;
  if (adminStatsLoadedFor === user.id && remote?.adminStats) return remote.adminStats;
  adminStatsLoadedFor = user.id;
  const settle = async (p) => { try { return await p; } catch { return null; } };
  const [postsCount, messagesCount, postsSnap] = await Promise.all([
    settle(getCountFromServer(collection(db, 'posts'))),
    settle(getCountFromServer(collection(db, 'messages'))),
    settle(getDocs(query(collection(db, 'posts'), orderBy('createdAt', 'desc'), limit(ADMIN_STATS_POST_SCAN))))
  ]);
  let commentsTotal = null;
  let likesTotal = null;
  if (postsSnap) {
    commentsTotal = 0;
    likesTotal = 0;
    for (const snap of postsSnap.docs) {
      const p = snap.data();
      commentsTotal += countPostComments(p);
      likesTotal += (p.likes || []).length;
    }
  }
  const stats = {
    postsTotal: postsCount ? postsCount.data().count : null,
    messagesTotal: messagesCount ? messagesCount.data().count : null,
    commentsTotal,
    likesTotal,
    scannedPosts: postsSnap ? postsSnap.size : 0,
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
  if (firebaseReady) {
    try {
      const ref = await addDoc(collection(db, 'adminLogs'), entry);
      return { id: ref.id, ...entry };
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
  if (firebaseReady) { await updateDoc(doc(db, 'users', userId), patch); return; }
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
  const ownPosts = data().posts.filter((p) => p.authorId === userId);
  if (firebaseReady) {
    for (const p of ownPosts) { try { await deleteDoc(doc(db, 'posts', p.id)); } catch { /* best-effort cleanup */ } }
    await deleteDoc(doc(db, 'users', userId));
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
  if (firebaseReady) {
    await createNotification({ userId, type: 'warning', actorId: actor.id, text, postId: '', conversationId: '', read: false, createdAt: Date.now() });
    return;
  }
  notify(userId, 'warning', actor.id, text);
}

// The user a report decision acts on: the reported user themselves, the
// author of a reported post, or the sender of a reported message
// (from the evidence snapshot — never by reading the conversation).
function reportTargetUserId(rep) {
  if (!rep) return '';
  if (rep.targetType === 'user') return rep.targetId;
  if (rep.targetType === 'post') return data().posts.find((p) => p.id === rep.targetId)?.authorId || '';
  if (rep.targetType === 'message') return rep.evidence?.senderId || '';
  return '';
}

async function writeReportPatch(reportId, patch) {
  if (firebaseReady) { await updateDoc(doc(db, 'reports', reportId), patch); return; }
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
  const rep = data().reports.find((r) => r.id === reportId);
  if (!rep) throw new Error('Report not found.');
  if (!['review', 'resolve', 'reject', 'escalate'].includes(decision)) throw new Error('Unknown decision.');
  const finalOutcome = decision === 'resolve' && ['content-removed', 'user-warned', 'user-suspended'].includes(outcome) ? outcome : 'none';
  if (decision === 'resolve') {
    if (finalOutcome === 'content-removed') {
      if (rep.targetType === 'post') await deletePost(rep.targetId);
      else if (rep.targetType === 'message') {
        if (firebaseReady) await deleteDoc(doc(db, 'messages', rep.targetId));
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
  await writeReportPatch(reportId, { status, decision: record });
  await logAdminAction(`report-${decision}`, { type: 'report', id: reportId, label: `${rep.targetType}: ${truncate(rep.reason || '', 60)}` }, reason);
  return { status, decision: record };
}

// Set a report's appeal status ('requested' | 'accepted' | 'declined' |
// 'none'). Accepting an appeal does NOT restore removed content — the
// UI says so; restoration is a separate manual act.
export async function adminSetReportAppeal(reportId, appealStatus, reason = '') {
  const actor = me();
  if (!actor || !canModerate(actor)) throw new Error('Moderators only.');
  const rep = data().reports.find((r) => r.id === reportId);
  if (!rep) throw new Error('Report not found.');
  if (!['requested', 'accepted', 'declined', 'none'].includes(appealStatus)) throw new Error('Unknown appeal status.');
  const appeal = { status: appealStatus, byId: actor.id, byName: actor.name || '', at: Date.now(), reason: String(reason || '') };
  await writeReportPatch(reportId, { appeal });
  await logAdminAction('report-appeal', { type: 'report', id: reportId, label: `${rep.targetType}: ${truncate(rep.reason || '', 60)}` }, reason || appealStatus);
  return appeal;
}

export async function adminSetMaintenance(enabled) {
  if (firebaseReady) { await setDoc(doc(db, 'config', 'app'), { maintenanceMode: enabled }, { merge: true }); }
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
    await setDoc(doc(db, 'users', bot.id), botUserProfile(bot));
    return;
  }
  if (existing.name !== bot.name || existing.username !== bot.username || existing.avatar !== bot.avatar || existing.bio !== bot.bio) {
    await updateDoc(doc(db, 'users', bot.id), { name: bot.name, username: bot.username, avatar: bot.avatar, bio: bot.bio });
  }
}

export async function saveBot(bot) {
  const b = normaliseBot(bot);
  const existed = Boolean(b.id) && data().bots.some((x) => x.id === b.id);
  if (firebaseReady) {
    const id = b.id || genId('bot');
    const saved = { ...b, id };
    // The document id lives in the doc path, not the payload — and
    // Firestore rejects undefined field values, so the id key must be
    // OMITTED from the stored data, never set to undefined.
    const { id: _omitId, ...botPayload } = saved;
    await setDoc(doc(db, 'bots', id), botPayload, { merge: true });
    await setDoc(doc(db, 'botBrains', id), { botId: id, systemPrompt: saved.personality.systemPrompt, provider: 'gemini-ready', model: 'template-fallback', updatedAt: Date.now() }, { merge: true });
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
    s.botBrains[b.id] = { botId: b.id, systemPrompt: b.personality.systemPrompt, provider: 'gemini-ready', model: 'template-fallback', updatedAt: Date.now() };
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
  if (firebaseReady) {
    await deleteDoc(doc(db, 'bots', botId));
    await deleteDoc(doc(db, 'botBrains', botId));
    try { await deleteDoc(doc(db, 'botMemories', botId)); } catch { /* best-effort */ }
    try { await deleteDoc(doc(db, 'users', botId)); } catch { /* best-effort */ }
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
  if (firebaseReady) { await setDoc(doc(db, 'botSettings', 'global'), { enabled }, { merge: true }); }
  else mutate((s) => { s.botSettings.global.enabled = enabled; });
  await logAdminAction(enabled ? 'bots-enabled' : 'bots-stopped', { type: 'config', id: 'botSettings', label: 'Global bot kill switch' });
}

export async function addBotMemory(botId, text) {
  const entry = { id: genId('mem'), text, createdAt: Date.now(), updatedAt: Date.now(), pinned: false };
  if (firebaseReady) {
    const ref = doc(db, 'botMemories', botId);
    const snap = await getDoc(ref);
    const items = snap.exists() ? (snap.data().items || []) : [];
    await setDoc(ref, { botId, items: [...items, entry] });
  } else {
    mutate((s) => { (s.botMemories[botId] = s.botMemories[botId] || []).push(entry); });
  }
  await logAdminAction('bot-memory-add', { type: 'bot', id: botId, label: data().bots.find((b) => b.id === botId)?.name || botId });
  return entry;
}

export async function deleteBotMemory(botId, memoryId) {
  if (firebaseReady) {
    const ref = doc(db, 'botMemories', botId);
    const snap = await getDoc(ref);
    if (snap.exists()) await setDoc(ref, { botId, items: (snap.data().items || []).filter((m) => m.id !== memoryId) });
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
  if (!firebaseReady || !botId) return;
  const user = me();
  if (!user || !isAdminRole(user)) return; // brains/memories are admin-only reads
  if (botAdminDataLoadedFor === botId) return;
  botAdminDataLoadedFor = botId;
  const settle = async (p) => { try { return await p; } catch { return null; } };
  const [brainSnap, memSnap, countersSnap, convSnap, msgSnap] = await Promise.all([
    settle(getDoc(doc(db, 'botBrains', botId))),
    settle(getDoc(doc(db, 'botMemories', botId))),
    settle(getDoc(doc(db, 'botSettings', 'counters'))),
    settle(getDocs(query(collection(db, 'conversations'), where('participants', 'array-contains', botId), limit(50)))),
    settle(getDocs(query(collection(db, 'messages'), where('participants', 'array-contains', botId), orderBy('createdAt', 'asc'), limit(500))))
  ]);
  if (!remote) return;
  if (brainSnap?.exists()) remote.botBrains[botId] = { botId, ...normaliseTimeFields(brainSnap.data(), ['updatedAt']) };
  if (memSnap?.exists()) remote.botMemories[botId] = memSnap.data().items || [];
  if (countersSnap?.exists()) remote.botSettings.counters = botCountersForDay(countersSnap.data(), counterDayKey());
  if (convSnap) {
    const counts = new Map();
    const lastAt = new Map();
    for (const md of msgSnap?.docs || []) {
      const m = md.data();
      counts.set(m.conversationId, (counts.get(m.conversationId) || 0) + 1);
      lastAt.set(m.conversationId, Math.max(lastAt.get(m.conversationId) || 0, tsToMs(m.createdAt) || 0));
    }
    remote.botConvMeta[botId] = convSnap.docs
      .map((cd) => ({ id: cd.id, ...cd.data() }))
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
  if (firebaseReady) {
    const ref = await addDoc(collection(db, 'announcements'), ann);
    await logAdminAction('announcement-create', { type: 'announcement', id: ref.id, label: cleanTitle });
    return { id: ref.id, ...ann };
  }
  const saved = { id: genId('ann'), ...ann };
  mutate((s) => { if (!Array.isArray(s.announcements)) s.announcements = []; s.announcements.unshift(saved); });
  await logAdminAction('announcement-create', { type: 'announcement', id: saved.id, label: cleanTitle });
  return saved;
}

export async function setAnnouncementActive(id, active) {
  requireAnnouncementAdmin();
  const ann = data().announcements.find((a) => a.id === id);
  if (firebaseReady) await updateDoc(doc(db, 'announcements', id), { active: Boolean(active) });
  else mutate((s) => { const a = (s.announcements || []).find((x) => x.id === id); if (a) a.active = Boolean(active); });
  await logAdminAction(active ? 'announcement-activate' : 'announcement-deactivate', { type: 'announcement', id, label: ann?.title || id });
}

export async function deleteAnnouncement(id, reason = '') {
  requireAnnouncementAdmin();
  const ann = data().announcements.find((a) => a.id === id);
  if (firebaseReady) await deleteDoc(doc(db, 'announcements', id));
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
  if (firebaseReady) {
    const ref = await addDoc(collection(db, 'notifications'), note);
    await logAdminAction('notify-user', { type: 'user', id: userId, label: target.name });
    return { id: ref.id, ...note };
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
  if (firebaseReady) await setDoc(doc(db, 'config', 'app'), clean, { merge: true });
  else mutate((s) => { s.config = { ...s.config, ...clean }; });
  await logAdminAction('settings-save', { type: 'config', id: 'app', label: Object.keys(clean).join(', ') }, reason);
  return clean;
}

// -------------------------------------------------------------------------
// SYSTEM HEALTH (Pack C) — a one-shot Firestore connectivity probe:
// time a single lightweight read (config/app) and mirror the outcome
// into the dataset for the Health page. Nothing is fabricated: a
// failed probe reports the failure, and demo mode never probes (the
// Health page labels demo as a local store instead).
// -------------------------------------------------------------------------
export async function probeFirestoreHealth() {
  if (!firebaseReady) return null;
  const started = Date.now();
  let probe;
  try {
    await getDoc(doc(db, 'config', 'app'));
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
  if (!firebaseReady || botSecretsLoaded) return;
  if (!canAccessBotSecrets(me())) return; // non-admins never read botSecrets
  botSecretsLoaded = true;
  try {
    const snap = await getDoc(doc(db, 'botSecrets', 'config'));
    if (remote) {
      const stored = snap.exists() ? snap.data() : {};
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
async function patchBotSecrets(firestorePatch, applyLocal) {
  if (firebaseReady) {
    await setDoc(doc(db, 'botSecrets', 'config'), { ...firestorePatch, updatedAt: Date.now() }, { merge: true });
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

export async function saveProviderEndpoint(endpoint) {
  const entry = assertProvider('ollama');
  if (!isAdmin()) throw new Error('Only admins can manage provider settings.');
  const value = String(endpoint || '').trim().replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Enter a valid endpoint URL (e.g. http://localhost:11434/v1).'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('The endpoint must start with http:// or https://.');
  await patchBotSecrets(
    { providers: { ollama: { endpoint: value } } },
    (s) => { (s.providers ||= {}).ollama = { ...(s.providers.ollama || {}), endpoint: value }; }
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
  const health = { ok: result.ok, detail: result.detail, at: Date.now() };
  if (firebaseReady) {
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
    p.calls += 1;
    if (!attempt.ok) p.errors += 1;
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
  if (firebaseReady) {
    if (!remote) return;
    remote.aiUsage = bumpAiUsage(remote.aiUsage, providerId, attempt);
    document.dispatchEvent(new CustomEvent('meetbook:data'));
    setDoc(doc(db, 'botSecrets', 'config'), {
      aiUsage: { day: remote.aiUsage.day, providers: remote.aiUsage.providers }, updatedAt: Date.now()
    }, { merge: true }).catch(() => { /* counters are bookkeeping — never fail a cycle */ });
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
  if (firebaseReady) return;
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
  if (firebaseReady) {
    setDoc(doc(db, 'botBrains', bot.id), {
      botId: bot.id, systemPrompt: bot.personality.systemPrompt, provider,
      model: stampedModel, updatedAt: Date.now()
    }, { merge: true }).catch(() => { /* bookkeeping only */ });
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
  if (firebaseReady) return { ran: false, reason: 'Bot engine runs in Cloud Functions when Firebase is configured.' };
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
    } else if (decision.action === 'comment') {
      const target = s.posts.find((p) => p.authorId !== bot.id);
      if (target) {
        entry.targetId = target.id;
        entry.gen = await generateBotText(bot, s.botMemories[bot.id] || [], { kind: 'comment', text: target.text }, generateTemplateComment(bot));
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
        st.posts.unshift({ id: genId('p'), authorId: bot.id, text: `AI Bot post · ${text}`, image: '', visibility: 'public', audienceIds: [], createdAt: Date.now(), editedAt: 0, likes: [], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [], groupId: '', pageId: '', pageName: '', pageAvatar: '', generatedBy: entry.gen.provider });
        counters.postsToday += 1;
        st.botActivities.unshift({ id: genId('act'), botId: bot.id, action: 'post', detail: text.slice(0, 90), createdAt: Date.now(), status: 'ok' });
      } else if (entry.action === 'comment' && entry.gen) {
        const target = st.posts.find((p) => p.id === entry.targetId) || st.posts.find((p) => p.authorId !== bot.id);
        if (target) {
          const text = entry.gen.text;
          target.comments.push({ id: genId('c'), authorId: bot.id, text, createdAt: Date.now(), replies: [] });
          counters.commentsToday += 1;
          st.botActivities.unshift({ id: genId('act'), botId: bot.id, action: 'comment', detail: text.slice(0, 90), createdAt: Date.now(), status: 'ok' });
          const author = st.users.find((u) => u.id === target.authorId);
          if (author && !author.isBot) {
            st.notifications.unshift({ id: genId('n'), userId: author.id, type: 'comment', actorId: bot.id, text: `${bot.name} (AI Bot) commented on your post.`, postId: target.id, conversationId: '', read: false, createdAt: Date.now() });
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
  return { ran: true, results };
}

// Bot reply in a 1-1 conversation (demo mode): uses the bot's OWN
// memories. Routed through the AI providers when any is configured
// (the user's message is the context, so a Bangla message earns a
// Bangla reply); the personality template below is the silent fallback.
export async function demoBotReply(botUserId, userText) {
  if (firebaseReady) return null;
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
  remote.botRunner = { live: true, active: Boolean(liveRunnerTimer), ...(remote.botRunner || {}), ...patchObj };
  document.dispatchEvent(new CustomEvent('meetbook:data'));
}

export function botRunnerIsActive() {
  return Boolean(liveRunnerTimer);
}

export function startBotRunner() {
  if (!firebaseReady || !isAdmin() || liveRunnerTimer) return botRunnerIsActive();
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
  if (!firebaseReady) return;
  if (isAdmin()) startBotRunner();
  else stopBotRunner();
}

// Auto cycles claim their interval window in botRunners (admin-only
// collection) so two admin tabs don't both post for the same window —
// the same duplicate-task protection the Functions engine uses.
async function runScheduledBotCycle() {
  if (!firebaseReady || !isAdmin()) return;
  try {
    const windowKey = Math.floor(Date.now() / BOT_RUNNER_INTERVAL_MS);
    const ref = doc(db, 'botRunners', `autocycle_${windowKey}`);
    const snap = await getDoc(ref);
    if (snap.exists()) return; // another admin session already ran this window
    await setDoc(ref, { kind: 'live-autocycle', window: windowKey, by: currentUid(), createdAt: Date.now(), status: 'claimed' });
  } catch { return; /* cannot claim — skip this window quietly */ }
  await runLiveBotCycle();
}

async function loadLiveBotCounters() {
  const day = counterDayKey();
  try {
    const snap = await getDoc(doc(db, 'botSettings', 'counters'));
    if (snap.exists()) return { day, counters: botCountersForDay(snap.data(), day) };
  } catch { /* fall through: a fresh day of counters */ }
  return { day, counters: {} };
}

async function saveLiveBotCounters(day, counters) {
  try { await setDoc(doc(db, 'botSettings', 'counters'), { day, counters, updatedAt: Date.now() }); } catch { /* best-effort */ }
}

async function loadLiveBotMemories(botId) {
  try {
    const snap = await getDoc(doc(db, 'botMemories', botId));
    if (snap.exists()) return snap.data().items || [];
  } catch { /* fall through to the mirrored copy */ }
  return data().botMemories[botId] || [];
}

// Find this bot's unreplied 1-1 conversations straight from Firestore:
// the admin's mirrored state only contains the ADMIN's own chats, so
// the runner queries for the bot (the conversations/messages read
// rules allow admins). Latest message per conversation decides — a
// conversation whose latest message is the human's is unreplied.
async function findLiveReplyTargets(bot) {
  const convSnap = await getDocs(query(collection(db, 'conversations'), where('participants', 'array-contains', bot.id), limit(50)));
  const convs = convSnap.docs.map((d) => ({ id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) })).slice(0, 20);
  const latestByConv = new Map();
  for (const conv of convs) {
    if (conv.isGroup) continue;
    const msgSnap = await getDocs(query(collection(db, 'messages'), where('conversationId', '==', conv.id), orderBy('createdAt', 'desc'), limit(1)));
    const latest = msgSnap.docs[0];
    latestByConv.set(conv.id, latest ? { id: latest.id, ...normaliseTimeFields(latest.data(), ['createdAt']) } : null);
  }
  return findBotReplyTargets(convs, latestByConv, bot.id);
}

async function latestLiveMessage(conversationId) {
  const snap = await getDocs(query(collection(db, 'messages'), where('conversationId', '==', conversationId), orderBy('createdAt', 'desc'), limit(1)));
  const d = snap.docs[0];
  return d ? { id: d.id, ...normaliseTimeFields(d.data(), ['createdAt']) } : null;
}

// One live bot cycle: for every active bot, first answer at most one
// unreplied 1-1 conversation (messages/day counter), then take the
// decideBotAction-driven autonomous action (post/comment/like) under
// the same counters + kill switch as the demo cycle and the Functions
// engine. Returns the demo cycle's { ran, results } shape.
export async function runLiveBotCycle() {
  if (!firebaseReady) return { ran: false, reason: 'The live bot runner needs Firebase mode.' };
  if (!isAdmin()) return { ran: false, reason: 'Only admins can run bot cycles.' };
  if (botCycleInFlight) return { ran: false, reason: 'A bot cycle is already running.' };
  if (data().botSettings.global.enabled === false) {
    setLiveRunnerState({ lastCycleAt: Date.now(), lastSummary: 'Skipped: global bot kill switch is off.' });
    return { ran: false, reason: 'Global bot kill switch is off.' };
  }
  botCycleInFlight = true;
  const results = [];
  try {
    resetLastRoutedFailure(); // the summary reports only THIS cycle's AI outcome
    await loadBotSecrets(); // make sure the provider keys are in memory
    const { day, counters } = await loadLiveBotCounters();
    let actions = 0;
    const details = [];
    for (const bot of data().bots) {
      const c = { ...emptyBotCounters(), ...(counters[bot.id] || {}) };
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
        const memories = await loadLiveBotMemories(bot.id);
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
            const gen = await generateBotText(bot, memories, { kind: 'message', text: fresh.text }, templateBotMessageReply(bot, fresh.text));
            await addDoc(collection(db, 'messages'), {
              conversationId: target.conversationId, participants: [...target.participants],
              senderId: bot.id, text: gen.text, image: '', audio: '',
              createdAt: Date.now(), status: 'sent', readBy: [bot.id]
            });
            await createNotification({
              userId: target.humanId, type: 'message', actorId: bot.id,
              text: `${bot.name} sent you a message.`, postId: '', conversationId: target.conversationId,
              read: false, createdAt: Date.now()
            });
            const updatedMemories = memoryFromConversation(memories, fresh.text, gen.text);
            try { await setDoc(doc(db, 'botMemories', bot.id), { botId: bot.id, items: updatedMemories }); } catch { /* memory is best-effort */ }
            c.messagesToday += 1;
            actions += 1;
            acted = true;
            results.push({ bot: bot.name, action: 'message' });
          }
        }
        if (dmNote) {
          dmDetail.note = dmNote;
          results.push({ bot: bot.name, action: 'none', reason: dmNote, pendingDMs: targets.length });
        }

        // --- autonomous action (post / comment / like) ---
        const decision = decideBotAction(bot, c, true);
        if (decision.action === 'post') {
          const gen = await generateBotText(bot, memories, { kind: 'post' }, generateTemplatePost(bot));
          // Same stored shape createPost writes: the audience pair is
          // denormalized via postAudience (public -> audienceIds []),
          // so the provable feed listeners pick the post up.
          const audience = postAudience({ visibility: 'public', authorFriendIds: friendIdsFromData(bot.id), authorCloseFriendIds: [] });
          await addDoc(collection(db, 'posts'), {
            authorId: bot.id, text: `AI Bot post · ${gen.text}`, image: '',
            visibility: audience.visibility, audienceIds: audience.audienceIds,
            createdAt: serverTimestamp(), editedAt: 0,
            likes: [], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [],
            groupId: '', pageId: '', pageName: '', pageAvatar: '',
            poll: null, location: '', feeling: '', pinned: false, generatedBy: gen.provider
          });
          c.postsToday += 1;
          c.lastActionAt = Date.now();
          actions += 1;
          acted = true;
          results.push({ bot: bot.name, action: 'post' });
        } else if (decision.action === 'comment') {
          const candidates = (data().posts || []).filter((p) => p.visibility === 'public' && !p.groupId && !p.pageId && p.authorId !== bot.id);
          const target = candidates.find((p) => !(p.comments || []).some((cm) => cm.authorId === bot.id)) || candidates[0];
          if (target) {
            const blockSnap = await getDoc(doc(db, 'blocks', `${target.authorId}_${bot.id}`));
            if (blockSnap.exists()) {
              results.push({ bot: bot.name, action: 'none', reason: 'post author blocked this bot' });
            } else {
              const gen = await generateBotText(bot, memories, { kind: 'comment', text: target.text }, generateTemplateComment(bot));
              const postSnap = await getDoc(doc(db, 'posts', target.id));
              const freshComments = postSnap.exists() ? (postSnap.data().comments || []) : (target.comments || []);
              const comment = { id: genId('c'), authorId: bot.id, text: gen.text, createdAt: Date.now(), replies: [] };
              await updateDoc(doc(db, 'posts', target.id), { comments: [...freshComments, comment] });
              await createNotification({
                userId: target.authorId, type: 'comment', actorId: bot.id,
                text: `${bot.name} (AI Bot) commented on your post.`, postId: target.id, conversationId: '',
                read: false, createdAt: Date.now()
              });
              c.commentsToday += 1;
              c.lastActionAt = Date.now();
              actions += 1;
              acted = true;
              results.push({ bot: bot.name, action: 'comment' });
            }
          }
        } else if (decision.action === 'like') {
          const target = (data().posts || []).find((p) => !p.groupId && !p.pageId && p.authorId !== bot.id && !(p.likes || []).includes(bot.id));
          if (target) {
            await updateDoc(doc(db, 'posts', target.id), { likes: arrayUnion(bot.id) });
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
    }
    await saveLiveBotCounters(day, counters);
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
  if (!firebaseReady) return runDemoBotCycle();
  return runLiveBotCycle();
}

export { resetDemo, findUser, userByUsername, friendIdsOf, blockedIdsOf };
export { postLimiter };
