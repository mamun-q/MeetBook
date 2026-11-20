// MeetBook QA Bot — automated bug hunter for the live site.
//
// Sweeps every main route on a phone viewport AND a desktop viewport,
// collecting: JS console errors, uncaught page errors, failed HTTP
// responses (>= 400), blank pages and sideways (horizontal) overflow —
// the bug class that crushed the admin table on phones. Then runs two
// self-cleaning smoke tests as the throwaway Test account: publish a
// post and delete it again, and open a message thread.
//
// Accounts come from environment variables (GitHub Secrets in CI):
//   QA_EMAIL / QA_PASSWORD       — MeetBook Test (regular user flows)
//   RUNNER_EMAIL / RUNNER_PASSWORD — MeetBook Official (admin pages,
//                                    visit-only, no actions taken)
// Writes qa-out/qa-report.md + qa-out/qa-report.json and exits 1 when
// any problem is found, so the workflow can open a GitHub Issue.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'https://mamun-q.github.io/MeetBook/';
const QA_EMAIL = process.env.QA_EMAIL || '';
const QA_PASSWORD = process.env.QA_PASSWORD || '';
const ADMIN_EMAIL = process.env.RUNNER_EMAIL || '';
const ADMIN_PASSWORD = process.env.RUNNER_PASSWORD || '';

const USER_ROUTES = ['', 'friends', 'groups', 'pages', 'messages', 'notifications', 'events', 'memories', 'saved', 'settings', 'help', 'search?q=meetbook'];
const ADMIN_ROUTES = ['admin', 'admin/analytics', 'admin/users', 'admin/content', 'admin/bots', 'admin/reports', 'admin/announce', 'admin/security', 'admin/settings', 'admin/health'];
const VIEWPORTS = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'desktop-1280', width: 1280, height: 800 },
];

const problems = [];
const notes = [];
function report(kind, where, detail) {
  const line = { kind, where, detail: String(detail).slice(0, 300) };
  if (!problems.some((p) => p.kind === line.kind && p.where === line.where && p.detail === line.detail)) problems.push(line);
}

// Console noise that is not a product bug.
const NOISE = [/ResizeObserver loop/i, /favicon/i];
function noisy(text) { return NOISE.some((re) => re.test(text)); }

async function login(page, email, password) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-form', { timeout: 20000 });
  await page.fill('#login-form input[name="email"]', email);
  await page.fill('#login-form input[name="password"]', password);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('.topbar', { timeout: 25000 });
}

async function checkRoute(page, route, viewportName, bag) {
  const where = `#/${route} [${viewportName}]`;
  bag.length = 0;
  await page.goto(BASE + '#/' + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600); // let Firestore data + render settle
  for (const e of bag) report(e.kind, where, e.detail);
  // Blank check measures the ROUTE CONTENT (.shell), not #app: the
  // app chrome (topbar/nav/footer) alone exceeds the old threshold,
  // so a route whose view rendered empty used to pass as "fine".
  const blank = await page.evaluate(() => (document.querySelector('.shell')?.innerText || '').trim().length);
  if (blank < 20) report('blank-page', where, `route content rendered only ${blank} chars of text`);
  const overflow = await page.evaluate(() => Math.max(
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    document.body ? document.body.scrollWidth - document.documentElement.clientWidth : 0,
  ));
  if (overflow > 1) report('horizontal-overflow', where, `page is ${overflow}px wider than the screen (sideways scroll)`);
}

async function sweep(browser, email, password, routes, label) {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await context.newPage();
    const bag = [];
    page.on('console', (msg) => { if (msg.type() === 'error' && !noisy(msg.text())) bag.push({ kind: 'console-error', detail: msg.text() }); });
    page.on('pageerror', (err) => bag.push({ kind: 'page-error', detail: err.message }));
    page.on('response', (res) => { if (res.status() >= 400 && !noisy(res.url())) bag.push({ kind: 'http-' + res.status(), detail: res.url() }); });
    page.on('requestfailed', (req) => {
      const url = req.url();
      // Firestore listen channels abort on navigation by design.
      if (url.includes('firestore.googleapis.com')) return;
      bag.push({ kind: 'request-failed', detail: `${url} (${req.failure()?.errorText || 'failed'})` });
    });
    try {
      await login(page, email, password);
    } catch (e) {
      report('login-failed', label, e.message);
      await context.close();
      continue;
    }
    for (const route of routes) {
      try { await checkRoute(page, route, vp.name, bag); }
      catch (e) { report('route-crash', `#/${route} [${vp.name}]`, e.message); }
    }
    await context.close();
  }
}

