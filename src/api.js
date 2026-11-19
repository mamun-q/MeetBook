// Unified data/API layer. Two backends behind one interface:
//  - Firebase mode (env config present): Firebase Auth + Firestore + Storage.
//  - Demo mode (no config): the local seeded store in store.js.
// Views always read from data() and write through these functions, so the UI
// code is identical in both modes.
import {
  getState, mutate, findUser, userByUsername, friendIdsOf, blockedIdsOf, notify, resetDemo
} from './store.js';
import { firebaseReady, auth, db, storage, googleProvider } from './firebase.js';
import { uid as genId, validateUsername, extractMentions, normaliseGroup, normalisePage, normaliseEvent, postAudience, castPollVote, tsToMs } from './utils.js';
import { generateTemplatePost, generateTemplateComment, decideBotAction, memoryFromConversation, normaliseBot } from './botLogic.js';

// --- Firebase imports are dynamic-free static imports of the SDK ---------
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signInWithPopup,
  sendPasswordResetEmail, signOut, deleteUser, onAuthStateChanged
} from 'firebase/auth';
import {
  collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot, serverTimestamp, arrayUnion, arrayRemove
} from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';

// -------------------------------------------------------------------------
let remote = null; // Firestore-mirrored dataset (same shape as demo state)
let remoteUid = '';
let emptyRemoteCache = null;

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

export function isAdmin(user = me()) {
  return Boolean(user && user.role === 'admin');
}

function blankRemote() {
  return {
    users: [], sessionUid: '', posts: [], stories: [], groups: [], pages: [], friendships: [], blocks: [],
    conversations: [], messages: [], notifications: [], reports: [], events: [], reviews: [], groupRequests: [],
    bots: [], botBrains: {}, botMemories: {}, botActivities: [], botLogs: [],
    botSettings: { global: { enabled: true }, counters: {} },
    config: { maintenanceMode: false },
    aiUsage: { callsToday: 0, tokensToday: 0, updatedAt: 0 }
  };
}

// -------------------------------------------------------------------------
// AUTH
// -------------------------------------------------------------------------
export async function register({ name, username, email, password }) {
  const v = validateUsername(username);
  if (!v.ok) throw new Error(v.error);
  if (firebaseReady) {
    // Create the Auth account FIRST: Firestore rules only allow signed-in
    // reads, so the username-uniqueness query must run after sign-up (an
    // unauthenticated query fails with "Missing or insufficient
    // permissions"). If anything after account creation fails, delete the
    // just-created Auth user so the email is not stranded.
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    const profile = {
      name: name.trim(), username: v.value, email: email.trim(), bio: '', avatar: '', cover: '',
      work: '', education: '', currentCity: '', hometown: '', relationship: '', website: '', nickname: '',
      role: 'user', isBot: false, online: true, createdAt: Date.now(), followers: [], following: [], closeFriends: [], settings: {}
    };
    try {
      const taken = await getDocs(query(collection(db, 'users'), where('username', '==', v.value)));
      if (!taken.empty) throw new Error('That username is already taken.');
      await setDoc(doc(db, 'users', cred.user.uid), profile);
    } catch (err) {
      try { await deleteUser(cred.user); } catch { /* rollback is best-effort */ }
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
      relationship: '', website: '', nickname: '', role: 'user', isBot: false, online: true,
      createdAt: Date.now(), followers: [], following: [], closeFriends: [], settings: {}
    };
    s.users.push(created);
    s.sessionUid = created.id;
  });
  return created;
}

export async function login(email, password) {
  if (firebaseReady) {
    const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
    remoteUid = cred.user.uid;
    return cred.user;
  }
  let user = null;
  mutate((s) => {
    user = s.users.find((u) => u.email === email.trim().toLowerCase() && u.password === password && !u.isBot);
    if (!user) throw new Error('Invalid email or password. Demo accounts: admin@meetbook.app / admin123, ayesha@example.com / demo123');
    user.online = true;
    s.sessionUid = user.id;
  });
  return user;
}

