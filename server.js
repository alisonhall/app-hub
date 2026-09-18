const path = require('path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { loadApps, APP_CONFIG_FILENAME } = require('./lib/apps');
const { assignPorts } = require('./lib/ports');
const { startApp, stopApp, stopAll, STATUS } = require('./lib/process-manager');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

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
    return `<!doctype html>
<html><head><meta charset="utf-8" /><meta http-equiv="refresh" content="1" />
<title>Starting ${appConfig.name}…</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem;">
  <p>${appConfig.name} is ${status}… this page will refresh automatically.</p>
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
            res.status(503).send(`${appConfig.name} failed to start: ${state.error}`);
            return;
          }
          res.status(202).send(waitingPage(appConfig, state.status));
          return;
        }
        next();
      },
      createProxyMiddleware({
        target: `http://localhost:${appConfig.port}`,
        changeOrigin: true,
        pathRewrite: (p) => p.replace(new RegExp(`^${prefix}`), '') || '/',
        ws: true,
      })
    );
  }

  // Top-level prefixes app-hub itself reserves; a sub-app's slug alias (see
  // below) never gets mounted over one of these, however unlikely a clash.
  const RESERVED_PREFIXES = new Set(['/api']);
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
    if (slugAlias !== appConfig.mountPath && !usedPrefixes.has(slugAlias) && !RESERVED_PREFIXES.has(slugAlias)) {
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

  app.post('/api/apps/:slug/start', (req, res) => {
    const i = apps.findIndex((a) => a.slug === req.params.slug);
    if (i === -1) return res.status(404).json({ error: 'app not found' });
    if (!apps[i].configured) return res.status(400).json({ error: `app has no ${APP_CONFIG_FILENAME}` });
    const state = ensureStarted(i);
    res.json({ status: state.status, error: state.error });
  });

  app.post('/api/apps/:slug/stop', (req, res) => {
    const i = apps.findIndex((a) => a.slug === req.params.slug);
    if (i === -1) return res.status(404).json({ error: 'app not found' });
    if (!apps[i].configured) return res.status(400).json({ error: `app has no ${APP_CONFIG_FILENAME}` });
    stopApp(states[i]);
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

  function shutdown() {
    stopAll(states);
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
