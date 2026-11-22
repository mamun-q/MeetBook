// MeetBook application shell: routing, rendering, event delegation, theme,
// PWA install handling and realtime refresh.
import * as api from './api.js';
import { firebaseReady, firebaseConfig } from './firebase.js';
import { subscribe as storeSubscribe, mutate as demoMutate } from './store.js';
import { setLocale, t } from './i18n.js';
import { escapeHtml, uid as genId, timeAgo, storyBackgroundCss, normalisePoll, isStaff, canModerate, isAdminRole, accountStatus, analyticsSeries, seriesToCsv, recordClientError, messageSnippet, focusMovesWithinForm, rsvpToastKey, isThreadPinned, pickScrollAnchor, anchoredScrollTop, threadRestoreMode, threadPinnedAfterScroll } from './utils.js';
import { toast, clearToasts, openModal, closeModal, confirmModal, adminActionModal, avatarHtml, postCardHtml } from './components.js';
import { providerById } from './aiProviders.js';
import { cldImg } from './cloudinary.js';
import * as V from './views.js';
import { icon } from './icons.js';

// ------------------------------------------------------------- preferences
const PREF_KEY = 'meetbook_prefs_v1';
const prefs = (() => {
  try { return { theme: 'light', locale: 'en', ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; }
  catch { return { theme: 'light', locale: 'en' }; }
})();
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } }
function applyPrefs() {
  document.documentElement.dataset.theme = prefs.theme;
  setLocale(prefs.locale);
}
applyPrefs();

// ------------------------------------------------------------- app state
let feedPage = 1;
let deferredInstallPrompt = null;
const appEl = document.getElementById('app');

// Live-mode auth restoration: until Firebase reports the initial auth
// state (and, when a session exists, until the mirrored profile doc has
// loaded), render() shows the boot splash instead of flashing the login
// form at a user who is actually signed in.
let authResolved = false;
let authSessionSeen = false;
let lastJoinCode = '';
const BOOT_SPLASH_HTML = `<div class="boot-splash"><div class="boot-logo">M</div><div class="boot-sub">${t('taglineShort')}</div><div class="boot-spinner" aria-hidden="true"></div></div>`;

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = hash.split('?');
  const seg = pathPart.split('/').filter(Boolean);
  const query = new URLSearchParams(queryPart || '');
  return { seg, query, raw: hash };
}

function me() { return api.me(); }

function unreadCount(d, user) {
  return d.notifications.filter((n) => n.userId === user.id && !n.read).length;
}
function unreadMsgCount(d, user) {
  return d.messages.filter((m) => m.senderId !== user.id && !(m.readBy || []).includes(user.id) && d.conversations.find((c) => c.id === m.conversationId)?.participants.includes(user.id)).length;
}

// ------------------------------------------------- admin routing (Pack A)
// #/admin/* lives in the sidebar shell (views.adminShell). Visibility
// ladder: analyst → overview only; moderator → + reports; admin and
// superadmin → everything. Non-staff users get the long-standing
// "Admins only." handling; staff without the tier for a module get the
// shell's access-denied card. Pack B/C register further sub-routes here.
function adminRoute(d, user, seg, query) {
  if (!isStaff(user)) return `<div class="page narrow"><div class="card empty-state"><p>Admins only.</p></div></div>`;
  const sub = seg[1] || '';
  const shell = (active, content) => V.adminShell(d, user, active, content);
  switch (sub) {
    case '': return shell('overview', V.adminOverviewView(d, user, { firebase: firebaseReady, projectId: firebaseConfig.projectId }));
    case 'analytics': return shell('analytics', V.adminAnalyticsView(d, user, { days: Number(query.get('days') || 30) }));
    case 'users': return shell('users', isAdminRole(user) ? V.adminUsersView(d, user, {
      q: query.get('q') || '', status: query.get('status') || 'all',
      role: query.get('role') || 'all', kind: query.get('kind') || 'all',
      page: Number(query.get('page') || 1)
    }) : V.adminDeniedView());
    case 'content': return shell('content', canModerate(user) ? V.adminContentView(d, user, {
      tab: query.get('tab') || 'posts', q: query.get('q') || '',
      kind: query.get('kind') || 'all', page: Number(query.get('page') || 1)
    }) : V.adminDeniedView());
    case 'bots': {
      if (!isAdminRole(user)) return shell('bots', V.adminDeniedView());
      // Bot Control Center details page (Pack C): #/admin/bots/<id>?tab=
      if (seg[2]) {
        void api.loadBotAdminData(seg[2]); // live: mirror brain/memories/counters/conv meta, then re-render
        return shell('bots', V.botDetailsView(d, user, seg[2], query.get('tab') || 'overview'));
      }
      return shell('bots', V.botsView(d, user));
    }
    case 'reports': return shell('reports', canModerate(user) ? V.reportsView(d, user, { status: query.get('status') || 'all' }) : V.adminDeniedView());
    case 'announce': return shell('announce', isAdminRole(user) ? V.adminAnnounceView(d, user) : V.adminDeniedView());
    case 'security': return shell('security', isAdminRole(user) ? V.adminSecurityView(d, user, { q: query.get('q') || '' }) : V.adminDeniedView());
    case 'settings': return shell('settings', isAdminRole(user) ? V.adminSettingsView(d, user) : V.adminDeniedView());
    case 'health': {
      if (!isAdminRole(user)) return shell('health', V.adminDeniedView());
      void api.probeFirestoreHealth(); // one-shot read probe; result mirrors into the dataset
      return shell('health', V.adminHealthView(d, user, { firebase: firebaseReady, projectId: firebaseConfig.projectId }));
    }
    default: return shell('', V.adminDeniedView());
  }
}

// ------------------------------------------------------------- rendering
function headerHtml(d, user) {
  const un = unreadCount(d, user);
  const um = unreadMsgCount(d, user);
  // Wide screens (≥1020px, CSS) show a small text label beside each icon;
  // the title attribute covers every width.
  const navItem = (href, icon, label, badge = 0) => `<a class="topnav-link" href="${href}" title="${label}">${icon}${badge ? `<span class="nav-badge">${badge}</span>` : ''}<span class="nav-label">${label}</span></a>`;
  return `<header class="topbar">
    <a class="brand" href="#/"><img class="brand-logo" src="./icons/icon-192.png" alt="" /><span class="brand-name">${escapeHtml(d.config?.platformName || 'MeetBook')}</span></a>
    <form id="search-form" class="search-box" role="search">
      <input name="q" placeholder="${t('searchPlaceholder')}" autocomplete="off" />
      <button class="btn btn-primary btn-sm" type="submit">${t('search')}</button>
    </form>
    <a class="icon-btn mobile-search" href="#/search" title="${t('search')}" aria-label="${t('search')}">${icon('search')}</a>
    <nav class="topnav">
      ${navItem('#/', icon('home'), t('home'))}
      ${navItem('#/friends', icon('users'), t('friends'))}
      ${navItem('#/events', icon('calendar'), t('events'))}
      ${navItem('#/groups', icon('users-round'), t('groups'))}
      ${navItem('#/pages', icon('flag'), t('pages'))}
      ${navItem('#/messages', icon('message-circle'), t('messages'), um)}
      ${navItem('#/notifications', icon('bell'), t('notifications'), un)}
      ${isStaff(user) ? navItem('#/admin', icon('shield'), t('admin')) : ''}${isAdminRole(user) ? navItem('#/admin/bots', icon('bot'), t('bots')) : ''}
      <button class="icon-btn" data-act="toggle-theme" title="Theme">${prefs.theme === 'dark' ? icon('sun') : icon('moon')}</button>
      ${deferredInstallPrompt ? `<button class="btn btn-ghost btn-sm install-btn" data-act="install-app">${icon('download')} Install</button>` : ''}
      <div class="avatar-wrap">
        <button class="avatar-btn topnav-avatar" data-act="avatar-menu" title="${t('accountMenu')}" aria-label="${t('accountMenu')}">${avatarHtml(user, 34)}</button>
        <div class="menu avatar-menu hidden" id="avatar-menu">
          <div class="menu-user">${avatarHtml(user, 36)}<span class="grow"><b>${escapeHtml(user.name)}</b><br/><span class="muted small">@${escapeHtml(user.username)}</span></span></div>
          <a href="#/profile/${user.id}">${icon('user')} ${t('myProfile')}</a>
          <a href="#/saved">${icon('bookmark')} ${t('savedPosts')}</a>
          <a href="#/events">${icon('calendar')} ${t('events')}</a>
          <a href="#/memories">${icon('history')} ${t('memories')}</a>
          <a href="#/settings">${icon('settings')} ${t('settings')}</a>
          ${isStaff(user) ? `<a href="#/admin">${icon('shield')} ${t('adminPanel')}</a>` : ''}
          <a href="#/help">${icon('help-circle')} ${t('help')}</a>
          <button data-act="logout">${icon('log-out')} ${t('logout')}</button>
        </div>
      </div>
    </nav>
  </header>`;
}

// Mobile-only bottom navigation (CSS hides it above 720px, where the topbar
// and left rail already provide navigation). Mirrors the topnav's icons,
// badges and destinations, with a text label under each icon.
function bottomNavHtml(d, user, route, seg) {
  const un = unreadCount(d, user);
  const um = unreadMsgCount(d, user);
  const item = (href, icon, label, active, badge = 0) => `<a class="bottom-nav-item ${active ? 'active' : ''}" href="${href}">${icon}${badge ? `<span class="nav-badge">${badge}</span>` : ''}<span class="bottom-nav-label">${label}</span></a>`;
  return `<nav class="bottom-nav" aria-label="Primary">
    ${item('#/', icon('home'), t('home'), route === '')}
    ${item('#/friends', icon('users'), t('friends'), route === 'friends')}
    ${item('#/groups', icon('users-round'), t('groups'), route === 'groups' || route === 'group')}
    ${item('#/pages', icon('flag'), t('pages'), route === 'pages' || route === 'page')}
    ${item('#/messages', icon('message-circle'), t('messages'), route === 'messages', um)}
    ${item('#/notifications', icon('bell'), t('notifications'), route === 'notifications', un)}
    ${item(`#/profile/${user.id}`, avatarHtml(user, 24), t('profile'), route === 'profile' && seg[1] === user.id)}
  </nav>`;
}

export function render() {
  // Carry the open thread's scroll/UI state across the DOM swap
  // below (see the thread-stability block): capture BEFORE anything
  // is rebuilt, restore synchronously after.
  captureThreadView();
  const d = api.data();
  const user = me();
  const brand = d.config?.platformName || 'MeetBook'; // Platform settings (Pack C)
  const { seg, query } = parseRoute();
  const route = seg[0] || '';

  // App-shell mode for an open chat (mobile CSS keys off this): the
  // messages view becomes a fixed-height shell whose ONLY scroller
  // is the thread itself, instead of a page that scrolls under a
  // vh-sized thread box. Set on every render so route changes,
  // sign-out and the boot splash never leave it stale.
  document.body.classList.toggle('chat-open', Boolean(user) && route === 'messages' && Boolean(seg[1]));

  // Boot gate (live mode only — demo auth is synchronous): splash while
  // the auth state restores, and while a restored session's profile is
  // still loading into the mirror.
  if (firebaseReady && (!authResolved || (authSessionSeen && !user))) {
    appEl.innerHTML = BOOT_SPLASH_HTML;
    return;
  }

  if (!user) {
    const mode = route === 'register' ? 'register' : 'login';
    if (['help', 'terms', 'privacy', 'guidelines'].includes(route)) {
      appEl.innerHTML = `<div class="auth-wrap-col">${V.staticView(route)}<p class="center"><a href="#/login">← Back to login</a></p></div>`;
      return;
    }
    appEl.innerHTML = V.authView(mode);
    return;
  }

  // Group-chat invite links (#/messages?join=CODE): join once per code,
  // then land inside the conversation. Failures show the reason and
  // fall through to the plain inbox.
  const joinCode = route === 'messages' ? query.get('join') : null;
  if (joinCode && joinCode !== lastJoinCode) {
    lastJoinCode = joinCode;
    api.joinConversationByCode(joinCode)
      .then((convId) => { toast(t('joinedGroupChat'), 'success'); location.hash = `#/messages/${convId}`; })
      .catch((err) => { toast(err.message || t('invalidInviteLink'), 'error'); location.hash = '#/messages'; });
    return;
  }

  // Account-status gate (Pack A): a suspended/banned user sees only
  // the status notice (plus the header, so they can still log out) —
  // never the app itself. Pairs with the writerStatusOk() create-rule
  // gate in firestore.rules.
  if (accountStatus(user) !== 'active') {
    appEl.innerHTML = `
    ${headerHtml(d, user)}
    <div class="shell">${V.accountStatusView(user)}</div>
    <footer class="footer muted small">${escapeHtml(brand)} · ${t('taglineShort')}</footer>`;
    return;
  }

  const maintenance = d.config?.maintenanceMode && !isAdminRole(user);
  let body = '';
  switch (route) {
    case '': body = V.feedView(d, user, feedPage); break;
    case 'friends': body = V.friendsView(d, user); break;
    case 'events': body = V.eventsView(d, user); break;
    case 'event': body = V.eventView(d, user, seg[1] || ''); break;
    case 'groups': body = V.groupsView(d, user, query.get('q') || ''); break;
    case 'group': body = V.groupView(d, user, seg[1] || '', { loading: api.groupsSyncPending() }); break;
    case 'pages': body = V.pagesView(d, user, query.get('q') || ''); break;
    case 'page': body = V.pageView(d, user, seg[1] || ''); break;
    case 'messages': body = V.messagesView(d, user, seg[1] || ''); setTimeout(setupThread, 30); break;
    case 'notifications': body = V.notificationsView(d, user); break;
    case 'support': body = V.supportInboxView(d, user); break;
    case 'profile': body = V.profileView(d, user, seg[1] || user.id); break;
    case 'search': body = V.searchView(d, user, query.get('q') || ''); break;
    case 'saved': body = V.savedView(d, user); break;
    case 'memories': body = V.memoriesView(d, user); break;
    case 'settings': body = V.settingsView(d, user, prefs); break;
    case 'admin': body = adminRoute(d, user, seg, query); break;
    case 'bots': location.hash = '#/admin/bots'; return; // legacy link → Bot Center inside the admin shell
    case 'help': case 'terms': case 'privacy': case 'guidelines': body = V.staticView(route); break;
    case 'login': case 'register': location.hash = '#/'; return;
    default: body = V.feedView(d, user, feedPage);
  }

  appEl.innerHTML = `
    ${headerHtml(d, user)}
    ${maintenance ? `<div class="maintenance-banner">${icon('wrench')} MeetBook is briefly under maintenance. You can browse, but changes may be paused.</div>` : ''}
    ${!firebaseReady ? `<div class="demo-banner">${icon('flask')} ${t('demoMode')} — sign in with a demo account or create one. <button class="link-btn" data-act="dismiss-demo">Dismiss</button></div>` : ''}
    <div class="shell">${body}</div>
    <footer class="footer muted small">${escapeHtml(brand)} · ${t('taglineShort')} · <a href="#/help">${t('help')}</a> · <a href="#/terms">${t('termsOfService')}</a> · <a href="#/privacy">${t('privacyPolicy')}</a> · <a href="#/guidelines">${t('communityGuidelines')}</a></footer>
    ${bottomNavHtml(d, user, route, seg)}`;

  // Keep an open post ••• menu open across the re-render (realtime
  // updates rebuild the DOM roughly every few seconds).
  if (openPostMenuId) {
    const openMenu = document.getElementById(`menu-${openPostMenuId}`);
    if (openMenu) openMenu.classList.remove('hidden'); else openPostMenuId = '';
  }

  // Restore the open thread's scroll position + composer chrome
  // SYNCHRONOUSLY, before paint: positioning used to wait for a
  // 30ms timer, so every rebuild first flashed the top of the
  // thread and then snapped — the visible "jump".
  if (route === 'messages') restoreThreadView();

  maybeBrowserNotify(d, user);
}

