// HTML generators for every route. Pure string builders: they read the shared
// dataset (api.data()) and never touch the DOM directly — main.js renders
// and binds events centrally.
import { escapeHtml, timeAgo, canViewPost, canViewGroup, canViewGroupPost, isGroupMember, searchByName, truncate, paginate, groupStoriesByAuthor, canViewStory, storyBackgroundCss, STORY_BACKGROUNDS, memoriesFor, upcomingEvents, canViewEvent, averageRating, FEELINGS, plural, mutualFriendCount } from './utils.js';
import { t } from './i18n.js';
import { avatarHtml, userNameHtml, postCardHtml, emptyState } from './components.js';
import { friendIdsOf, blockedIdsOf } from './store.js';
import { firebaseReady } from './firebase.js';

// Transient per-session UI state that views need but which is not app
// data (main.js flips these; a re-render reads them).
export const uiState = { memoriesDismissed: false };

export function usersById(d) {
  return Object.fromEntries(d.users.map((u) => [u.id, u]));
}

export function viewCtx(d, meUser) {
  const byId = usersById(d);
  const friendIds = meUser ? friendIdsOfData(d, meUser.id) : new Set();
  return {
    usersById: byId, me: meUser, friendIds,
    pagesById: Object.fromEntries((d.pages || []).map((p) => [p.id, p])),
    groupsById: Object.fromEntries((d.groups || []).map((g) => [g.id, g]))
  };
}

export function friendIdsOfData(d, uidValue) {
  const ids = new Set();
  for (const f of d.friendships) {
    if (f.status !== 'accepted') continue;
    if (f.from === uidValue) ids.add(f.to);
    if (f.to === uidValue) ids.add(f.from);
  }
  return ids;
}

export function blockedIdsOfData(d, uidValue) {
  return new Set((d.blocks || []).filter((b) => b.by === uidValue).map((b) => b.target));
}

// ------------------------------------------------------------------ AUTH
// Multicolour Google "G" (the official four-colour mark, inline SVG).
const GOOGLE_G_SVG = '<svg class="google-g" width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.5 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.5 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>';

// Password field with a show/hide eye toggle (main.js wires data-act).
function passwordFieldHtml({ name = 'password', labelKey = 'password', autocomplete = 'current-password', placeholder = '••••••••', required = true, minlength = '' }) {
  return `<label>${t(labelKey)}<span class="pw-wrap"><input name="${name}" type="password" ${required ? 'required' : ''} ${minlength ? `minlength="${minlength}"` : ''} autocomplete="${autocomplete}" placeholder="${placeholder}" /><button type="button" class="pw-eye" data-act="toggle-pw" aria-label="${t('showPassword')}" title="${t('showPassword')}">👁️</button></span></label>`;
}

