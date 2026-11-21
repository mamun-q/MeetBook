// BACKEND COMPATIBILITY SHIM (Firebase → Supabase migration, Phase 2).
//
// The data layer (src/api.js) now runs on Supabase (src/supabase.js).
// src/main.js and src/views.js still import `firebaseReady` /
// `firebaseConfig` from this module for mode display, so this shim
// re-exports the Supabase-backed equivalents under the old names and
// the UI files need no changes. It imports NOTHING from the firebase
// package — the old SDK exports (app/auth/db/storage/googleProvider)
// are null because nothing outside the retired data layer used them.
//
// The legacy Firebase web config itself lives on in
// src/firebase-config.js, which only the not-yet-migrated GitHub
// Actions runner (runner/run-cycle.mjs, Phase 4) still reads.
import { supabaseReady, supabaseConfig } from './supabase.js';

export const firebaseReady = supabaseReady;
export const isFirebaseConfigured = supabaseReady;
export const firebaseConfig = {
  projectId: supabaseConfig.projectRef,
  authDomain: '',
  apiKey: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
  measurementId: ''
};
export const app = null;
export const auth = null;
export const db = null;
export const storage = null;
export const googleProvider = null;
