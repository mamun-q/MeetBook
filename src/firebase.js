// Firebase initialisation.
// Config resolution: VITE_FIREBASE_* env vars override the committed default
// web config (src/firebase-config.js) for project meetbook-d8a44, so the app
// runs in LIVE Firebase mode by default. Demo/offline mode is only a
// fallback if the config is removed or initialisation fails.
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { resolveFirebaseConfig, isConfigComplete } from './firebase-config.js';

const cfg = resolveFirebaseConfig(import.meta.env || {});

export const firebaseConfig = cfg;
export const isFirebaseConfigured = isConfigComplete(cfg);

let app = null;
let auth = null;
let db = null;
let storage = null;
let googleProvider = null;

if (isFirebaseConfigured) {
  try {
    app = initializeApp(cfg);
    auth = getAuth(app);
    db = getFirestore(app);
    // NOTE: Firebase Storage on this project requires the Blaze plan and is
    // not enabled yet (project is on Spark). getStorage() itself is safe to
    // call, but uploads may fail at runtime — api.uploadImage() catches that
    // and falls back to compressed data-URL images stored in Firestore.
    try { storage = getStorage(app); } catch { storage = null; }
    googleProvider = new GoogleAuthProvider();
  } catch (err) {
    // Fall back to demo mode rather than crashing the whole app.
    console.error('Firebase init failed, falling back to demo mode:', err);
    app = auth = db = storage = googleProvider = null;
  }
}

export { app, auth, db, storage, googleProvider };
export const firebaseReady = Boolean(db);
