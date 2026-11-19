// HTML generators for every route. Pure string builders: they read the shared
// dataset (api.data()) and never touch the DOM directly — main.js renders
// and binds events centrally.
import { escapeHtml, timeAgo, canViewPost, canViewGroup, canViewGroupPost, isGroupMember, searchByName, truncate, paginate } from './utils.js';
import { t } from './i18n.js';
import { avatarHtml, userNameHtml, postCardHtml, emptyState } from './components.js';
import { friendIdsOf, blockedIdsOf } from './store.js';

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
export function authView(mode = 'login') {
  return `
  <div class="auth-wrap">
    <div class="auth-hero">
      <div class="logo-big">MeetBook</div>
      <p>Connect with friends, discover people, and meet friendly AI bots — clearly labelled, always.</p>
    </div>
    <div class="card auth-card">
      <div class="tabs">
        <button class="tab ${mode === 'login' ? 'active' : ''}" data-nav="#/login">${t('login')}</button>
        <button class="tab ${mode === 'register' ? 'active' : ''}" data-nav="#/register">${t('register')}</button>
      </div>
      ${mode === 'login' ? `
      <form id="login-form" class="stack">
        <label>Email<input name="email" type="email" required autocomplete="email" placeholder="you@example.com" /></label>
        <label>Password<input name="password" type="password" required autocomplete="current-password" placeholder="••••••••" /></label>
        <button class="btn btn-primary btn-block" type="submit">${t('login')}</button>
        <button class="btn btn-google btn-block" type="button" data-act="google-login">Continue with Google</button>
        <button class="link-btn center" type="button" data-act="forgot">Forgot password?</button>
        <p class="muted small center">Demo accounts (offline mode): admin@meetbook.app / admin123 · ayesha@example.com / demo123</p>
      </form>` : `
      <form id="register-form" class="stack">
        <label>Full name<input name="name" required maxlength="60" placeholder="Your name" /></label>
        <label>Username<input name="username" required maxlength="24" placeholder="your.name" /></label>
        <label>Email<input name="email" type="email" required autocomplete="email" placeholder="you@example.com" /></label>
        <label>Password<input name="password" type="password" required minlength="6" autocomplete="new-password" placeholder="At least 6 characters" /></label>
        <button class="btn btn-primary btn-block" type="submit">${t('register')}</button>
        <button class="btn btn-google btn-block" type="button" data-act="google-login">Continue with Google</button>
        <p class="muted small center">By registering you agree to our <a href="#/terms">Terms</a> and <a href="#/privacy">Privacy Policy</a>.</p>
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
  const stories = d.users.filter((u) => u.id !== meUser.id && !blocked.has(u.id)).slice(0, 8);
  return `
  <div class="layout">
    <aside class="col-left">${leftRail(d, meUser)}</aside>
    <main class="col-main">
      <div class="stories card">
        ${stories.map((u) => `<a class="story" href="#/profile/${u.id}">${avatarHtml(u, 52)}<span>${escapeHtml(u.name.split(' ')[0])}</span>${u.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''}</a>`).join('') || '<p class="muted">No one else here yet.</p>'}
      </div>
      <div class="card composer">
        <div class="row gap-sm">${avatarHtml(meUser, 40)}<span class="muted">${escapeHtml(meUser.name)}</span></div>
        <form id="composer-form" class="stack">
          <textarea name="text" rows="3" maxlength="2000" placeholder="${t('whatsOnYourMind')}"></textarea>
          <div id="composer-preview"></div>
          <div class="row gap wrap">
            <label class="btn btn-ghost btn-sm">📷 Photo<input type="file" name="image" accept="image/*" hidden /></label>
            <select name="visibility" class="select-sm" aria-label="Post privacy">
              <option value="public">🌍 Public</option>
              <option value="friends">👥 Friends</option>
              <option value="only-me">🔒 Only me</option>
            </select>
            <span class="spacer"></span>
            <button class="btn btn-primary" type="submit">${t('post')}</button>
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

export function leftRail(d, meUser) {
  return `<div class="card rail">
    <a class="rail-item" href="#/profile/${meUser.id}">${avatarHtml(meUser, 36)}<span>${escapeHtml(meUser.name)}</span></a>
    <a class="rail-item" href="#/">📰 Feed</a>
    <a class="rail-item" href="#/friends">👥 ${t('friends')}</a>
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
    ${suggestions.map((u) => `<div class="row gap-sm rail-person">${avatarHtml(u, 36)}<a class="grow" href="#/profile/${u.id}">${escapeHtml(u.name)}</a>${u.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : `<button class="btn btn-ghost btn-sm" data-act="send-request" data-id="${u.id}">${t('addFriend')}</button>`}</div>`).join('') || '<p class="muted small">No suggestions right now.</p>'}
    <h4>Online</h4>
    ${d.users.filter((u) => u.online && u.id !== meUser.id).slice(0, 6).map((u) => `<a class="row gap-sm rail-person" href="#/profile/${u.id}"><span class="online-dot"></span>${escapeHtml(u.name)}${u.isBot ? ` <span class="badge badge-bot">${t('aiBot')}</span>` : ''}</a>`).join('') || '<p class="muted small">Nobody online.</p>'}
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
      <div class="cover" style="${user.cover ? `background-image:url('${escapeHtml(user.cover)}')` : ''}"></div>
      <div class="profile-meta">
        ${avatarHtml(user, 110)}
        <div class="grow">
          <h2>${userNameHtml(user)}</h2>
          <p class="muted">@${escapeHtml(user.username)} · ${friendIds.size} friends · ${(user.followers || []).length} followers · <span class="${user.online ? 'online-text' : 'muted'}">${user.online ? '● ' + t('online') : t('offline')}</span></p>
          <p>${escapeHtml(user.bio || 'No bio yet.')}</p>
        </div>
        <div class="row gap wrap">
          ${isMe ? `<button class="btn btn-primary" data-act="edit-profile">✏️ ${t('edit')} profile</button>` : `
            ${blocked ? `<button class="btn btn-ghost" data-act="block" data-id="${user.id}">Unblock</button>` : `
              ${rel?.status === 'accepted' ? `<button class="btn btn-ghost" data-act="remove-friend" data-id="${rel.id}">✓ Friends</button>` : rel?.status === 'pending' && rel.from === meUser.id ? '<span class="badge">Request sent</span>' : rel?.status === 'pending' ? `<button class="btn btn-primary" data-act="accept-request" data-id="${rel.id}">Accept request</button>` : (!user.isBot ? `<button class="btn btn-primary" data-act="send-request" data-id="${user.id}">${t('addFriend')}</button>` : '')}
              <button class="btn ${following ? 'btn-ghost' : 'btn-primary'}" data-act="follow" data-id="${user.id}">${following ? t('following') : t('follow')}</button>
              <button class="btn btn-ghost" data-act="message-user" data-id="${user.id}">💬 Message</button>
              <button class="btn btn-ghost" data-act="block" data-id="${user.id}">Block</button>
              <button class="btn btn-ghost" data-act="report-user" data-id="${user.id}">🚩 ${t('report')}</button>`}
          `}
        </div>
      </div>
    </div>
    <div class="profile-posts">
      ${posts.map((p) => postCardHtml(p, ctx)).join('') || emptyState('📝', 'No visible posts yet.')}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ FRIENDS
export function friendsView(d, meUser) {
  const byId = usersById(d);
  const friendIds = friendIdsOfData(d, meUser.id);
  const incoming = d.friendships.filter((f) => f.to === meUser.id && f.status === 'pending');
  const outgoing = d.friendships.filter((f) => f.from === meUser.id && f.status === 'pending');
  const suggestions = suggestionsFor(d, meUser);
  const person = (u, actions) => `<div class="card person-card">${avatarHtml(u, 56)}<a href="#/profile/${u.id}"><b>${escapeHtml(u.name)}</b></a><span class="muted small">@${escapeHtml(u.username)}</span>${u.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''}<div class="row gap wrap center">${actions}</div></div>`;
  return `<div class="page">
    <h2>👥 ${t('friends')}</h2>
    ${incoming.length ? `<h3>Requests received</h3><div class="grid-people">${incoming.map((f) => person(byId[f.from], `<button class="btn btn-primary btn-sm" data-act="accept-request" data-id="${f.id}">Accept</button><button class="btn btn-ghost btn-sm" data-act="reject-request" data-id="${f.id}">Reject</button>`)).join('')}</div>` : ''}
    ${outgoing.length ? `<h3>Requests sent</h3><div class="grid-people">${outgoing.map((f) => person(byId[f.to], `<button class="btn btn-ghost btn-sm" data-act="remove-friend" data-id="${f.id}">Cancel request</button>`)).join('')}</div>` : ''}
    <h3>Your friends (${friendIds.size})</h3>
    <div class="grid-people">${[...friendIds].map((id) => { const rel = d.friendships.find((f) => f.status === 'accepted' && ((f.from === meUser.id && f.to === id) || (f.to === meUser.id && f.from === id))); return person(byId[id], `<button class="btn btn-ghost btn-sm" data-act="message-user" data-id="${id}">Message</button><button class="btn btn-ghost btn-sm" data-act="remove-friend" data-id="${rel?.id}">Remove</button>`); }).join('') || '<p class="muted">No friends yet — send a request below.</p>'}</div>
    <h3>Suggested for you</h3>
    <div class="grid-people">${suggestions.map((u) => person(u, u.isBot ? `<button class="btn btn-ghost btn-sm" data-act="message-user" data-id="${u.id}">Chat with bot</button>` : `<button class="btn btn-primary btn-sm" data-act="send-request" data-id="${u.id}">${t('addFriend')}</button>`)).join('') || '<p class="muted">No suggestions.</p>'}</div>
  </div>`;
}

// ------------------------------------------------------------------ GROUPS
export function groupsView(d, meUser, queryText = '') {
  const visible = (d.groups || []).filter((g) => canViewGroup(g, meUser.id));
  const mine = searchByName(visible.filter((g) => isGroupMember(g, meUser.id)), queryText);
  const discover = searchByName(visible.filter((g) => !isGroupMember(g, meUser.id)), queryText);
  const card = (g) => `<div class="card person-card">
    ${avatarHtml({ name: g.name, username: g.name, avatar: g.cover }, 56)}
    <a href="#/group/${g.id}"><b>${escapeHtml(g.name)}</b></a>
    <span class="muted small">${g.privacy === 'private' ? '🔒 ' + t('privateLabel') : '🌍 ' + t('publicLabel')} · ${(g.members || []).length} ${t('members')}</span>
    <span class="muted small">${escapeHtml(truncate(g.description || '', 90))}</span>
    <div class="row gap wrap center">
      ${isGroupMember(g, meUser.id) ? `<span class="badge badge-ok">${t('joined')}</span>` : `<button class="btn btn-primary btn-sm" data-act="toggle-group-join" data-id="${g.id}">${t('joinGroup')}</button>`}
      <a class="btn btn-ghost btn-sm" href="#/group/${g.id}">View</a>
    </div>
  </div>`;
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
  if (!group || !canViewGroup(group, meUser.id)) return emptyState('🏘️', 'This group could not be found.');
  const ctx = viewCtx(d, meUser);
  ctx.showGroupContext = false; // already inside the group — no context note
  const byId = ctx.usersById;
  const member = isGroupMember(group, meUser.id);
  const isCreator = group.createdBy === meUser.id;
  const blocked = blockedIdsOfData(d, meUser.id);
  const posts = d.posts
    .filter((p) => p.groupId === group.id && canViewGroupPost(p, group, meUser.id, blocked))
    .sort((a, b) => b.createdAt - a.createdAt);
  return `<div class="profile-wrap">
    <div class="card profile-head">
      <div class="cover" style="${group.cover ? `background-image:url('${escapeHtml(group.cover)}')` : ''}"></div>
      <div class="profile-meta">
        ${avatarHtml({ name: group.name, username: group.name, avatar: '' }, 110)}
        <div class="grow">
          <h2>${escapeHtml(group.name)}</h2>
          <p class="muted">${group.privacy === 'private' ? '🔒 ' + t('privateLabel') : '🌍 ' + t('publicLabel')} · ${(group.members || []).length} ${t('members')} · created by ${escapeHtml(byId[group.createdBy]?.name || '')}</p>
          <p>${escapeHtml(group.description || '')}</p>
        </div>
        <div class="row gap wrap">
          ${isCreator ? `<button class="btn btn-primary" data-act="edit-group" data-id="${group.id}">✏️ ${t('edit')}</button><button class="btn btn-danger" data-act="delete-group" data-id="${group.id}">${t('delete')} group</button>`
            : member ? `<button class="btn btn-ghost" data-act="toggle-group-join" data-id="${group.id}">${t('leaveGroup')}</button>`
            : `<button class="btn btn-primary" data-act="toggle-group-join" data-id="${group.id}">${t('joinGroup')}</button>`}
        </div>
      </div>
    </div>
    ${member ? `
    <div class="card composer">
      <div class="row gap-sm">${avatarHtml(meUser, 40)}<span class="muted">${escapeHtml(meUser.name)}</span></div>
      <form id="group-composer-form" data-group="${group.id}" class="stack">
        <textarea name="text" rows="3" maxlength="2000" placeholder="${t('postToGroup')}"></textarea>
        <div class="row gap wrap">
          <label class="btn btn-ghost btn-sm">📷 Photo<input type="file" name="image" accept="image/*" hidden /></label>
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
        return `<div class="row gap-sm">${avatarHtml(u, 36)}<a class="grow" href="#/profile/${u.id}">${escapeHtml(u.name)}</a>${id === group.createdBy ? '<span class="badge badge-admin">Admin</span>' : ''}${u.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''}${isCreator && id !== group.createdBy ? `<button class="btn btn-ghost btn-sm" data-act="remove-member" data-group="${group.id}" data-id="${id}">Remove</button>` : ''}</div>`;
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
    <span class="muted small">${(p.followers || []).length} ${t('followers')}</span>
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
  return `<div class="profile-wrap">
    <div class="card profile-head">
      <div class="cover" style="${page.cover ? `background-image:url('${escapeHtml(page.cover)}')` : ''}"></div>
      <div class="profile-meta">
        ${avatarHtml({ name: page.name, username: page.name, avatar: page.avatar }, 110)}
        <div class="grow">
          <h2>${escapeHtml(page.name)} <span class="badge">${t('pageLabel')}</span></h2>
          <p class="muted">${escapeHtml(page.category || '')} · ${(page.followers || []).length} ${t('followers')} · by ${escapeHtml(ctx.usersById[page.ownerId]?.name || '')}</p>
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
        <div class="row gap wrap">
          <label class="btn btn-ghost btn-sm">📷 Photo<input type="file" name="image" accept="image/*" hidden /></label>
          <span class="spacer"></span>
          <button class="btn btn-primary" type="submit">${t('post')}</button>
        </div>
      </form>
    </div>` : ''}
    <div class="profile-posts">
      ${posts.map((p) => postCardHtml(p, ctx)).join('') || emptyState('📝', t('noPosts'))}
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

// ------------------------------------------------------------------ MESSAGES
export function messagesView(d, meUser, activeConvId = '') {
  const byId = usersById(d);
  const myConvs = d.conversations.filter((c) => c.participants.includes(meUser.id))
    .map((c) => {
      const otherId = c.participants.find((p) => p !== meUser.id);
      const msgs = d.messages.filter((m) => m.conversationId === c.id).sort((a, b) => a.createdAt - b.createdAt);
      const last = msgs[msgs.length - 1];
      const unread = msgs.filter((m) => m.senderId !== meUser.id && !(m.readBy || []).includes(meUser.id)).length;
      return { conv: c, other: byId[otherId], last, unread, msgs };
    })
    .sort((a, b) => (b.last?.createdAt || b.conv.createdAt) - (a.last?.createdAt || a.conv.createdAt));
  const active = myConvs.find((x) => x.conv.id === activeConvId) || myConvs[0];
  return `<div class="messenger card">
    <div class="conv-list">
      <h3>💬 ${t('messages')}</h3>
      ${myConvs.map((x) => `<button class="conv-item ${active?.conv.id === x.conv.id ? 'active' : ''}" data-act="open-conv" data-id="${x.conv.id}">
        ${avatarHtml(x.other, 44)}<span class="grow left"><b>${escapeHtml(x.other?.name || 'Unknown')}</b> ${x.other?.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''}<br/><span class="muted small">${escapeHtml((x.last?.text || (x.last?.image ? '📷 Photo' : 'Say hello')).slice(0, 42))}</span></span>
        ${x.unread ? `<span class="unread-badge">${x.unread}</span>` : ''}
      </button>`).join('') || `<p class="muted small">${t('noMessages')}</p>
      <div class="stack"><h4>Start a chat</h4>${d.users.filter((u) => u.id !== meUser.id).slice(0, 6).map((u) => `<button class="conv-item" data-act="message-user" data-id="${u.id}">${avatarHtml(u, 36)}<span>${escapeHtml(u.name)}</span>${u.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''}</button>`).join('')}</div>`}
    </div>
    <div class="conv-thread">
      ${active ? `
      <header class="thread-head">${avatarHtml(active.other, 40)}<div><b>${escapeHtml(active.other?.name || '')}</b><br/><span class="muted small">${active.other?.online ? t('online') : t('offline')}${active.other?.isBot ? ' · AI Bot' : ''}</span></div>
      <span class="spacer"></span><button class="btn btn-ghost btn-sm" data-act="report-user" data-id="${active.other?.id}">🚩</button></header>
      <div class="thread-body" id="thread-body">
        ${active.msgs.map((m) => messageHtml(m, meUser, byId)).join('') || '<p class="muted center">No messages yet. Say hello 👋</p>'}
      </div>
      <form id="message-form" data-conv="${active.conv.id}" class="message-form">
        <label class="btn btn-ghost btn-sm">📷<input type="file" name="image" accept="image/*" hidden /></label>
        <input name="text" placeholder="Type a message…" autocomplete="off" maxlength="2000" />
        <button class="btn btn-primary" type="submit">${t('send')}</button>
      </form>` : `<div class="empty-state"><div class="empty-icon">💬</div><p class="muted">${t('noMessages')}</p></div>`}
    </div>
  </div>`;
}

function messageHtml(m, meUser, byId) {
  const mine = m.senderId === meUser.id;
  const status = mine ? (m.status === 'read' || (m.readBy || []).length > 1 ? '✓✓ read' : m.status === 'delivered' ? '✓✓' : '✓ sent') : '';
  return `<div class="msg-row ${mine ? 'mine' : ''}">
    ${mine ? '' : avatarHtml(byId[m.senderId], 28)}
    <div class="msg-bubble ${mine ? 'mine' : ''}">
      ${m.image ? `<img class="msg-image" src="${escapeHtml(m.image)}" alt="Shared photo" loading="lazy" />` : ''}
      ${m.text ? `<p>${escapeHtml(m.text)}</p>` : ''}
      <span class="msg-meta">${timeAgo(m.createdAt)} ${status}</span>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ NOTIFICATIONS
export function notificationsView(d, meUser) {
  const byId = usersById(d);
  const mine = d.notifications.filter((n) => n.userId === meUser.id).sort((a, b) => b.createdAt - a.createdAt);
  const icons = { friend_request: '👥', friend_accept: '✅', like: '❤️', comment: '💬', reply: '↩️', message: '✉️', mention: '@', share: '🔁', follow: '➕', group_join: '🏘️', page_follow: '📄' };
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
    <h3>People</h3>
    <div class="grid-people">${users.map((u) => `<div class="card person-card">${avatarHtml(u, 56)}<a href="#/profile/${u.id}"><b>${escapeHtml(u.name)}</b></a><span class="muted small">@${escapeHtml(u.username)}</span>${u.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''}</div>`).join('') || '<p class="muted">No people matched.</p>'}</div>
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
  const types = ['friend_request', 'like', 'comment', 'reply', 'message', 'mention', 'follow'];
  return `<div class="page narrow">
    <h2>⚙️ ${t('settings')}</h2>
    <div class="card stack">
      <h3>Account</h3>
      <p><b>${escapeHtml(meUser.name)}</b> · @${escapeHtml(meUser.username)}<br/><span class="muted">${escapeHtml(meUser.email || '')}</span></p>
      <div class="row gap wrap">
        <button class="btn btn-ghost" data-act="edit-profile">✏️ ${t('edit')} profile</button>
        <button class="btn btn-ghost" data-act="change-password">Change password / reset</button>
        <button class="btn btn-danger" data-act="delete-account">${t('delete')} account</button>
      </div>
    </div>
    <div class="card stack">
      <h3>Appearance & language</h3>
      <div class="row gap wrap">
        <button class="btn btn-ghost" data-act="toggle-theme">${prefs.theme === 'dark' ? '☀️ ' + t('lightMode') : '🌙 ' + t('darkMode')}</button>
        <label>Language
          <select id="locale-select" class="select-sm">
            <option value="en" ${prefs.locale === 'en' ? 'selected' : ''}>English</option>
            <option value="bn" ${prefs.locale === 'bn' ? 'selected' : ''}>বাংলা</option>
          </select>
        </label>
      </div>
      <p class="muted small">The app is language-ready: all core strings live in locale dictionaries (English + বাংলা included).</p>
    </div>
    <div class="card stack">
      <h3>Notification preferences</h3>
      <form id="notif-prefs-form" class="stack">
        ${types.map((type) => `<label class="row gap-sm"><input type="checkbox" name="${type}" ${np[type] === false ? '' : 'checked'} /> <span class="grow">${type.replaceAll('_', ' ')}</span></label>`).join('')}
        <button class="btn btn-primary btn-sm" type="submit">Save preferences</button>
      </form>
    </div>
    <div class="card stack">
      <h3>Privacy</h3>
      <p class="muted">Blocked people cannot see your posts or message you. Manage blocks from any profile page.</p>
      ${(d.blocks || []).filter((b) => b.by === meUser.id).map((b) => `<div class="row gap-sm">${avatarHtml(usersById(d)[b.target], 32)}<span class="grow">${escapeHtml(usersById(d)[b.target]?.name || '')}</span><button class="btn btn-ghost btn-sm" data-act="block" data-id="${b.target}">Unblock</button></div>`).join('') || '<p class="muted small">You have not blocked anyone.</p>'}
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
    ['Be kind', 'Treat people — and bots — with respect. No harassment, hate speech or bullying.'],
    ['No spam or deception', 'Do not impersonate others, spread scams, or post misleading content. AI bots are always labelled as bots.'],
    ['Respect privacy', 'Do not share other people\'s private information. Report content that does.'],
    ['Keep it safe', 'No illegal content, no graphic violence, no sexual content involving minors — ever. Violations are removed and accounts may be suspended.']
  ]},
  terms: { title: '📄 Terms of Service', body: [
    ['The service', 'MeetBook is a social networking platform provided as-is. You are responsible for your account and content.'],
    ['Your content', 'You keep ownership of what you post and grant MeetBook a licence to display it to the audiences you choose with your privacy settings.'],
    ['AI bots', 'Some accounts are AI bots, clearly labelled. Bot content is generated automatically and may occasionally be inaccurate.'],
    ['Termination', 'Accounts that violate the Community Guidelines may be suspended or removed. You may delete your account at any time from Settings.']
  ]},
  privacy: { title: '🔒 Privacy Policy', body: [
    ['What we store', 'Account details (name, username, email), profile information, posts, comments, messages, friendships and notifications needed to run the platform.'],
    ['Who can see it', 'Content follows the privacy setting you choose. Private messages are restricted to conversation participants by security rules.'],
    ['AI bots', 'Bots keep their own conversation memories to stay in character. Bot memories are visible to administrators in the Bot Admin Panel.'],
    ['Your controls', 'Edit or delete your posts and profile at any time, block users, tune notification preferences, or delete your account from Settings.'],
    ['Demo mode', 'When the app runs in demo mode (no Firebase config), all data stays in your own browser\'s local storage and never leaves your device.']
  ]}
};

export function staticView(kind) {
  const page = STATIC[kind] || STATIC.help;
  return `<div class="page narrow"><div class="card stack"><h2>${page.title}</h2>
    ${page.body.map(([h, b]) => `<section><h4>${escapeHtml(h)}</h4><p class="muted">${escapeHtml(b)}</p></section>`).join('')}
  </div></div>`;
}

export function editProfileHtml(user) {
  return `<h3>✏️ ${t('edit')} profile</h3>
  <form id="edit-profile-form" class="stack">
    <label>Name<input name="name" required maxlength="60" value="${escapeHtml(user.name)}" /></label>
    <label>Username<input name="username" required maxlength="24" value="${escapeHtml(user.username)}" /></label>
    <label>Bio<textarea name="bio" rows="3" maxlength="300">${escapeHtml(user.bio || '')}</textarea></label>
    <label>Profile picture<input type="file" name="avatar" accept="image/*" /></label>
    <label>Cover photo<input type="file" name="cover" accept="image/*" /></label>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save profile</button></div>
  </form>`;
}

export { friendIdsOf, blockedIdsOf };
