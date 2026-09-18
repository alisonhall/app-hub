const { test } = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, gitBadge, nodeBadge } = require('../public/client-helpers');

test('escapeHtml escapes all five HTML-sensitive characters', () => {
  assert.equal(escapeHtml(`<script>&"'</script>`), '&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;');
});

test('escapeHtml coerces non-string values instead of throwing', () => {
  assert.equal(escapeHtml(4001), '4001');
  assert.equal(escapeHtml(null), 'null');
});

test('gitBadge reflects hasOwnGit', () => {
  assert.match(gitBadge({ hasOwnGit: true }), /Has its own git repository/);
  assert.match(gitBadge({ hasOwnGit: false }), /not its own git repository/);
});

test('nodeBadge renders nothing for an app with no .nvmrc pin', () => {
  assert.equal(nodeBadge({ node: { requested: null, used: 'v22.22.2', source: 'system' } }), '');
});

test('nodeBadge renders nothing before the app has started (used not yet set)', () => {
  assert.equal(nodeBadge({ node: { requested: 'v20.11.1', used: null, source: null } }), '');
});

test('nodeBadge renders nothing when node info is entirely absent', () => {
  assert.equal(nodeBadge({}), '');
});

test('nodeBadge shows a plain badge when the pinned version was honored via fnm', () => {
  const html = nodeBadge({ node: { requested: 'v20.11.1', used: 'v20.11.1', source: 'fnm' } });
  assert.match(html, /class="node-badge"/);
  assert.doesNotMatch(html, /node-fallback/);
  assert.match(html, />v20\.11\.1 via fnm</);
  assert.match(html, /title="Pinned to v20\.11\.1 via \.nvmrc, provided by fnm\."/);
});

test('nodeBadge shows a plain badge when the pinned version was honored via nvm', () => {
  const html = nodeBadge({ node: { requested: 'v20.11.1', used: 'v20.11.1', source: 'nvm' } });
  assert.match(html, />v20\.11\.1 via nvm</);
});

test('nodeBadge flags a fallback to the system Node with a warning style and explanation', () => {
  const html = nodeBadge({ node: { requested: 'v20.11.1', used: 'v22.22.2', source: 'system' } });
  assert.match(html, /class="node-badge node-fallback"/);
  assert.match(html, />⚠ v22\.22\.2 \(wanted v20\.11\.1\)</);
  assert.match(html, /neither fnm nor nvm could provide it/);
});

test('nodeBadge HTML-escapes version strings before interpolating them', () => {
  const html = nodeBadge({ node: { requested: '"><img src=x>', used: 'v20.11.1', source: 'system' } });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&quot;&gt;&lt;img/);
});
