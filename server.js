const path = require('path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { loadApps, APP_CONFIG_FILENAME, RESERVED_MOUNT_PREFIXES } = require('./lib/apps');
const { assignPorts } = require('./lib/ports');
const { startApp, stopApp, stopAll, STATUS } = require('./lib/process-manager');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Lightweight CSRF guard for the state-changing endpoints below: app-hub has
// no auth (it's a local dev tool), so without this, any other page open in
// the same browser could POST to these routes. Browsers always send Origin
// on a cross-origin fetch/XHR; non-browser tools (curl, etc.) typically send
// none at all, so only a *present-but-mismatched* Origin is rejected.
function requireSameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next();
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: 'invalid Origin header' });
  }
  if (originHost !== req.headers.host) {
    return res.status(403).json({ error: 'cross-origin request rejected' });
  }
  next();
}

async function main() {
  const apps = await assignPorts(loadApps());
  const states = apps.map((appConfig) => ({
    app: appConfig,
    status: appConfig.configured ? STATUS.STOPPED : STATUS.NOT_CONFIGURED,
    error: null,
    child: null,
  }));

  function ensureStarted(i) {
    if (!apps[i].configured) return states[i];
    if (states[i].status === STATUS.STOPPED || states[i].status === STATUS.ERROR) {
      states[i] = startApp(apps[i]);
    }
    return states[i];
  }

  function waitingPage(appConfig, status) {
    const name = escapeHtml(appConfig.name);
    return `<!doctype html>
<html><head><meta charset="utf-8" /><meta http-equiv="refresh" content="1" />
<title>Starting ${name}…</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem;">
  <p>${name} is ${escapeHtml(status)}… this page will refresh automatically.</p>
</body></html>`;
  }

  function mountApp(prefix, appConfig, i) {
    app.use(
      prefix,
      (req, res, next) => {
        // Sub-apps commonly use root-relative or "./" asset paths that only
        // resolve correctly once the browser's address bar has a trailing
        // slash after the mount path (e.g. /view-prs/, not /view-prs).
        if (req.originalUrl === prefix) {
          res.redirect(302, `${prefix}/`);
          return;
        }
        const state = ensureStarted(i);
        if (state.status !== STATUS.RUNNING) {
          if (state.status === STATUS.ERROR) {
            res.status(503).send(`${escapeHtml(appConfig.name)} failed to start: ${escapeHtml(state.error)}`);
            return;
          }
          res.status(202).send(waitingPage(appConfig, state.status));
          return;
        }
        next();
      },
      createProxyMiddleware({
        target: `http://127.0.0.1:${appConfig.port}`,
        changeOrigin: true,
        // A literal prefix strip, not a regex: a folder/slug name containing
        // regex-special characters (e.g. "my-app (backup)") would otherwise
        // throw "Invalid regular expression" on the app's first request.
        pathRewrite: (p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p) || '/',
        ws: true,
      })
    );
  }

  const usedPrefixes = new Set(apps.filter((a) => a.configured).map((a) => a.mountPath));

  apps.forEach((appConfig, i) => {
    if (!appConfig.configured) return;

    mountApp(appConfig.mountPath, appConfig, i);

    // Compatibility alias: some sub-apps' own client-side code hardcodes an
    // assumption that they're mounted at "/<slug>" rather than app-hub's
    // actual "/apps/<slug>" convention (e.g. a fetch('/<slug>/api/...') call
    // computed from window.location.pathname). Since slugs are already
    // enforced unique, this alias is unambiguous, and it transparently fixes
    // that whole class of mistake without touching the sub-app.
    const slugAlias = `/${appConfig.slug}`;
    if (slugAlias !== appConfig.mountPath && !usedPrefixes.has(slugAlias) && !RESERVED_MOUNT_PREFIXES.has(slugAlias)) {
      mountApp(slugAlias, appConfig, i);
      usedPrefixes.add(slugAlias);
    }
  });

  app.get('/api/apps', (req, res) => {
    res.json(
      states.map((s) => ({
        name: s.app.name,
        slug: s.app.slug,
        description: s.app.description,
        icon: s.app.icon,
        mountPath: s.app.mountPath,
        port: s.app.port,
        configured: s.app.configured,
        hasOwnGit: s.app.hasOwnGit,
        actions: s.app.actions,
        status: s.status,
        error: s.error,
      }))
    );
  });

  app.post('/api/apps/:slug/start', requireSameOrigin, (req, res) => {
    const i = apps.findIndex((a) => a.slug === req.params.slug);
    if (i === -1) return res.status(404).json({ error: 'app not found' });
    if (!apps[i].configured) return res.status(400).json({ error: `app has no ${APP_CONFIG_FILENAME}` });
    const state = ensureStarted(i);
    res.json({ status: state.status, error: state.error });
  });

  app.post('/api/apps/:slug/stop', requireSameOrigin, async (req, res) => {
    const i = apps.findIndex((a) => a.slug === req.params.slug);
    if (i === -1) return res.status(404).json({ error: 'app not found' });
    if (!apps[i].configured) return res.status(400).json({ error: `app has no ${APP_CONFIG_FILENAME}` });
    await stopApp(states[i]);
    res.json({ status: states[i].status });
  });

  app.listen(PORT, () => {
    console.log(`app-hub listening on http://localhost:${PORT}`);
    apps.forEach((a) => {
      if (a.configured) {
        console.log(`  -> ${a.name}: http://localhost:${PORT}${a.mountPath} (child port ${a.port})`);
      } else {
        console.log(`  -> ${a.name}: not configured (apps/${a.folderName}/${APP_CONFIG_FILENAME} missing)`);
      }
    });
  });

  async function shutdown() {
    await stopAll(states);
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
