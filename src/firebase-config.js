// Default Firebase web configuration for the MeetBook project
// (project "meetbook", Project ID: meetbook-d8a44).
//
// A Firebase *web* config is NOT a secret: it identifies the project to
// client apps and is designed to be shipped in public web code. Access is
// controlled by Firebase Authentication + Firestore/Storage Security Rules,
// never by hiding this config. Real secrets (AI provider keys, service
// accounts) must NEVER appear here — they live only in Cloud Functions.
//
// Any value can be overridden at build time with VITE_FIREBASE_* env vars
// (see .env.example). If this config is removed or broken, the app falls
// back to its clearly-labelled demo/offline mode.
export const DEFAULT_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCqsu9rHscxS_gxToFRH_p9Lh7if2_Zscc',
  authDomain: 'meetbook-d8a44.firebaseapp.com',
  projectId: 'meetbook-d8a44',
  storageBucket: 'meetbook-d8a44.firebasestorage.app',
  messagingSenderId: '952952705672',
  appId: '1:952952705672:web:fcc48ba8a41dc95b5ac53d',
  measurementId: 'G-L7PZG79GDQ'
};

export function resolveFirebaseConfig(env = {}) {
  const pick = (key, fallback) => {
    const v = env[key];
    return typeof v === 'string' && v.trim() ? v.trim() : fallback;
  };
  return {
    apiKey: pick('VITE_FIREBASE_API_KEY', DEFAULT_FIREBASE_CONFIG.apiKey),
    authDomain: pick('VITE_FIREBASE_AUTH_DOMAIN', DEFAULT_FIREBASE_CONFIG.authDomain),
    projectId: pick('VITE_FIREBASE_PROJECT_ID', DEFAULT_FIREBASE_CONFIG.projectId),
    storageBucket: pick('VITE_FIREBASE_STORAGE_BUCKET', DEFAULT_FIREBASE_CONFIG.storageBucket),
    messagingSenderId: pick('VITE_FIREBASE_MESSAGING_SENDER_ID', DEFAULT_FIREBASE_CONFIG.messagingSenderId),
    appId: pick('VITE_FIREBASE_APP_ID', DEFAULT_FIREBASE_CONFIG.appId),
    measurementId: pick('VITE_FIREBASE_MEASUREMENT_ID', DEFAULT_FIREBASE_CONFIG.measurementId)
  };
}

export function isConfigComplete(cfg) {
  return Boolean(cfg && cfg.apiKey && cfg.authDomain && cfg.projectId && cfg.appId);
}