export async function loginWithGoogle() {
  if (!firebaseReady) throw new Error('Google sign-in needs Firebase configuration. In demo mode, register or use a demo account.');
  const cred = await signInWithPopup(auth, googleProvider);
  remoteUid = cred.user.uid;
  const ref = doc(db, 'users', cred.user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    const base = (cred.user.email || 'user').split('@')[0].replace(/[^a-z0-9_.]/gi, '').toLowerCase() || 'user';
    await setDoc(ref, {
      name: cred.user.displayName || 'MeetBook User', username: base.slice(0, 24), email: cred.user.email || '',
      bio: '', avatar: cred.user.photoURL || '', cover: '', work: '', education: '', currentCity: '',
      hometown: '', relationship: '', website: '', nickname: '', role: 'user', isBot: false, online: true,
      createdAt: Date.now(), followers: [], following: [], closeFriends: [], settings: {}
    });
  }
  return cred.user;
}

export async function resetPassword(email) {
  if (firebaseReady) { await sendPasswordResetEmail(auth, email.trim()); return; }
  const exists = getState().users.some((u) => u.email === email.trim().toLowerCase());
  if (!exists) throw new Error('No demo account uses that email.');
  // Demo mode cannot send real email; we surface a clear, honest message.
  throw new Error('Demo mode: password reset email cannot be sent. In demo mode sign in with the demo password, or wire Firebase config to enable real reset emails.');
}

