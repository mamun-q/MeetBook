// In-memory fakes for the firebase/firestore + firebase/auth SDK
// surface src/api.js imports, so live-mode (firebaseReady) code paths
// can be tested end to end without a network. Deliberately small:
// equality + array-contains filters, one orderBy, limit, doc/query
// snapshot listeners that re-fire on writes, and the arrayUnion /
// arrayRemove / serverTimestamp sentinels resolved at write time.
// No security-rules enforcement — rules are reviewed, not executed.

const collections = new Map(); // name -> Map(id -> data)
const listeners = new Set();
let autoId = 0;
let flushScheduled = false;

function colMap(name) {
  if (!collections.has(name)) collections.set(name, new Map());
  return collections.get(name);
}

function scheduleFlush(colName) {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    for (const l of [...listeners]) {
      if (l.col !== colName) continue;
      try { l.cb(snapshotFor(l)); } catch { /* listener errors are the app's problem */ }
    }
  });
}

function applyData(existing, data, merge) {
  const out = merge && existing ? { ...existing } : {};
  for (const [k, val] of Object.entries(data || {})) {
    if (val === undefined) continue;
    if (val && typeof val === 'object' && val.__arrayOp) {
      const arr = Array.isArray(out[k]) ? [...out[k]] : [];
      if (val.__arrayOp === 'union') { if (!arr.includes(val.value)) arr.push(val.value); }
      else { const i = arr.indexOf(val.value); if (i >= 0) arr.splice(i, 1); }
      out[k] = arr;
    } else if (val && typeof val === 'object' && val.__serverTs) {
      out[k] = Date.now();
    } else {
      out[k] = structuredClone(val);
    }
  }
  return out;
}

function writeDoc(col, id, data, merge) {
  const map = colMap(col);
  map.set(id, applyData(map.get(id), data, merge));
  scheduleFlush(col);
}

function runQuery(col, constraints = []) {
  let rows = [...colMap(col).entries()].map(([id, data]) => ({ id, data }));
  let lim = Infinity;
  for (const c of constraints) {
    if (c.type === 'where') {
      rows = rows.filter(({ data }) => {
        const v = data[c.field];
        if (c.op === '==') return v === c.value;
        if (c.op === 'array-contains') return Array.isArray(v) && v.includes(c.value);
        return false;
      });
    } else if (c.type === 'orderBy') {
      const dir = c.dir === 'desc' ? -1 : 1;
      rows = [...rows].sort((a, b) => ((a.data[c.field] ?? 0) - (b.data[c.field] ?? 0)) * dir);
    } else if (c.type === 'limit') lim = c.n;
  }
  return rows.slice(0, lim);
}

function docSnap(col, id) {
  const data = colMap(col).get(id);
  return {
    id,
    ref: { __col: col, __id: id },
    exists: () => data !== undefined,
    data: () => (data ? structuredClone(data) : undefined)
  };
}

function querySnap(col, constraints) {
  const rows = runQuery(col, constraints);
  return { docs: rows.map(({ id }) => docSnap(col, id)), empty: rows.length === 0, size: rows.length };
}

function snapshotFor(l) {
  return l.docId ? docSnap(l.col, l.docId) : querySnap(l.col, l.constraints);
}

// ------------------------------------------------------- firestore API
export function collection(db, name) { return { __col: name }; }
export function doc(db, name, id) { return { __col: name, __id: id }; }
export function query(colRef, ...constraints) { return { __col: colRef.__col, __constraints: constraints }; }
export function where(field, op, value) { return { type: 'where', field, op, value }; }
export function orderBy(field, dir = 'asc') { return { type: 'orderBy', field, dir }; }
export function limit(n) { return { type: 'limit', n }; }
export function serverTimestamp() { return { __serverTs: true }; }
export function arrayUnion(value) { return { __arrayOp: 'union', value }; }
export function arrayRemove(value) { return { __arrayOp: 'remove', value }; }

export async function setDoc(ref, data, opts = {}) {
  writeDoc(ref.__col, ref.__id, data, Boolean(opts.merge));
}
export async function addDoc(colRef, data) {
  const id = `fake_${(++autoId).toString(36)}`;
  writeDoc(colRef.__col, id, data, false);
  return { id, __col: colRef.__col, __id: id };
}
export async function updateDoc(ref, data) {
  if (!colMap(ref.__col).has(ref.__id)) throw new Error(`No document to update: ${ref.__col}/${ref.__id}`);
  writeDoc(ref.__col, ref.__id, data, true);
}
export async function deleteDoc(ref) {
  colMap(ref.__col).delete(ref.__id);
  scheduleFlush(ref.__col);
}
export async function getDoc(ref) { return docSnap(ref.__col, ref.__id); }
export async function getDocs(q) { return querySnap(q.__col, q.__constraints || []); }
export function onSnapshot(ref, cb, errCb) {
  const l = { col: ref.__col, docId: ref.__id || null, constraints: ref.__constraints || [], cb, errCb };
  listeners.add(l);
  queueMicrotask(() => { try { cb(snapshotFor(l)); } catch { /* ignore */ } });
  return () => listeners.delete(l);
}

// ------------------------------------------------------------ auth API
let authUser = null;
const authListeners = new Set();

function fireAuth() { for (const cb of [...authListeners]) cb(authUser); }

export const fakeAuth = {
  onAuthStateChanged(auth, cb) {
    authListeners.add(cb);
    queueMicrotask(() => cb(authUser));
    return () => authListeners.delete(cb);
  },
  async signInWithEmailAndPassword(auth, email) {
    const uid = fakeControl.usersByEmail[String(email).trim().toLowerCase()];
    if (!uid) { const e = new Error('Firebase: Error (auth/invalid-credential).'); e.code = 'auth/invalid-credential'; throw e; }
    authUser = { uid };
    fireAuth();
    return { user: authUser };
  },
  async createUserWithEmailAndPassword() { throw new Error('createUserWithEmailAndPassword is not implemented in the fake'); },
  async signInWithPopup() { throw new Error('signInWithPopup is not implemented in the fake'); },
  async sendPasswordResetEmail() {},
  async signOut() { authUser = null; fireAuth(); },
  async deleteUser() {}
};

// --------------------------------------------------------- test control
export const fakeControl = {
  usersByEmail: {},
  setAuthUser(user) { authUser = user; fireAuth(); },
  seed(col, id, data) { writeDoc(col, id, data, false); },
  get(col, id) { const d = colMap(col).get(id); return d ? structuredClone(d) : undefined; },
  all(col) { return [...colMap(col).entries()].map(([id, data]) => ({ id, ...structuredClone(data) })); },
  remove(col, id) { colMap(col).delete(id); scheduleFlush(col); },
  reset() {
    collections.clear();
    listeners.clear();
    authListeners.clear();
    authUser = null;
    this.usersByEmail = {};
  }
};