// ------------------------------------------------------- thread stability
// render() rebuilds the whole app DOM on every data event, so an open
// conversation's scroll position must be carried across the swap
// explicitly. Without this, every rebuild created a fresh #thread-body
// at scrollTop 0 and a timer snapped it to the bottom 30ms later —
// the thread visibly jumped up and down on ANY data change (a message
// arriving in another chat, a typing heartbeat, a like), and a user
// who had scrolled up to read history was yanked to the tail. The
// model (pure helpers in utils.js): the view is either PINNED to the
// bottom or ANCHORED to the message row being read.
// captureThreadView() runs at the top of render(), before the swap;
// restoreThreadView() re-applies the position synchronously after it,
// and setupThread / image loads re-apply it as late layout (message
// photos have no reserved box, so rows grow as they load) settles.
// A passive scroll listener keeps the intent current between renders,
// so panel toggles and image loads never re-apply a stale position.
let threadIntent = null; // { convId, pinned, anchor, scrollTop }
let threadChrome = null; // { convId, panels, convSearch, convListTop }
// The thread box's height at the last intent update: a scroll event
// whose clientHeight differs from this was driven by a RESIZE
// (browser chrome, keyboard), not by the user's finger, and must
// not flip the pin (see threadPinnedAfterScroll in utils.js).
let threadLastClientHeight = null;
// Watches the thread box itself: any resize (chrome toggle,
// keyboard, panel opening above it) re-applies the scroll intent,
// so a pinned view re-glues to the tail instead of being left
// stranded wherever the geometry change dropped it.
let threadResizeObserver = null;
// Unsent composer text per conversation, tracked from the input
// event: a rebuild wipes the form, and softRender only protects the
// draft while focus stays inside the input — tapping any composer
// button (focus moves to the button) used to risk losing it on the
// next data event.
const composerDrafts = new Map();

function measureThreadRows(el) {
  const box = el.getBoundingClientRect();
  return [...el.querySelectorAll('.msg-row[id]')].map((row) => ({
    id: row.id.replace(/^msg-/, ''),
    top: row.getBoundingClientRect().top - box.top + el.scrollTop,
    height: row.offsetHeight
  }));
}

function panelOpen(id) {
  const p = document.getElementById(id);
  return p ? !p.classList.contains('hidden') : null;
}

function setPanelOpen(id, open) {
  if (open == null) return;
  const p = document.getElementById(id);
  if (p) p.classList.toggle('hidden', !open);
}

function captureThreadView() {
  const el = document.getElementById('thread-body');
  const convId = document.getElementById('message-form')?.dataset.conv || '';
  if (el && el.clientHeight > 0) {
    // Resize-aware pin: if the box height changed since the last
    // recorded metrics (chrome/keyboard) and the resize's own scroll
    // event was missed (listener attaches a beat after each rebuild),
    // the raw metrics would read a tail-glued user as "scrolled up".
    const resized = threadLastClientHeight != null && el.clientHeight !== threadLastClientHeight;
    const pinned = threadPinnedAfterScroll({
      wasPinned: threadIntent && threadIntent.convId === convId ? threadIntent.pinned : null,
      clientHeightBefore: threadLastClientHeight,
      scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight
    });
    threadIntent = {
      convId, pinned,
      // Across a resize, keep the anchor row the user was reading —
      // its position is re-measured in the new DOM at restore time.
      anchor: pinned ? null
        : (resized && threadIntent && threadIntent.convId === convId && threadIntent.anchor)
          || pickScrollAnchor(measureThreadRows(el), el.scrollTop),
      scrollTop: el.scrollTop
    };
    threadLastClientHeight = el.clientHeight;
  } else if (!el) {
    // No thread on screen (another route, logged out): the next open
    // is a FRESH open and must land on the latest message.
    threadIntent = null;
    threadLastClientHeight = null;
    if (threadResizeObserver) { threadResizeObserver.disconnect(); threadResizeObserver = null; }
  }
  threadChrome = {
    convId,
    panels: { emoji: panelOpen('emoji-panel'), sticker: panelOpen('sticker-panel'), tray: panelOpen('composer-tray') },
    convSearch: document.getElementById('conv-search')?.value ?? null,
    convListTop: document.querySelector('.conv-list')?.scrollTop ?? null
  };
}

// Apply the captured scroll intent to the live thread. Used after a
// rebuild and whenever late layout settles (image loads, panel
// toggles) — the intent itself is kept current by captureThreadView
// and the scroll listener, never re-read from a layout that a just
// loaded image may have already stretched.
function applyThreadScroll() {
  const el = document.getElementById('thread-body');
  if (!el || el.clientHeight === 0) return;
  const convId = document.getElementById('message-form')?.dataset.conv || '';
  if (threadRestoreMode(threadIntent, convId) === 'bottom') {
    el.scrollTop = el.scrollHeight;
    return;
  }
  const top = anchoredScrollTop(measureThreadRows(el), threadIntent.anchor);
  el.scrollTop = top != null ? top : Math.min(threadIntent.scrollTop || 0, el.scrollHeight);
}

function restoreThreadView() {
  applyThreadScroll();
  // Late first-frame settle (a webfont swap, a photo that completes
  // between the swap and the first paint) can still shift rows after
  // the synchronous apply: re-apply once on the next frame. The
  // intent is re-read at apply time, so a user scroll inside that
  // frame is respected, never overridden.
  requestAnimationFrame(() => applyThreadScroll());
  const s = threadChrome;
  if (!s) return;
  const list = document.querySelector('.conv-list');
  if (list && s.convListTop != null) list.scrollTop = s.convListTop;
  const convId = document.getElementById('message-form')?.dataset.conv || '';
  if (s.convId === convId) {
    const input = document.querySelector('#message-form input[name="text"]');
    const draft = composerDrafts.get(convId);
    if (input && draft && input.value !== draft) input.value = draft;
    setPanelOpen('emoji-panel', s.panels.emoji);
    setPanelOpen('sticker-panel', s.panels.sticker);
    setPanelOpen('composer-tray', s.panels.tray);
  }
  const cs = document.getElementById('conv-search');
  if (cs && s.convSearch != null && cs.value !== s.convSearch) {
    cs.value = s.convSearch;
    applyConvListFilter(cs);
  }
}

// Passive scroll listener (installed by setupThread): keeps the
// intent describing the position the user is actually looking at, so
// a later applyThreadScroll never snaps back to a pre-scroll spot.
// Programmatic scrolls fire it too — they recompute the intent from
// the position just applied, which is the same intent (stable).
function refreshThreadIntent(e) {
  const el = e.currentTarget;
  if (!el || el.clientHeight === 0) return;
  const convId = document.getElementById('message-form')?.dataset.conv || '';
  // A scroll event fired by a box RESIZE (browser chrome toggling,
  // keyboard opening) is not a user scroll: the browser clamps
  // scrollTop to the new geometry, and re-deriving the intent from
  // those clamped metrics would silently unpin a user at the tail
  // (box shrank → distance-to-bottom over the threshold) or move an
  // anchored reader's anchor row. Carry the intent over untouched;
  // only the height baseline moves.
  const resized = threadLastClientHeight != null && el.clientHeight !== threadLastClientHeight;
  threadLastClientHeight = el.clientHeight;
  if (resized && threadIntent && threadIntent.convId === convId) return;
  const pinned = isThreadPinned(el);
  threadIntent = {
    convId,
    pinned,
    anchor: pinned ? null : pickScrollAnchor(measureThreadRows(el), el.scrollTop),
    scrollTop: el.scrollTop
  };
}

// Explicit go-to-the-tail (own send, quick-emoji, poll create): jump
// now AND pin the intent, so following re-renders keep the tail in
// view instead of restoring a pre-send reading position.
function scrollThread() {
  const el = document.getElementById('thread-body');
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  threadIntent = {
    convId: document.getElementById('message-form')?.dataset.conv || '',
    pinned: true, anchor: null, scrollTop: el.scrollTop
  };
}

function setupThread() {
  restoreThreadView();
  const threadEl = document.getElementById('thread-body');
  if (threadEl) {
    threadEl.addEventListener('scroll', refreshThreadIntent, { passive: true });
    // Message photos have no reserved dimensions: when one finishes
    // loading it grows its row (and the thread). Re-applying the
    // intent keeps a pinned view glued to the tail and an anchored
    // view on the same message at the same offset.
    threadEl.addEventListener('load', (e) => { if (e.target?.tagName === 'IMG') applyThreadScroll(); }, true);
    // Box-resize glue: when the thread's own box changes height
    // (browser chrome toggling, keyboard opening, a panel opening
    // above it), re-apply the intent so a pinned view re-glues to
    // the tail and an anchored view re-seats its row, instead of
    // stranding the position the old geometry had. (Applying a
    // scroll never resizes the box, so this cannot loop.)
    if (typeof ResizeObserver !== 'undefined') {
      if (threadResizeObserver) threadResizeObserver.disconnect();
      threadResizeObserver = new ResizeObserver(() => applyThreadScroll());
      threadResizeObserver.observe(threadEl);
    }
  }
  // Voice messages need MediaRecorder + getUserMedia; hide the mic
  // button entirely where they are unavailable.
  const btn = document.getElementById('voice-btn');
  if (btn && !voiceSupported()) btn.style.display = 'none';
  // Chat Pack: restore the reply preview if a re-render wiped it
  // mid-reply, and keep the typing row fresh on a 1s ticker — a full
  // re-render per heartbeat would yank focus out of the composer, and
  // softRender is suppressed while typing anyway. The ticker retires
  // itself as soon as the thread leaves the DOM.
  if (replyTarget && document.getElementById('message-form')?.dataset.conv === replyTarget.convId) showReplyPreview();
  if (typingTicker) clearInterval(typingTicker);
  typingTicker = setInterval(() => {
    const row = document.getElementById('typing-row');
    if (!row) { clearInterval(typingTicker); typingTicker = null; return; }
    const convId = document.getElementById('message-form')?.dataset.conv;
    const d = api.data();
    const user = me();
    const conv = d.conversations.find((c) => c.id === convId);
    row.innerHTML = conv && user ? V.typingIndicatorHtml(conv, user, V.usersById(d)) : '';
    // Vanish mode: re-render the moment a vanish message in the open
    // thread passes its expiry, so it disappears on time.
    if (conv?.vanish && user) {
      const now = Date.now();
      if (d.messages.some((m) => m.conversationId === convId && m.vanish && m.expiresAt && m.expiresAt <= now && m.expiresAt > now - 1500)) render();
    }
  }, 1000);
}

// ------------------------------------------------- foreground web notifications
// When the user enables "Browser notifications" (Settings → Notifications)
// and grants permission, NEW notifications that arrive through the existing
// realtime listeners while the app is open also pop a Web Notification.
// The seen-id set is seeded on first sight so history never replays; only
// notifications created after this session started can pop.
//
// FUTURE (FCM): background push (app closed) would plug in here — it
// needs Firebase Cloud Messaging plus a server-side sender (Cloud
// Functions on Blaze) calling the FCM API for the user's registration
// tokens. Out of scope on the Spark plan; foreground-only by design.
const seenNotificationIds = new Set();
let notifWatchStartedAt = 0;
function maybeBrowserNotify(d, user) {
  if (!('Notification' in window)) return;
  const mine = (d.notifications || []).filter((n) => n.userId === user.id);
  if (!notifWatchStartedAt) {
    notifWatchStartedAt = Date.now();
    for (const n of mine) seenNotificationIds.add(n.id);
    return;
  }
  if (!user.settings?.browserNotifications || Notification.permission !== 'granted') {
    for (const n of mine) seenNotificationIds.add(n.id);
    return;
  }
  for (const n of mine) {
    if (seenNotificationIds.has(n.id)) continue;
    seenNotificationIds.add(n.id);
    if (n.read || n.actorId === user.id || Number(n.createdAt) < notifWatchStartedAt) continue;
    try { new Notification('MeetBook', { body: n.text || 'You have a new notification.' }); } catch { /* permission raced */ }
  }
  if (seenNotificationIds.size > 1000) { // keep the set bounded
    const keep = mine.slice(0, 200).map((n) => n.id);
    seenNotificationIds.clear();
    for (const id of keep) seenNotificationIds.add(id);
  }
}

// ------------------------------------------------- Chat Pack: reply + typing
// replyTarget: the message the composer is currently replying to (set
// by the ↩️ action on a message, cleared on send / cancel / navigation).
// The send path snapshots it onto the new message via api.sendMessage.
let replyTarget = null; // { id, convId, name, text }
let openPostMenuId = ''; // post id whose ••• menu is open — render() restores it so realtime re-renders don't slam the menu shut mid-click (audit 2026-11-20)
let typingTicker = null; // 1s interval refreshing #typing-row (setupThread)

function showReplyPreview() {
  const el = document.getElementById('reply-preview');
  if (!el || !replyTarget) return;
  el.innerHTML = `<span class="grow small"><b>${escapeHtml(t('replyingTo').replace('{name}', replyTarget.name))}</b><br/>${escapeHtml(replyTarget.text)}</span><button type="button" class="btn btn-ghost btn-sm" data-act="cancel-reply" aria-label="${t('cancel')}">${icon('x')}</button>`;
  el.classList.remove('hidden');
}

