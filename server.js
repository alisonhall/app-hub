const path = require('path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { loadApps } = require('./lib/apps');
const { startApp, stopAll, STATUS } = require('./lib/process-manager');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const apps = loadApps();
const states = apps.map(startApp);

apps.forEach((appConfig, i) => {
  app.use(
    appConfig.mountPath,
    (req, res, next) => {
      if (states[i].status !== STATUS.RUNNING) {
        res.status(503).send(`${appConfig.name} is not ready yet (${states[i].status}). Refresh in a moment.`);
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
      status: s.status,
      error: s.error,
    }))
  );
});

app.listen(PORT, () => {
  console.log(`app-hub listening on http://localhost:${PORT}`);
  apps.forEach((a) => console.log(`  -> ${a.name}: http://localhost:${PORT}${a.mountPath} (child port ${a.port})`));
});

function shutdown() {
  stopAll(states);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