export async function logout() {
  if (firebaseReady) { await signOut(auth); remoteUid = ''; return; }
  mutate((s) => {
    const u = s.users.find((x) => x.id === s.sessionUid);
    if (u) u.online = false;
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
function startRemoteSync() {
  if (syncStarted || !firebaseReady) return;
  syncStarted = true;
  remote = blankRemote();
  const patch = (fn) => { fn(remote); document.dispatchEvent(new CustomEvent('meetbook:data')); };
  onSnapshot(query(collection(db, 'users'), limit(300)), (snap) => patch((r) => { r.users = snap.docs.map((d) => ({ id: d.id, ...d.data() })); }));
  // Posts: three provable listeners merged by id (see header note).
  const mapPost = (d) => ({ id: d.id, comments: [], likes: [], reactions: {}, savedBy: [], groupId: '', pageId: '', audienceIds: [], ...d.data() });
  let ownPosts = [];
  let publicPosts = [];
  let audiencePosts = [];
  const mergePosts = () => patch((r) => {
    const byIdMap = new Map();
    for (const p of [...publicPosts, ...audiencePosts, ...ownPosts]) byIdMap.set(p.id, p);
    r.posts = [...byIdMap.values()];
  });
  onSnapshot(query(collection(db, 'posts'), where('visibility', '==', 'public'), orderBy('createdAt', 'desc'), limit(100)),
    (snap) => { publicPosts = snap.docs.map(mapPost); mergePosts(); },
    () => { /* listener rejected — leave the mirrored set untouched */ });
  // Stories: same provable three-listener pattern as posts, merged by id.
  // createdAt is normalised to epoch ms (Firestore returns Timestamps) so
  // the 24h expiry filter in the view layer compares real numbers.
  const mapStory = (d) => {
    const raw = d.data();
    return { id: d.id, image: '', text: '', bg: 'sunset', audienceIds: [], views: [], ...raw, createdAt: tsToMs(raw.createdAt) };
  };
  let ownStories = [];
  let publicStories = [];
  let audienceStories = [];
  const mergeStories = () => patch((r) => {
    const byIdMap = new Map();
    for (const s of [...publicStories, ...audienceStories, ...ownStories]) byIdMap.set(s.id, s);
    r.stories = [...byIdMap.values()];
  });
  onSnapshot(query(collection(db, 'stories'), where('visibility', '==', 'public'), orderBy('createdAt', 'desc'), limit(100)),
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
  onSnapshot(query(collection(db, 'events'), where('visibility', '==', 'public'), orderBy('dateTime', 'asc'), limit(100)),
    (snap) => { publicEvents = snap.docs.map(mapEvent); mergeEvents(); },
    () => { /* listener rejected — leave the mirrored set untouched */ });
  // Reviews: the read rule is signedIn-only (field-independent), so a
  // plain listener is provable — same as users/pages.
  onSnapshot(query(collection(db, 'reviews'), orderBy('createdAt', 'desc'), limit(500)),
    (snap) => patch((r) => { r.reviews = snap.docs.map((d) => ({ id: d.id, ...d.data() })); }),
    () => { /* listener rejected — leave the mirrored set untouched */ });
  onSnapshot(query(collection(db, 'pages'), limit(200)), (snap) => patch((r) => { r.pages = snap.docs.map((d) => ({ id: d.id, ...d.data() })); }));
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
  onSnapshot(query(collection(db, 'groups'), where('privacy', '==', 'public'), limit(200)), (snap) => { publicGroups = snap.docs.map((d) => ({ id: d.id, ...d.data() })); mergeGroups(); });
  // Friendships: two provable listeners merged by id (from == me, to == me).
  let friendshipsFrom = [];
  let friendshipsTo = [];
  const mergeFriendships = () => patch((r) => {
    const byIdMap = new Map();
    for (const f of [...friendshipsFrom, ...friendshipsTo]) byIdMap.set(f.id, f);
    r.friendships = [...byIdMap.values()];
  });
  onSnapshot(query(collection(db, 'bots'), limit(100)), (snap) => patch((r) => { r.bots = snap.docs.map((d) => normaliseBot({ id: d.id, ...d.data() })); }));
  onSnapshot(query(collection(db, 'botActivities'), orderBy('createdAt', 'desc'), limit(100)),
    (snap) => patch((r) => { r.botActivities = snap.docs.map((d) => ({ id: d.id, ...d.data() })); }),
    () => { /* non-admins cannot read bot activities — ignore */ });
  onSnapshot(query(collection(db, 'botLogs'), orderBy('createdAt', 'desc'), limit(100)),
    (snap) => patch((r) => { r.botLogs = snap.docs.map((d) => ({ id: d.id, ...d.data() })); }),
    () => { /* non-admins cannot read bot logs — ignore */ });
  onSnapshot(doc(db, 'botSettings', 'global'), (snap) => patch((r) => { if (snap.exists()) r.botSettings.global = snap.data(); }));
  onSnapshot(doc(db, 'config', 'app'), (snap) => patch((r) => { if (snap.exists()) r.config = { ...r.config, ...snap.data() }; }));
  if (remoteUid) {
    onSnapshot(query(collection(db, 'posts'), where('authorId', '==', remoteUid)),
      (snap) => { ownPosts = snap.docs.map(mapPost); mergePosts(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    onSnapshot(query(collection(db, 'posts'), where('audienceIds', 'array-contains', remoteUid)),
      (snap) => { audiencePosts = snap.docs.map(mapPost); mergePosts(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    onSnapshot(query(collection(db, 'stories'), where('authorId', '==', remoteUid)),
      (snap) => { ownStories = snap.docs.map(mapStory); mergeStories(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    onSnapshot(query(collection(db, 'stories'), where('audienceIds', 'array-contains', remoteUid)),
      (snap) => { audienceStories = snap.docs.map(mapStory); mergeStories(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    onSnapshot(query(collection(db, 'events'), where('createdBy', '==', remoteUid)),
      (snap) => { ownEvents = snap.docs.map(mapEvent); mergeEvents(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    onSnapshot(query(collection(db, 'events'), where('audienceIds', 'array-contains', remoteUid)),
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
    onSnapshot(query(collection(db, 'groupRequests'), where('userId', '==', remoteUid)),
      (snap) => { myGroupRequests = snap.docs.map((d) => ({ id: d.id, ...d.data() })); mergeGroupRequests(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    onSnapshot(query(collection(db, 'groupRequests'), where('groupOwnerId', '==', remoteUid)),
      (snap) => { ownedGroupRequests = snap.docs.map((d) => ({ id: d.id, ...d.data() })); mergeGroupRequests(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    onSnapshot(query(collection(db, 'friendships'), where('from', '==', remoteUid)),
      (snap) => { friendshipsFrom = snap.docs.map((d) => ({ id: d.id, ...d.data() })); mergeFriendships(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    onSnapshot(query(collection(db, 'friendships'), where('to', '==', remoteUid)),
      (snap) => { friendshipsTo = snap.docs.map((d) => ({ id: d.id, ...d.data() })); mergeFriendships(); },
      () => { /* listener rejected — leave the mirrored set untouched */ });
    onSnapshot(query(collection(db, 'notifications'), where('userId', '==', remoteUid), orderBy('createdAt', 'desc'), limit(100)),
      (snap) => patch((r) => { r.notifications = snap.docs.map((d) => ({ id: d.id, ...d.data() })); }));
    onSnapshot(query(collection(db, 'conversations'), where('participants', 'array-contains', remoteUid)),
      (snap) => patch((r) => { r.conversations = snap.docs.map((d) => ({ id: d.id, ...d.data() })); }));
    onSnapshot(query(collection(db, 'messages'), where('participants', 'array-contains', remoteUid), orderBy('createdAt', 'asc'), limit(500)),
      (snap) => patch((r) => { r.messages = snap.docs.map((d) => ({ id: d.id, ...d.data() })); }),
      () => { /* listener rejected — leave the mirrored set untouched */ });
    onSnapshot(query(collection(db, 'blocks'), where('by', '==', remoteUid)),
      (snap) => patch((r) => { r.blocks = snap.docs.map((d) => ({ id: d.id, ...d.data() })); }));
    onSnapshot(query(collection(db, 'groups'), where('members', 'array-contains', remoteUid), limit(200)),
      (snap) => { memberGroups = snap.docs.map((d) => ({ id: d.id, ...d.data() })); mergeGroups(); });
    onSnapshot(query(collection(db, 'reports'), orderBy('createdAt', 'desc'), limit(100)),
      (snap) => patch((r) => { r.reports = snap.docs.map((d) => ({ id: d.id, ...d.data() })); }), () => { /* non-admins cannot read reports — ignore */ });
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
  // 1) Try Firebase Storage first (works once the project is on Blaze).
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
  // 2) Demo mode / Storage unavailable: compressed data URL stored locally
  //    (demo store) or in the Firestore document (live mode).
  return compressImageToDataUrl(file);
}

export function setOnline(userId, online) {
  if (firebaseReady) { updateDoc(doc(db, 'users', userId), { online }).catch(() => {}); return; }
  mutate((s) => { const u = s.users.find((x) => x.id === userId); if (u) u.online = online; });
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
    const ref = await addDoc(collection(db, 'posts'), { ...post, createdAt: serverTimestamp() });
    fanOutMentions(post.text, author, ref.id);
    return { id: ref.id, ...post };
  }
  const full = { id: genId('p'), ...post };
  mutate((s) => { s.posts.unshift(full); notifyMentions(s, full, author); });
  return full;
}

function notifyMentions(s, post, author) {
  for (const uname of extractMentions(post.text)) {
    const target = s.users.find((u) => u.username === uname);
    if (target) {
      s.notifications.unshift({ id: genId('n'), userId: target.id, type: 'mention', actorId: author.id, text: `${author.name} mentioned you in a post.`, postId: post.id, conversationId: '', read: false, createdAt: Date.now() });
    }
  }
}

async function fanOutMentions(text, author, postId) {
  for (const uname of extractMentions(text)) {
    const snap = await getDocs(query(collection(db, 'users'), where('username', '==', uname)));
    for (const d of snap.docs) {
      await addDoc(collection(db, 'notifications'), { userId: d.id, type: 'mention', actorId: author.id, text: `${author.name} mentioned you in a post.`, postId, conversationId: '', read: false, createdAt: Date.now() });
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
    await updateDoc(doc(db, 'posts', postId), { likes: has ? arrayRemove(user.id) : arrayUnion(user.id) });
    if (!has && post) await addDoc(collection(db, 'notifications'), { userId: post.authorId, type: 'like', actorId: user.id, text: `${user.name} liked your post.`, postId, conversationId: '', read: false, createdAt: Date.now() });
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
    const reactions = { ...(post?.reactions || {}) };
    if (reactions[user.id] === emoji) delete reactions[user.id]; else reactions[user.id] = emoji;
    await updateDoc(doc(db, 'posts', postId), { reactions });
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
    await updateDoc(doc(db, 'posts', postId), { savedBy: has ? arrayRemove(user.id) : arrayUnion(user.id) });
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
    await updateDoc(doc(db, 'posts', postId), { poll: { options: post.poll.options, votes } });
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
    await addDoc(collection(db, 'posts'), shared);
    await updateDoc(doc(db, 'posts', postId), { shares: (original.shares || 0) + 1 });
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
    const comments = [...(post?.comments || [])];
    if (parentCommentId) {
      const parent = comments.find((c) => c.id === parentCommentId);
      if (parent) parent.replies = [...(parent.replies || []), comment];
    } else comments.push(comment);
    await updateDoc(doc(db, 'posts', postId), { comments });
    if (post) await addDoc(collection(db, 'notifications'), { userId: post.authorId, type: parentCommentId ? 'reply' : 'comment', actorId: user.id, text: `${user.name} ${parentCommentId ? 'replied to a comment' : 'commented on your post.'}`, postId, conversationId: '', read: false, createdAt: Date.now() });
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
    const comments = (post?.comments || []).filter((c) => c.id !== commentId)
      .map((c) => ({ ...c, replies: (c.replies || []).filter((r) => r.id !== commentId) }));
    await updateDoc(doc(db, 'posts', postId), { comments });
    return;
  }
  mutate((s) => {
    const p = s.posts.find((x) => x.id === postId);
    if (!p) return;
    p.comments = p.comments.filter((c) => c.id !== commentId);
    for (const c of p.comments) c.replies = (c.replies || []).filter((r) => r.id !== commentId);
  });
}

export async function reportContent(targetType, targetId, reason) {
  const user = me(); if (!user) throw new Error('Sign in to report content.');
  const report = { reporterId: user.id, targetType, targetId, reason: String(reason || 'Inappropriate content'), status: 'open', createdAt: Date.now() };
  if (firebaseReady) { await addDoc(collection(db, 'reports'), report); return; }
  mutate((s) => { s.reports.unshift({ id: genId('rep'), ...report }); });
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
      await addDoc(collection(db, 'notifications'), { userId: group.createdBy, type: 'group_request', actorId: user.id, text: `${user.name} asked to join your private group "${group.name}".`, postId: '', conversationId: '', read: false, createdAt: Date.now() });
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
    if (!isMember) await addDoc(collection(db, 'notifications'), { userId: group.createdBy, type: 'group_join', actorId: user.id, text: `${user.name} joined your group "${group.name}".`, postId: '', conversationId: '', read: false, createdAt: Date.now() });
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
    await addDoc(collection(db, 'notifications'), { userId: request.userId, type: 'group_request_result', actorId: user.id, text: approve ? `Your request to join "${group.name}" was approved.` : `Your request to join "${group.name}" was declined.`, postId: '', conversationId: '', read: false, createdAt: Date.now() });
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
    if (!following) await addDoc(collection(db, 'notifications'), { userId: page.ownerId, type: 'page_follow', actorId: user.id, text: `${user.name} started following your page "${page.name}".`, postId: '', conversationId: '', read: false, createdAt: Date.now() });
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
      await addDoc(collection(db, 'notifications'), { userId: event.createdBy, type: 'event_rsvp', actorId: user.id, text: `${user.name} is ${kind === 'going' ? 'going to' : 'interested in'} your event "${event.title}".`, postId: '', conversationId: '', read: false, createdAt: Date.now() });
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
    // Deterministic doc id ({from}_{to}) so firestore.rules can verify a
    // friendship with a single exists() check for friends-only posts.
    await setDoc(doc(db, 'friendships', `${user.id}_${toId}`), { from: user.id, to: toId, status: 'pending', createdAt: Date.now() });
    await addDoc(collection(db, 'notifications'), { userId: toId, type: 'friend_request', actorId: user.id, text: `${user.name} sent you a friend request.`, postId: '', conversationId: '', read: false, createdAt: Date.now() });
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
  const existing = data().conversations.find((c) => !c.isGroup && c.participants.includes(user.id) && c.participants.includes(otherId) && c.participants.length === 2);
  if (existing) return existing;
  const conv = { participants: [user.id, otherId], createdAt: Date.now() };
  if (firebaseReady) {
    const ref = await addDoc(collection(db, 'conversations'), conv);
    return { id: ref.id, ...conv };
  }
  const full = { id: genId('conv'), ...conv };
  mutate((s) => { s.conversations.push(full); });
  return full;
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

export async function sendMessage(conversationId, { text, image, audio = '' }) {
  const user = me(); if (!user) throw new Error('Sign in first.');
  const conv = data().conversations.find((c) => c.id === conversationId);
  // Participants are DENORMALIZED onto the message: the messages read
  // rule and the live listener filter on this array, because a get() join
  // to the conversation document is not provable for list queries.
  // `audio` is a base64 data URL for voice messages (recorded client-side,
  // capped at ~60s / ~700KB by the composer before it gets here).
  const msg = { conversationId, participants: conv ? [...conv.participants] : [], senderId: user.id, text: String(text || '').trim(), image: image || '', audio: audio || '', createdAt: Date.now(), status: 'sent', readBy: [user.id] };
  if (!msg.text && !msg.image && !msg.audio) throw new Error('Message cannot be empty.');
  const others = (conv?.participants || []).filter((p) => p !== user.id);
  const noteText = msg.audio && !msg.text ? `${user.name} sent you a voice message.` : `${user.name} sent you a message.`;
  if (firebaseReady) {
    const ref = await addDoc(collection(db, 'messages'), msg);
    for (const other of others) {
      await addDoc(collection(db, 'notifications'), { userId: other, type: 'message', actorId: user.id, text: noteText, postId: '', conversationId, read: false, createdAt: Date.now() });
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

// -------------------------------------------------------------------------
// NOTIFICATIONS
// -------------------------------------------------------------------------
export async function markAllNotificationsRead() {
  const user = me(); if (!user) return;
  if (firebaseReady) {
    const mine = data().notifications.filter((n) => n.userId === user.id && !n.read);
    for (const n of mine) await updateDoc(doc(db, 'notifications', n.id), { read: true });
    return;
  }
  mutate((s) => { for (const n of s.notifications) if (n.userId === user.id) n.read = true; });
}

export async function markNotificationRead(id) {
  if (firebaseReady) { await updateDoc(doc(db, 'notifications', id), { read: true }); return; }
  mutate((s) => { const n = s.notifications.find((x) => x.id === id); if (n) n.read = true; });
}

// -------------------------------------------------------------------------
// ADMIN
// -------------------------------------------------------------------------
export async function adminSetRole(userId, role) {
  if (firebaseReady) { await updateDoc(doc(db, 'users', userId), { role }); return; }
  mutate((s) => { const u = s.users.find((x) => x.id === userId); if (u) u.role = role; });
}

export async function adminResolveReport(reportId, action) {
  if (firebaseReady) {
    if (action === 'remove-post') {
      const rep = data().reports.find((r) => r.id === reportId);
      if (rep?.targetType === 'post') await deleteDoc(doc(db, 'posts', rep.targetId));
    }
    await updateDoc(doc(db, 'reports', reportId), { status: action === 'dismiss' ? 'dismissed' : 'actioned' });
    return;
  }
  mutate((s) => {
    const rep = s.reports.find((r) => r.id === reportId);
    if (!rep) return;
    if (action === 'remove-post' && rep.targetType === 'post') s.posts = s.posts.filter((p) => p.id !== rep.targetId);
    rep.status = action === 'dismiss' ? 'dismissed' : 'actioned';
  });
}

export async function adminSetMaintenance(enabled) {
  if (firebaseReady) { await setDoc(doc(db, 'config', 'app'), { maintenanceMode: enabled }, { merge: true }); return; }
  mutate((s) => { s.config.maintenanceMode = enabled; });
}

// -------------------------------------------------------------------------
// BOTS — admin + demo simulation
// -------------------------------------------------------------------------
export async function saveBot(bot) {
  const b = normaliseBot(bot);
  if (firebaseReady) {
    await setDoc(doc(db, 'bots', b.id || genId('bot')), { ...b, id: undefined }, { merge: true });
    await setDoc(doc(db, 'botBrains', b.id), { botId: b.id, systemPrompt: b.personality.systemPrompt, provider: 'gemini-ready', model: 'template-fallback', updatedAt: Date.now() }, { merge: true });
    return b;
  }
  mutate((s) => {
    const i = s.bots.findIndex((x) => x.id === b.id);
    if (i >= 0) s.bots[i] = b; else s.bots.push(b);
    if (!s.users.some((u) => u.id === b.id)) {
      s.users.push({ id: b.id, name: b.name, username: b.username, email: '', password: '', bio: b.bio, avatar: b.avatar, cover: '', work: '', education: '', currentCity: '', hometown: '', relationship: '', website: '', nickname: '', role: 'bot', isBot: true, botId: b.id, online: true, createdAt: Date.now(), followers: [], following: [], closeFriends: [], settings: {} });
    } else {
      const u = s.users.find((x) => x.id === b.id);
      Object.assign(u, { name: b.name, username: b.username, bio: b.bio, avatar: b.avatar });
    }
    s.botBrains[b.id] = { botId: b.id, systemPrompt: b.personality.systemPrompt, provider: 'gemini-ready', model: 'template-fallback', updatedAt: Date.now() };
    if (!s.botMemories[b.id]) s.botMemories[b.id] = [];
    s.botLogs.unshift({ id: genId('log'), botId: b.id, level: 'info', message: `Bot ${b.name} saved by admin.`, createdAt: Date.now() });
  });
  return b;
}

export async function deleteBot(botId) {
  if (firebaseReady) {
    await deleteDoc(doc(db, 'bots', botId));
    await deleteDoc(doc(db, 'botBrains', botId));
    return;
  }
  mutate((s) => {
    s.bots = s.bots.filter((b) => b.id !== botId);
    s.users = s.users.filter((u) => u.id !== botId);
    delete s.botBrains[botId];
    delete s.botMemories[botId];
  });
}

export async function setGlobalBotEnabled(enabled) {
  if (firebaseReady) { await setDoc(doc(db, 'botSettings', 'global'), { enabled }, { merge: true }); return; }
  mutate((s) => { s.botSettings.global.enabled = enabled; });
}

export async function addBotMemory(botId, text) {
  const entry = { id: genId('mem'), text, createdAt: Date.now(), updatedAt: Date.now(), pinned: false };
  if (firebaseReady) {
    const ref = doc(db, 'botMemories', botId);
    const snap = await getDoc(ref);
    const items = snap.exists() ? (snap.data().items || []) : [];
    await setDoc(ref, { botId, items: [...items, entry] });
    return;
  }
  mutate((s) => { (s.botMemories[botId] = s.botMemories[botId] || []).push(entry); });
}

export async function deleteBotMemory(botId, memoryId) {
  if (firebaseReady) {
    const ref = doc(db, 'botMemories', botId);
    const snap = await getDoc(ref);
    if (snap.exists()) await setDoc(ref, { botId, items: (snap.data().items || []).filter((m) => m.id !== memoryId) });
    return;
  }
  mutate((s) => { if (s.botMemories[botId]) s.botMemories[botId] = s.botMemories[botId].filter((m) => m.id !== memoryId); });
}

// Client-side demo bot simulation: one runner cycle against local state.
// In Firebase mode the real engine lives in Cloud Functions (botRunner);
// this simulation is used only for demo mode so bot activity is visible.
export function runDemoBotCycle() {
  if (firebaseReady) return { ran: false, reason: 'Bot engine runs in Cloud Functions when Firebase is configured.' };
  const s = getState();
  if (!s.botSettings.global.enabled) return { ran: false, reason: 'Global bot kill switch is off.' };
  const results = [];
  mutate((st) => {
    st.botSettings.counters = st.botSettings.counters || {};
    for (const bot of st.bots) {
      const counters = st.botSettings.counters[bot.id] || { postsToday: 0, commentsToday: 0, likesToday: 0, messagesToday: 0, lastActionAt: 0 };
      const decision = decideBotAction(bot, { ...counters, lastActionAt: 0 }, true);
      if (decision.action === 'none') { results.push({ bot: bot.name, action: 'none', reason: decision.reason }); continue; }
      if (decision.action === 'post') {
        const text = generateTemplatePost(bot);
        st.posts.unshift({ id: genId('p'), authorId: bot.id, text: `AI Bot post · ${text}`, image: '', visibility: 'public', audienceIds: [], createdAt: Date.now(), editedAt: 0, likes: [], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [], groupId: '', pageId: '', pageName: '', pageAvatar: '' });
        counters.postsToday += 1;
        st.botActivities.unshift({ id: genId('act'), botId: bot.id, action: 'post', detail: text.slice(0, 90), createdAt: Date.now(), status: 'ok' });
      } else if (decision.action === 'comment') {
        const target = st.posts.find((p) => p.authorId !== bot.id);
        if (target) {
          const text = generateTemplateComment(bot);
          target.comments.push({ id: genId('c'), authorId: bot.id, text, createdAt: Date.now(), replies: [] });
          counters.commentsToday += 1;
          st.botActivities.unshift({ id: genId('act'), botId: bot.id, action: 'comment', detail: text.slice(0, 90), createdAt: Date.now(), status: 'ok' });
          const author = st.users.find((u) => u.id === target.authorId);
          if (author && !author.isBot) {
            st.notifications.unshift({ id: genId('n'), userId: author.id, type: 'comment', actorId: bot.id, text: `${bot.name} (AI Bot) commented on your post.`, postId: target.id, conversationId: '', read: false, createdAt: Date.now() });
          }
        }
      } else if (decision.action === 'like') {
        const target = st.posts.find((p) => p.authorId !== bot.id && !p.likes.includes(bot.id));
        if (target) { target.likes.push(bot.id); counters.likesToday += 1; st.botActivities.unshift({ id: genId('act'), botId: bot.id, action: 'like', detail: 'Liked a post.', createdAt: Date.now(), status: 'ok' }); }
      }
      counters.lastActionAt = Date.now();
      st.botSettings.counters[bot.id] = counters;
      results.push({ bot: bot.name, action: decision.action });
    }
    st.aiUsage.callsToday += results.filter((r) => r.action !== 'none').length;
    st.aiUsage.updatedAt = Date.now();
  });
  return { ran: true, results };
}

// Bot reply in a 1-1 conversation (demo mode): uses the bot's OWN memories.
export function demoBotReply(botUserId, userText) {
  if (firebaseReady) return null;
  const s = getState();
  const bot = s.bots.find((b) => b.id === botUserId);
  if (!bot || !bot.active || !s.botSettings.global.enabled) return null;
  const memories = s.botMemories[bot.id] || [];
  const interest = bot.personality.interests.find((i) => String(userText).toLowerCase().includes(i.split(' ')[0].toLowerCase()));
  const reply = interest
    ? `I love talking about ${interest}! As an AI bot I am still learning, but here is my take: it is a great topic to explore together. What part interests you most?`
    : `Thanks for messaging me! I am ${bot.name}, an AI bot with a ${bot.personality.tone} style. My favourite topics are ${bot.personality.interests.join(', ') || 'good conversation'}. Tell me more about what you said: "${String(userText).slice(0, 60)}"`;
  mutate((st) => {
    st.botMemories[bot.id] = memoryFromConversation(st.botMemories[bot.id] || memories, userText, reply);
    st.botActivities.unshift({ id: genId('act'), botId: bot.id, action: 'message', detail: 'Replied to a message.', createdAt: Date.now(), status: 'ok' });
  });
  return reply;
}

export { resetDemo, findUser, userByUsername, friendIdsOf, blockedIdsOf };
export { postLimiter };
