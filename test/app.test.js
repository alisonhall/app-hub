const { test } = require('node:test');
const assert = require('node:assert/strict');

// public/app.js references escapeHtml/gitBadge/nodeBadge as bare globals —
// exactly how the browser sees them once client-helpers.js's <script> has
// run first (see index.html). Node has no such thing as scripts sharing a
// global scope, so this stands in for that: assigning them onto `global`
// here is what makes plain `escapeHtml(...)` resolve inside app.js when
// it's require()'d below, the same way it resolves in the browser.
Object.assign(global, require('../public/client-helpers'));
const { renderAppItem } = require('../public/app');

test('renderAppItem renders an unconfigured app without a toggle button', () => {
  const html = renderAppItem({ configured: false, icon: '❓', name: 'Unset App', description: 'no config yet' });
  assert.match(html, /not set up/);
  assert.match(html, /Unset App/);
  assert.doesNotMatch(html, /class="toggle"/);
});

test('renderAppItem shows a Start button and no elapsed count for a stopped app', () => {
  const html = renderAppItem({
    configured: true,
    icon: '🔧',
    name: 'Stopped App',
    slug: 'stopped-app',
    status: 'stopped',
    port: 4000,
    mountPath: '/apps/stopped-app',
    node: {},
  });
  assert.match(html, /data-action="start"/);
  assert.match(html, />Start</);
  assert.doesNotMatch(html, /\(\d+s\)/, 'a stopped app has no elapsed-time count');
});

test('renderAppItem shows a clickable Stop button (not disabled) for a starting app', () => {
  // Regression coverage for a real bug found in this repo: the Stop button
  // used to be `disabled` while starting, which — once pollUntilHealthy
  // stopped timing out — meant a stuck/misconfigured app could never be
  // stopped from the UI at all. See the git history around
  // lib/process-manager.js's pollUntilHealthy for the full story.
  const html = renderAppItem({
    configured: true,
    icon: '🔧',
    name: 'Starting App',
    slug: 'starting-app',
    status: 'starting',
    startedAt: Date.now(),
    port: 4000,
    mountPath: '/apps/starting-app',
    node: {},
  });
  assert.match(html, /data-action="stop"/);
  assert.match(html, />Stop</);
  assert.doesNotMatch(html, /<button[^>]*disabled/, 'the toggle button must stay clickable while starting');
});

test('renderAppItem shows a live elapsed-seconds count for a starting app with startedAt', () => {
  const startedAt = Date.now() - 45_000;
  const html = renderAppItem({
    configured: true,
    icon: '🔧',
    name: 'Slow Build App',
    slug: 'slow-build-app',
    status: 'starting',
    startedAt,
    port: 4000,
    mountPath: '/apps/slow-build-app',
    node: {},
  });
  assert.match(html, /status-starting/);
  assert.match(html, /\(4[4-6]s\)/, 'expected roughly a 45s elapsed count');
});

test('renderAppItem omits the elapsed count for a starting app with no startedAt (e.g. an old cached response)', () => {
  const html = renderAppItem({
    configured: true,
    icon: '🔧',
    name: 'No StartedAt App',
    slug: 'no-startedat-app',
    status: 'starting',
    startedAt: null,
    port: 4000,
    mountPath: '/apps/no-startedat-app',
    node: {},
  });
  assert.doesNotMatch(html, /\(\d+s\)/);
});

test('renderAppItem shows the error message alongside the status for a failed app', () => {
  const html = renderAppItem({
    configured: true,
    icon: '🔧',
    name: 'Broken App',
    slug: 'broken-app',
    status: 'error',
    error: 'missing required command(s): jq',
    port: 4000,
    mountPath: '/apps/broken-app',
    node: {},
  });
  assert.match(html, /status-error/);
  assert.match(html, /missing required command\(s\): jq/);
  assert.match(html, /data-action="start"/, 'a failed app should offer Start again, not Stop');
});

test('renderAppItem only renders the extra actions row for a running app that declares actions', () => {
  const runningWithActions = renderAppItem({
    configured: true,
    icon: '🔧',
    name: 'Actionable App',
    slug: 'actionable-app',
    status: 'running',
    port: 4000,
    mountPath: '/apps/actionable-app',
    actions: [{ label: 'Run', path: '/run', method: 'POST' }],
    node: {},
  });
  assert.match(runningWithActions, /class="action-btn"/);
  assert.match(runningWithActions, />Run</);

  const runningNoActions = renderAppItem({
    configured: true,
    icon: '🔧',
    name: 'Plain App',
    slug: 'plain-app',
    status: 'running',
    port: 4000,
    mountPath: '/apps/plain-app',
    actions: [],
    node: {},
  });
  assert.doesNotMatch(runningNoActions, /class="action-btn"/);

  const startingWithActions = renderAppItem({
    configured: true,
    icon: '🔧',
    name: 'Not Running Yet App',
    slug: 'not-running-yet-app',
    status: 'starting',
    startedAt: Date.now(),
    port: 4000,
    mountPath: '/apps/not-running-yet-app',
    actions: [{ label: 'Run', path: '/run', method: 'POST' }],
    node: {},
  });
  assert.doesNotMatch(startingWithActions, /class="action-btn"/, 'actions only show once actually running');
});

test('renderAppItem HTML-escapes untrusted fields (name, description, error)', () => {
  const html = renderAppItem({
    configured: true,
    icon: '🔧',
    name: '<script>alert(1)</script>',
    description: '"><img src=x>',
    slug: 'xss-app',
    status: 'error',
    error: '<b>boom</b>',
    port: 4000,
    mountPath: '/apps/xss-app',
    node: {},
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.doesNotMatch(html, /<b>boom<\/b>/);
  assert.match(html, /&lt;script&gt;/);
});
