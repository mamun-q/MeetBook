// Language-ready i18n structure. Add a locale by adding a dictionary;
// missing keys fall back to English. The UI language is persisted per user.
export const LOCALES = {
  en: {
    appName: 'MeetBook',
    home: 'Home',
    friends: 'Friends',
    messages: 'Messages',
    notifications: 'Notifications',
    profile: 'Profile',
    settings: 'Settings',
    admin: 'Admin',
    bots: 'AI Bots',
    searchPlaceholder: 'Search people and posts…',
    whatsOnYourMind: "What's on your mind?",
    post: 'Post',
    like: 'Like',
    comment: 'Comment',
    share: 'Share',
    save: 'Save',
    saved: 'Saved',
    login: 'Log in',
    register: 'Create account',
    logout: 'Log out',
    demoMode: 'Demo mode — data is stored locally in your browser',
    aiBot: 'AI Bot',
    send: 'Send',
    darkMode: 'Dark mode',
    lightMode: 'Light mode',
    help: 'Help & FAQ',
    noPosts: 'No posts yet. Be the first to share something!',
    noNotifications: 'No notifications yet.',
    noMessages: 'No conversations yet. Say hello to someone!',
    online: 'Online',
    offline: 'Offline',
    follow: 'Follow',
    following: 'Following',
    addFriend: 'Add friend',
    friendsLabel: 'Friends',
    report: 'Report',
    delete: 'Delete',
    edit: 'Edit',
    cancel: 'Cancel'
  },
  bn: {
    appName: 'MeetBook',
    home: 'হোম',
    friends: 'বন্ধুরা',
    messages: 'মেসেজ',
    notifications: 'বিজ্ঞপ্তি',
    profile: 'প্রোফাইল',
    settings: 'সেটিংস',
    admin: 'অ্যাডমিন',
    bots: 'এআই বট',
    searchPlaceholder: 'মানুষ ও পোস্ট খুঁজুন…',
    whatsOnYourMind: 'আপনার মনে কী চলছে?',
    post: 'পোস্ট',
    like: 'লাইক',
    comment: 'মন্তব্য',
    share: 'শেয়ার',
    save: 'সেভ',
    saved: 'সেভ করা',
    login: 'লগ ইন',
    register: 'অ্যাকাউন্ট খুলুন',
    logout: 'লগ আউট',
    demoMode: 'ডেমো মোড — ডেটা আপনার ব্রাউজারেই থাকে',
    aiBot: 'এআই বট',
    send: 'পাঠান',
    darkMode: 'ডার্ক মোড',
    lightMode: 'লাইট মোড',
    help: 'সাহায্য ও প্রশ্নোত্তর',
    noPosts: 'এখনো কোনো পোস্ট নেই। প্রথম পোস্টটি আপনিই করুন!',
    noNotifications: 'এখনো কোনো বিজ্ঞপ্তি নেই।',
    noMessages: 'এখনো কোনো কথোপকথন নেই। কাউকে হ্যালো বলুন!',
    online: 'অনলাইন',
    offline: 'অফলাইন',
    follow: 'ফলো',
    following: 'ফলো করছেন',
    addFriend: 'বন্ধু যোগ করুন',
    friendsLabel: 'বন্ধু',
    report: 'রিপোর্ট',
    delete: 'মুছুন',
    edit: 'এডিট',
    cancel: 'বাতিল'
  }
};

let currentLocale = 'en';

export function setLocale(code) {
  if (LOCALES[code]) currentLocale = code;
  return currentLocale;
}

export function getLocale() {
  return currentLocale;
}

export function availableLocales() {
  return Object.keys(LOCALES);
}

export function t(key, locale = currentLocale) {
  return LOCALES[locale]?.[key] ?? LOCALES.en[key] ?? key;
}