export function authView(mode = 'login') {
  return `
  <div class="auth-wrap">
    <div class="auth-hero">
      <div class="logo-big">MeetBook</div>
      <p>${t('authTagline')}</p>
      <ul class="auth-feats">
        <li>📰 ${t('authFeat1')}</li>
        <li>💬 ${t('authFeat2')}</li>
        <li>🤖 ${t('authFeat3')}</li>
      </ul>
    </div>
    <div class="card auth-card">
      ${mode === 'login' ? `
      <form id="login-form" class="stack">
        <label>${t('email')}<input name="email" type="email" required autocomplete="email" placeholder="you@example.com" /></label>
        ${passwordFieldHtml({})}
        <button class="btn btn-primary btn-block" type="submit">${t('login')}</button>
        <button class="btn btn-google btn-block" type="button" data-act="google-login">${GOOGLE_G_SVG} ${t('continueWithGoogle')}</button>
        <button class="link-btn center" type="button" data-act="forgot">${t('forgotPassword')}</button>
        ${firebaseReady ? '' : `<p class="muted small center">Demo accounts (offline mode): admin@meetbook.app / admin123 · ayesha@example.com / demo123</p>`}
        <p class="muted small center">${t('newToMeetBook')} <a href="#/register">${t('register')}</a></p>
      </form>` : `
      <form id="register-form" class="stack">
        <label>${t('fullName')}<input name="name" required maxlength="60" placeholder="Your name" /></label>
        <label>${t('username')}<input name="username" required maxlength="24" placeholder="your.name" /></label>
        <label>${t('email')}<input name="email" type="email" required autocomplete="email" placeholder="you@example.com" /></label>
        ${passwordFieldHtml({ autocomplete: 'new-password', placeholder: 'At least 6 characters', minlength: '6' })}
        ${passwordFieldHtml({ name: 'confirmPassword', labelKey: 'confirmPassword', autocomplete: 'new-password', placeholder: 'At least 6 characters', minlength: '6' })}
        <label>${t('dob')}<input name="dob" type="date" /></label>
        <label>${t('gender')}
          <select name="gender">
            <option value="">—</option>
            <option value="Female">${t('genderFemale')}</option>
            <option value="Male">${t('genderMale')}</option>
            <option value="Other">${t('genderOther')}</option>
            <option value="Prefer not to say">${t('genderPreferNot')}</option>
          </select>
        </label>
        <button class="btn btn-primary btn-block" type="submit">${t('register')}</button>
        <button class="btn btn-google btn-block" type="button" data-act="google-login">${GOOGLE_G_SVG} ${t('continueWithGoogle')}</button>
        <p class="muted small center">By registering you agree to our <a href="#/terms">Terms</a> and <a href="#/privacy">Privacy Policy</a>.</p>
        <p class="muted small center">${t('alreadyHaveAccount')} <a href="#/login">${t('login')}</a></p>
      </form>`}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ FEED
export function feedView(d, meUser, page = 1) {
  const ctx = viewCtx(d, meUser);
  const blocked = blockedIdsOfData(d, meUser.id);
  // Group posts live ONLY in their group feeds (their visibility is governed
  // by group privacy, not the post-level field), so the home feed excludes
  // them. Page posts are ordinary public posts and flow in naturally.
  const visible = d.posts
    .filter((p) => !p.groupId && canViewPost(p, { viewerId: meUser.id, authorId: p.authorId, friendIds: ctx.friendIds, blockedIds: blocked }))
    .sort((a, b) => b.createdAt - a.createdAt);
  const pg = paginate(visible, page, 10);
  const defaultVis = meUser.settings?.defaultPostPrivacy || 'public';
  return `
  <div class="layout">
    <aside class="col-left">${leftRail(d, meUser)}</aside>
    <main class="col-main">
      ${storiesRailHtml(d, meUser, ctx)}
      ${memoriesHtml(d, meUser, ctx)}
      <div class="card composer">
        <div class="row gap-sm">${avatarHtml(meUser, 40)}<span class="muted">${escapeHtml(meUser.name)}</span></div>
        <form id="composer-form" class="stack">
          <textarea name="text" rows="3" maxlength="2000" placeholder="${t('whatsOnYourMind')}"></textarea>
          <div id="composer-preview"></div>
          <input type="file" name="image" accept="image/*" hidden />
          <div class="row gap wrap">
            <button type="button" class="btn btn-ghost btn-sm" data-act="pick-photo">📷 Photo</button>
            <label class="btn btn-ghost btn-sm">📊 ${t('addPoll')}<input type="checkbox" name="hasPoll" hidden /></label>
            <select name="visibility" class="select-sm" aria-label="Post privacy">
              <option value="public" ${defaultVis === 'public' ? 'selected' : ''}>🌍 Public</option>
              <option value="friends" ${defaultVis === 'friends' ? 'selected' : ''}>👥 Friends</option>
              <option value="close" ${defaultVis === 'close' ? 'selected' : ''}>⭐ ${t('closeFriends')}</option>
              <option value="only-me" ${defaultVis === 'only-me' ? 'selected' : ''}>🔒 Only me</option>
            </select>
            <span class="spacer"></span>
            <button class="btn btn-primary" type="submit">${t('post')}</button>
          </div>
          <div id="poll-fields" class="stack hidden">
            <div id="poll-options-list" class="stack">
              ${[1, 2].map((i) => `<div class="row gap-sm poll-opt-row"><input name="pollOption" maxlength="60" placeholder="${t('pollOption')} ${i}" autocomplete="off" /></div>`).join('')}
            </div>
            <div class="row gap wrap">
              <button type="button" class="btn btn-ghost btn-sm" data-act="poll-add-option">＋ ${t('addOption')}</button>
              <button type="button" class="btn btn-ghost btn-sm" data-act="poll-remove">✕ ${t('removePoll')}</button>
            </div>
          </div>
          <div class="row gap wrap">
            <label class="grow">📍 ${t('checkIn')}<input name="location" maxlength="120" placeholder="e.g. Lalbagh Fort, Dhaka" autocomplete="off" /></label>
            <label>🙂 ${t('feeling')}
              <select name="feeling" class="select-sm">
                <option value="">—</option>
                ${FEELINGS.map((f) => `<option value="${f.key}">${f.emoji} ${f.label}</option>`).join('')}
              </select>
            </label>
          </div>
        </form>
      </div>
      <div id="feed-list">
        ${pg.items.map((p) => postCardHtml(p, ctx)).join('') || emptyState('📰', t('noPosts'))}
      </div>
      ${pg.hasMore ? `<button class="btn btn-ghost btn-block" data-act="feed-more" data-page="${page + 1}">Load more posts</button>` : (visible.length > 10 ? '<p class="muted center small">You are all caught up 🎉</p>' : '')}
    </main>
    <aside class="col-right">${rightRail(d, meUser)}</aside>
  </div>`;
}

// ------------------------------------------------------------------ MEMORIES
// "On this day" card: the viewer's own posts from the same calendar date
// in earlier years, computed client-side from already-synced posts
// (utils.memoriesFor) — no extra collection or query. Dismissible for
// the session via uiState.
export function memoriesHtml(d, meUser, ctx) {
  if (uiState.memoriesDismissed) return '';
  const memories = memoriesFor(d.posts, meUser.id);
  if (!memories.length) return '';
  return `<div class="card memory-card">
    <div class="row gap-sm">
      <h3 class="grow">🕰️ ${t('memories')} · ${t('onThisDay')}</h3>
      <button class="icon-btn" data-act="dismiss-memories" aria-label="Dismiss">✕</button>
    </div>
    ${memories.map(({ post, yearsAgo }) => `<a class="memory-item" href="#/profile/${meUser.id}">
      <span class="memory-when">${yearsAgo} ${yearsAgo === 1 ? t('yearAgo') : t('yearsAgo')}</span>
      <span class="memory-text">${escapeHtml(truncate(post.text || (post.image ? '📷 Photo' : ''), 160))}</span>
    </a>`).join('')}
  </div>`;
}

// ------------------------------------------------------------------ STORIES
// The rail shows one tile per author with active (≤24h) stories the viewer
// may see; expired stories never render (groupStoriesByAuthor filters by
// the 24h window). Bots never post stories, so no bot tiles appear.
export function visibleStoryGroups(d, meUser) {
  const ctx = viewCtx(d, meUser);
  const blocked = blockedIdsOfData(d, meUser.id);
  const viewable = (d.stories || []).filter((s) => canViewStory(s, { viewerId: meUser.id, friendIds: ctx.friendIds, blockedIds: blocked }));
  return groupStoriesByAuthor(viewable);
}

// Flattened playback queue for the story viewer: author groups in rail
// order, each author's stories oldest-first.
export function storyQueueFor(d, meUser) {
  return visibleStoryGroups(d, meUser).flatMap((g) => g.stories);
}

export function storiesRailHtml(d, meUser, ctx) {
  const groups = visibleStoryGroups(d, meUser);
  const byId = ctx.usersById;
  const tile = (g) => {
    const author = byId[g.authorId];
    if (!author) return '';
    const latest = g.stories[g.stories.length - 1];
    const mine = g.authorId === meUser.id;
    const unviewed = !mine && g.stories.some((s) => !(s.views || []).includes(meUser.id));
    const bg = latest.image ? '' : `background:${storyBackgroundCss(latest.bg)};`;
    return `<button class="story-tile ${unviewed ? 'unviewed' : 'viewed'}" style="${bg}" data-act="view-story" data-author="${g.authorId}" aria-label="${escapeHtml(author.name)} — ${t('stories')}">
      ${latest.image ? `<img class="story-tile-img" src="${escapeHtml(latest.image)}" alt="" loading="lazy" />` : ''}
      <span class="story-tile-avatar">${avatarHtml(author, 34)}</span>
      <span class="story-tile-name">${escapeHtml(author.name.split(' ')[0])}</span>
    </button>`;
  };
  return `<div class="stories card">
    <button class="story-tile create" data-act="create-story" aria-label="${t('createStory')}">
      <span class="story-tile-avatar">${avatarHtml(meUser, 34)}</span>
      <span class="story-plus">➕</span>
      <span class="story-tile-name">${t('createStory')}</span>
    </button>
    ${groups.map(tile).join('')}
    ${groups.length === 0 ? `<p class="muted small story-empty">${t('noStories')}</p>` : ''}
  </div>`;
}

export function storyFormHtml() {
  return `<h3>➕ ${t('createStory')}</h3>
  <form id="story-form" class="stack">
    <label>${t('storyText')}<textarea name="text" rows="3" maxlength="300" placeholder="${t('storyTextPlaceholder')}"></textarea></label>
    <label>📷 Photo<input type="file" name="image" accept="image/*" /></label>
    <div>
      <span class="small muted">${t('storyBackground')}</span>
      <div class="bg-swatches">
        ${STORY_BACKGROUNDS.map((b, i) => `<label class="bg-swatch" style="background:${b.css}" title="${b.key}"><input type="radio" name="bg" value="${b.key}" ${i === 0 ? 'checked' : ''} /><span class="sr-only">${b.key}</span></label>`).join('')}
      </div>
    </div>
    <label>${t('privacyLabel')}
      <select name="visibility">
        <option value="public">🌍 ${t('publicLabel')}</option>
        <option value="friends">👥 ${t('friends')}</option>
      </select>
    </label>
    <p class="muted small">${t('stories')} · 24h</p>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${t('createStory')}</button></div>
  </form>`;
}

export function leftRail(d, meUser) {
  return `<div class="card rail">
    <a class="rail-item" href="#/profile/${meUser.id}">${avatarHtml(meUser, 36)}<span>${escapeHtml(meUser.name)}</span></a>
    <a class="rail-item" href="#/">📰 Feed</a>
    <a class="rail-item" href="#/friends">👥 ${t('friends')}</a>
    <a class="rail-item" href="#/events">📅 ${t('events')}</a>
    <a class="rail-item" href="#/groups">🏘️ ${t('groups')}</a>
    <a class="rail-item" href="#/pages">📄 ${t('pages')}</a>
    <a class="rail-item" href="#/messages">💬 ${t('messages')}</a>
    <a class="rail-item" href="#/saved">🔖 ${t('saved')} posts</a>
    <a class="rail-item" href="#/notifications">🔔 ${t('notifications')}</a>
    ${meUser.role === 'admin' ? `<a class="rail-item" href="#/admin">🛡️ ${t('admin')}</a><a class="rail-item" href="#/bots">🤖 ${t('bots')}</a>` : ''}
    <a class="rail-item" href="#/settings">⚙️ ${t('settings')}</a>
    <a class="rail-item" href="#/help">❓ ${t('help')}</a>
  </div>`;
}

export function rightRail(d, meUser) {
  const friendIds = friendIdsOfData(d, meUser.id);
  const pending = d.friendships.filter((f) => f.to === meUser.id && f.status === 'pending');
  const suggestions = suggestionsFor(d, meUser).slice(0, 4);
  const byId = usersById(d);
  return `<div class="card rail">
    ${pending.length ? `<h4>Friend requests</h4>${pending.map((f) => `<div class="row gap-sm rail-person">${avatarHtml(byId[f.from], 36)}<span class="grow">${escapeHtml(byId[f.from]?.name || '')}</span><button class="btn btn-primary btn-sm" data-act="accept-request" data-id="${f.id}">Accept</button><button class="btn btn-ghost btn-sm" data-act="reject-request" data-id="${f.id}">✕</button></div>`).join('')}` : ''}
    <h4>People you may know</h4>
    ${suggestions.map((u) => { const mutual = mutualFriendCount(d.friendships, meUser.id, u.id); return `<div class="row gap-sm rail-person">${avatarHtml(u, 36)}<span class="grow"><a href="#/profile/${u.id}">${escapeHtml(u.name)}</a>${mutual > 0 ? `<br/><span class="muted small">${mutual} ${mutual === 1 ? t('mutualFriend') : t('mutualFriends')}</span>` : ''}</span>${u.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : `<button class="btn btn-ghost btn-sm" data-act="send-request" data-id="${u.id}">${t('addFriend')}</button>`}</div>`; }).join('') || '<p class="muted small">No suggestions right now.</p>'}
    <h4>Online</h4>
    ${d.users.filter((u) => u.id !== meUser.id && isFreshOnline(u)).slice(0, 6).map((u) => `<a class="row gap-sm rail-person" href="#/profile/${u.id}"><span class="online-dot"></span>${escapeHtml(u.name)}${u.isBot ? ` <span class="badge badge-bot">${t('aiBot')}</span>` : ''}</a>`).join('') || '<p class="muted small">Nobody online.</p>'}
    <p class="muted small">${friendIds.size} friends · MeetBook</p>
  </div>`;
}

export function suggestionsFor(d, meUser) {
  const friendIds = friendIdsOfData(d, meUser.id);
  const related = new Set([...friendIds, meUser.id]);
  for (const f of d.friendships) { if (f.from === meUser.id) related.add(f.to); if (f.to === meUser.id) related.add(f.from); }
  const blocked = blockedIdsOfData(d, meUser.id);
  return d.users.filter((u) => !related.has(u.id) && !blocked.has(u.id));
}

// "Online now" for the right rail: the online flag must be set AND the
// lastSeen heartbeat fresh (within 10 minutes). Older user docs without
// lastSeen fall back to the flag alone so nobody vanishes unfairly.
const ONLINE_FRESH_MS = 10 * 60_000;
export function isFreshOnline(u, now = Date.now()) {
  if (!u?.online) return false;
  const seen = Number(u.lastSeen) || 0;
  if (!seen) return true;
  return now - seen < ONLINE_FRESH_MS;
}

// ------------------------------------------------------------------ PROFILE
export function profileView(d, meUser, userId) {
  const ctx = viewCtx(d, meUser);
  const user = ctx.usersById[userId];
  if (!user) return emptyState('🕵️', 'This profile could not be found.');
  const isMe = user.id === meUser.id;
  const friendIds = friendIdsOfData(d, user.id);
  const myFriends = friendIdsOfData(d, meUser.id);
  const rel = d.friendships.find((f) => (f.from === meUser.id && f.to === user.id) || (f.from === user.id && f.to === meUser.id));
  const following = (meUser.following || []).includes(user.id);
  const blocked = blockedIdsOfData(d, meUser.id).has(user.id);
  const posts = d.posts.filter((p) => p.authorId === user.id && !p.groupId && canViewPost(p, { viewerId: meUser.id, authorId: p.authorId, friendIds: myFriends, blockedIds: blockedIdsOfData(d, meUser.id) })).sort((a, b) => b.createdAt - a.createdAt);
  return `
  <div class="profile-wrap">
    <div class="card profile-head">
      <div class="cover" style="${user.cover ? `background-image:url('${escapeHtml(user.cover)}')` : ''}">
        ${isMe ? `<button class="btn btn-ghost btn-sm cover-edit-btn" data-act="edit-profile">📷 ${user.cover ? t('changeCoverPhoto') : t('addCoverPhoto')}</button>` : ''}
      </div>
      <div class="profile-meta">
        ${avatarHtml(user, 110)}
        <div class="grow">
          <h2>${userNameHtml(user)}${user.nickname ? ` <span class="nickname">(${escapeHtml(user.nickname)})</span>` : ''}</h2>
          <p class="muted">@${escapeHtml(user.username)} · ${friendIds.size} friends · ${(user.followers || []).length} followers · <span class="${user.online ? 'online-text' : 'muted'}">${user.online ? '● ' + t('online') : t('offline')}</span></p>
          <p>${escapeHtml(user.bio || 'No bio yet.')}</p>
          ${isMe && !user.avatar ? `<button class="link-btn small" data-act="edit-profile">📷 ${t('addProfilePhoto')}</button>` : ''}
        </div>
        <div class="row gap wrap">
          ${isMe ? `<button class="btn btn-primary" data-act="edit-profile">✏️ ${t('editProfile')}</button>` : `
            ${blocked ? `<button class="btn btn-ghost" data-act="block" data-id="${user.id}">Unblock</button>` : `
              ${rel?.status === 'accepted' ? `<button class="btn btn-ghost" data-act="remove-friend" data-id="${rel.id}">✓ Friends</button>` : rel?.status === 'pending' && rel.from === meUser.id ? `<button class="btn btn-ghost" data-act="cancel-request" data-id="${rel.id}" title="${t('tapToCancel')}">✓ ${t('requestSent')}</button>` : rel?.status === 'pending' ? `<button class="btn btn-primary" data-act="accept-request" data-id="${rel.id}">Accept request</button>` : (!user.isBot ? `<button class="btn btn-primary" data-act="send-request" data-id="${user.id}">${t('addFriend')}</button>` : '')}
              <button class="btn ${following ? 'btn-ghost' : 'btn-primary'}" data-act="follow" data-id="${user.id}">${following ? t('following') : t('follow')}</button>
              <button class="btn btn-ghost" data-act="message-user" data-id="${user.id}">💬 Message</button>
              <button class="btn btn-ghost" data-act="block" data-id="${user.id}">Block</button>
              <button class="btn btn-ghost" data-act="report-user" data-id="${user.id}">🚩 ${t('report')}</button>`}
          `}
        </div>
      </div>
    </div>
    ${(() => {
      const intro = introCardHtml(user, isMe);
      // Photos strip: this user's photo posts (already visibility-filtered
      // into `posts` above), newest first, up to 9 thumbnails.
      const photoPosts = posts.filter((p) => p.image).slice(0, 9);
      const photosStrip = photoPosts.length ? `<div class="card strip-card">
        <h3>${t('photos')}</h3>
        <div class="photos-grid">${photoPosts.map((p) => `<img class="photos-thumb" src="${escapeHtml(p.image)}" alt="${escapeHtml(truncate(p.text || 'Photo', 60))}" loading="lazy" />`).join('')}</div>
      </div>` : '';
      // Friends strip: count + up to 9 friend avatars linking to profiles.
      const friendUsers = [...friendIds].map((id) => ctx.usersById[id]).filter(Boolean).slice(0, 9);
      const friendsStrip = friendUsers.length ? `<div class="card strip-card">
        <h3>${t('friends')} (${friendIds.size})</h3>
        <div class="friends-strip">${friendUsers.map((u) => `<a class="friend-tile" href="#/profile/${u.id}">${avatarHtml(u, 52)}<span>${escapeHtml(u.name.split(' ')[0])}</span></a>`).join('')}</div>
      </div>` : '';
      const sideBits = intro + photosStrip + friendsStrip;
      const postsHtml = `<div class="profile-posts">
      ${posts.map((p) => postCardHtml(p, ctx)).join('') || emptyState('📝', 'No visible posts yet.')}
    </div>`;
      return sideBits
        ? `<div class="profile-cols"><aside class="profile-side">${sideBits}</aside>${postsHtml}</div>`
        : postsHtml;
    })()}
  </div>`;
}

// Facebook-style Intro card: only the About fields the user actually
// filled in, one icon row each. Website values are linked (https:// is
// assumed when no scheme is present).
export function introCardHtml(user, isMe = false) {
  const items = [];
  if (user.work) items.push(`<div class="intro-row"><span class="intro-icon">💼</span><span>${t('worksAt')} <b>${escapeHtml(user.work)}</b></span></div>`);
  if (user.education) items.push(`<div class="intro-row"><span class="intro-icon">🎓</span><span>${t('studiedAt')} <b>${escapeHtml(user.education)}</b></span></div>`);
  if (user.currentCity) items.push(`<div class="intro-row"><span class="intro-icon">📍</span><span>${t('livesIn')} <b>${escapeHtml(user.currentCity)}</b></span></div>`);
  if (user.hometown) items.push(`<div class="intro-row"><span class="intro-icon">🏠</span><span>${t('fromPlace')} <b>${escapeHtml(user.hometown)}</b></span></div>`);
  if (user.relationship) items.push(`<div class="intro-row"><span class="intro-icon">❤️</span><span>${escapeHtml(user.relationship)}</span></div>`);
  if (user.dob) {
    const dobDate = new Date(`${user.dob}T00:00:00`);
    const dobText = Number.isNaN(dobDate.getTime()) ? String(user.dob) : dobDate.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    items.push(`<div class="intro-row"><span class="intro-icon">🎂</span><span>${t('birthday')}: <b>${escapeHtml(dobText)}</b></span></div>`);
  }
  if (user.gender) items.push(`<div class="intro-row"><span class="intro-icon">🧑</span><span>${t('gender')}: <b>${escapeHtml(user.gender)}</b></span></div>`);
  if (user.website) {
    const href = /^https?:\/\//i.test(user.website) ? user.website : `https://${user.website}`;
    items.push(`<div class="intro-row"><span class="intro-icon">🔗</span><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(user.website)}</a></div>`);
  }
  if (!items.length && !isMe) return '';
  return `<div class="card intro-card">
    <h3>${t('intro')}</h3>
    ${items.join('') || `<p class="muted small">Add your work, education, city and more from Edit profile.</p>`}
  </div>`;
}

