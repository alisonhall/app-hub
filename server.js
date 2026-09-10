const path = require('path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { loadApps } = require('./lib/apps');
const { startApp, stopApp, stopAll, STATUS } = require('./lib/process-manager');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const apps = loadApps();
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

apps.forEach((appConfig, i) => {
  if (!appConfig.configured) return;

  app.use(
    appConfig.mountPath,
    (req, res, next) => {
      // Sub-apps commonly use root-relative or "./" asset paths that only
      // resolve correctly once the browser's address bar has a trailing
      // slash after the mount path (e.g. /view-prs/, not /view-prs).
      if (req.originalUrl === appConfig.mountPath) {
        res.redirect(302, `${appConfig.mountPath}/`);
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
      pathRewrite: (p) => p.replace(new RegExp(`^${appConfig.mountPath}`), '') || '/',
      ws: true,
    })
  );
});

app.get('/api/apps', (req, res) => {
  res.json(
    states.map((s) => ({
      name: s.app.name,
      slug: s.app.slug,
      description: s.app.description,
      icon: s.app.icon,
      mountPath: s.app.mountPath,
      configured: s.app.configured,
      status: s.status,
      error: s.error,
    }))
  );
});

app.post('/api/apps/:slug/start', (req, res) => {
  const i = apps.findIndex((a) => a.slug === req.params.slug);
  if (i === -1) return res.status(404).json({ error: 'app not found' });
  if (!apps[i].configured) return res.status(400).json({ error: 'app has no defaults.json' });
  const state = ensureStarted(i);
  res.json({ status: state.status, error: state.error });
});

app.post('/api/apps/:slug/stop', (req, res) => {
  const i = apps.findIndex((a) => a.slug === req.params.slug);
  if (i === -1) return res.status(404).json({ error: 'app not found' });
  if (!apps[i].configured) return res.status(400).json({ error: 'app has no defaults.json' });
  stopApp(states[i]);
  res.json({ status: states[i].status });
});

app.listen(PORT, () => {
  console.log(`app-hub listening on http://localhost:${PORT}`);
  apps.forEach((a) => {
    if (a.configured) {
      console.log(`  -> ${a.name}: http://localhost:${PORT}${a.mountPath} (child port ${a.port})`);
    } else {
      console.log(`  -> ${a.name}: not configured (apps/${a.folderName}/defaults.json missing)`);
    }
  });
});

function shutdown() {
  stopAll(states);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