function hideReplyPreview() {
  const el = document.getElementById('reply-preview');
  if (el) { el.innerHTML = ''; el.classList.add('hidden'); }
}

// Typing heartbeat: refresh conversations.typing[me] at most every 2s
// while keystrokes continue; clear it 3s after the last keystroke, or
// immediately on send/blur. Readers honour only entries <4s old
// (utils.TYPING_FRESH_MS), so a missed clear can never stick.
let typingState = { convId: '', lastSent: 0, idleTimer: null };

function noteTyping(convId) {
  if (!convId) return;
  if (typingState.convId !== convId) typingState = { convId, lastSent: 0, idleTimer: null };
  const now = Date.now();
  if (now - typingState.lastSent >= 2000) {
    typingState.lastSent = now;
    void api.setTyping(convId, true);
  }
  clearTimeout(typingState.idleTimer);
  typingState.idleTimer = setTimeout(stopTyping, 3000);
}

function stopTyping() {
  clearTimeout(typingState.idleTimer);
  if (typingState.convId) void api.setTyping(typingState.convId, false);
  typingState = { convId: '', lastSent: 0, idleTimer: null };
}

// ------------------------------------------------------------- voice messages
// MediaRecorder capture for Messenger voice notes. Audio is stored as a
// base64 data URL on the message (audio/webm in most browsers), capped at
// 60 seconds and ~700KB — Firestore documents cap at 1MB, so anything
// bigger is rejected with a toast instead of being sent.
const VOICE_MAX_MS = 60_000;
const VOICE_MAX_DATA_URL = 950_000; // ~700KB of audio once base64-decoded
let voiceRec = null; // { recorder, stream, chunks, startedAt, timer, convId, blob }

function voiceSupported() {
  return typeof window !== 'undefined' && 'MediaRecorder' in window && Boolean(navigator.mediaDevices?.getUserMedia);
}

async function startVoiceRecording(convId) {
  if (!voiceSupported()) { toast('Voice recording is not supported in this browser.', 'error'); return; }
  if (voiceRec) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { toast('Microphone access was denied.', 'error'); return; }
  const recorder = new MediaRecorder(stream);
  const rec = { recorder, stream, chunks: [], startedAt: Date.now(), timer: null, convId, blob: null };
  recorder.ondataavailable = (ev) => { if (ev.data?.size) rec.chunks.push(ev.data); };
  recorder.onstop = () => {
    rec.blob = new Blob(rec.chunks, { type: recorder.mimeType || 'audio/webm' });
    stream.getTracks().forEach((tr) => tr.stop());
  };
  voiceRec = rec;
  recorder.start(250);
  document.getElementById('voice-ui')?.classList.remove('hidden');
  document.getElementById('message-form')?.classList.add('hidden');
  const timeEl = document.getElementById('voice-time');
  rec.timer = setInterval(() => {
    const elapsed = Date.now() - rec.startedAt;
    if (timeEl) timeEl.textContent = `${Math.floor(elapsed / 60000)}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, '0')}`;
    if (elapsed >= VOICE_MAX_MS && recorder.state === 'recording') recorder.stop(); // hard cap: auto-stop at 60s
  }, 250);
}

function endVoiceRecording() {
  if (!voiceRec) return;
  clearInterval(voiceRec.timer);
  if (voiceRec.recorder.state === 'recording') voiceRec.recorder.stop();
  voiceRec.stream?.getTracks().forEach((tr) => tr.stop());
}

function resetVoiceUi() {
  endVoiceRecording();
  voiceRec = null;
  document.getElementById('voice-ui')?.classList.add('hidden');
  document.getElementById('message-form')?.classList.remove('hidden');
}

async function sendVoiceRecording() {
  const rec = voiceRec;
  if (!rec) return;
  endVoiceRecording();
  // Give onstop a tick to assemble the blob.
  await new Promise((r) => setTimeout(r, 60));
  const blob = rec.blob || new Blob(rec.chunks, { type: 'audio/webm' });
  const convId = rec.convId;
  resetVoiceUi();
  if (!blob.size) { toast('Nothing was recorded.', 'error'); return; }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  }).catch(() => '');
  if (!dataUrl) { toast('Could not read the recording.', 'error'); return; }
  if (dataUrl.length > VOICE_MAX_DATA_URL) {
    toast('That voice message is too long to send (about 60 seconds max).', 'error');
    return;
  }
  const replyToId = replyTarget && replyTarget.convId === convId ? replyTarget.id : '';
  const sent = await handle(api.sendMessage(convId, { text: '', image: '', audio: dataUrl, replyToId }), 'Voice message sent.');
  if (sent) { if (replyToId) replyTarget = null; render(); scrollThread(); }
}

// ------------------------------------------------------------- story viewer
// Full-screen overlay rendered into its own root (separate from #app and
// #modal-root, so realtime re-renders never disturb it). The queue is the
// flattened rail order from views.storyQueueFor: author groups in rail
// order, each author's stories oldest-first. Opening an author starts at
// their first unviewed story (or their first story when all are viewed).
let storySession = null; // { queue: [story], idx }

// Each story shows for 5s: the active progress segment fills over the
// same duration (CSS animation) and a timer advances the viewer.
const STORY_DURATION_MS = 5000;
let storyTimer = null;
function clearStoryTimer() { if (storyTimer) { clearTimeout(storyTimer); storyTimer = null; } }
function armStoryTimer() {
  clearStoryTimer();
  if (!storySession) return;
  storyTimer = setTimeout(() => {
    storyTimer = null;
    // Never yank the story away mid-reply — re-check shortly instead.
    if (document.activeElement?.id === 'story-reply-input') { armStoryTimer(); return; }
    storyNav(1);
  }, STORY_DURATION_MS);
}

function storyRootEl() {
  let root = document.getElementById('story-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'story-root';
    document.body.appendChild(root);
  }
  return root;
}

function openStoryViewer(authorId) {
  const d = api.data();
  const user = me();
  if (!user) return;
  const queue = V.storyQueueFor(d, user);
  const mine = queue.map((s, i) => (s.authorId === authorId ? i : -1)).filter((i) => i >= 0);
  if (!mine.length) return;
  const start = mine.find((i) => queue[i].authorId !== user.id && !(queue[i].views || []).includes(user.id)) ?? mine[0];
  storySession = { queue, idx: start };
  renderStoryViewer();
}

function closeStoryViewer() {
  clearStoryTimer();
  storySession = null;
  storyRootEl().innerHTML = '';
}

function storyNav(delta) {
  if (!storySession) return;
  const next = storySession.idx + delta;
  if (next < 0) return;
  if (next >= storySession.queue.length) { closeStoryViewer(); return; }
  storySession.idx = next;
  renderStoryViewer();
}

function renderStoryViewer() {
  if (!storySession) return;
  const d = api.data();
  const user = me();
  const s = storySession.queue[storySession.idx];
  if (!s || !user) { closeStoryViewer(); return; }
  const byId = V.usersById(d);
  const author = byId[s.authorId];
  const isMine = s.authorId === user.id;
  const authorStories = storySession.queue.filter((q) => q.authorId === s.authorId);
  const posInAuthor = authorStories.indexOf(s);
  const viewers = (s.views || []).map((id) => byId[id]).filter(Boolean);
  const stage = s.image
    ? `<img class="story-stage-img" src="${escapeHtml(cldImg(s.image, 1080))}" alt="" decoding="async" />${s.text ? `<div class="story-caption">${escapeHtml(s.text)}</div>` : ''}`
    : `<div class="story-stage-text" style="background:${storyBackgroundCss(s.bg)}"><p>${escapeHtml(s.text)}</p></div>`;
  storyRootEl().innerHTML = `
  <div class="story-viewer" role="dialog" aria-modal="true" aria-label="${t('stories')}">
    <div class="story-top">
      <div class="story-segments">${authorStories.map((q, qi) => `<span class="story-seg ${qi < posInAuthor ? 'done' : qi === posInAuthor ? 'active' : ''}"><span class="story-seg-fill"></span></span>`).join('')}</div>
      <div class="story-author">
        ${avatarHtml(author, 34)}
        <span class="grow"><b>${escapeHtml(author?.name || '')}</b> <span class="story-time">${timeAgo(s.createdAt)}</span></span>
        ${isMine ? `<button class="story-icon-btn" data-act="story-delete" aria-label="${t('deleteStory')}">${icon('trash')}</button>` : ''}
        <button class="story-icon-btn" data-act="story-close" aria-label="Close">${icon('x')}</button>
      </div>
    </div>
    <div class="story-stage">
      ${stage}
      <button class="story-zone left" data-act="story-prev" aria-label="Previous">‹</button>
      <button class="story-zone right" data-act="story-next" aria-label="Next">›</button>
    </div>
    ${isMine ? `<div class="story-footer">${icon('eye')} ${viewers.length} ${t('viewers')}${viewers.length ? ` · ${t('seenBy')}: ${viewers.map((v) => escapeHtml(v.name)).join(', ')}` : ` · ${t('noViewersYet')}`}</div>` : `
    <form id="story-reply-form" class="story-reply" data-author="${s.authorId}">
      <input id="story-reply-input" name="text" maxlength="500" placeholder="${t('storyReplyPlaceholder')}" autocomplete="off" />
      <button class="btn btn-primary btn-sm" type="submit">${t('send')}</button>
    </form>`}
  </div>`;
  armStoryTimer();
  // Viewing someone else's story records the view (rules allow exactly
  // this views-only append); fire-and-forget so playback never blocks.
  if (!isMine) api.markStoryViewed(s.id).catch(() => {});
}

document.addEventListener('keydown', (e) => {
  if (!storySession) return;
  if (e.key === 'Escape') { closeStoryViewer(); return; }
  // Arrow keys belong to the reply input while the user is typing.
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (e.key === 'ArrowRight') storyNav(1);
  if (e.key === 'ArrowLeft') storyNav(-1);
});

function softRender() {
  if (voiceRec) return; // never re-render mid-recording — it would wipe the recording UI
  // Signed-out → signed-in transitions must ALWAYS render, even while
  // focus sits in the login form's inputs: otherwise a successful login
  // (whose mirror update arrives after the submit handler) leaves the
  // user staring at the login form until a manual reload.
  if (!me()) { render(); return; }
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return; // don't yank focus while typing
  render();
}

// Realtime: demo store subscription + Firestore mirror events.
storeSubscribe(() => softRender());
document.addEventListener('meetbook:data', () => softRender());
// Thread glue for layout changes no rebuild is involved in. A
// photo finishing loading grows its row (photos carry no reserved
// box): the load listener lives on the document (capture phase —
// load does not bubble) so it also covers the window between a
// rebuild and setupThread attaching the thread-local one, which a
// fast cached photo could otherwise slip through. Viewport resizes
// (mobile browser chrome showing/hiding, keyboard open/close — the
// latter often ONLY moves the visual viewport) re-apply the intent
// the same way: pinned re-glues, anchored re-seats.
document.addEventListener('load', (e) => {
  if (e.target?.tagName === 'IMG' && e.target.closest?.('#thread-body')) applyThreadScroll();
}, true);
window.addEventListener('resize', () => applyThreadScroll());
window.visualViewport?.addEventListener('resize', () => applyThreadScroll());
window.addEventListener('hashchange', () => { feedPage = 1; clearToasts(1500); replyTarget = null; stopTyping(); render(); window.scrollTo({ top: 0 }); });

// Infinite scroll for the feed (the Load more button is the fallback).
window.addEventListener('scroll', () => {
  const { seg } = parseRoute();
  if ((seg[0] || '') !== '' || !me()) return;
  if (window.innerHeight + window.scrollY > document.body.offsetHeight - 600) {
    const btn = document.querySelector('[data-act="feed-more"]');
    if (btn) { feedPage = Number(btn.dataset.page || feedPage + 1); render(); }
  }
}, { passive: true });

// ------------------------------------------------------------- helpers
async function handle(promise, successMsg) {
  try {
    const r = await promise;
    if (successMsg) toast(successMsg, 'success');
    render();
    return r;
  } catch (err) {
    toast(err.message || 'Something went wrong.', 'error');
    return null;
  }
}

// Engagement actions (like / react / save / poll vote) refresh ONLY the
// tapped post card, in place. A full render() rebuilds the whole page —
// and with the optimistic patch, handle() and the Firestore echo each
// rendering too, one tap used to mean three full rebuilds, which on a
// phone reads as the screen shaking. The api now patches the mirror
// silently for these actions and the posts listener suppresses
// no-change echoes, so this local refresh is the only paint.
function refreshPostCard(postId) {
  const old = document.querySelector(`article.post-card[data-post="${CSS.escape(postId)}"]`);
  const d = api.data(); const user = me();
  const post = d.posts.find((p) => p.id === postId);
  if (!old || !post || !user) { render(); return; }
  // Carry over anything typed into the card's comment/reply boxes and
  // any open reply forms — the swap must never eat a draft.
  const drafts = new Map(); const openReplies = new Set();
  old.querySelectorAll('form').forEach((f) => {
    const key = f.dataset.commentForm ? `c:${f.dataset.commentForm}` : f.dataset.replyForm ? `r:${f.dataset.replyForm}` : '';
    const input = f.querySelector('input[name="text"]');
    if (key && input && input.value) drafts.set(key, input.value);
    if (f.dataset.replyForm && !f.classList.contains('hidden')) openReplies.add(f.dataset.replyForm);
  });
  const tpl = document.createElement('template');
  const ctx = V.viewCtx(d, user);
  // The group view deliberately suppresses the "Posted in …" note
  // (you are already inside the group); a card refreshed there must
  // not grow the note until the next full render (Audit #3).
  if (parseRoute().seg[0] === 'group') ctx.showGroupContext = false;
  tpl.innerHTML = postCardHtml(post, ctx).trim();
  const fresh = tpl.content.firstElementChild;
  if (!fresh) { render(); return; }
  old.replaceWith(fresh);
  fresh.querySelectorAll('form').forEach((f) => {
    const key = f.dataset.commentForm ? `c:${f.dataset.commentForm}` : f.dataset.replyForm ? `r:${f.dataset.replyForm}` : '';
    const input = f.querySelector('input[name="text"]');
    if (key && input && drafts.has(key)) input.value = drafts.get(key);
    if (f.dataset.replyForm && openReplies.has(f.dataset.replyForm)) f.classList.remove('hidden');
  });
}