// ------------------------------------------------------------------ FRIENDS
export function friendsView(d, meUser) {
  const byId = usersById(d);
  const friendIds = friendIdsOfData(d, meUser.id);
  const incoming = d.friendships.filter((f) => f.to === meUser.id && f.status === 'pending');
  const outgoing = d.friendships.filter((f) => f.from === meUser.id && f.status === 'pending');
  const suggestions = suggestionsFor(d, meUser);
  const mutualLine = (u) => {
    if (!u) return '';
    const n = mutualFriendCount(d.friendships, meUser.id, u.id);
    return n > 0 ? `<span class="muted small">${n} ${n === 1 ? t('mutualFriend') : t('mutualFriends')}</span>` : '';
  };
  const person = (u, actions, extra = '') => `<div class="card person-card">${avatarHtml(u, 56)}<a href="#/profile/${u.id}"><b>${escapeHtml(u.name)}</b></a><span class="muted small">@${escapeHtml(u.username)}</span>${extra}${u.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''}<div class="row gap wrap center">${actions}</div></div>`;
  return `<div class="page">
    <h2>👥 ${t('friends')}</h2>
    <h3>${t('requestsReceived')}</h3>
    ${incoming.length ? `<div class="grid-people">${incoming.map((f) => person(byId[f.from], `<button class="btn btn-primary btn-sm" data-act="accept-request" data-id="${f.id}">Accept</button><button class="btn btn-ghost btn-sm" data-act="reject-request" data-id="${f.id}">Reject</button>`, mutualLine(byId[f.from]))).join('')}</div>` : `<p class="muted">${t('noRequestsReceived')}</p>`}
    <h3>${t('requestsSent')}</h3>
    ${outgoing.length ? `<div class="grid-people">${outgoing.map((f) => person(byId[f.to], `<button class="btn btn-ghost btn-sm" data-act="cancel-request" data-id="${f.id}">${t('cancelRequest')}</button>`)).join('')}</div>` : `<p class="muted">${t('noRequestsSent')}</p>`}
    <h3>${t('yourFriends')} (${friendIds.size})</h3>
    <div class="grid-people">${[...friendIds].map((id) => { const rel = d.friendships.find((f) => f.status === 'accepted' && ((f.from === meUser.id && f.to === id) || (f.to === meUser.id && f.from === id))); const isClose = (meUser.closeFriends || []).includes(id); return person(byId[id], `<button class="btn ${isClose ? 'btn-primary' : 'btn-ghost'} btn-sm" data-act="toggle-close-friend" data-id="${id}" title="${t('closeFriends')}">${isClose ? '⭐' : '☆'} ${t('closeFriends')}</button><button class="btn btn-ghost btn-sm" data-act="message-user" data-id="${id}">Message</button><button class="btn btn-ghost btn-sm" data-act="remove-friend" data-id="${rel?.id}">Remove</button>`); }).join('') || '<p class="muted">No friends yet — send a request below.</p>'}</div>
    <h3>${t('suggestedForYou')}</h3>
    <div class="grid-people">${suggestions.map((u) => person(u, u.isBot ? `<button class="btn btn-ghost btn-sm" data-act="message-user" data-id="${u.id}">Chat with bot</button>` : `<button class="btn btn-primary btn-sm" data-act="send-request" data-id="${u.id}">${t('addFriend')}</button>`, mutualLine(u))).join('') || '<p class="muted">No suggestions.</p>'}</div>
  </div>`;
}

// ------------------------------------------------------------------ GROUPS
export function groupsView(d, meUser, queryText = '') {
  // Private groups are DISCOVERABLE by name/description (Facebook-style)
  // so people can request to join; their posts and member list stay
  // member-only (groupView + the group read rules enforce that).
  const visible = (d.groups || []).filter((g) => canViewGroup(g, meUser.id) || g.privacy === 'private');
  const mine = searchByName(visible.filter((g) => isGroupMember(g, meUser.id)), queryText);
  const discover = searchByName(visible.filter((g) => !isGroupMember(g, meUser.id)), queryText);
  const card = (g) => {
    const pendingReq = (d.groupRequests || []).some((r) => r.groupId === g.id && r.userId === meUser.id && r.status === 'pending');
    return `<div class="card person-card">
    ${avatarHtml({ name: g.name, username: g.name, avatar: g.cover }, 56)}
    <a href="#/group/${g.id}"><b>${escapeHtml(g.name)}</b></a>
    <span class="muted small">${g.privacy === 'private' ? '🔒 ' + t('privateLabel') : '🌍 ' + t('publicLabel')} · ${plural((g.members || []).length, t('member'), t('members'))}</span>
    <span class="muted small">${escapeHtml(truncate(g.description || '', 90))}</span>
    <div class="row gap wrap center">
      ${isGroupMember(g, meUser.id) ? `<span class="badge badge-ok">${t('joined')}</span>` : pendingReq ? `<span class="badge badge-warn">${t('requestPending')}</span>` : `<button class="btn btn-primary btn-sm" data-act="toggle-group-join" data-id="${g.id}">${g.privacy === 'private' ? t('requestToJoin') : t('joinGroup')}</button>`}
      <a class="btn btn-ghost btn-sm" href="#/group/${g.id}">View</a>
    </div>
  </div>`;
  };
  return `<div class="page">
    <div class="row"><h2 class="grow">🏘️ ${t('groups')}</h2><button class="btn btn-primary" data-act="create-group">+ ${t('createGroup')}</button></div>
    <form id="groups-search-form" class="row gap">
      <input name="q" class="grow" placeholder="${t('searchGroups')}" value="${escapeHtml(queryText || '')}" autocomplete="off" />
      <button class="btn btn-ghost" type="submit">Search</button>
    </form>
    <h3>${t('yourGroups')} (${mine.length})</h3>
    <div class="grid-people">${mine.map(card).join('') || `<p class="muted">${t('noGroups')}</p>`}</div>
    <h3>${t('discoverGroups')}</h3>
    <div class="grid-people">${discover.map(card).join('') || `<p class="muted">${t('noGroups')}</p>`}</div>
  </div>`;
}