async function smokeTests(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const bag = [];
  page.on('pageerror', (err) => bag.push({ kind: 'page-error', detail: err.message }));
  try {
    await login(page, QA_EMAIL, QA_PASSWORD);
  } catch (e) {
    report('smoke-login-failed', 'smoke', e.message);
    await context.close();
    return;
  }
  // 1) Publish a post, see it, delete it (self-cleaning).
  const marker = `[QA-BOT] automated check ${Date.now()}`;
  try {
    await page.goto(BASE + '#/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#composer-form textarea', { timeout: 15000 });
    await page.fill('#composer-form textarea', marker);
    await page.click('#composer-form button[type="submit"], #composer-form .btn-primary');
    // The marker must appear inside a rendered POST CARD — checking
    // body text was satisfied by the composer textarea itself (its
    // current value is part of innerText), a false pass when the
    // publish actually failed.
    await page.waitForFunction((m) => [...document.querySelectorAll('.post-card')].some((el) => el.innerText.includes(m)), marker, { timeout: 20000 });
    notes.push('smoke: post published and visible');
    const card = page.locator('.post-card', { hasText: marker }).first();
    await card.locator('.post-menu-wrap button').first().click();
    await card.locator('[data-act="delete-post"]').click();
    await page.waitForSelector('.modal', { timeout: 8000 });
    await page.click('.modal .btn-danger, .modal .btn-primary');
    await page.waitForFunction((m) => !document.body.innerText.includes(m), marker, { timeout: 15000 });
    notes.push('smoke: post deleted again (cleaned up)');
  } catch (e) {
    report('smoke-post-flow', 'smoke [mobile-390]', e.message);
  }
  // 2) Open the first message thread.
  try {
    await page.goto(BASE + '#/messages', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const conv = page.locator('.conv-item').first();
    if (await conv.count()) {
      await conv.click();
      await page.waitForSelector('.thread-head', { timeout: 10000 });
      // The header alone is not proof: the 2026-11-20 DM bug rendered
      // the thread with a silently EMPTY message list. Require actual
      // message rows or the thread's own empty-state text.
      await page.waitForFunction(() => {
        const b = document.querySelector('#thread-body');
        return Boolean(b && (b.querySelector('.msg-row') || b.innerText.trim().length > 0));
      }, { timeout: 10000 });
      notes.push('smoke: message thread opened, messages region rendered');
    } else {
      notes.push('smoke: no conversations exist for the Test account — thread open skipped');
    }
  } catch (e) {
    report('smoke-messages-flow', 'smoke [mobile-390]', e.message);
  }
  for (const e of bag) report(e.kind, 'smoke [mobile-390]', e.detail);
  await context.close();
}

const started = new Date();
if (!QA_EMAIL || !QA_PASSWORD) {
  report('setup', 'qa-bot', 'QA_EMAIL / QA_PASSWORD secrets are missing — user-flow sweep skipped');
} else {
  const browser = await chromium.launch();
  await sweep(browser, QA_EMAIL, QA_PASSWORD, USER_ROUTES, 'user-login');
  await smokeTests(browser);
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    await sweep(browser, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_ROUTES, 'admin-login');
  } else {
    notes.push('admin sweep skipped (RUNNER_EMAIL / RUNNER_PASSWORD not set)');
  }
  await browser.close();
}

mkdirSync('qa-out', { recursive: true });
const when = started.toISOString();
const md = [
  `# QA Bot report — ${when}`,
  '',
  problems.length ? `**${problems.length} problem(s) found.**` : '**All clear — no problems found.** ✅',
  '',
  ...problems.map((p) => `- [${p.kind}] ${p.where} — ${p.detail}`),
  '',
  '## Notes',
  ...notes.map((n) => `- ${n}`),
  '',
].join('\n');
writeFileSync('qa-out/qa-report.md', md);
writeFileSync('qa-out/qa-report.json', JSON.stringify({ when, problems, notes }, null, 2));
console.log(md);
process.exit(problems.length ? 1 : 0);
