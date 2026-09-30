// Loaded after client-helpers.js (escapeHtml, gitBadge, nodeBadge come from
// there — shared with test/client-helpers.test.js, see that file's
// comment). Split into its own file, rather than an inline <script> in
// index.html, so it's an ordinary .js file ESLint actually lints — an
// inline <script> block is invisible to ESLint's default file targeting.

// Pure (no DOM access) so it's unit-testable directly — see
// test/app.test.js — independently of refresh()'s actual document.write.
function renderAppItem(a) {
  if (!a.configured) {
    return `
    <li>
      <span class="icon">${escapeHtml(a.icon)}</span>
      <span class="meta">
        <div class="name">${gitBadge(a)} <span class="unconfigured">${escapeHtml(a.name)}</span></div>
        <div class="desc">${escapeHtml(a.description || '')}</div>
      </span>
      <span class="status status-not-configured">not set up</span>
    </li>`;
  }

  const isRunning = a.status === 'running' || a.status === 'starting';
  const action = isRunning ? 'stop' : 'start';
  const startingFor = a.status === 'starting' && a.startedAt ? Math.max(0, Math.round((Date.now() - a.startedAt) / 1000)) : null;
  // Stop stays clickable while starting — with no timeout, a stuck
  // or misconfigured app (wrong healthPath, hung build) would
  // otherwise be unkillable from the UI. The elapsed count on the
  // status badge already communicates "still starting"; the button
  // itself just needs to say what clicking it does.
  const label = isRunning ? 'Stop' : 'Start';

  const actionsHtml =
    a.status === 'running' && a.actions && a.actions.length
      ? `<div class="actions-row">${a.actions
          .map(
            (act) =>
              `<button class="action-btn" data-mount-path="${escapeHtml(a.mountPath)}" data-path="${escapeHtml(act.path)}" data-method="${escapeHtml(act.method || 'POST')}">${escapeHtml(act.label)}</button>`
          )
          .join('')}<span class="action-result"></span></div>`
      : '';

  return `
    <li>
      <span class="icon">${escapeHtml(a.icon)}</span>
      <span class="meta">
        <div class="name">${gitBadge(a)} <a href="${escapeHtml(a.mountPath)}">${escapeHtml(a.name)}</a></div>
        <div class="desc">${escapeHtml(a.description || '')}</div>
      </span>
      <span class="status status-${a.status}">${a.status}${startingFor !== null ? ` (${startingFor}s)` : ''}${a.error ? ': ' + escapeHtml(a.error) : ''}</span>
      <span class="port" title="Child process port">:${escapeHtml(a.port)}</span>
      ${nodeBadge(a)}
      <button class="toggle" data-slug="${escapeHtml(a.slug)}" data-action="${action}">${label}</button>
      ${actionsHtml}
    </li>`;
}

async function refresh() {
  const res = await fetch('/api/apps');
  const apps = await res.json();
  const list = document.getElementById('apps');

  if (!apps.length) {
    list.innerHTML = '<li class="empty">No apps found. Add one under apps/&lt;folder&gt;/app-hub.config.json.</li>';
    return;
  }

  list.innerHTML = apps.map(renderAppItem).join('');
}

function wireUpToggleHandlers() {
  document.getElementById('apps').addEventListener('click', async (e) => {
    const toggleBtn = e.target.closest('button.toggle');
    if (toggleBtn) {
      toggleBtn.disabled = true;
      await fetch(`/api/apps/${toggleBtn.dataset.slug}/${toggleBtn.dataset.action}`, { method: 'POST' });
      refresh();
      return;
    }

    const actionBtn = e.target.closest('button.action-btn');
    if (actionBtn) {
      const { mountPath, path: actionPath, method } = actionBtn.dataset;
      const resultEl = actionBtn.parentElement.querySelector('.action-result');
      actionBtn.disabled = true;
      if (resultEl) resultEl.textContent = 'Running…';
      try {
        const res = await fetch(`${mountPath}${actionPath}`, { method });
        let text;
        try {
          const data = await res.json();
          text = data.message || (data.ok === false ? 'Failed.' : 'Done.');
        } catch {
          text = res.ok ? 'Done.' : `Failed (${res.status}).`;
        }
        if (resultEl) resultEl.textContent = text;
      } catch (err) {
        if (resultEl) resultEl.textContent = `Error: ${err.message}`;
      } finally {
        actionBtn.disabled = false;
      }
    }
  });
}

// Only run this page's actual bootstrap in a real browser — a plain
// <script> load, not a require() from test/app.test.js (which only wants
// the pure renderAppItem above; document/fetch don't exist under node:test).
if (typeof document !== 'undefined') {
  wireUpToggleHandlers();
  refresh();
  setInterval(refresh, 2000);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderAppItem };
}