export function groupView(d, meUser, groupId) {
  const group = (d.groups || []).find((g) => g.id === groupId);
  if (!group) return emptyState('🏘️', 'This group could not be found.');
  if (!canViewGroup(group, meUser.id)) {
    // Private group, not a member: show only the public metadata and the
    // join-request action — no posts, no member list.
    const pending = (d.groupRequests || []).find((r) => r.groupId === group.id && r.userId === meUser.id && r.status === 'pending');
    return `<div class="profile-wrap"><div class="card profile-head">
      <div class="cover"></div>
      <div class="profile-meta">
        ${avatarHtml({ name: group.name, username: group.name, avatar: '' }, 110)}
        <div class="grow">
          <h2>${escapeHtml(group.name)}</h2>
          <p class="muted">🔒 ${t('privateLabel')} · ${plural((group.members || []).length, t('member'), t('members'))}</p>
          <p>${escapeHtml(group.description || '')}</p>
        </div>
        <div class="row gap wrap">
          ${pending ? `<span class="badge badge-warn">${t('requestPending')}</span><button class="btn btn-ghost" data-act="toggle-group-join" data-id="${group.id}">${t('withdrawRequest')}</button>`
            : `<button class="btn btn-primary" data-act="toggle-group-join" data-id="${group.id}">${t('requestToJoin')}</button>`}
        </div>
      </div>
    </div></div>`;
  }
  const ctx = viewCtx(d, meUser);
  ctx.showGroupContext = false; // already inside the group — no context note
  const byId = ctx.usersById;
  const member = isGroupMember(group, meUser.id);
  const isCreator = group.createdBy === meUser.id;
  const blocked = blockedIdsOfData(d, meUser.id);
  const myPending = (d.groupRequests || []).find((r) => r.groupId === group.id && r.userId === meUser.id && r.status === 'pending');
  const pendingRequests = isCreator ? (d.groupRequests || []).filter((r) => r.groupId === group.id && r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt) : [];
  // Announcements (pinned posts) lead the group feed, newest first within
  // each tier.
  const posts = d.posts
    .filter((p) => p.groupId === group.id && canViewGroupPost(p, group, meUser.id, blocked))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.createdAt - a.createdAt);
  return `<div class="profile-wrap">
    <div class="card profile-head">
      <div class="cover" style="${group.cover ? `background-image:url('${escapeHtml(group.cover)}')` : ''}"></div>
      <div class="profile-meta">
        ${avatarHtml({ name: group.name, username: group.name, avatar: '' }, 110)}
        <div class="grow">
          <h2>${escapeHtml(group.name)}</h2>
          <p class="muted">${group.privacy === 'private' ? '🔒 ' + t('privateLabel') : '🌍 ' + t('publicLabel')} · ${plural((group.members || []).length, t('member'), t('members'))} · created by ${escapeHtml(byId[group.createdBy]?.name || '')}</p>
          <p class="muted small">🏘️ ${t('aboutThisGroup')}: ${group.privacy === 'private' ? '🔒 ' + t('privateLabel') : '🌍 ' + t('publicLabel')} · ${t('createdOn')} ${new Date(group.createdAt || Date.now()).toLocaleDateString()} · ${plural((group.members || []).length, t('member'), t('members'))}</p>
          <p>${escapeHtml(group.description || '')}</p>
        </div>
        <div class="row gap wrap">
          ${isCreator ? `<button class="btn btn-primary" data-act="edit-group" data-id="${group.id}">✏️ ${t('edit')}</button><button class="btn btn-danger" data-act="delete-group" data-id="${group.id}">${t('delete')} group</button>`
            : member ? `<button class="btn btn-ghost" data-act="toggle-group-join" data-id="${group.id}">${t('leaveGroup')}</button>`
            : myPending ? `<span class="badge badge-warn">${t('requestPending')}</span><button class="btn btn-ghost" data-act="toggle-group-join" data-id="${group.id}">${t('withdrawRequest')}</button>`
            : `<button class="btn btn-primary" data-act="toggle-group-join" data-id="${group.id}">${group.privacy === 'private' ? t('requestToJoin') : t('joinGroup')}</button>`}
        </div>
      </div>
    </div>
    ${isCreator && pendingRequests.length ? `
    <div class="card stack">
      <h3>📥 ${t('joinRequests')} (${pendingRequests.length})</h3>
      ${pendingRequests.map((r) => { const u = byId[r.userId]; return u ? `<div class="row gap-sm">${avatarHtml(u, 36)}<a class="grow" href="#/profile/${u.id}">${escapeHtml(u.name)}</a><button class="btn btn-primary btn-sm" data-act="approve-group-request" data-id="${r.id}">${t('approve')}</button><button class="btn btn-ghost btn-sm" data-act="reject-group-request" data-id="${r.id}">${t('reject')}</button></div>` : ''; }).join('')}
    </div>` : ''}
    ${member ? `
    <div class="card composer">
      <div class="row gap-sm">${avatarHtml(meUser, 40)}<span class="muted">${escapeHtml(meUser.name)}</span></div>
      <form id="group-composer-form" data-group="${group.id}" class="stack">
        <textarea name="text" rows="3" maxlength="2000" placeholder="${t('postToGroup')}"></textarea>
        <input type="file" name="image" accept="image/*" hidden />
        <div class="row gap wrap">
          <button type="button" class="btn btn-ghost btn-sm" data-act="pick-photo">📷 Photo</button>
          <span class="spacer"></span>
          <button class="btn btn-primary" type="submit">${t('post')}</button>
        </div>
      </form>
    </div>` : `<div class="card"><p class="muted">${t('joinToPost')}</p></div>`}
    <div class="profile-posts">
      ${posts.map((p) => postCardHtml(p, ctx)).join('') || emptyState('📝', t('noPosts'))}
    </div>
    <div class="card stack">
      <h3>${t('members')} (${(group.members || []).length})</h3>
      ${(group.members || []).map((id) => {
        const u = byId[id];
        if (!u) return '';
        return `<div class="row gap-sm">${avatarHtml(u, 36)}<a class="grow" href="#/profile/${u.id}">${escapeHtml(u.name)}</a>${id === group.createdBy ? ' <span class="badge badge-admin">Admin</span>' : ''}${u.isBot ? ` <span class="badge badge-bot">${t('aiBot')}</span>` : ''}${isCreator && id !== group.createdBy ? `<button class="btn btn-ghost btn-sm" data-act="remove-member" data-group="${group.id}" data-id="${id}">Remove</button>` : ''}</div>`;
      }).join('')}
    </div>
  </div>`;
}

export function groupFormHtml(group = null) {
  return `<h3>${group ? `${t('edit')} group` : t('createGroup')}</h3>
  <form id="group-form" data-id="${group?.id || ''}" class="stack">
    <label>${t('groupName')}<input name="name" required maxlength="80" value="${escapeHtml(group?.name || '')}" /></label>
    <label>${t('description')}<textarea name="description" rows="3" maxlength="500">${escapeHtml(group?.description || '')}</textarea></label>
    <label>${t('privacyLabel')}
      <select name="privacy">
        <option value="public" ${group?.privacy !== 'private' ? 'selected' : ''}>🌍 ${t('publicLabel')}</option>
        <option value="private" ${group?.privacy === 'private' ? 'selected' : ''}>🔒 ${t('privateLabel')}</option>
      </select>
    </label>
    <label>Cover photo<input type="file" name="cover" accept="image/*" /></label>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${group ? 'Save group' : t('createGroup')}</button></div>
  </form>`;
}

// ------------------------------------------------------------------ PAGES
export function pagesView(d, meUser, queryText = '') {
  const all = d.pages || [];
  const mine = searchByName(all.filter((p) => p.ownerId === meUser.id || (p.followers || []).includes(meUser.id)), queryText);
  const discover = searchByName(all.filter((p) => p.ownerId !== meUser.id && !(p.followers || []).includes(meUser.id)), queryText);
  const card = (p) => `<div class="card person-card">
    ${avatarHtml({ name: p.name, username: p.name, avatar: p.avatar }, 56)}
    <a href="#/page/${p.id}"><b>${escapeHtml(p.name)}</b></a>
    <span class="badge">${escapeHtml(p.category || t('pageLabel'))}</span>
    <span class="muted small">${plural((p.followers || []).length, t('follower'), t('followers'))}</span>
    <span class="muted small">${escapeHtml(truncate(p.about || '', 90))}</span>
    <div class="row gap wrap center">
      ${p.ownerId === meUser.id ? `<span class="badge badge-ok">Your page</span>` : (p.followers || []).includes(meUser.id) ? `<button class="btn btn-ghost btn-sm" data-act="follow-page" data-id="${p.id}">${t('following')}</button>` : `<button class="btn btn-primary btn-sm" data-act="follow-page" data-id="${p.id}">${t('follow')}</button>`}
      <a class="btn btn-ghost btn-sm" href="#/page/${p.id}">View</a>
    </div>
  </div>`;
  return `<div class="page">
    <div class="row"><h2 class="grow">📄 ${t('pages')}</h2><button class="btn btn-primary" data-act="create-page">+ ${t('createPage')}</button></div>
    <form id="pages-search-form" class="row gap">
      <input name="q" class="grow" placeholder="${t('searchPages')}" value="${escapeHtml(queryText || '')}" autocomplete="off" />
      <button class="btn btn-ghost" type="submit">Search</button>
    </form>
    <h3>${t('yourPages')} (${mine.length})</h3>
    <div class="grid-people">${mine.map(card).join('') || `<p class="muted">${t('noPages')}</p>`}</div>
    <h3>${t('discoverPages')}</h3>
    <div class="grid-people">${discover.map(card).join('') || `<p class="muted">${t('noPages')}</p>`}</div>
  </div>`;
}

export function pageView(d, meUser, pageId) {
  const page = (d.pages || []).find((p) => p.id === pageId);
  if (!page) return emptyState('📄', 'This page could not be found.');
  const ctx = viewCtx(d, meUser);
  const isOwner = page.ownerId === meUser.id;
  const following = (page.followers || []).includes(meUser.id);
  const posts = d.posts.filter((p) => p.pageId === page.id).sort((a, b) => b.createdAt - a.createdAt);
  const pageReviews = (d.reviews || []).filter((r) => r.pageId === page.id).sort((a, b) => b.createdAt - a.createdAt);
  const ratingSummary = averageRating(pageReviews);
  const myReview = pageReviews.find((r) => r.authorId === meUser.id);
  const stars = (n) => '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n));
  return `<div class="profile-wrap">
    <div class="card profile-head">
      <div class="cover" style="${page.cover ? `background-image:url('${escapeHtml(page.cover)}')` : ''}"></div>
      <div class="profile-meta">
        ${avatarHtml({ name: page.name, username: page.name, avatar: page.avatar }, 110)}
        <div class="grow">
          <h2>${escapeHtml(page.name)} <span class="badge">${t('pageLabel')}</span></h2>
          <p class="muted">${escapeHtml(page.category || '')} · ${plural((page.followers || []).length, t('follower'), t('followers'))} · by ${escapeHtml(ctx.usersById[page.ownerId]?.name || '')}</p>
          <p>${escapeHtml(page.about || '')}</p>
        </div>
        <div class="row gap wrap">
          ${isOwner ? `<button class="btn btn-primary" data-act="edit-page" data-id="${page.id}">✏️ ${t('edit')}</button><button class="btn btn-danger" data-act="delete-page" data-id="${page.id}">${t('delete')} page</button>`
            : `<button class="btn ${following ? 'btn-ghost' : 'btn-primary'}" data-act="follow-page" data-id="${page.id}">${following ? t('following') : t('follow')}</button>`}
        </div>
      </div>
    </div>
    ${isOwner ? `
    <div class="card composer">
      <div class="row gap-sm">${avatarHtml({ name: page.name, username: page.name, avatar: page.avatar }, 40)}<span class="muted">${escapeHtml(page.name)}</span></div>
      <form id="page-composer-form" data-page="${page.id}" class="stack">
        <textarea name="text" rows="3" maxlength="2000" placeholder="${t('postAsPage')}"></textarea>
        <input type="file" name="image" accept="image/*" hidden />
        <div class="row gap wrap">
          <button type="button" class="btn btn-ghost btn-sm" data-act="pick-photo">📷 Photo</button>
          <span class="spacer"></span>
          <button class="btn btn-primary" type="submit">${t('post')}</button>
        </div>
      </form>
    </div>` : ''}
    <div class="profile-posts">
      ${posts.map((p) => postCardHtml(p, ctx)).join('') || emptyState('📝', t('noPosts'))}
    </div>
    <div class="card stack">
      <h3>⭐ ${t('reviews')} ${ratingSummary.count ? `· <span class="stars">${stars(ratingSummary.average)}</span> ${ratingSummary.average} (${ratingSummary.count})` : ''}</h3>
      ${pageReviews.map((r) => { const a = ctx.usersById[r.authorId]; return `<div class="row gap-sm review-item">${avatarHtml(a, 36)}<div class="grow"><b>${escapeHtml(a?.name || '')}</b> <span class="stars">${stars(r.rating)}</span> <span class="muted small">${timeAgo(r.createdAt)}</span>${r.text ? `<br/>${escapeHtml(r.text)}` : ''}</div>${r.authorId === meUser.id ? `<button class="btn btn-ghost btn-sm" data-act="delete-review" data-id="${r.id}">🗑️</button>` : ''}</div>`; }).join('') || `<p class="muted">${t('noReviews')}</p>`}
      ${isOwner ? '' : `
      <form id="review-form" data-page="${page.id}" class="stack">
        <h4>${myReview ? t('yourReview') : t('writeReview')}</h4>
        <div class="star-picker" role="radiogroup" aria-label="${t('rating')}">
          ${[1, 2, 3, 4, 5].map((n) => `<label class="star-option"><input type="radio" name="rating" value="${n}" ${Number(myReview?.rating || 0) === n ? 'checked' : ''} required /><span>${n <= Number(myReview?.rating || 0) ? '★' : '☆'}</span></label>`).join('')}
        </div>
        <textarea name="text" rows="2" maxlength="500" placeholder="${t('writeReview')}…">${escapeHtml(myReview?.text || '')}</textarea>
        <div><button class="btn btn-primary btn-sm" type="submit">${myReview ? 'Update review' : t('writeReview')}</button></div>
      </form>`}
    </div>
  </div>`;
}

