// MeetBook Phase 5 migration — Firestore EXPORT (one-off).
//
// Signs in with the shared MeetBook Official admin account
// (RUNNER_EMAIL / RUNNER_PASSWORD GitHub Secrets) through the normal
// Firebase client SDK — the exact same access pattern as
// runner/run-cycle.mjs — then dumps EVERY collection to a single
// JSON file (firestore-export.json) for runner/import-to-supabase.mjs.
//
// Shape: { exportedAt, collections: { <name>: [ { __id, ...data } ] } }
// Firestore Timestamps are serialised to epoch-ms numbers (mirroring
// tsToMs in src/utils.js), recursively, so the export is plain JSON.
//
// The botSecrets/config doc carries live AI provider keys, so this
// file is SENSITIVE: it is only ever produced as a short-lived
// GitHub Actions artifact (see .github/workflows/export-firestore.yml)
// and must be deleted after the import. This script never prints doc
// contents — counts only.
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { writeFileSync } from 'node:fs';
import { DEFAULT_FIREBASE_CONFIG } from '../src/firebase-config.js';

const email = process.env.RUNNER_EMAIL;
const password = process.env.RUNNER_PASSWORD;
if (!email || !password) {
  console.error('RUNNER_EMAIL / RUNNER_PASSWORD secrets are not set — cannot run.');
  process.exit(1);
}

// Every live collection (comments are embedded in posts — no separate
// collection exists). Order matches the import order for readability.
const COLLECTIONS = [
  'users', 'posts', 'stories', 'groups', 'groupRequests', 'pages',
  'reviews', 'events', 'conversations', 'invites', 'messages',
  'friendships', 'blocks', 'notifications', 'reports', 'adminLogs',
  'announcements', 'bots', 'botBrains', 'botMemories',
  'botConversations', 'botActivities', 'botLogs', 'botRunners',
  'botSettings', 'botSecrets', 'config'
];

// Recursive Firestore → plain-JSON serialiser. Timestamp handling
// mirrors tsToMs (src/utils.js): seconds * 1000 + floor(ns / 1e6).
function serialise(value) {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'number' || t === 'string' || t === 'boolean') return value;
  if (t !== 'object') return null; // functions/symbols cannot occur in Firestore data
  if (typeof value.toMillis === 'function') return value.toMillis(); // Firestore Timestamp
  if (value instanceof Date) return value.getTime();
  // Plain { seconds, nanoseconds } shape (defensive — data() normally
  // returns real Timestamp instances, handled above).
  if (typeof value.seconds === 'number' && Object.keys(value).length <= 2
      && (value.nanoseconds === undefined || typeof value.nanoseconds === 'number')) {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  // DocumentReference (the app stores id strings everywhere, so this
  // should never fire — keep the id rather than walking internals).
  if (typeof value.path === 'string' && typeof value.id === 'string' && 'firestore' in value) {
    return value.id;
  }
  if (Array.isArray(value)) return value.map(serialise);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = serialise(v);
  return out;
}

const app = initializeApp(DEFAULT_FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

async function main() {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  const meSnap = await getDoc(doc(db, 'users', cred.user.uid));
  const myRole = meSnap.exists() ? String(meSnap.data().role || '') : '';
  if (!['admin', 'superadmin'].includes(myRole)) {
    console.error(`Export account ${email} is not an admin (role: ${myRole || 'none'}) — refusing to run.`);
    process.exit(1);
  }
  console.log(`Signed in as ${email} (role: ${myRole}). Exporting…`);

  const collections = {};
  const failures = [];
  let total = 0;
  for (const name of COLLECTIONS) {
    try {
      const snap = await getDocs(collection(db, name));
      const rows = snap.docs.map((d) => ({ __id: d.id, ...serialise(d.data()) }));
      collections[name] = rows;
      total += rows.length;
      console.log(`  ${name}: ${rows.length} doc(s)${rows.length === 0 ? ' (missing or empty — skipped)' : ''}`);
    } catch (err) {
      failures.push(name);
      collections[name] = [];
      console.error(`  ${name}: READ FAILED — ${err.message}`);
    }
  }

  const payload = { exportedAt: Date.now(), collections };
  const outPath = 'firestore-export.json';
  writeFileSync(outPath, JSON.stringify(payload));
  console.log(`Export complete: ${total} doc(s) across ${COLLECTIONS.length} collections → ${outPath}`);

  if (failures.length) {
    // A partial dump must never be imported unknowingly — fail the
    // workflow run so no artifact is produced from incomplete data.
    console.error(`FAILED collections: ${failures.join(', ')} — export is INCOMPLETE, do not import.`);
    process.exit(1);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(`Export failed: ${err.stack || err.message}`);
  process.exit(1);
});