async function engage(promise, postId, successMsg) {
  try { refreshPostCard(postId); } catch { render(); } // the mirror is already patched optimistically — paint now
  try {
    const r = await promise;
    if (successMsg) toast(successMsg, 'success');
    // On the Saved view, unsaving changes the LIST itself, not just
    // the card: a card-only refresh left the unsaved post sitting in
    // the list until the next full render (Audit #3).
    const user = me();
    const post = api.data().posts.find((p) => p.id === postId);
    if ((parseRoute().seg[0] || '') === 'saved' && post && user && !(post.savedBy || []).includes(user.id)) render();
    else refreshPostCard(postId);
    return r;
  } catch (err) {
    toast(err.message || 'Something went wrong.', 'error');
    try { refreshPostCard(postId); } catch { render(); } // the api rolled the mirror back — show the true state
    return null;
  }
}

function fileFrom(form, name) {
  const input = form.querySelector(`input[name="${name}"]`);
  return input?.files?.[0] || null;
}

// ------------------------------------------------------------- click actions
document.addEventListener('click', async (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { location.hash = nav.dataset.nav; return; }

  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) { closeModal(); return; }

  const menuBtn = e.target.closest('[data-menu]');
  if (menuBtn) {
    const menu = document.getElementById(`menu-${menuBtn.dataset.menu}`);
    document.querySelectorAll('.menu').forEach((m) => { if (m !== menu) m.classList.add('hidden'); });
    menu?.classList.toggle('hidden');
    openPostMenuId = menu && !menu.classList.contains('hidden') ? menuBtn.dataset.menu : '';
    return;
  }

  // Post ••• menus: a click on a menu item closes the menu; a click
  // anywhere outside the menu wrapper closes it too.
  if (e.target.closest('.post-menu-wrap .menu [data-act]')) {
    e.target.closest('.menu')?.classList.add('hidden');
    openPostMenuId = '';
  } else if (!e.target.closest('.post-menu-wrap')) {
    document.querySelectorAll('.post-menu-wrap .menu').forEach((m) => m.classList.add('hidden'));
    openPostMenuId = '';
  }

  // Account dropdown: closes on any click outside its wrapper, and when
  // one of its links is followed (the toggle button itself is inside the
  // wrapper, so it never triggers this close).
  const avatarMenuEl = document.getElementById('avatar-menu');
  if (avatarMenuEl && (!e.target.closest('.avatar-wrap') || e.target.closest('.avatar-menu a'))) {
    avatarMenuEl.classList.add('hidden');
  }

  // Messenger emoji picker: insert into the message input, keep focus.
  const emojiBtn = e.target.closest('[data-emoji-insert]');
  if (emojiBtn) {
    const input = document.querySelector('#message-form input[name="text"]');
    if (input) {
      input.value += emojiBtn.dataset.emojiInsert;
      input.focus();
      // Programmatic edit — no input event fires, so sync the draft.
      const convId = document.getElementById('message-form')?.dataset.conv;
      if (convId) composerDrafts.set(convId, input.value);
    }
    return;
  }

  const actEl = e.target.closest('[data-act]');
  if (!actEl) return;
  const act = actEl.dataset.act;
  const d = api.data();
  const user = me();
  const postEl = actEl.closest('[data-post]');
  const postId = postEl?.dataset.post;

  switch (act) {
    case 'dismiss-demo': actEl.parentElement.remove(); break;
    case 'avatar-menu': document.getElementById('avatar-menu')?.classList.toggle('hidden'); break;
    case 'toggle-pw': {
      const wrap = actEl.closest('.pw-wrap');
      const input = wrap?.querySelector('input');
      if (input) {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        actEl.innerHTML = show ? icon('eye-off') : icon('eye');
        actEl.setAttribute('aria-label', show ? t('hidePassword') : t('showPassword'));
        actEl.title = show ? t('hidePassword') : t('showPassword');
      }
      break;
    }
    case 'pick-photo': actEl.closest('form')?.querySelector('input[type="file"][name="image"]')?.click(); break;
    case 'remove-composer-photo': {
      const form = actEl.closest('form');
      const input = form?.querySelector('input[name="image"]');
      if (input) input.value = '';
      const preview = document.getElementById('composer-preview');
      if (preview) preview.innerHTML = '';
      break;
    }
    case 'clear-message-photo': {
      const input = document.getElementById('msg-image-input');
      if (input) input.value = '';
      const preview = document.getElementById('message-preview');
      if (preview) { preview.innerHTML = ''; preview.classList.add('hidden'); }
      break;
    }
    case 'poll-add-option': {
      const list = document.getElementById('poll-options-list');
      if (!list) break;
      const rows = list.querySelectorAll('.poll-opt-row');
      if (rows.length >= 4) { toast('A poll can have up to 4 options.', 'error'); break; }
      const row = document.createElement('div');
      row.className = 'row gap-sm poll-opt-row';
      row.innerHTML = `<input name="pollOption" maxlength="60" placeholder="${t('pollOption')} ${rows.length + 1}" autocomplete="off" /><button type="button" class="btn btn-ghost btn-sm" data-act="poll-remove-option" aria-label="Remove option">${icon('x')}</button>`;
      list.appendChild(row);
      row.querySelector('input')?.focus();
      break;
    }
    case 'poll-remove-option': actEl.closest('.poll-opt-row')?.remove(); break;
    case 'poll-remove': {
      const form = actEl.closest('form');
      const checkbox = form?.querySelector('[name="hasPoll"]');
      if (checkbox) checkbox.checked = false;
      document.getElementById('poll-fields')?.classList.add('hidden');
      const list = document.getElementById('poll-options-list');
      if (list) list.innerHTML = [1, 2].map((i) => `<div class="row gap-sm poll-opt-row"><input name="pollOption" maxlength="60" placeholder="${t('pollOption')} ${i}" autocomplete="off" /></div>`).join('');
      const ta = form?.querySelector('textarea[name="text"]');
      if (ta) ta.placeholder = t('whatsOnYourMind');
      break;
    }
    case 'emoji-toggle': { const panel = document.getElementById('emoji-panel'); panel?.classList.toggle('hidden'); if (panel && !panel.classList.contains('hidden')) applyThreadScroll(); break; }
    case 'composer-more': { const tray = document.getElementById('composer-tray'); tray?.classList.toggle('hidden'); if (tray && !tray.classList.contains('hidden')) applyThreadScroll(); break; }
    // ---- Chat Pack: conversation info / themes / reply / reactions / pins
    case 'conv-info': {
      // The open state lives in uiState (keyed by conversation) so a
      // re-render — above all picking a chat theme, Audit fix #5 —
      // restores the panel instead of rebuilding it closed.
      const convId = document.getElementById('message-form')?.dataset.conv || '';
      V.uiState.convInfoFor = V.uiState.convInfoFor === convId ? '' : convId;
      document.getElementById('conv-info')?.classList.toggle('hidden');
      break;
    }
    case 'set-theme': await handle(api.setConversationTheme(actEl.dataset.conv, actEl.dataset.theme)); break;
    // ---- Messenger Complete Pack: filters, archive/mute, thread emoji
    case 'conv-filter': V.uiState.convFilter = actEl.dataset.filter || 'all'; V.uiState.convMenuFor = ''; render(); break;
    case 'conv-menu': {
      const id = actEl.dataset.id;
      const menu = document.getElementById(`conv-menu-${id}`);
      document.querySelectorAll('.conv-menu').forEach((m) => { if (m !== menu) m.classList.add('hidden'); });
      V.uiState.convMenuFor = V.uiState.convMenuFor === id ? '' : id;
      menu?.classList.toggle('hidden');
      break;
    }
    case 'conv-archive': {
      const conv = d.conversations.find((c) => c.id === actEl.dataset.id);
      const on = !(conv?.archivedBy || []).includes(user.id);
      V.uiState.convMenuFor = '';
      await handle(api.setConversationFlag(actEl.dataset.id, 'archivedBy', on), on ? t('chatArchived') : t('chatUnarchived'));
      break;
    }
    case 'conv-mute': {
      // Useful Pack: timed mute — data-ms is '' (unmute), 'inf'
      // (forever) or a millisecond duration.
      V.uiState.convMenuFor = '';
      const ms = actEl.dataset.ms;
      if (!ms) await handle(api.setConversationMute(actEl.dataset.id, null), t('chatUnmuted'));
      else await handle(api.setConversationMute(actEl.dataset.id, ms === 'inf' ? Infinity : Number(ms)), t('chatMuted'));
      break;
    }
    case 'conv-pin': {
      const conv = d.conversations.find((c) => c.id === actEl.dataset.id);
      const on = !(conv?.pinnedBy || []).includes(user.id);
      V.uiState.convMenuFor = '';
      await handle(api.setConversationFlag(actEl.dataset.id, 'pinnedBy', on), on ? t('chatPinned') : t('chatUnpinned'));
      break;
    }
    case 'accept-msg-request': await handle(api.acceptConversationRequest(actEl.dataset.id), t('requestAccepted')); break;
    case 'vanish-toggle': {
      const conv = d.conversations.find((c) => c.id === actEl.dataset.conv);
      const on = !conv?.vanish;
      await handle(api.setConversationVanish(actEl.dataset.conv, on), on ? t('vanishEnabled') : t('vanishDisabled'));
      break;
    }
    case 'create-invite': await handle(api.createConversationInvite(actEl.dataset.conv), t('inviteLinkReady')); break;
    case 'copy-invite': {
      const link = actEl.dataset.link || '';
      try { await navigator.clipboard.writeText(link); toast(t('linkCopied'), 'success'); }
      catch { toast(link, 'success'); }
      break;
    }
    case 'mention-pick': {
      const input = document.querySelector('#message-form input[name="text"]');
      const menu = document.getElementById('mention-menu');
      if (input) {
        const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
        const match = upto.match(/@([\w.]*)$/);
        if (match) {
          input.value = upto.slice(0, upto.length - match[0].length) + `@${actEl.dataset.username} ` + input.value.slice(input.selectionStart ?? input.value.length);
        }
        input.focus();
      }
      menu?.classList.add('hidden');
      break;
    }
    case 'clear-message-file': {
      const input = document.getElementById('msg-file-input');
      if (input) input.value = '';
      const preview = document.getElementById('message-preview');
      if (preview) { preview.innerHTML = ''; preview.classList.add('hidden'); }
      break;
    }
    case 'set-conv-emoji': await handle(api.setConversationEmoji(actEl.dataset.conv, actEl.dataset.emoji)); break;
    case 'send-thread-emoji': {
      const conv = d.conversations.find((c) => c.id === actEl.dataset.conv);
      if (conv) { await handle(api.sendMessage(conv.id, { text: conv.emoji || '👍' })); render(); scrollThread(); }
      break;
    }
    case 'group-remove-member': if (await confirmModal(t('removeMember'), t('removeMemberConfirm'))) await handle(api.removeGroupChatMember(actEl.dataset.conv, actEl.dataset.id), t('memberRemoved')); break;
    case 'group-leave': if (await confirmModal(t('leaveGroup'), t('leaveGroupConfirm'))) { await handle(api.leaveGroupConversation(actEl.dataset.conv), t('leftGroup')); location.hash = '#/messages'; } break;
    case 'reply-message': {
      const msg = d.messages.find((m) => m.id === actEl.dataset.id);
      if (msg) {
        replyTarget = {
          id: msg.id, convId: msg.conversationId,
          name: d.users.find((u) => u.id === msg.senderId)?.name || '',
          text: messageSnippet(msg, 120)
        };
        showReplyPreview();
        document.querySelector('#message-form input[name="text"]')?.focus();
      }
      break;
    }
    case 'cancel-reply': replyTarget = null; hideReplyPreview(); break;
    case 'msg-react-toggle': {
      const picker = document.getElementById(`msg-picker-${actEl.dataset.id}`);
      document.querySelectorAll('.msg-picker').forEach((p) => { if (p !== picker) p.classList.add('hidden'); });
      picker?.classList.toggle('hidden');
      break;
    }
    case 'msg-react': await handle(api.toggleMessageReaction(actEl.dataset.id, actEl.dataset.emoji)); break;
    // ---- Fun Pack: stickers, location, chat polls, any-emoji reactions, nicknames
    case 'react-more': { document.querySelectorAll('.msg-picker-more').forEach((p) => { if (p.id !== `msg-picker-more-${actEl.dataset.id}`) p.classList.add('hidden'); }); document.getElementById(`msg-picker-more-${actEl.dataset.id}`)?.classList.toggle('hidden'); break; }
    case 'sticker-toggle': { const panel = document.getElementById('sticker-panel'); panel?.classList.toggle('hidden'); if (panel && !panel.classList.contains('hidden')) applyThreadScroll(); break; }
    case 'send-sticker': { const convId = document.getElementById('message-form')?.dataset.conv; if (convId) { await handle(api.sendMessage(convId, { sticker: actEl.dataset.emoji })); render(); scrollThread(); } break; }
    case 'send-location': {
      const convId = document.getElementById('message-form')?.dataset.conv;
      if (!convId) break;
      if (!navigator.geolocation) { toast(t('locationUnavailable'), 'error'); break; }
      navigator.geolocation.getCurrentPosition(async (pos) => {
        await handle(api.sendMessage(convId, { location: { lat: pos.coords.latitude, lng: pos.coords.longitude } }), t('locationShared'));
        render(); scrollThread();
      }, () => toast(t('locationUnavailable'), 'error'), { timeout: 10000, maximumAge: 60000 });
      break;
    }
    case 'poll-open': openModal(`<h3>${icon('bar-chart')} ${t('createPoll')}</h3><form id="chat-poll-form" data-conv="${actEl.dataset.conv}" class="stack"><input name="question" placeholder="${t('pollQuestion')}" maxlength="120" required /><input name="option1" placeholder="${t('pollOption')} 1" maxlength="60" required /><input name="option2" placeholder="${t('pollOption')} 2" maxlength="60" required /><input name="option3" placeholder="${t('pollOption')} 3 (${t('optional')})" maxlength="60" /><input name="option4" placeholder="${t('pollOption')} 4 (${t('optional')})" maxlength="60" /><div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${t('createPoll')}</button></div></form>`); break;
    case 'vote-poll': await handle(api.voteChatPoll(actEl.dataset.id, actEl.dataset.option)); break;
    case 'set-nickname': {
      const d = api.data(); const conv = d.conversations.find((c) => c.id === actEl.dataset.conv); const target = d.users.find((u) => u.id === actEl.dataset.id);
      openModal(`<h3>${icon('tag')} ${t('setNickname')}</h3><form id="nickname-form" data-conv="${actEl.dataset.conv}" data-user="${actEl.dataset.id}" class="stack"><label>${escapeHtml(target?.name || '')}<input name="nickname" value="${escapeHtml(conv?.nicknames?.[actEl.dataset.id] || '')}" placeholder="${escapeHtml(target?.name || '')}" maxlength="40" /></label><p class="muted small">${t('nicknameHint')}</p><div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save</button></div></form>`);
      break;
    }
    case 'pin-message': { const pinned = await handle(api.togglePinMessage(actEl.dataset.id)); if (pinned !== null) toast(pinned ? t('messagePinned') : t('messageUnpinned'), 'success'); break; }
    // ---- Messenger Complete Pack: per-message menu, edit, unsend, hide, forward
    case 'msg-menu': {
      const id = actEl.dataset.id;
      const menu = document.getElementById(`msg-menu-${id}`);
      document.querySelectorAll('.msg-menu').forEach((m) => { if (m !== menu) m.classList.add('hidden'); });
      V.uiState.msgMenuFor = V.uiState.msgMenuFor === id ? '' : id;
      menu?.classList.toggle('hidden');
      break;
    }
    case 'edit-message': {
      const msg = d.messages.find((m) => m.id === actEl.dataset.id);
      if (msg) openModal(`<h3>${t('editMessage')}</h3><form id="edit-message-form" data-id="${msg.id}" class="stack"><textarea name="text" rows="3" maxlength="2000">${escapeHtml(msg.text || '')}</textarea><div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save</button></div></form>`);
      break;
    }
    case 'unsend-message': V.uiState.msgMenuFor = ''; if (await confirmModal(t('unsendMessage'), t('unsendConfirm'))) await handle(api.unsendMessage(actEl.dataset.id), t('messageUnsentDone')); break;
    case 'hide-message': V.uiState.msgMenuFor = ''; await handle(api.hideMessage(actEl.dataset.id), t('messageRemovedForYou')); break;
    case 'forward-message': {
      V.uiState.msgMenuFor = '';
      const msg = d.messages.find((m) => m.id === actEl.dataset.id);
      if (msg) {
        const byId = V.usersById(d);
        const targets = d.conversations.filter((c) => c.participants.includes(user.id) && c.id !== msg.conversationId);
        openModal(`<h3>${t('forwardMessage')}</h3><div class="stack">${targets.length ? targets.map((c) => {
          const title = c.isGroup ? (c.title || t('groupChat')) : (byId[c.participants.find((p) => p !== user.id)]?.name || 'Unknown');
          return `<button class="conv-item" data-act="forward-to" data-id="${msg.id}" data-conv="${c.id}">${avatarHtml(c.isGroup ? { name: title, username: title, avatar: c.photo || '' } : (byId[c.participants.find((p) => p !== user.id)] || { name: 'Unknown', username: 'unknown' }), 36)}<span>${c.isGroup ? icon('users', 'ic-sm') + ' ' : ''}${escapeHtml(title)}</span></button>`;
        }).join('') : `<p class="muted">${t('noForwardTargets')}</p>`}</div>`);
      }
      break;
    }
    case 'forward-to': closeModal(); await handle(api.forwardMessage(actEl.dataset.id, actEl.dataset.conv), t('messageForwarded')); break;
    case 'jump-message': {
      const target = document.getElementById(`msg-${actEl.dataset.id}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.remove('flash');
        void target.offsetWidth; // restart the flash animation if re-tapped
        target.classList.add('flash');
        setTimeout(() => target.classList.remove('flash'), 1600);
      } else {
        toast(t('originalMessageUnavailable'), 'error');
      }
      break;
    }
    case 'toggle-theme': prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark'; savePrefs(); applyPrefs(); render(); break;
    case 'install-app': if (deferredInstallPrompt) { deferredInstallPrompt.prompt(); deferredInstallPrompt = null; } break;
    case 'logout': await handle(api.logout(), 'Logged out.'); location.hash = '#/login'; break;
    case 'google-login': await handle(api.loginWithGoogle(), 'Welcome to MeetBook!'); if (me()) location.hash = '#/'; break;
    case 'forgot': {
      const email = document.querySelector('#login-form input[name="email"]')?.value || user?.email || '';
      if (!email) { toast('Enter your email first, then tap Forgot password.', 'error'); break; }
      await handle(api.resetPassword(email), 'Password reset email sent (check your inbox).');
      break;
    }
    case 'like': await engage(api.toggleLike(postId), postId); break;
    case 'poll-vote': await engage(api.votePoll(postId, actEl.dataset.option), postId); break;
    case 'toggle-pin': { const pinned = await handle(api.togglePinPost(postId)); if (pinned !== null) toast(pinned ? 'Pinned as announcement.' : 'Announcement unpinned.', 'success'); break; }
    case 'dismiss-memories': V.uiState.memoriesDismissed = true; render(); break;
    case 'react': await engage(api.toggleReaction(postId, actEl.dataset.emoji), postId); break;
    case 'share': await handle(api.sharePost(postId), 'Post shared to your timeline.'); break;
    case 'save-post': document.getElementById(`menu-${postId}`)?.classList.add('hidden'); await engage(api.toggleSave(postId), postId, 'Saved list updated.'); break;
    case 'focus-comment': postEl?.querySelector('.comment-form input')?.focus(); break;
    case 'edit-post': {
      const post = d.posts.find((p) => p.id === postId);
      const modal = openModal(`<h3>Edit post</h3><form id="edit-post-form" data-id="${postId}" class="stack"><textarea name="text" rows="4" maxlength="2000">${escapeHtml(post?.text || '')}</textarea><div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save</button></div></form>`);
      modal.querySelector('[data-close]').onclick = closeModal;
      break;
    }
    case 'delete-post': if (await confirmModal('Delete post?', 'This post and its comments will be removed.')) await handle(api.deletePost(postId), 'Post deleted.'); break;
    case 'report-post': {
      const modal = openModal(V.reportFormHtml('post', postId));
      modal.querySelector('[data-close]').onclick = closeModal;
      break;
    }
    case 'report-user': {
      const modal = openModal(V.reportFormHtml('user', actEl.dataset.id));
      modal.querySelector('[data-close]').onclick = closeModal;
      break;
    }
    case 'report-message': {
      // Reporting a message snapshots ONLY that message as evidence
      // (api.reportContent) — the conversation itself stays private.
      const modal = openModal(V.reportFormHtml('message', actEl.dataset.id));
      modal.querySelector('[data-close]').onclick = closeModal;
      break;
    }
    case 'delete-comment': {
      const commentId = actEl.dataset.comment;
      if (await confirmModal('Delete comment?', 'This comment/reply will be removed.')) await handle(api.deleteComment(postId, commentId), 'Comment deleted.');
      break;
    }
    case 'reply-toggle': {
      const form = postEl.querySelector(`[data-reply-form="${actEl.dataset.comment}"]`);
      form?.classList.toggle('hidden');
      form?.querySelector('input')?.focus();
      break;
    }
    case 'feed-more': feedPage = Number(actEl.dataset.page || 2); render(); break;
    case 'create-story': { const modal = openModal(V.storyFormHtml()); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'view-story': openStoryViewer(actEl.dataset.author); break;
    case 'story-close': closeStoryViewer(); break;
    case 'story-prev': storyNav(-1); break;
    case 'story-next': storyNav(1); break;
    case 'story-delete': {
      const current = storySession?.queue[storySession.idx];
      if (current && await confirmModal('Delete this story?', 'It will be removed immediately for everyone.')) {
        await handle(api.deleteStory(current.id), 'Story deleted.');
        storySession.queue = storySession.queue.filter((q) => q.id !== current.id);
        if (!storySession.queue.length) closeStoryViewer();
        else { storySession.idx = Math.min(storySession.idx, storySession.queue.length - 1); renderStoryViewer(); }
      }
      break;
    }
    case 'send-request': await handle(api.sendFriendRequest(actEl.dataset.id), 'Friend request sent.'); break;
    case 'cancel-request': await handle(api.cancelFriendRequest(actEl.dataset.id), t('requestCancelled')); break;
    case 'accept-request': await handle(api.respondFriendRequest(actEl.dataset.id, true), 'You are now friends!'); break;
    case 'reject-request': await handle(api.respondFriendRequest(actEl.dataset.id, false), 'Request removed.'); break;
    case 'remove-friend': if (await confirmModal('Remove connection?', 'This friendship/request will be removed.')) await handle(api.removeFriendship(actEl.dataset.id), 'Removed.'); break;
    case 'follow': await handle(api.toggleFollow(actEl.dataset.id)); break;
    case 'toggle-close-friend': { const nowClose = await handle(api.toggleCloseFriend(actEl.dataset.id)); if (nowClose !== null) toast(nowClose ? 'Added to your close friends.' : 'Removed from close friends.', 'success'); break; }
    case 'create-event': { const modal = openModal(V.eventFormHtml()); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'delete-event': if (await confirmModal('Delete event?', 'The event and its RSVPs will be removed.')) { await handle(api.deleteEvent(actEl.dataset.id), 'Event deleted.'); location.hash = '#/events'; } break;
    case 'rsvp': {
      const kind = actEl.dataset.kind;
      const res = await handle(api.toggleEventRsvp(actEl.dataset.id, kind));
      // api.toggleEventRsvp resolves a boolean (true = RSVP now
      // active) or null when the event is gone — the toast must say
      // what actually happened (Audit fix #4).
      if (res === true || res === false) toast(t(rsvpToastKey(res, kind)), 'success');
      break;
    }
    case 'delete-review': if (await confirmModal('Delete your review?', 'Your rating and review text will be removed.')) await handle(api.deleteReview(actEl.dataset.id), 'Review deleted.'); break;
    case 'create-group': { const modal = openModal(V.groupFormHtml(null)); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'edit-group': { const g = (d.groups || []).find((x) => x.id === actEl.dataset.id); const modal = openModal(V.groupFormHtml(g)); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'delete-group': if (await confirmModal('Delete group?', 'The group and all of its posts will be removed. This cannot be undone.')) { await handle(api.deleteGroup(actEl.dataset.id), 'Group deleted.'); location.hash = '#/groups'; } break;
    case 'toggle-group-join': {
      const result = await handle(api.toggleGroupMembership(actEl.dataset.id));
      if (result === 'requested') toast('Join request sent — the group creator will review it.', 'success');
      else if (result === 'withdrawn') toast('Join request withdrawn.', 'success');
      else if (result === 'joined') toast('You joined the group.', 'success');
      else if (result === 'left') toast('You left the group.', 'success');
      break;
    }
    case 'approve-group-request': await handle(api.respondGroupRequest(actEl.dataset.id, true), 'Request approved — member added.'); break;
    case 'reject-group-request': await handle(api.respondGroupRequest(actEl.dataset.id, false), 'Request rejected.'); break;
    case 'remove-member': if (await confirmModal('Remove this member?', 'They will lose access to this group and its posts.')) await handle(api.removeGroupMember(actEl.dataset.group, actEl.dataset.id), 'Member removed.'); break;
    case 'create-page': { const modal = openModal(V.pageFormHtml(null)); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'edit-page': { const p = (d.pages || []).find((x) => x.id === actEl.dataset.id); const modal = openModal(V.pageFormHtml(p)); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'delete-page': if (await confirmModal('Delete page?', 'The page and all of its posts will be removed. This cannot be undone.')) { await handle(api.deletePage(actEl.dataset.id), 'Page deleted.'); location.hash = '#/pages'; } break;
    case 'follow-page': await handle(api.toggleFollowPage(actEl.dataset.id)); break;
    case 'block': {
      // Resolve by the dataset id, not by a users lookup: the target
      // may be a deleted account (Settings still lists the block), and
      // dereferencing a missing user used to throw before the unblock
      // could run — the stale block was unremovable.
      const targetId = actEl.dataset.id;
      const target = d.users.find((u) => u.id === targetId);
      const willBlock = !(d.blocks || []).some((b) => b.by === user.id && b.target === targetId);
      if (!willBlock || await confirmModal(`Block ${target?.name || 'this user'}?`, 'They will not be able to see your posts or message you.')) await handle(api.toggleBlock(targetId), willBlock ? 'User blocked.' : 'User unblocked.');
      break;
    }
    case 'message-user': {
      const conv = await handle(api.openConversation(actEl.dataset.id));
      if (conv) location.hash = `#/messages/${conv.id}`;
      break;
    }
    case 'open-conv': await handle(api.markConversationRead(actEl.dataset.id)); location.hash = `#/messages/${actEl.dataset.id}`; render(); break;
    case 'create-group-chat': { const modal = openModal(V.groupChatFormHtml(d, user)); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'voice-toggle': { const convId = document.getElementById('message-form')?.dataset.conv; if (convId) await startVoiceRecording(convId); break; }
    case 'voice-cancel': resetVoiceUi(); break;
    case 'voice-send': await sendVoiceRecording(); break;
    case 'notif-read-all': await handle(api.markAllNotificationsRead(), 'All caught up.'); break;
    case 'notif-open': {
      // Every notification type lands on ITS OWN place (Audit #3):
      // group/page/event notifications used to carry no target id at
      // all and dumped the user on the home feed, and post
      // notifications only knew the home feed — a group or page post
      // was never found there.
      const n = d.notifications.find((x) => x.id === actEl.dataset.id);
      await handle(api.markNotificationRead(actEl.dataset.id));
      if (actEl.dataset.conv) location.hash = `#/messages/${actEl.dataset.conv}`;
      else if (actEl.dataset.group) location.hash = `#/group/${actEl.dataset.group}`;
      else if (actEl.dataset.page) location.hash = `#/page/${actEl.dataset.page}`;
      else if (actEl.dataset.event) location.hash = '#/events';
      else if (n && ['report_decision', 'moderation_notice', 'appeal_decision', 'warning'].includes(n.type)) location.hash = '#/support';
      else if (n?.type === 'friend_request') location.hash = '#/friends';
      else if ((n?.type === 'follow' || n?.type === 'friend_accept') && actEl.dataset.actor) location.hash = `#/profile/${actEl.dataset.actor}`;
      else if (n && (n.type === 'group_join' || n.type === 'group_request' || n.type === 'group_request_result')) location.hash = '#/groups';
      else if (n?.type === 'page_follow' && actEl.dataset.actor) location.hash = `#/profile/${actEl.dataset.actor}`;
      else if (actEl.dataset.post) {
        // Land ON the post, in the view it actually lives in (group
        // feed, page feed, or home), then scroll + flash it. The
        // scroll retries while the destination view settles, and if
        // the post is older than the feed window it falls back to
        // the author's profile, where all their posts are listed.
        const postId = actEl.dataset.post;
        const post = d.posts.find((p) => p.id === postId);
        const dest = post?.groupId ? `#/group/${post.groupId}` : post?.pageId ? `#/page/${post.pageId}` : '#/';
        location.hash = dest;
        let tries = 0;
        let fellBack = false;
        const tick = () => {
          const el = document.querySelector(`article.post-card[data-post="${CSS.escape(postId)}"]`);
          if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2000); return; }
          tries += 1;
          if (tries < 10) { setTimeout(tick, 300); return; }
          if (!fellBack && post?.authorId && dest === '#/') { fellBack = true; tries = 0; location.hash = `#/profile/${post.authorId}`; setTimeout(tick, 350); }
        };
        setTimeout(tick, 350);
      }
      else location.hash = '#/';
      break;
    }
    case 'edit-profile': {
      const modal = openModal(V.editProfileHtml(user));
      modal.querySelector('[data-close]').onclick = closeModal;
      break;
    }
    case 'change-password': await handle(api.resetPassword(user.email), firebaseReady ? t('resetEmailSent') : undefined); break;
    case 'delete-account': if (await confirmModal('Delete your account?', 'Your profile and posts will be removed. This cannot be undone.')) { await handle(api.deleteAccount(), 'Account deleted.'); location.hash = '#/register'; } break;
    // ---- Super Admin user management (Pack A): every action goes
    // through a confirmation dialog with an optional reason, and the
    // api layer re-checks the role guards + writes an audit entry.
    case 'admin-user-suspend': {
      const target = d.users.find((u) => u.id === actEl.dataset.id);
      const r = await adminActionModal({ title: `${t('suspend')} — ${target?.name || ''}`, body: 'They keep their account and content but cannot use MeetBook until unsuspended.', confirmLabel: t('suspend') });
      if (r) await handle(api.adminSetUserStatus(actEl.dataset.id, 'suspended', r.reason, 'suspend-user'), 'User suspended.');
      break;
    }
    case 'admin-user-unsuspend': {
      const target = d.users.find((u) => u.id === actEl.dataset.id);
      const r = await adminActionModal({ title: `${t('unsuspend')} — ${target?.name || ''}`, body: 'They will be able to use MeetBook again right away.', confirmLabel: t('unsuspend'), danger: false });
      if (r) await handle(api.adminSetUserStatus(actEl.dataset.id, 'active', r.reason, 'unsuspend-user'), 'User unsuspended.');
      break;
    }
    case 'admin-user-ban': {
      const target = d.users.find((u) => u.id === actEl.dataset.id);
      const r = await adminActionModal({ title: `${t('ban')} — ${target?.name || ''}`, body: 'Banned users cannot use MeetBook at all. Use for serious or repeated violations.', confirmLabel: t('ban') });
      if (r) await handle(api.adminSetUserStatus(actEl.dataset.id, 'banned', r.reason, 'ban-user'), 'User banned.');
      break;
    }
    case 'admin-user-restore': {
      const target = d.users.find((u) => u.id === actEl.dataset.id);
      const r = await adminActionModal({ title: `${t('restore')} — ${target?.name || ''}`, body: 'The ban will be lifted and the account becomes active again.', confirmLabel: t('restore'), danger: false });
      if (r) await handle(api.adminSetUserStatus(actEl.dataset.id, 'active', r.reason, 'restore-user'), 'User restored.');
      break;
    }
    case 'admin-user-verify': {
      const target = d.users.find((u) => u.id === actEl.dataset.id);
      const verified = actEl.dataset.verified === '1';
      const r = await adminActionModal({ title: `${verified ? t('verify') : t('unverify')} — ${target?.name || ''}`, body: verified ? 'A ✓ verified badge will appear next to their name across MeetBook.' : 'The ✓ verified badge will be removed from their name.', confirmLabel: verified ? t('verify') : t('unverify'), danger: false });
      if (r) await handle(api.adminSetVerified(actEl.dataset.id, verified, r.reason), verified ? 'User verified.' : 'Verification removed.');
      break;
    }
    case 'admin-user-delete': {
      const target = d.users.find((u) => u.id === actEl.dataset.id);
      const r = await adminActionModal({ title: `${t('delete')} — ${target?.name || ''}`, body: 'PERMANENT: the profile and all of their posts will be deleted. This cannot be undone.', confirmLabel: t('delete') });
      if (r) await handle(api.adminDeleteUser(actEl.dataset.id, r.reason), 'User deleted.');
      break;
    }
    // ---- Reports Center decisions (Pack B): every decision goes
    // through a confirmation dialog with an optional reason, and
    // api.adminDecideReport re-checks the moderator gate, applies any
    // outcome side effects, updates the report and writes the audit
    // entry.
    case 'report-review': {
      const r = await adminActionModal({ title: t('markUnderReview'), body: 'The report stays in the queue, marked as being looked at.', confirmLabel: t('markUnderReview'), danger: false });
      if (r) await handle(api.adminDecideReport(actEl.dataset.id, 'review', { reason: r.reason }), 'Report marked under review.');
      break;
    }
    case 'report-resolve-open': {
      const rep = d.reports.find((x) => x.id === actEl.dataset.id);
      if (!rep) break;
      const modal = openModal(V.reportResolveFormHtml(rep));
      modal.querySelector('[data-close]').onclick = closeModal;
      break;
    }
    case 'report-reject': {
      const r = await adminActionModal({ title: t('rejectReport'), body: 'The report will be closed with no action taken.', confirmLabel: t('rejectReport') });
      if (r) await handle(api.adminDecideReport(actEl.dataset.id, 'reject', { reason: r.reason }), 'Report rejected.');
      break;
    }
    case 'report-escalate': {
      const r = await adminActionModal({ title: t('escalateReport'), body: 'The report will be flagged for senior admin attention.', confirmLabel: t('escalateReport'), danger: false });
      if (r) await handle(api.adminDecideReport(actEl.dataset.id, 'escalate', { reason: r.reason }), 'Report escalated.');
      break;
    }
    case 'report-appeal': {
      const appealStatus = actEl.dataset.appeal;
      const r = await adminActionModal({ title: `${t('appealLabel')} — ${appealStatus}`, body: t('appealNoRestore'), confirmLabel: t('appealLabel'), danger: false });
      if (r) await handle(api.adminSetReportAppeal(actEl.dataset.id, appealStatus, r.reason), 'Appeal updated.');
      break;
    }
    // ---- Support Inbox (user side): the author of acted-on content
    // files their one appeal; api.appealReport re-checks ownership,
    // decision state and the one-appeal rule.
    case 'support-appeal-open': {
      const rep = (d.reports || []).find((x) => x.id === actEl.dataset.id) || (d.supportReports || []).find((x) => x.id === actEl.dataset.id);
      if (!rep) break;
      const modal = openModal(V.supportAppealFormHtml(rep));
      modal.querySelector('[data-close]').onclick = closeModal;
      break;
    }
    // ---- Content moderation (Pack B): delete post/comment with a
    // reason, audited via api.adminDeletePost / adminDeleteComment.
    case 'admin-content-delete-post': {
      const r = await adminActionModal({ title: 'Delete this post?', body: 'The post and its comments will be removed for everyone.', confirmLabel: t('delete') });
      if (r) await handle(api.adminDeletePost(actEl.dataset.id, r.reason), 'Post deleted.');
      break;
    }
    case 'admin-content-delete-comment': {
      const r = await adminActionModal({ title: 'Delete this comment?', body: 'The comment/reply will be removed from the post.', confirmLabel: t('delete') });
      if (r) await handle(api.adminDeleteComment(actEl.dataset.post, actEl.dataset.id, r.reason), 'Comment deleted.');
      break;
    }
    case 'admin-export-analytics': {
      const days = Number(actEl.dataset.days || 30);
      const csv = seriesToCsv(analyticsSeries(api.data(), days));
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `meetbook-analytics-${days}d.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      break;
    }
    case 'reset-demo': if (!firebaseReady && await confirmModal('Reset demo data?', 'Local demo data returns to its seeded state.')) { api.resetDemo(); toast('Demo data reset.', 'success'); render(); } else if (firebaseReady) toast('Demo reset is only available in demo mode.', 'error'); break;
    case 'bot-kill-switch': await handle(api.setGlobalBotEnabled(actEl.dataset.on === '1'), actEl.dataset.on === '1' ? 'Bots enabled.' : 'All bots stopped.'); break;
    case 'bot-run-cycle': {
      const r = await api.runBotCycle();
      toast(r.ran ? `Bot cycle ran: ${r.results.map((x) => `${x.bot} → ${x.action}`).join(', ')}` : `Bot cycle skipped: ${r.reason}`, r.ran ? 'success' : 'error');
      render();
      break;
    }
    // ---- AI Providers (Stage A): enable/disable, key removal, health
    // test and the paid-provider approval gate.
    case 'provider-toggle': {
      const entry = providerById(actEl.dataset.id);
      await handle(api.setProviderEnabled(actEl.dataset.id, actEl.dataset.on === '1'), actEl.dataset.on === '1' ? `${entry?.label || 'Provider'} enabled.` : `${entry?.label || 'Provider'} disabled.`);
      break;
    }
    case 'provider-key-remove': {
      const entry = providerById(actEl.dataset.id);
      if (await confirmModal(`Remove the ${entry?.label || ''} API key?`, 'Bots will skip this provider until a new key is saved.')) {
        await handle(actEl.dataset.id === 'gemini' ? api.removeGeminiApiKey() : api.removeProviderKey(actEl.dataset.id), 'API key removed.');
      }
      break;
    }
    case 'provider-test': {
      const r = await handle(api.testProviderConnection(actEl.dataset.id));
      if (r) toast(r.detail, r.ok ? 'success' : 'error');
      render();
      break;
    }
    case 'ai-paid-toggle': {
      const turningOn = actEl.dataset.on === '1';
      if (turningOn && !(await confirmModal('Turn on paid-provider approval?', 'Cerebras and Hugging Face have NO free tier and bill per use. This only unlocks their cards so an admin can add a key — the router never attempts a paid provider while approval is off.'))) break;
      await handle(api.adminSavePlatformSettings({ aiPaidApproved: turningOn }), turningOn ? 'Paid providers unlocked.' : 'Paid providers locked.');
      break;
    }
    case 'bot-new': { const modal = openModal(V.botFormHtml(null)); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'bot-edit': { const bot = d.bots.find((b) => b.id === actEl.dataset.id); const modal = openModal(V.botFormHtml(bot)); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'bot-toggle': { const bot = d.bots.find((b) => b.id === actEl.dataset.id); if (bot) await handle(api.saveBot({ ...bot, active: !bot.active }), bot.active ? 'Bot deactivated.' : 'Bot activated.'); break; }
    case 'bot-delete': {
      // Hard confirm with a reason (Pack C) — the deletion is audited
      // by api.deleteBot. From a details page, return to the bot list.
      const r = await adminActionModal({ title: t('deleteBotTitle'), body: t('deleteBotBody'), confirmLabel: t('delete') });
      if (r) {
        await handle(api.deleteBot(actEl.dataset.id, r.reason), 'Bot deleted.');
        if (location.hash.startsWith('#/admin/bots/')) location.hash = '#/admin/bots';
      }
      break;
    }
    case 'bot-memory-delete': await handle(api.deleteBotMemory(actEl.dataset.bot, actEl.dataset.id), 'Memory removed.'); break;
    // ---- Announcements (Pack C): feed banner dismissal is remembered
    // per user in their settings; admin toggles/deletes are audited.
    case 'dismiss-announcement': {
      if (!user) break;
      const dismissed = [...new Set([...(user.settings?.dismissedAnnouncements || []), actEl.dataset.id])];
      await handle(api.updateSettings(user.id, { dismissedAnnouncements: dismissed }));
      render();
      break;
    }
    case 'announcement-toggle': await handle(api.setAnnouncementActive(actEl.dataset.id, actEl.dataset.on === '1'), actEl.dataset.on === '1' ? 'Announcement activated.' : 'Announcement deactivated.'); break;
    case 'announcement-delete': {
      const r = await adminActionModal({ title: t('delete'), body: 'This announcement will be removed for everyone.', confirmLabel: t('delete') });
      if (r) await handle(api.deleteAnnouncement(actEl.dataset.id, r.reason), 'Announcement deleted.');
      break;
    }
    default: break;
  }
});

// ------------------------------------------------------------- form handling
document.addEventListener('submit', async (e) => {
  const form = e.target;
  e.preventDefault();
  const fd = new FormData(form);
  const user = me();

  if (form.id === 'search-form' || form.id === 'search-page-form') {
    const q = String(fd.get('q') || '').trim();
    location.hash = `#/search?q=${encodeURIComponent(q)}`;
    return;
  }
  if (form.id === 'admin-user-filter') {
    const params = new URLSearchParams({
      q: String(fd.get('q') || '').trim(), status: String(fd.get('status') || 'all'),
      role: String(fd.get('role') || 'all'), kind: String(fd.get('kind') || 'all'), page: '1'
    });
    location.hash = `#/admin/users?${params.toString()}`;
    return;
  }
  if (form.id === 'admin-log-filter') {
    location.hash = `#/admin/security?q=${encodeURIComponent(String(fd.get('q') || '').trim())}`;
    return;
  }
  if (form.id === 'admin-content-filter') {
    const params = new URLSearchParams({
      tab: 'posts', q: String(fd.get('q') || '').trim(),
      kind: String(fd.get('kind') || 'all'), page: '1'
    });
    location.hash = `#/admin/content?${params.toString()}`;
    return;
  }
  if (form.id === 'report-form') {
    const reason = String(fd.get('reason') || '').trim();
    if (!reason) { toast('Please tell us what happened.', 'error'); return; }
    const r = await handle(api.reportContent(form.dataset.type, form.dataset.id, reason, { category: String(fd.get('category') || 'other') }), 'Thanks — our moderators will review it.');
    if (r !== null) closeModal();
    return;
  }
  if (form.id === 'report-resolve-form') {
    const r = await handle(api.adminDecideReport(form.dataset.id, 'resolve', {
      outcome: String(fd.get('outcome') || 'none'),
      reason: String(fd.get('reason') || '').trim()
    }), 'Report resolved.');
    if (r !== null) closeModal();
    return;
  }
  if (form.id === 'support-appeal-form') {
    const r = await handle(api.appealReport(form.dataset.id, String(fd.get('text') || '').trim()), 'Appeal sent — our team will review it.');
    if (r !== null) closeModal();
    return;
  }
  if (form.id === 'login-form') {
    const r = await handle(api.login(String(fd.get('email')), String(fd.get('password'))), 'Welcome back!');
    if (r) { location.hash = '#/'; render(); }
    return;
  }
  if (form.id === 'register-form') {
    const password = String(fd.get('password'));
    if (password !== String(fd.get('confirmPassword'))) { toast(t('passwordsDontMatch'), 'error'); return; }
    const r = await handle(api.register({
      name: String(fd.get('name')), username: String(fd.get('username')),
      email: String(fd.get('email')), password,
      dob: String(fd.get('dob') || ''), gender: String(fd.get('gender') || '')
    }), 'Account created — welcome to MeetBook!');
    if (r) { location.hash = '#/'; render(); }
    return;
  }
  if (form.id === 'story-reply-form') {
    // A story reply becomes a normal 1-1 message with the author,
    // prefixed so the context survives outside the 24h story window.
    const text = String(fd.get('text') || '').trim();
    const authorId = form.dataset.author;
    if (text && authorId) {
      const conv = await handle(api.openConversation(authorId));
      if (conv) {
        const sent = await handle(api.sendMessage(conv.id, { text: `Replied to your story: ${text}` }));
        if (sent) { toast(t('storyReplySent'), 'success'); form.reset(); }
      }
    }
    return;
  }
  if (form.id === 'composer-form') {
    const file = fileFrom(form, 'image');
    const image = file ? await api.uploadImage(file, `posts/${user.id}/${Date.now()}_${file.name}`).catch((err) => { toast(err.message, 'error'); return ''; }) : '';
    const poll = form.querySelector('[name="hasPoll"]')?.checked
      ? normalisePoll(fd.getAll('pollOption').map((v) => String(v)))
      : null;
    if (form.querySelector('[name="hasPoll"]')?.checked && !poll) toast('A poll needs at least two options — posting without the poll.', 'error');
    const r = await handle(api.createPost({
      text: String(fd.get('text') || ''), image, visibility: String(fd.get('visibility') || 'public'),
      poll, location: String(fd.get('location') || ''), feeling: String(fd.get('feeling') || '')
    }), 'Post published.');
    if (r) { feedPage = 1; render(); }
    return;
  }
  if (form.id === 'event-form') {
    const coverFile = fileFrom(form, 'cover');
    const cover = coverFile ? await api.uploadImage(coverFile, `events/${user.id}/${Date.now()}_${coverFile.name}`).catch((err) => { toast(err.message, 'error'); return ''; }) : '';
    const dateTime = new Date(String(fd.get('dateTime') || '')).getTime();
    const r = await handle(api.createEvent({
      title: String(fd.get('title') || ''), description: String(fd.get('description') || ''),
      dateTime, location: String(fd.get('location') || ''), cover,
      visibility: String(fd.get('visibility') || 'public')
    }), 'Event created.');
    if (r) { closeModal(); location.hash = `#/event/${r.id}`; }
    return;
  }
  if (form.id === 'review-form') {
    const r = await handle(api.saveReview(form.dataset.page, { rating: Number(fd.get('rating') || 0), text: String(fd.get('text') || '') }), 'Review saved.');
    if (r) render();
    return;
  }
  if (form.id === 'group-chat-form') {
    const memberIds = fd.getAll('member').map((v) => String(v));
    const r = await handle(api.createGroupConversation({ title: String(fd.get('title') || ''), memberIds }), 'Group chat created.');
    if (r) { closeModal(); location.hash = `#/messages/${r.id}`; }
    return;
  }
  if (form.id === 'groups-search-form') {
    location.hash = `#/groups?q=${encodeURIComponent(String(fd.get('q') || '').trim())}`;
    return;
  }
  if (form.id === 'pages-search-form') {
    location.hash = `#/pages?q=${encodeURIComponent(String(fd.get('q') || '').trim())}`;
    return;
  }
  if (form.id === 'group-composer-form') {
    const file = fileFrom(form, 'image');
    const image = file ? await api.uploadImage(file, `posts/${user.id}/${Date.now()}_${file.name}`).catch((err) => { toast(err.message, 'error'); return ''; }) : '';
    await handle(api.createPost({ text: String(fd.get('text') || ''), image, visibility: 'public', groupId: form.dataset.group }), 'Posted to the group.');
    return;
  }
  if (form.id === 'page-composer-form') {
    const file = fileFrom(form, 'image');
    const image = file ? await api.uploadImage(file, `posts/${user.id}/${Date.now()}_${file.name}`).catch((err) => { toast(err.message, 'error'); return ''; }) : '';
    await handle(api.createPagePost(form.dataset.page, { text: String(fd.get('text') || ''), image }), 'Posted as page.');
    return;
  }
  if (form.id === 'group-form') {
    const existing = (api.data().groups || []).find((g) => g.id === form.dataset.id);
    const fields = { name: String(fd.get('name')), description: String(fd.get('description') || ''), privacy: String(fd.get('privacy') || 'public') };
    const coverFile = fileFrom(form, 'cover');
    if (coverFile) fields.cover = await api.uploadImage(coverFile, `groups/${existing?.id || 'new'}/cover`).catch((err) => { toast(err.message, 'error'); return existing?.cover || ''; });
    if (existing) {
      const r = await handle(api.updateGroup(existing.id, fields), 'Group updated.');
      if (r) closeModal();
    } else {
      const r = await handle(api.createGroup({ ...fields, cover: fields.cover || '' }), 'Group created.');
      if (r) { closeModal(); location.hash = `#/group/${r.id}`; }
    }
    return;
  }
  if (form.id === 'page-form') {
    const existing = (api.data().pages || []).find((p) => p.id === form.dataset.id);
    const fields = { name: String(fd.get('name')), category: String(fd.get('category') || ''), about: String(fd.get('about') || '') };
    const avatarFile = fileFrom(form, 'avatar');
    const coverFile = fileFrom(form, 'cover');
    if (avatarFile) fields.avatar = await api.uploadImage(avatarFile, `pages/${existing?.id || 'new'}/avatar`).catch((err) => { toast(err.message, 'error'); return existing?.avatar || ''; });
    if (coverFile) fields.cover = await api.uploadImage(coverFile, `pages/${existing?.id || 'new'}/cover`).catch((err) => { toast(err.message, 'error'); return existing?.cover || ''; });
    if (existing) {
      const r = await handle(api.updatePage(existing.id, fields), 'Page updated.');
      if (r) closeModal();
    } else {
      const r = await handle(api.createPage({ ...fields, avatar: fields.avatar || '', cover: fields.cover || '' }), 'Page created.');
      if (r) { closeModal(); location.hash = `#/page/${r.id}`; }
    }
    return;
  }
  if (form.dataset.commentForm) {
    const text = String(fd.get('text') || '').trim();
    if (text) await handle(api.addComment(form.dataset.commentForm, text));
    return;
  }
  if (form.dataset.replyForm !== undefined && form.classList.contains('reply-form')) {
    const postEl = form.closest('[data-post]');
    const text = String(fd.get('text') || '').trim();
    if (text && postEl) await handle(api.addComment(postEl.dataset.post, text, form.dataset.replyForm));
    return;
  }
  if (form.id === 'message-form') {
    const convId = form.dataset.conv;
    const file = fileFrom(form, 'image');
    const image = file ? await api.uploadImage(file, `messages/${convId}/${Date.now()}_${file.name}`).catch((err) => { toast(err.message, 'error'); return ''; }) : '';
    const rawFile = fileFrom(form, 'file');
    let chatFile = null;
    if (rawFile) {
      chatFile = await api.uploadMessageFile(rawFile).catch((err) => { toast(err.message, 'error'); return null; });
      if (!chatFile) return;
    }
    const text = String(fd.get('text') || '');
    const replyToId = replyTarget && replyTarget.convId === convId ? replyTarget.id : '';
    // Clear the tracked draft the moment the send lands — BEFORE
    // handle()'s re-render, or the restore would resurrect the sent
    // text as a "draft". On failure the draft survives and the
    // restore puts it back in the rebuilt composer.
    const sent = await handle(api.sendMessage(convId, { text, image, replyToId, file: chatFile })
      .then((r) => { composerDrafts.delete(convId); return r; }));
    if (sent) {
      if (replyToId) replyTarget = null; // the re-render rebuilds the (hidden) reply preview
      stopTyping();
      render(); scrollThread();
      // Demo-mode bot replies: the bot answers from its OWN personality+memory.
      // 1-1 conversations only — bots never auto-reply inside group chats.
      if (!firebaseReady) {
        const conv = api.data().conversations.find((c) => c.id === convId);
        const otherId = conv && !conv.isGroup && conv.participants.length === 2
          ? conv.participants.find((p) => p !== user.id)
          : null;
        const other = api.data().users.find((u) => u.id === otherId);
        if (other?.isBot) {
          setTimeout(async () => {
            const reply = await api.demoBotReply(otherId, text);
            if (reply) {
              demoMutate((s) => {
                s.messages.push({ id: genId('m'), conversationId: convId, senderId: otherId, text: reply, image: '', createdAt: Date.now(), status: 'delivered', readBy: [otherId] });
              });
              // No forced scrollThread(): the reply is an INCOMING
              // message — render()'s restore keeps a pinned view at
              // the tail and an anchored (reading) view where it was.
              render();
            }
          }, 900);
        }
      }
    }
    return;
  }
  if (form.id === 'edit-post-form') {
    const r = await handle(api.editPost(form.dataset.id, String(fd.get('text') || '')), 'Post updated.');
    if (r !== null) closeModal(); // handle() returns null ONLY on failure — editPost itself returns undefined, so `if (r)` kept the dialog open even on success
    return;
  }
  if (form.id === 'edit-message-form') {
    const r = await handle(api.editMessage(form.dataset.id, String(fd.get('text') || '')), t('messageEdited'));
    if (r !== null) closeModal();
    return;
  }
  if (form.id === 'chat-poll-form') {
    const question = String(fd.get('question') || '').trim();
    const options = ['option1', 'option2', 'option3', 'option4'].map((k) => String(fd.get(k) || '').trim()).filter(Boolean)
      .map((text, i) => ({ id: `o${i + 1}`, text, votes: [] }));
    if (question && options.length >= 2) {
      const r = await handle(api.sendMessage(form.dataset.conv, { poll: { question, options } }), t('pollCreated'));
      if (r) { closeModal(); scrollThread(); }
    }
    return;
  }
  if (form.id === 'nickname-form') {
    const r = await handle(api.setNickname(form.dataset.conv, form.dataset.user, String(fd.get('nickname') || '')), t('nicknameSet'));
    if (r) closeModal();
    return;
  }
  if (form.id === 'group-rename-form') {
    await handle(api.renameGroupConversation(form.dataset.conv, String(fd.get('title') || '')), t('groupRenamed'));
    return;
  }
  if (form.id === 'group-add-form') {
    const memberIds = fd.getAll('member').map((v) => String(v));
    if (memberIds.length) await handle(api.addGroupMembers(form.dataset.conv, memberIds), t('membersAdded'));
    return;
  }
  if (form.id === 'edit-profile-form') {
    const patch = {
      name: String(fd.get('name')), username: String(fd.get('username')), bio: String(fd.get('bio')),
      nickname: String(fd.get('nickname') || '').trim(),
      work: String(fd.get('work') || '').trim(), education: String(fd.get('education') || '').trim(),
      currentCity: String(fd.get('currentCity') || '').trim(), hometown: String(fd.get('hometown') || '').trim(),
      relationship: String(fd.get('relationship') || ''), website: String(fd.get('website') || '').trim(),
      dob: String(fd.get('dob') || ''), gender: String(fd.get('gender') || '')
    };
    const avatarFile = fileFrom(form, 'avatar');
    const coverFile = fileFrom(form, 'cover');
    if (avatarFile) patch.avatar = await api.uploadImage(avatarFile, `avatars/${user.id}`).catch((err) => { toast(err.message, 'error'); return user.avatar; });
    if (coverFile) patch.cover = await api.uploadImage(coverFile, `covers/${user.id}`).catch((err) => { toast(err.message, 'error'); return user.cover; });
    const r = await handle(api.updateProfile(user.id, patch), 'Profile updated.');
    if (r !== null) closeModal();
    return;
  }
  if (form.id === 'notif-prefs-form') {
    const notifPrefs = {};
    for (const type of ['friend_request', 'like', 'comment', 'reply', 'message', 'mention', 'follow']) notifPrefs[type] = form.querySelector(`[name="${type}"]`)?.checked !== false;
    await handle(api.updateSettings(user.id, { notifPrefs }), 'Preferences saved.');
    // Browser notifications: enabling asks for permission right away;
    // the flag is stored either way so the toggle reflects the choice.
    const wantBrowser = form.querySelector('[name="browserNotifications"]')?.checked === true;
    if (wantBrowser && 'Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission().catch(() => 'denied');
    }
    if (wantBrowser && 'Notification' in window && Notification.permission !== 'granted') {
      toast('Browser notifications are blocked for this site — allow them in your browser settings.', 'error');
    }
    await handle(api.updateSettings(user.id, { browserNotifications: wantBrowser }));
    return;
  }
  if (form.id === 'privacy-prefs-form') {
    await handle(api.updateSettings(user.id, { defaultPostPrivacy: String(fd.get('defaultPostPrivacy') || 'public') }), 'Privacy saved.');
    return;
  }
  if (form.id === 'story-form') {
    const file = fileFrom(form, 'image');
    const image = file ? await api.uploadImage(file, `stories/${user.id}/${Date.now()}_${file.name}`).catch((err) => { toast(err.message, 'error'); return ''; }) : '';
    const r = await handle(api.createStory({ text: String(fd.get('text') || ''), image, bg: String(fd.get('bg') || 'sunset'), visibility: String(fd.get('visibility') || 'public') }), 'Story posted — it will disappear in 24 hours.');
    if (r) closeModal();
    return;
  }
  if (form.id === 'bot-form') {
    const split = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
    const existing = api.data().bots.find((b) => b.id === form.dataset.id);
    const botId = form.dataset.id || genId('bot');
    // Avatar (Pack C): an uploaded file goes through the shared image
    // pipeline (Storage when available, compressed data-URL fallback
    // otherwise); no file keeps the avatar already on the bot.
    let avatar = String(fd.get('avatar') || '');
    const avatarFile = fileFrom(form, 'avatarFile');
    if (avatarFile) {
      avatar = await api.uploadImage(avatarFile, `bots/${botId}/${Date.now()}_${avatarFile.name}`)
        .catch((err) => { toast(err.message, 'error'); return avatar; });
    }
    const bot = {
      ...(existing || {}),
      id: botId,
      name: String(fd.get('name')), username: String(fd.get('username')).toLowerCase(),
      bio: String(fd.get('bio') || ''),
      avatar,
      provider: String(fd.get('provider') || ''),
      model: String(fd.get('modelCustom') || '').trim() || String(fd.get('model') || ''),
      active: existing ? existing.active : true,
      personality: {
        traits: split(fd.get('traits')), tone: String(fd.get('tone') || 'friendly'),
        interests: split(fd.get('interests')), systemPrompt: String(fd.get('systemPrompt') || '')
      },
      limits: {
        postsPerDay: Number(fd.get('postsPerDay') || 3), commentsPerDay: Number(fd.get('commentsPerDay') || 10),
        likesPerDay: Number(fd.get('likesPerDay') || 20), messagesPerDay: Number(fd.get('messagesPerDay') || 5),
        minIntervalMs: existing?.limits?.minIntervalMs ?? 15 * 60 * 1000
      }
    };
    const r = await handle(api.saveBot(bot), existing ? 'Bot updated.' : 'Bot created.');
    if (r) closeModal();
    return;
  }
  // ---- Bot details tabs (Pack C): each form patches one facet of the
  // bot through the existing saveBot path (which also refreshes the
  // botBrains doc and writes the audit entry).
  if (form.id === 'bot-brain-form') {
    const existing = api.data().bots.find((b) => b.id === form.dataset.id);
    if (!existing) { toast('Bot not found.', 'error'); return; }
    const bot = { ...existing, personality: { ...existing.personality, systemPrompt: String(fd.get('systemPrompt') || '') } };
    await handle(api.saveBot(bot), 'Brain saved.');
    return;
  }
  if (form.id === 'bot-personality-form') {
    const split = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
    const existing = api.data().bots.find((b) => b.id === form.dataset.id);
    if (!existing) { toast('Bot not found.', 'error'); return; }
    const bot = {
      ...existing,
      bio: String(fd.get('bio') || ''),
      personality: {
        ...existing.personality,
        traits: split(fd.get('traits')), tone: String(fd.get('tone') || 'friendly'),
        interests: split(fd.get('interests'))
      }
    };
    await handle(api.saveBot(bot), 'Personality saved.');
    return;
  }
  if (form.id === 'bot-settings-form') {
    const existing = api.data().bots.find((b) => b.id === form.dataset.id);
    if (!existing) { toast('Bot not found.', 'error'); return; }
    const bot = {
      ...existing,
      provider: String(fd.get('provider') || ''),
      model: String(fd.get('modelCustom') || '').trim() || String(fd.get('model') || ''),
      limits: {
        ...existing.limits,
        postsPerDay: Number(fd.get('postsPerDay') || 0), commentsPerDay: Number(fd.get('commentsPerDay') || 0),
        likesPerDay: Number(fd.get('likesPerDay') || 0), messagesPerDay: Number(fd.get('messagesPerDay') || 0)
      }
    };
    await handle(api.saveBot(bot), 'Bot settings saved.');
    return;
  }
  // ---- Announcements + platform settings (Pack C)
  if (form.id === 'announcement-form') {
    const r = await handle(api.createAnnouncement({ title: String(fd.get('title') || ''), body: String(fd.get('body') || '') }), 'Announcement published.');
    if (r) form.reset();
    return;
  }
  if (form.id === 'admin-notify-form') {
    const r = await handle(api.adminNotifyUser(String(fd.get('userId') || ''), { title: String(fd.get('title') || ''), body: String(fd.get('body') || '') }), 'Notification sent.');
    if (r) form.reset();
    return;
  }
  if (form.id === 'platform-settings-form') {
    await handle(api.adminSavePlatformSettings({
      platformName: String(fd.get('platformName') || ''),
      registrationOpen: fd.get('registrationOpen') === 'on',
      defaultLanguage: String(fd.get('defaultLanguage') || 'en')
    }), 'Platform settings saved.');
    return;
  }
  if (form.dataset.botMemoryForm) {
    const text = String(fd.get('text') || '').trim();
    if (text) await handle(api.addBotMemory(form.dataset.botMemoryForm, text), 'Memory added.');
    return;
  }
  // ---- AI Providers (Stage A): keys/endpoints/default models are
  // saved per provider; the key input is never re-rendered with a
  // value, so a saved key never appears back in the page.
  if (form.dataset.providerKeyForm) {
    const id = form.dataset.providerKeyForm;
    const key = String(fd.get('apiKey') || '').trim();
    if (key) await handle(id === 'gemini' ? api.saveGeminiApiKey(key) : api.saveProviderKey(id, key), 'API key saved.');
    return;
  }
  if (form.dataset.providerEndpointForm) {
    await handle(api.saveProviderEndpoint(form.dataset.providerEndpointForm, String(fd.get('endpoint') || '')), 'Endpoint saved.');
    return;
  }
  if (form.dataset.providerModelForm) {
    await handle(api.saveProviderDefaultModel(form.dataset.providerModelForm, String(fd.get('model') || '')), 'Default model saved.');
    return;
  }
  if (form.id === 'ai-fallback-form') {
    const order = String(fd.get('order') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    await handle(api.adminSavePlatformSettings({ aiFallbackOrder: order }), 'Fallback order saved.');
    return;
  }
});

// Composer image preview + poll toggle + locale select + maintenance toggle (change events)
document.addEventListener('change', async (e) => {
  if (e.target.name === 'provider') {
    // Bot form / bot settings: the model dropdown follows the chosen
    // provider (Stage A). The stored custom option is dropped — the
    // custom-id input below the dropdown is the override path.
    const form = e.target.closest('#bot-form, #bot-settings-form');
    const modelSel = form?.querySelector('select[name="model"]');
    if (modelSel) {
      const entry = providerById(e.target.value) || providerById('gemini');
      const options = entry?.models || [];
      modelSel.innerHTML = `<option value="">${escapeHtml(t('modelProviderDefaultLabel'))}</option>`
        + options.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    }
  }
  if (e.target.name === 'hasPoll' && e.target.closest('#composer-form')) {
    document.getElementById('poll-fields')?.classList.toggle('hidden', !e.target.checked);
    // In poll mode the composer asks the question the poll answers.
    const ta = e.target.closest('#composer-form').querySelector('textarea[name="text"]');
    if (ta) ta.placeholder = e.target.checked ? t('askQuestion') : t('whatsOnYourMind');
  }
  if (e.target.id === 'locale-select') {
    prefs.locale = e.target.value; savePrefs(); applyPrefs(); render();
  }
  if (e.target.id === 'maintenance-toggle') {
    await handle(api.adminSetMaintenance(e.target.checked), e.target.checked ? 'Maintenance mode on.' : 'Maintenance mode off.');
  }
  if (e.target.classList?.contains('admin-role-select')) {
    // Role changes are superadmin-only (api + rules enforce it) and go
    // through the same confirm-with-reason dialog as other user actions.
    const userId = e.target.dataset.id;
    const role = e.target.value;
    const target = api.data().users.find((u) => u.id === userId);
    const r = await adminActionModal({ title: `${t('roleLabel')} — ${target?.name || ''}`, body: `Set this user's role to "${role}"?`, confirmLabel: t('roleLabel'), danger: false });
    if (r) await handle(api.adminSetRole(userId, role, r.reason), 'Role updated.');
    render(); // re-sync the select with the stored role either way
  }
  if (e.target.name === 'image' && e.target.closest('#composer-form')) {
    const file = e.target.files?.[0];
    const preview = document.getElementById('composer-preview');
    if (file && preview) {
      const url = URL.createObjectURL(file);
      preview.innerHTML = `<div class="composer-preview-wrap"><img class="post-image" src="${url}" alt="Selected photo preview" /><button type="button" class="preview-remove" data-act="remove-composer-photo" aria-label="Remove photo" title="Remove photo">${icon('x')}</button></div>`;
    }
  }
  if (e.target.id === 'msg-image-input') {
    // Chat photo attach: show the chosen photo in the composer BEFORE
    // sending, so the tap visibly did something and the user can still
    // change their mind (the ✕ clears the input).
    const file = e.target.files?.[0];
    const preview = document.getElementById('message-preview');
    if (file && preview) {
      const url = URL.createObjectURL(file);
      preview.innerHTML = `<img src="${url}" alt="Selected photo preview" /><span class="grow small">${escapeHtml(file.name)}</span><button type="button" class="btn btn-ghost btn-sm" data-act="clear-message-photo" aria-label="${t('removePhoto')}" title="${t('removePhoto')}">${icon('x')}</button>`;
      preview.classList.remove('hidden');
    }
  }
  if (e.target.id === 'msg-file-input') {
    // Chat file attach: same preview pattern as photos (name + size).
    const file = e.target.files?.[0];
    const preview = document.getElementById('message-preview');
    if (file && preview) {
      preview.innerHTML = `<span class="grow small">${icon('paperclip')} ${escapeHtml(file.name)} (${Math.max(1, Math.round(file.size / 1024))} KB)</span><button type="button" class="btn btn-ghost btn-sm" data-act="clear-message-file" aria-label="${t('attachFile')}" title="${t('attachFile')}">${icon('x')}</button>`;
      preview.classList.remove('hidden');
    }
  }
});

// Mark a conversation read when its thread is opened.
document.addEventListener('meetbook:route', () => {});

// Conversation-list search: pure DOM filter over the rendered conv items
// (matched on the other person's name, stored lowercase in data-search),
// so typing never triggers a re-render that would lose input focus.
// Named so restoreThreadView can re-apply the filter after a rebuild
// restores the search text (a rebuild used to wipe both).
function applyConvListFilter(input) {
  const q = input.value.trim().toLowerCase();
  document.querySelectorAll('.conv-item[data-search]').forEach((el) => {
    // Hide the whole row WRAP: the ⋯ menu button is a sibling of the
    // .conv-item inside .conv-item-wrap, and hiding only the item left
    // orphan ⋯ buttons floating in the filtered list.
    const row = el.closest('.conv-item-wrap') || el;
    row.style.display = !q || (el.dataset.search || '').includes(q) ? '' : 'none';
  });
}
document.addEventListener('input', (e) => {
  if (e.target.id !== 'conv-search') return;
  applyConvListFilter(e.target);
});

// @mention picker (Useful Pack): while typing in a GROUP thread, an
// @token at the caret opens a member list above the composer; picking
// a member completes the @username. Pure DOM — no re-render, so the
// composer's focus and caret survive.
document.addEventListener('input', (e) => {
  if (!(e.target instanceof HTMLInputElement) || e.target.name !== 'text' || !e.target.closest('#message-form')) return;
  const menu = document.getElementById('mention-menu');
  if (!menu) return;
  const form = document.getElementById('message-form');
  const conv = api.data().conversations.find((c) => c.id === form?.dataset.conv);
  const user = me();
  if (!conv?.isGroup || !user) { menu.classList.add('hidden'); return; }
  const upto = e.target.value.slice(0, e.target.selectionStart ?? e.target.value.length);
  const match = upto.match(/(?:^|\s)@([\w.]*)$/);
  if (!match) { menu.classList.add('hidden'); return; }
  const token = match[1].toLowerCase();
  const byId = V.usersById(api.data());
  const candidates = conv.participants.filter((id) => id !== user.id)
    .map((id) => byId[id]).filter(Boolean)
    .filter((u) => u.username.toLowerCase().startsWith(token) || u.name.toLowerCase().startsWith(token))
    .slice(0, 6);
  if (!candidates.length) { menu.classList.add('hidden'); return; }
  menu.innerHTML = candidates.map((u) => `<button type="button" class="mention-item" data-act="mention-pick" data-username="${escapeHtml(u.username)}">${avatarHtml(u, 26)}<span class="grow"><b>${escapeHtml(u.name)}</b> <span class="muted small">@${escapeHtml(u.username)}</span></span></button>`).join('');
  menu.classList.remove('hidden');
});

// In-conversation search (Messenger Complete Pack): pure DOM results
// under the search box — matching messages of the OPEN thread, newest
// first, each row jumping to (and flashing) its message via the
// delegated jump-message action. No re-render, so focus stays put.
document.addEventListener('input', (e) => {
  if (e.target.id !== 'conv-msg-search') return;
  const box = document.getElementById('conv-search-results');
  if (!box) return;
  const q = e.target.value.trim().toLowerCase();
  if (!q) { box.innerHTML = ''; return; }
  const d = api.data();
  const user = me();
  const byId = V.usersById(d);
  const hits = d.messages
    .filter((m) => m.conversationId === e.target.dataset.conv && !m.unsent && !(m.hiddenFor || []).includes(user?.id || '') && (m.text || '').toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20);
  box.innerHTML = hits.length
    ? hits.map((m) => `<button type="button" class="pinned-item" data-act="jump-message" data-id="${m.id}"><b>${escapeHtml((byId[m.senderId]?.name || '').split(' ')[0])}</b><span class="grow">${escapeHtml(messageSnippet(m, 80))}</span><span class="muted small">${timeAgo(m.createdAt)}</span></button>`).join('')
    : `<p class="muted small">${t('noSearchResults')}</p>`;
});

// Chat Pack typing heartbeat: keystrokes in the composer refresh my
// typing entry (throttled inside noteTyping); emptying the input or
// leaving it clears the entry right away. The same listener tracks
// the unsent draft per conversation (see composerDrafts above).
document.addEventListener('input', (e) => {
  if (!e.target.matches?.('#message-form input[name="text"]')) return;
  const convId = document.getElementById('message-form')?.dataset.conv;
  if (convId) {
    if (e.target.value) composerDrafts.set(convId, e.target.value);
    else composerDrafts.delete(convId);
  }
  if (e.target.value) noteTyping(convId); else stopTyping();
});
document.addEventListener('focusout', (e) => {
  if (!e.target.matches?.('#message-form input[name="text"]')) return;
  // Pressing one of the composer's own controls — above all the Send
  // button — moves focus WITHIN the form (input -> button) before the
  // click can submit it. Clearing typing on that blur is destructive:
  // setTyping notifies the render listeners synchronously, softRender's
  // focus guard no longer applies (focus just left the input), and the
  // re-render rebuilds the thread mid-press — destroying the form and
  // the button, so no submit ever fires (Enter, which never blurs,
  // kept working). The user is still composing here: the send path
  // clears the typing entry after a successful send, and the idle
  // timer clears it otherwise.
  if (focusMovesWithinForm(e.target.form?.id, e.relatedTarget?.form?.id)) return;
  stopTyping();
});

// Client error collector (Pack C): keep the last 10 uncaught errors
// on this device (utils.recordClientError, localStorage) so the admin
// System Health page can show what the client actually hit. Nothing
// is transmitted anywhere.
window.addEventListener('error', (e) => { recordClientError(e.message || 'Unknown error'); });

// ------------------------------------------------------------- PWA
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstallPrompt = e; softRender(); });
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed:', err));
  });
}

// Presence heartbeat (demo + live profile flag + lastSeen stamp).
setInterval(() => { const u = me(); if (u) api.setOnline(u.id, true); }, 60_000);
// Best-effort sign-off so the Online rail does not keep ghosts around.
window.addEventListener('beforeunload', () => { const u = me(); if (u) api.setOnline(u.id, false); });

// ------------------------------------------------------------- boot
api.onAuthReady((u) => { authResolved = true; authSessionSeen = !!u; render(); });
render();