const PAGE_CATEGORIES = ['Community', 'Business', 'Food & Drink', 'Technology', 'Entertainment', 'Education', 'Health', 'Arts', 'Sports', 'Other'];

export function pageFormHtml(page = null) {
  return `<h3>${page ? `${t('edit')} page` : t('createPage')}</h3>
  <form id="page-form" data-id="${page?.id || ''}" class="stack">
    <label>Page name<input name="name" required maxlength="80" value="${escapeHtml(page?.name || '')}" /></label>
    <label>${t('category')}<input name="category" list="page-categories" maxlength="60" value="${escapeHtml(page?.category || '')}" placeholder="Community" /></label>
    <datalist id="page-categories">${PAGE_CATEGORIES.map((c) => `<option value="${c}"></option>`).join('')}</datalist>
    <label>${t('about')}<textarea name="about" rows="3" maxlength="500">${escapeHtml(page?.about || '')}</textarea></label>
    <label>Profile picture<input type="file" name="avatar" accept="image/*" /></label>
    <label>Cover photo<input type="file" name="cover" accept="image/*" /></label>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${page ? 'Save page' : t('createPage')}</button></div>
  </form>`;
}

// ------------------------------------------------------------------ EVENTS
function eventDateBlock(dateTime) {
  const d = new Date(dateTime || 0);
  const day = d.getDate();
  const mon = d.toLocaleDateString(undefined, { month: 'short' });
  return `<div class="event-date"><span class="event-day">${day}</span><span class="event-mon">${escapeHtml(mon)}</span></div>`;
}

function eventCardHtml(d, meUser, e, ctx) {
  const byId = ctx.usersById;
  const when = new Date(e.dateTime || 0).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const going = (e.going || []).includes(meUser.id);
  const interested = (e.interested || []).includes(meUser.id);
  return `<div class="card event-card">
    <div class="row gap">
      ${eventDateBlock(e.dateTime)}
      <div class="grow">
        <a href="#/event/${e.id}"><b>${escapeHtml(e.title)}</b></a>
        <div class="muted small">🕒 ${escapeHtml(when)}${e.location ? ` · 📍 ${escapeHtml(e.location)}` : ''}</div>
        <div class="muted small">${e.visibility === 'friends' ? '👥 ' + t('friends') : '🌍 ' + t('publicLabel')} · ${plural((e.going || []).length, t('going'), t('going'))} · ${plural((e.interested || []).length, t('interested'), t('interested'))} · by ${escapeHtml(byId[e.createdBy]?.name || '')}</div>
      </div>
    </div>
    <div class="row gap wrap">
      <button class="btn ${going ? 'btn-primary' : 'btn-ghost'} btn-sm" data-act="rsvp" data-kind="going" data-id="${e.id}">✓ ${t('going')}</button>
      <button class="btn ${interested ? 'btn-primary' : 'btn-ghost'} btn-sm" data-act="rsvp" data-kind="interested" data-id="${e.id}">⭐ ${t('interested')}</button>
      <a class="btn btn-ghost btn-sm" href="#/event/${e.id}">Details</a>
    </div>
  </div>`;
}

export function eventsView(d, meUser) {
  const ctx = viewCtx(d, meUser);
  const blocked = blockedIdsOfData(d, meUser.id);
  const visible = upcomingEvents((d.events || []).filter((e) => canViewEvent(e, { viewerId: meUser.id, friendIds: ctx.friendIds, blockedIds: blocked })));
  return `<div class="page">
    <div class="row"><h2 class="grow">📅 ${t('events')}</h2><button class="btn btn-primary" data-act="create-event">+ ${t('createEvent')}</button></div>
    <h3>${t('upcomingEvents')} (${visible.length})</h3>
    ${visible.map((e) => eventCardHtml(d, meUser, e, ctx)).join('') || emptyState('📅', t('noEvents'))}
  </div>`;
}

export function eventView(d, meUser, eventId) {
  const e = (d.events || []).find((x) => x.id === eventId);
  const ctx = viewCtx(d, meUser);
  const blocked = blockedIdsOfData(d, meUser.id);
  if (!e || !canViewEvent(e, { viewerId: meUser.id, friendIds: ctx.friendIds, blockedIds: blocked })) return emptyState('📅', 'This event could not be found.');
  const byId = ctx.usersById;
  const isCreator = e.createdBy === meUser.id;
  const going = (e.going || []).includes(meUser.id);
  const interested = (e.interested || []).includes(meUser.id);
  const when = new Date(e.dateTime || 0).toLocaleString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const personList = (ids) => (ids || []).map((id) => byId[id] ? `<div class="row gap-sm">${avatarHtml(byId[id], 32)}<a href="#/profile/${id}">${escapeHtml(byId[id].name)}</a></div>` : '').join('') || '<p class="muted small">—</p>';
  return `<div class="profile-wrap">
    <div class="card profile-head">
      <div class="cover" style="${e.cover ? `background-image:url('${escapeHtml(e.cover)}')` : ''}"></div>
      <div class="profile-meta">
        ${eventDateBlock(e.dateTime)}
        <div class="grow">
          <h2>${escapeHtml(e.title)}</h2>
          <p class="muted">🕒 ${escapeHtml(when)}${e.location ? `<br/>📍 ${escapeHtml(e.location)}` : ''}</p>
          <p class="muted small">${e.visibility === 'friends' ? '👥 ' + t('friends') : '🌍 ' + t('publicLabel')}</p>
          ${byId[e.createdBy] ? `<div class="row gap-sm host-row">${avatarHtml(byId[e.createdBy], 32)}<span>${t('hostedBy')} <a href="#/profile/${e.createdBy}"><b>${escapeHtml(byId[e.createdBy].name)}</b></a></span></div>` : ''}
        </div>
        <div class="row gap wrap">
          ${isCreator ? `<button class="btn btn-danger" data-act="delete-event" data-id="${e.id}">${t('delete')} event</button>` : ''}
        </div>
      </div>
    </div>
    <div class="card stack">
      <div class="row gap wrap">
        <button class="btn ${going ? 'btn-primary' : 'btn-ghost'}" data-act="rsvp" data-kind="going" data-id="${e.id}">✓ ${t('going')} (${(e.going || []).length})</button>
        <button class="btn ${interested ? 'btn-primary' : 'btn-ghost'}" data-act="rsvp" data-kind="interested" data-id="${e.id}">⭐ ${t('interested')} (${(e.interested || []).length})</button>
      </div>
      ${e.description ? `<p>${escapeHtml(e.description)}</p>` : ''}
    </div>
    <div class="card stack">
      <h3>${t('attendees')}</h3>
      <h4>${t('going')} (${(e.going || []).length})</h4>
      ${personList(e.going)}
      <h4>${t('interested')} (${(e.interested || []).length})</h4>
      ${personList(e.interested)}
    </div>
  </div>`;
}

export function eventFormHtml() {
  // datetime-local needs a value in local time; leave empty and let the
  // browser picker fill it (required).
  return `<h3>📅 ${t('createEvent')}</h3>
  <form id="event-form" class="stack">
    <label>${t('eventTitle')}<input name="title" required maxlength="120" /></label>
    <label>${t('description')}<textarea name="description" rows="3" maxlength="1000"></textarea></label>
    <label>${t('eventDate')}<input name="dateTime" type="datetime-local" required /></label>
    <label>${t('eventLocation')}<input name="location" maxlength="120" placeholder="e.g. TSC, University of Dhaka" /></label>
    <label>Cover photo<input type="file" name="cover" accept="image/*" /></label>
    <label>${t('privacyLabel')}
      <select name="visibility">
        <option value="public">🌍 ${t('publicLabel')}</option>
        <option value="friends">👥 ${t('friends')}</option>
      </select>
    </label>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${t('createEvent')}</button></div>
  </form>`;
}

