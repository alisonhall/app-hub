// Shared between public/index.html (loaded as a plain <script>, so these
// declarations become ordinary globals — no bundler/module system there)
// and test/client-helpers.test.js (loaded via require() as a CommonJS
// module, see the module.exports guard at the bottom). Kept dependency-free
// so it works unmodified in both environments.

// Names/descriptions/errors ultimately come from config files (or a
// spawned process's own text), not from untrusted network input — but
// escaping them before dropping into innerHTML costs nothing and avoids
// a stray "<" or "&" in an app's own description silently breaking the
// page (or worse, a config file with real markup in it doing something
// unexpected).
function escapeHtml(value) {
  const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, (c) => escapes[c]);
}

function gitBadge(a) {
  return a.hasOwnGit
    ? '<span class="git-badge" title="Has its own git repository">🔀</span>'
    : '<span class="git-badge" title="Local code, not its own git repository">📁</span>';
}

// Shows which Node version the app actually launched under, once started —
// and flags it clearly when a .nvmrc pin couldn't be honored (neither fnm
// nor nvm could provide it) and app-hub fell back to running under its own
// Node instead of the requested one. Only shown for apps that actually pin
// a version via .nvmrc — for everything else, "which Node did it use" isn't
// a meaningful question (there was nothing to match or fall back from), so
// showing a version number there would just be noise.
function nodeBadge(a) {
  if (!a.node || !a.node.requested || !a.node.used) return '';
  const { requested, used, source } = a.node;
  const fallback = source === 'system';
  const label = fallback ? `⚠ ${used} (wanted ${requested})` : `${used} via ${source}`;
  const title = fallback
    ? `Pinned to ${requested} via .nvmrc, but neither fnm nor nvm could provide it on this machine — running under app-hub's own Node instead.`
    : `Pinned to ${requested} via .nvmrc, provided by ${source}.`;
  return `<span class="node-badge${fallback ? ' node-fallback' : ''}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeHtml, gitBadge, nodeBadge };
}