// ------------------------------------------------------------------ MESSAGES
export function messagesView(d, meUser, activeConvId = '') {
  const byId = usersById(d);
  const myConvs = d.conversations.filter((c) => c.participants.includes(meUser.id))
    .map((c) => {
      const isGroup = Boolean(c.isGroup);
      const otherId = c.participants.find((p) => p !== meUser.id);
      const msgs = d.messages.filter((m) => m.conversationId === c.id).sort((a, b) => a.createdAt - b.createdAt);
      const last = msgs[msgs.length - 1];
      const unread = msgs.filter((m) => m.senderId !== meUser.id && !(m.readBy || []).includes(meUser.id)).length;
      const title = isGroup ? (c.title || t('groupChat')) : (byId[otherId]?.name || 'Unknown');
      const avatarUser = isGroup ? { name: title, username: title, avatar: '' } : byId[otherId];
      let preview = 'Say hello';
      if (last) preview = last.audio && !last.text ? `🎤 ${t('voiceMessage')}` : (last.text || (last.image ? '📷 Photo' : 'Say hello'));
      if (isGroup && last && last.senderId !== meUser.id) preview = `${(byId[last.senderId]?.name || '').split(' ')[0]}: ${preview}`;
      return { conv: c, isGroup, other: byId[otherId], title, avatarUser, searchText: title.toLowerCase(), last, unread, msgs, preview };
    })
    .sort((a, b) => (b.last?.createdAt || b.conv.createdAt) - (a.last?.createdAt || a.conv.createdAt));
  const active = myConvs.find((x) => x.conv.id === activeConvId) || myConvs[0];
  return `<div class="messenger card ${activeConvId ? 'has-open' : ''}">
    <div class="conv-list">
      <div class="row gap-sm"><h3 class="grow">💬 ${t('messages')}</h3><button class="btn btn-primary btn-sm" data-act="create-group-chat">👥 ${t('newGroupChat')}</button></div>
      <input id="conv-search" class="conv-search" type="search" placeholder="${t('searchConversations')}" autocomplete="off" aria-label="${t('searchConversations')}" />
      ${myConvs.map((x) => `<button class="conv-item ${active?.conv.id === x.conv.id ? 'active' : ''}" data-act="open-conv" data-id="${x.conv.id}" data-search="${escapeHtml(x.searchText)}">
        ${avatarHtml(x.avatarUser, 44)}<span class="grow left"><b>${x.isGroup ? '👥 ' : ''}${escapeHtml(x.title)}</b> ${!x.isGroup && x.other?.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''}<br/><span class="muted small">${escapeHtml(x.preview.slice(0, 42))}</span></span>
        ${x.unread ? `<span class="unread-badge">${x.unread}</span>` : ''}
      </button>`).join('') || `<p class="muted small">${t('noMessages')}</p>
      <div class="stack"><h4>Start a chat</h4>${d.users.filter((u) => u.id !== meUser.id).slice(0, 6).map((u) => `<button class="conv-item" data-act="message-user" data-id="${u.id}">${avatarHtml(u, 36)}<span>${escapeHtml(u.name)}</span>${u.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''}</button>`).join('')}</div>`}
    </div>
    <div class="conv-thread">
      ${active ? `
      <header class="thread-head"><a class="thread-back" href="#/messages" aria-label="Back to conversations">←</a>${avatarHtml(active.avatarUser, 40)}<div><b>${active.isGroup ? '👥 ' : ''}${escapeHtml(active.title)}</b><br/><span class="muted small">${active.isGroup ? `${active.conv.participants.length} ${t('members')}` : `${active.other?.online ? t('online') : t('offline')}${active.other?.isBot ? ' · AI Bot' : ''}`}</span></div>
      ${active.isGroup ? '' : `<span class="spacer"></span><button class="btn btn-ghost btn-sm" data-act="report-user" data-id="${active.other?.id}">🚩</button>`}</header>
      <div class="thread-body" id="thread-body">
        ${active.msgs.map((m) => messageHtml(m, meUser, byId, active.isGroup)).join('') || '<p class="muted center">No messages yet. Say hello 👋</p>'}
      </div>
      <form id="message-form" data-conv="${active.conv.id}" class="message-form">
        <input type="file" name="image" accept="image/*" hidden />
        <button type="button" class="btn btn-ghost btn-sm" data-act="pick-photo" title="Photo" aria-label="Photo">📷</button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="emoji-toggle" title="Emoji" aria-label="Emoji">😊</button>
        <input name="text" placeholder="Type a message…" autocomplete="off" maxlength="2000" />
        <button type="button" class="btn btn-ghost btn-sm" id="voice-btn" data-act="voice-toggle" title="${t('voiceMessage')}" aria-label="${t('voiceMessage')}">🎤</button>
        <button class="btn btn-primary" type="submit">${t('send')}</button>
      </form>
      <div id="emoji-panel" class="emoji-panel hidden">
        ${CHAT_EMOJIS.map((e) => `<button type="button" class="emoji-btn" data-emoji-insert="${e}" aria-label="Insert ${e}">${e}</button>`).join('')}
      </div>
      <div id="voice-ui" class="voice-ui hidden">
        <span class="voice-dot"></span><span id="voice-time" class="mono">0:00</span><span class="grow small">${t('recording')}…</span>
        <button class="btn btn-ghost btn-sm" data-act="voice-cancel">✕ ${t('cancel')}</button>
        <button class="btn btn-primary btn-sm" data-act="voice-send">${t('send')}</button>
      </div>` : `<div class="empty-state"><div class="empty-icon">💬</div><p class="muted">${t('selectConversation')}</p></div>`}
    </div>
  </div>`;
}

// Emoji set for the Messenger picker (~24 common ones).
const CHAT_EMOJIS = ['😀', '😂', '🤣', '😍', '🥰', '😊', '😎', '🤔', '😴', '😢', '😮', '😅', '😭', '👍', '👏', '🙏', '❤️', '🔥', '🎉', '✨', '🌙', '☕', '🍰', '📷'];

function messageHtml(m, meUser, byId, isGroup = false) {
  const mine = m.senderId === meUser.id;
  // Own-message status as words (Facebook-style): "Seen" once any other
  // participant has it in readBy / the status flipped to read, else "Sent".
  const seen = m.status === 'read' || (m.readBy || []).length > 1;
  const status = mine ? (seen ? `✓✓ ${t('seen')}` : `✓ ${t('sent')}`) : '';
  return `<div class="msg-row ${mine ? 'mine' : ''}">
    ${mine ? '' : avatarHtml(byId[m.senderId], 28)}
    <div class="msg-bubble ${mine ? 'mine' : ''}">
      ${isGroup && !mine ? `<span class="msg-sender">${escapeHtml(byId[m.senderId]?.name || '')}</span>` : ''}
      ${m.image ? `<img class="msg-image" src="${escapeHtml(m.image)}" alt="Shared photo" loading="lazy" />` : ''}
      ${m.audio ? `<audio class="msg-audio" controls preload="metadata" src="${escapeHtml(m.audio)}"></audio>` : ''}
      ${m.text ? `<p>${escapeHtml(m.text)}</p>` : ''}
      <span class="msg-meta">${timeAgo(m.createdAt)} ${status}</span>
    </div>
  </div>`;
}

// Pick-friends form for a new group conversation (accepted friends only).
export function groupChatFormHtml(d, meUser) {
  const byId = usersById(d);
  const friends = [...friendIdsOfData(d, meUser.id)].map((id) => byId[id]).filter(Boolean);
  return `<h3>👥 ${t('newGroupChat')}</h3>
  <form id="group-chat-form" class="stack">
    <label>${t('groupChat')}<input name="title" maxlength="60" placeholder="e.g. Weekend Plans" /></label>
    <div class="stack group-pick-list">
      ${friends.length ? friends.map((u) => `<label class="row gap-sm"><input type="checkbox" name="member" value="${u.id}" /> ${avatarHtml(u, 30)}<span>${escapeHtml(u.name)}</span></label>`).join('') : `<p class="muted small">${t('noFriendsForGroupChat')}</p><div><a class="btn btn-primary btn-sm" href="#/friends" data-close>🔍 ${t('findFriends')}</a></div>`}
    </div>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${t('newGroupChat')}</button></div>
  </form>`;
}

// ------------------------------------------------------------------ NOTIFICATIONS
export function notificationsView(d, meUser) {
  const byId = usersById(d);
  const mine = d.notifications.filter((n) => n.userId === meUser.id).sort((a, b) => b.createdAt - a.createdAt);
  const icons = { friend_request: '👥', friend_accept: '✅', like: '❤️', comment: '💬', reply: '↩️', message: '✉️', mention: '@', share: '🔁', follow: '➕', group_join: '🏘️', page_follow: '📄', group_request: '📥', group_request_result: '🏘️', event_rsvp: '📅' };
  return `<div class="page narrow">
    <div class="row"><h2 class="grow">🔔 ${t('notifications')}</h2><button class="btn btn-ghost btn-sm" data-act="notif-read-all">Mark all read</button></div>
    ${mine.map((n) => `<button class="card notif ${n.read ? '' : 'unread'}" data-act="notif-open" data-id="${n.id}" data-post="${n.postId || ''}" data-conv="${n.conversationId || ''}">
      ${avatarHtml(byId[n.actorId], 40)}<span class="grow left">${icons[n.type] || '🔔'} ${escapeHtml(n.text)}<br/><span class="muted small">${timeAgo(n.createdAt)}</span></span>
    </button>`).join('') || emptyState('🔔', t('noNotifications'))}
  </div>`;
}

// ------------------------------------------------------------------ SEARCH
export function searchView(d, meUser, queryText) {
  const q = String(queryText || '').trim().toLowerCase();
  const byId = usersById(d);
  const blocked = blockedIdsOfData(d, meUser.id);
  const users = q ? d.users.filter((u) => !blocked.has(u.id) && (u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))) : [];
  const friendIds = friendIdsOfData(d, meUser.id);
  const posts = q ? d.posts.filter((p) => !p.groupId && p.text.toLowerCase().includes(q) && canViewPost(p, { viewerId: meUser.id, friendIds, blockedIds: blocked })).sort((a, b) => b.createdAt - a.createdAt) : [];
  const ctx = viewCtx(d, meUser);
  return `<div class="page">
    <h2>🔎 Search ${q ? `for “${escapeHtml(queryText)}”` : ''}</h2>
    <form id="search-page-form" class="search-box search-page-form" role="search">
      <input name="q" placeholder="${t('searchPlaceholder')}" value="${escapeHtml(queryText || '')}" autocomplete="off" />
      <button class="btn btn-primary" type="submit">Search</button>
    </form>
    <h3>People</h3>
    <div class="grid-people">${users.map((u) => {
      const rel = d.friendships.find((f) => (f.from === meUser.id && f.to === u.id) || (f.from === u.id && f.to === meUser.id));
      const mutual = mutualFriendCount(d.friendships, meUser.id, u.id);
      let action = '';
      if (u.id === meUser.id) action = '';
      else if (u.isBot) action = `<button class="btn btn-ghost btn-sm" data-act="message-user" data-id="${u.id}">Chat with bot</button>`;
      else if (rel?.status === 'accepted') action = `<span class="badge badge-ok">✓ ${t('friendsLabel')}</span>`;
      else if (rel?.status === 'pending' && rel.from === meUser.id) action = `<button class="btn btn-ghost btn-sm" data-act="cancel-request" data-id="${rel.id}" title="${t('tapToCancel')}">✓ ${t('requestSent')}</button>`;
      else if (rel?.status === 'pending') action = `<button class="btn btn-primary btn-sm" data-act="accept-request" data-id="${rel.id}">Accept request</button>`;
      else action = `<button class="btn btn-primary btn-sm" data-act="send-request" data-id="${u.id}">${t('addFriend')}</button>`;
      return `<div class="card person-card">${avatarHtml(u, 56)}<a href="#/profile/${u.id}"><b>${escapeHtml(u.name)}</b></a><span class="muted small">@${escapeHtml(u.username)}</span>${mutual > 0 ? `<span class="muted small">${mutual} ${mutual === 1 ? t('mutualFriend') : t('mutualFriends')}</span>` : ''}${u.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''}${action ? `<div class="row gap wrap center">${action}</div>` : ''}</div>`;
    }).join('') || '<p class="muted">No people matched.</p>'}</div>
    <h3>Posts</h3>
    ${posts.map((p) => postCardHtml(p, ctx)).join('') || '<p class="muted">No posts matched.</p>'}
    <p class="muted small">Searched as ${escapeHtml(byId[meUser.id]?.name || '')} — private content you cannot access is never shown.</p>
  </div>`;
}

// ------------------------------------------------------------------ SAVED
export function savedView(d, meUser) {
  const ctx = viewCtx(d, meUser);
  const blocked = blockedIdsOfData(d, meUser.id);
  const posts = d.posts.filter((p) => (p.savedBy || []).includes(meUser.id)
    && (!p.groupId || canViewGroupPost(p, ctx.groupsById[p.groupId], meUser.id, blocked))).sort((a, b) => b.createdAt - a.createdAt);
  return `<div class="page narrow"><h2>🔖 ${t('saved')} posts</h2>${posts.map((p) => postCardHtml(p, ctx)).join('') || emptyState('🔖', 'Posts you save will appear here.')}</div>`;
}

// ------------------------------------------------------------------ SETTINGS
export function settingsView(d, meUser, prefs) {
  const np = meUser.settings?.notifPrefs || {};
  const defaultPrivacy = meUser.settings?.defaultPostPrivacy || 'public';
  const prefLabels = {
    friend_request: t('prefFriendRequest'), like: t('prefLike'), comment: t('prefComment'),
    reply: t('prefReply'), message: t('prefMessage'), mention: t('prefMention'), follow: t('prefFollow')
  };
  const types = Object.keys(prefLabels);
  return `<div class="page narrow">
    <h2>⚙️ ${t('settings')}</h2>
    <div class="card stack">
      <h3>${t('settingsAccount')}</h3>
      <p><b>${escapeHtml(meUser.name)}</b> · @${escapeHtml(meUser.username)}<br/><span class="muted">${escapeHtml(meUser.email || '')}</span></p>
      <div class="row gap wrap">
        <button class="btn btn-ghost" data-act="edit-profile">✏️ ${t('editProfile')}</button>
        <button class="btn btn-ghost" data-act="change-password">✉️ ${t('sendResetEmail')}</button>
        <button class="btn btn-ghost settings-logout" data-act="logout">🚪 ${t('logout')}</button>
        <button class="btn btn-danger" data-act="delete-account">${t('deleteAccount')}</button>
      </div>
    </div>
    <div class="card stack">
      <h3>${t('settingsAppearance')}</h3>
      <div class="row gap wrap">
        <button class="btn btn-ghost" data-act="toggle-theme">${prefs.theme === 'dark' ? '☀️ ' + t('lightMode') : '🌙 ' + t('darkMode')}</button>
        <label>${t('languageLabel')}
          <select id="locale-select" class="select-sm">
            <option value="en" ${prefs.locale === 'en' ? 'selected' : ''}>English</option>
            <option value="bn" ${prefs.locale === 'bn' ? 'selected' : ''}>বাংলা</option>
          </select>
        </label>
      </div>
    </div>
    <div class="card stack">
      <h3>${t('settingsNotifications')}</h3>
      <form id="notif-prefs-form" class="stack">
        ${types.map((type) => `<label class="notif-pref-row"><span class="grow">${prefLabels[type]}</span><input type="checkbox" name="${type}" ${np[type] === false ? '' : 'checked'} /></label>`).join('')}
        <label class="notif-pref-row"><span class="grow">🔔 ${t('browserNotifications')}</span><input type="checkbox" name="browserNotifications" ${meUser.settings?.browserNotifications ? 'checked' : ''} /></label>
        <p class="muted small">${t('browserNotificationsHelp')}</p>
        <div><button class="btn btn-primary btn-sm" type="submit">${t('savePreferences')}</button></div>
      </form>
    </div>
    <div class="card stack">
      <h3>${t('settingsPrivacy')}</h3>
      <form id="privacy-prefs-form" class="stack">
        <label>${t('defaultPostPrivacy')}
          <select name="defaultPostPrivacy">
            <option value="public" ${defaultPrivacy === 'public' ? 'selected' : ''}>🌍 Public</option>
            <option value="friends" ${defaultPrivacy === 'friends' ? 'selected' : ''}>👥 Friends</option>
            <option value="close" ${defaultPrivacy === 'close' ? 'selected' : ''}>⭐ ${t('closeFriends')}</option>
            <option value="only-me" ${defaultPrivacy === 'only-me' ? 'selected' : ''}>🔒 Only me</option>
          </select>
        </label>
        <div><button class="btn btn-primary btn-sm" type="submit">${t('savePrivacy')}</button></div>
      </form>
      <p class="muted">${t('blockedHelp')}</p>
      ${(d.blocks || []).filter((b) => b.by === meUser.id).map((b) => `<div class="row gap-sm">${avatarHtml(usersById(d)[b.target], 32)}<span class="grow">${escapeHtml(usersById(d)[b.target]?.name || '')}</span><button class="btn btn-ghost btn-sm" data-act="block" data-id="${b.target}">${t('unblock')}</button></div>`).join('') || `<p class="muted small">${t('noBlocked')}</p>`}
      <div class="row gap wrap">
        <a class="btn btn-ghost btn-sm" href="#/privacy">Privacy Policy</a>
        <a class="btn btn-ghost btn-sm" href="#/terms">Terms of Service</a>
        <a class="btn btn-ghost btn-sm" href="#/guidelines">Community Guidelines</a>
        <a class="btn btn-ghost btn-sm" href="#/help">${t('help')}</a>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ ADMIN
export function adminView(d, meUser, mode) {
  const byId = usersById(d);
  const openReports = d.reports.filter((r) => r.status === 'open');
  const today = new Date().toDateString();
  const postsToday = d.posts.filter((p) => new Date(p.createdAt).toDateString() === today).length;
  return `<div class="page">
    <h2>🛡️ Admin Dashboard</h2>
    <div class="stat-grid">
      <div class="card stat"><b>${d.users.filter((u) => !u.isBot).length}</b><span>Users</span></div>
      <div class="card stat"><b>${d.bots.length}</b><span>AI Bots</span></div>
      <div class="card stat"><b>${d.posts.length}</b><span>Posts (${postsToday} today)</span></div>
      <div class="card stat"><b>${openReports.length}</b><span>Open reports</span></div>
      <div class="card stat"><b>${d.messages.length}</b><span>Messages</span></div>
      <div class="card stat"><b>${d.aiUsage?.callsToday || 0}</b><span>AI calls today</span></div>
    </div>
    <div class="card stack">
      <h3>System status</h3>
      <p>Mode: <b>${mode.firebase ? 'Live Firebase' : 'Demo / offline'}</b> · Project: <b>${escapeHtml(mode.projectId)}</b> · Auth: ${mode.firebase ? 'Firebase Authentication' : 'Local demo accounts'} · Firestore: ${mode.firebase ? 'connected' : 'local store'} · Storage: ${mode.firebase ? 'Storage with compressed data-URL fallback (Blaze enables full Storage)' : 'local data URLs'}</p>
      <label class="row gap-sm"><input type="checkbox" id="maintenance-toggle" ${d.config?.maintenanceMode ? 'checked' : ''} /> <span class="grow">Maintenance mode (shows a maintenance banner to non-admin users)</span></label>
      <div class="row gap wrap"><a class="btn btn-primary btn-sm" href="#/bots">🤖 Open Bot Admin Panel</a><button class="btn btn-ghost btn-sm" data-act="reset-demo">Reset demo data</button></div>
      <p class="muted small">Admin rights are enforced server-side: Firestore rules check users/{uid}.role and Cloud Functions verify admin before privileged actions. This page is only the interface.</p>
    </div>
    <div class="card stack">
      <h3>Reports queue (${openReports.length} open)</h3>
      ${d.reports.map((r) => `<div class="row gap-sm wrap"><span class="badge ${r.status === 'open' ? 'badge-warn' : ''}">${escapeHtml(r.status)}</span><span class="grow">${escapeHtml(r.targetType)} · ${escapeHtml(r.reason)} · by ${escapeHtml(byId[r.reporterId]?.name || '')} · ${timeAgo(r.createdAt)}</span>${r.status === 'open' ? `<button class="btn btn-danger btn-sm" data-act="report-action" data-id="${r.id}" data-action="remove-post">Remove post</button><button class="btn btn-ghost btn-sm" data-act="report-action" data-id="${r.id}" data-action="dismiss">Dismiss</button>` : ''}</div>`).join('') || '<p class="muted">No reports.</p>'}
    </div>
    <div class="card stack">
      <h3>User management</h3>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>User</th><th>Username</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${d.users.map((u) => `<tr>
          <td>${avatarHtml(u, 28)} ${escapeHtml(u.name)} ${u.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''}</td>
          <td>@${escapeHtml(u.username)}</td><td>${escapeHtml(u.role)}</td><td>${u.online ? 'online' : 'offline'}</td>
          <td>${u.id !== meUser.id && !u.isBot ? `<button class="btn btn-ghost btn-sm" data-act="admin-role" data-id="${u.id}" data-role="${u.role === 'admin' ? 'user' : 'admin'}">${u.role === 'admin' ? 'Make user' : 'Make admin'}</button>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="card stack">
      <h3>Post moderation (recent)</h3>
      ${[...d.posts].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10).map((p) => `<div class="row gap-sm"><span class="grow">${escapeHtml(p.text.slice(0, 90))} <span class="muted small">— ${escapeHtml(byId[p.authorId]?.name || '')}</span></span><button class="btn btn-danger btn-sm" data-act="admin-delete-post" data-id="${p.id}">Remove</button></div>`).join('') || '<p class="muted">No posts.</p>'}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ BOTS ADMIN
export function botsView(d, meUser) {
  const globalOn = d.botSettings?.global?.enabled !== false;
  return `<div class="page">
    <h2>🤖 AI Bot Admin Panel</h2>
    <div class="card stack">
      <div class="row gap wrap">
        <span class="grow"><b>Global bot kill switch</b><br/><span class="muted small">When off, no bot may post, comment, like or message — enforced in the bot engine and Cloud Functions.</span></span>
        <button class="btn ${globalOn ? 'btn-danger' : 'btn-primary'}" data-act="bot-kill-switch" data-on="${globalOn ? '0' : '1'}">${globalOn ? '⛔ Stop all bots' : '▶️ Enable bots'}</button>
        <button class="btn btn-ghost" data-act="bot-run-cycle">Run one demo cycle</button>
        <button class="btn btn-primary" data-act="bot-new">+ Create bot</button>
      </div>
      <p class="muted small">Status: <b>${globalOn ? 'ENABLED' : 'STOPPED'}</b> · AI usage today: ${d.aiUsage?.callsToday || 0} calls · ~${d.aiUsage?.tokensToday || 0} tokens (template fallback uses 0 provider tokens).</p>
    </div>
    ${d.bots.map((b) => botCardHtml(d, b)).join('') || emptyState('🤖', 'No bots yet. Create your first AI bot.')}
    <div class="card stack">
      <h3>Recent bot activity</h3>
      ${d.botActivities.slice(0, 15).map((a) => `<p class="small">• <b>${escapeHtml(d.bots.find((x) => x.id === a.botId)?.name || a.botId)}</b> ${escapeHtml(a.action)} — ${escapeHtml(a.detail || '')} <span class="muted">${timeAgo(a.createdAt)} · ${escapeHtml(a.status || '')}</span></p>`).join('') || '<p class="muted">No activity yet.</p>'}
      <h3>Bot logs</h3>
      ${d.botLogs.slice(0, 10).map((l) => `<p class="small mono">[${escapeHtml(l.level)}] ${escapeHtml(l.message)} <span class="muted">${timeAgo(l.createdAt)}</span></p>`).join('') || '<p class="muted">No logs.</p>'}
    </div>
  </div>`;
}

function botCardHtml(d, b) {
  const memories = d.botMemories?.[b.id] || [];
  const acts = d.botActivities.filter((a) => a.botId === b.id);
  const errors = d.botLogs.filter((l) => l.botId === b.id && l.level === 'error');
  return `<div class="card stack bot-card" data-bot="${b.id}">
    <div class="row gap wrap">
      ${avatarHtml(d.users.find((u) => u.id === b.id) || { name: b.name, username: b.username, avatar: b.avatar }, 52)}
      <div class="grow"><b>${escapeHtml(b.name)}</b> <span class="badge badge-bot">${t('aiBot')}</span> <span class="badge ${b.active ? 'badge-ok' : 'badge-warn'}">${b.active ? 'Active' : 'Inactive'}</span><br/>
      <span class="muted small">@${escapeHtml(b.username)} · traits: ${escapeHtml(b.personality.traits.join(', '))} · tone: ${escapeHtml(b.personality.tone)} · interests: ${escapeHtml(b.personality.interests.join(', '))}</span></div>
      <button class="btn btn-ghost btn-sm" data-act="bot-toggle" data-id="${b.id}">${b.active ? 'Deactivate' : 'Activate'}</button>
      <button class="btn btn-ghost btn-sm" data-act="bot-edit" data-id="${b.id}">Configure</button>
      <button class="btn btn-danger btn-sm" data-act="bot-delete" data-id="${b.id}">${t('delete')}</button>
    </div>
    <p class="small"><b>System prompt:</b> ${escapeHtml(b.personality.systemPrompt)}</p>
    <p class="small muted">Limits/day — posts ${b.limits.postsPerDay}, comments ${b.limits.commentsPerDay}, likes ${b.limits.likesPerDay}, messages ${b.limits.messagesPerDay} · Activity records: ${acts.length} · Errors: ${errors.length}</p>
    <details><summary>Memory (${memories.length}) — this bot's own memory only</summary>
      ${memories.map((m) => `<div class="row gap-sm"><span class="grow small">${m.pinned ? '📌 ' : ''}${escapeHtml(m.text)}</span><button class="btn btn-ghost btn-sm" data-act="bot-memory-delete" data-bot="${b.id}" data-id="${m.id}">✕</button></div>`).join('') || '<p class="muted small">No memories yet.</p>'}
      <form class="row gap-sm" data-bot-memory-form="${b.id}"><input name="text" class="grow" placeholder="Add a memory for this bot…" maxlength="300" /><button class="btn btn-primary btn-sm" type="submit">Add</button></form>
    </details>
  </div>`;
}

export function botFormHtml(bot = null) {
  const b = bot || { name: '', username: '', bio: '', personality: { traits: [], tone: '', interests: [], systemPrompt: '' }, limits: { postsPerDay: 3, commentsPerDay: 10, likesPerDay: 20, messagesPerDay: 5 } };
  return `<h3>${bot ? 'Configure bot' : 'Create AI bot'}</h3>
  <form id="bot-form" data-id="${bot?.id || ''}" class="stack">
    <label>Name<input name="name" required maxlength="40" value="${escapeHtml(b.name)}" /></label>
    <label>Username<input name="username" required maxlength="24" value="${escapeHtml(b.username)}" placeholder="name.bot" /></label>
    <label>Bio<input name="bio" maxlength="160" value="${escapeHtml(b.bio)}" /></label>
    <label>Personality traits (comma separated)<input name="traits" value="${escapeHtml(b.personality.traits.join(', '))}" /></label>
    <label>Tone<input name="tone" value="${escapeHtml(b.personality.tone)}" /></label>
    <label>Interests (comma separated)<input name="interests" value="${escapeHtml(b.personality.interests.join(', '))}" /></label>
    <label>Individual system prompt<textarea name="systemPrompt" rows="4" maxlength="1000">${escapeHtml(b.personality.systemPrompt)}</textarea></label>
    <div class="row gap wrap">
      <label>Posts/day<input name="postsPerDay" type="number" min="0" max="50" value="${b.limits.postsPerDay}" /></label>
      <label>Comments/day<input name="commentsPerDay" type="number" min="0" max="100" value="${b.limits.commentsPerDay}" /></label>
      <label>Likes/day<input name="likesPerDay" type="number" min="0" max="200" value="${b.limits.likesPerDay}" /></label>
      <label>Messages/day<input name="messagesPerDay" type="number" min="0" max="50" value="${b.limits.messagesPerDay}" /></label>
    </div>
    <p class="muted small">This bot will always be labelled “AI Bot” and gets its own brain, prompt and memory.</p>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${bot ? 'Save bot' : 'Create bot'}</button></div>
  </form>`;
}

// ------------------------------------------------------------------ STATIC PAGES
const STATIC = {
  help: { title: '❓ Help & FAQ', body: [
    ['How do I create an account?', 'Use “Create account” with your name, a unique username, email and password — or continue with Google when Firebase is configured.'],
    ['What are AI Bots?', 'MeetBook includes AI bot members. They are always labelled “AI Bot”, have their own personalities and memories, and are managed from the Bot Admin Panel by administrators. They never pretend to be human.'],
    ['How do I report something?', 'Open the ••• menu on any post and choose Report, or use the report button on a profile. Administrators review reports in the Admin Dashboard.'],
    ['How do posts\' privacy work?', 'Choose Public, Friends or Only me when posting. Friends-only posts are visible only to your accepted friends; Only-me posts only to you.'],
    ['I forgot my password', 'On the login screen choose “Forgot password?”. With Firebase configured you will receive a reset email.'],
    ['Is my data private?', 'Private conversations are only visible to their participants, enforced by security rules in live mode. See the Privacy Policy for details.']
  ]},
  guidelines: { title: '📜 Community Guidelines', body: [
    ['Be kind', 'Treat people — and bots — with respect. Disagreement is fine; harassment, hate speech, threats, bullying and targeted abuse are not. If someone is bothering you, block them and report the content — admins review reports.'],
    ['Post responsibly', 'Do not post illegal content, graphic violence, or other people\'s private information such as addresses, phone numbers or passwords. Never post sexual content involving minors — zero tolerance: such accounts are removed immediately.'],
    ['No spam or deception', 'Do not impersonate another person, brand or the MeetBook team, spread scams or fake giveaways, or post repetitive promotional content. AI bots are always labelled as bots and never pretend to be human.'],
    ['Groups and pages', 'Group admins and page owners moderate their own spaces. Private groups carry an expectation of privacy — do not redistribute private group content outside the group without consent.'],
    ['Enforcement', 'Content that breaks these guidelines may be hidden or removed, and repeat or serious violations can lead to account suspension. If you think a decision was wrong, contact us through the Help page.']
  ]},
  terms: { title: '📄 Terms of Service', body: [
    ['The service', 'MeetBook is a social networking platform for connecting with people you know: sharing posts and photos, joining groups and pages, following events and chatting. By creating an account or using the service, you agree to these terms. The service is provided "as is" without warranties, and features may change, be added or be removed over time.'],
    ['Your account', 'You are responsible for the activity on your account and for keeping your password secret. Register with accurate information, use one account per person, and let us know if you believe your account has been compromised. You must be old enough to use online social services in your country.'],
    ['Your content', 'You keep ownership of the posts, photos and messages you create. By posting, you grant MeetBook a licence to store and display your content to the audiences you choose with your privacy settings. You can delete your content at any time; copies may remain in backups for a short period.'],
    ['Acceptable use', 'Do not post illegal content, harass or impersonate others, share someone else\'s private information, post spam or scams, or attempt to break the security of the service. Content or accounts that break these rules may be removed, and accounts may be suspended.'],
    ['AI bots', 'Some accounts are AI bots, clearly labelled at all times. Bot content is generated automatically, may occasionally be inaccurate, and bots never pretend to be human. Administrators can disable bots at any time.'],
    ['Termination', 'Accounts that violate the Community Guidelines may be suspended or removed. You may delete your account at any time from Settings. These terms may be updated — continued use after a change means you accept the updated terms. Questions: see the Help page.']
  ]},
  privacy: { title: '🔒 Privacy Policy', body: [
    ['What we store', 'Account details (name, username, email), profile information (bio, photos, and date of birth and gender if you choose to add them), posts, comments, messages, friendships, group and page memberships, and notifications needed to run the platform.'],
    ['How it is used', 'Your information is used to operate MeetBook: showing your profile and posts to the audience you picked, delivering messages and notifications, suggesting people you may know, and keeping accounts safe. We do not sell your personal information and we do not show third-party advertising.'],
    ['Who can see it', 'Content follows the privacy setting you choose (public, friends, close friends or only you). Private groups are visible only to their members. Private messages are restricted to conversation participants by security rules. Your online status is shown to other signed-in users while you use the app.'],
    ['AI bots', 'Bot accounts are operated by the service and always labelled. Bots keep their own conversation memories to stay in character; bot memories are visible to administrators in the Bot Admin Panel. Do not share sensitive personal information with a bot.'],
    ['Your controls', 'Edit or delete your posts and profile at any time, block users, tune notification preferences, or delete your account from Settings. Deleting your account removes your profile and content from the service, subject to short backup retention.'],
    ['Demo mode', 'When the app runs in demo mode (no Firebase config), all data stays in your own browser\'s local storage and never leaves your device.']
  ]}
};

export function staticView(kind) {
  const page = STATIC[kind] || STATIC.help;
  return `<div class="page narrow"><div class="card stack"><h2>${page.title}</h2>
    ${page.body.map(([h, b]) => `<section><h4>${escapeHtml(h)}</h4><p class="muted">${escapeHtml(b)}</p></section>`).join('')}
  </div></div>`;
}

const RELATIONSHIP_OPTIONS = ['', 'Single', 'In a relationship', 'Engaged', 'Married', "It's complicated"];

export function editProfileHtml(user) {
  return `<h3>✏️ ${t('editProfile')}</h3>
  <form id="edit-profile-form" class="stack">
    <label>Name<input name="name" required maxlength="60" value="${escapeHtml(user.name)}" /></label>
    <label>Username<input name="username" required maxlength="24" value="${escapeHtml(user.username)}" /></label>
    <label>${t('nickname')}<input name="nickname" maxlength="40" value="${escapeHtml(user.nickname || '')}" /></label>
    <label>Bio<textarea name="bio" rows="3" maxlength="300">${escapeHtml(user.bio || '')}</textarea></label>
    <label>${t('work')}<input name="work" maxlength="100" value="${escapeHtml(user.work || '')}" /></label>
    <label>${t('education')}<input name="education" maxlength="100" value="${escapeHtml(user.education || '')}" /></label>
    <label>${t('currentCity')}<input name="currentCity" maxlength="80" value="${escapeHtml(user.currentCity || '')}" /></label>
    <label>${t('hometown')}<input name="hometown" maxlength="80" value="${escapeHtml(user.hometown || '')}" /></label>
    <label>${t('relationship')}
      <select name="relationship">
        ${RELATIONSHIP_OPTIONS.map((opt) => `<option value="${escapeHtml(opt)}" ${String(user.relationship || '') === opt ? 'selected' : ''}>${opt === '' ? '—' : escapeHtml(opt)}</option>`).join('')}
      </select>
    </label>
    <label>${t('dob')}<input name="dob" type="date" value="${escapeHtml(user.dob || '')}" /></label>
    <label>${t('gender')}
      <select name="gender">
        <option value="" ${!user.gender ? 'selected' : ''}>—</option>
        <option value="Female" ${user.gender === 'Female' ? 'selected' : ''}>${t('genderFemale')}</option>
        <option value="Male" ${user.gender === 'Male' ? 'selected' : ''}>${t('genderMale')}</option>
        <option value="Other" ${user.gender === 'Other' ? 'selected' : ''}>${t('genderOther')}</option>
        <option value="Prefer not to say" ${user.gender === 'Prefer not to say' ? 'selected' : ''}>${t('genderPreferNot')}</option>
      </select>
    </label>
    <label>${t('website')}<input name="website" type="text" maxlength="200" placeholder="https://example.com" value="${escapeHtml(user.website || '')}" /></label>
    <label>Profile picture<input type="file" name="avatar" accept="image/*" /></label>
    <label>Cover photo<input type="file" name="cover" accept="image/*" /></label>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save profile</button></div>
  </form>`;
}

export { friendIdsOf, blockedIdsOf };
