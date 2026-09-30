const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { APPS_DIR } = require('../lib/apps');
const { buildApp } = require('../server');

// These tests create a real temp app under apps/ (loadApps()'s APPS_DIR
// isn't injectable — same approach as test/apps.test.js) and boot the real
// Express app on an ephemeral port, so they exercise actual routing/proxying,
// not just the handler functions in isolation.
function withTempApp(name, fn) {
  const dir = path.join(APPS_DIR, name);
  return async () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

test(
  'GET /api/apps lists an unconfigured app with a "not-configured" status',
  withTempApp('test-server-unconfigured', async () => {
    const { app } = await buildApp();
    const { server, base } = await listen(app);
    try {
      const res = await fetch(`${base}/api/apps`);
      const apps = await res.json();
      const entry = apps.find((a) => a.slug === 'test-server-unconfigured');
      assert.ok(entry, 'unconfigured app should still be listed');
      assert.equal(entry.configured, false);
      assert.equal(entry.status, 'not-configured');
    } finally {
      server.close();
    }
  })
);

test(
  'POST /api/apps/:slug/start for an unknown slug returns 404',
  withTempApp('test-server-404', async () => {
    const { app } = await buildApp();
    const { server, base } = await listen(app);
    try {
      const res = await fetch(`${base}/api/apps/totally-unknown-slug-xyz/start`, { method: 'POST' });
      assert.equal(res.status, 404);
    } finally {
      server.close();
    }
  })
);

test(
  'POST /api/apps/:slug/start for an unconfigured app returns 400',
  withTempApp('test-server-unconfigured-start', async (dir) => {
    const { app } = await buildApp();
    const { server, base } = await listen(app);
    try {
      const res = await fetch(`${base}/api/apps/${path.basename(dir)}/start`, { method: 'POST' });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /app-hub\.config\.json/);
    } finally {
      server.close();
    }
  })
);

test(
  'a cross-origin POST to /start is rejected end-to-end through the real route',
  withTempApp('test-server-csrf', async (dir) => {
    fs.writeFileSync(
      path.join(dir, 'app-hub.config.json'),
      JSON.stringify({ name: 'x', slug: 'test-server-csrf', start: 'node -e "process.exit(0)"' })
    );
    const { app } = await buildApp();
    const { server, base } = await listen(app);
    try {
      const res = await fetch(`${base}/api/apps/test-server-csrf/start`, {
        method: 'POST',
        headers: { origin: 'http://evil.example' },
      });
      assert.equal(res.status, 403);
    } finally {
      server.close();
    }
  })
);

test(
  'GET /api/apps exposes startedAt once an app has been asked to start, for the client\'s live elapsed-time count',
  withTempApp('test-server-startedat', async (dir) => {
    fs.writeFileSync(
      path.join(dir, 'app-hub.config.json'),
      JSON.stringify({ name: 'startedAt test', slug: 'test-server-startedat', start: 'node index.js', healthPath: '/' })
    );
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      "require('http').createServer((req,res)=>res.end('ok')).listen(process.env.PORT);"
    );
    const { app, states } = await buildApp();
    const { server, base } = await listen(app);
    const slug = 'test-server-startedat';

    try {
      const beforeRes = await fetch(`${base}/api/apps`);
      const beforeEntry = (await beforeRes.json()).find((a) => a.slug === slug);
      assert.equal(beforeEntry.startedAt, null, 'not started yet, so no startedAt');

      const before = Date.now();
      const startRes = await fetch(`${base}/api/apps/${slug}/start`, { method: 'POST' });
      assert.equal(startRes.status, 200);
      const after = Date.now();

      const afterRes = await fetch(`${base}/api/apps`);
      const afterEntry = (await afterRes.json()).find((a) => a.slug === slug);
      assert.equal(typeof afterEntry.startedAt, 'number');
      assert.ok(
        afterEntry.startedAt >= before && afterEntry.startedAt <= after,
        `expected startedAt (${afterEntry.startedAt}) between ${before} and ${after}`
      );
    } finally {
      const state = states.find((s) => s.app.slug === slug);
      if (state && state.child && state.child.exitCode === null) {
        const { stopApp } = require('../lib/process-manager');
        await stopApp(state);
      }
      server.close();
    }
  })
);

test(
  'starting a real app through the HTTP API makes it reachable through both the proxy mount and the slug alias',
  withTempApp('test-server-e2e', async (dir) => {
    fs.writeFileSync(
      path.join(dir, 'app-hub.config.json'),
      JSON.stringify({ name: 'E2E test app', slug: 'test-server-e2e', start: 'node index.js', healthPath: '/' })
    );
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      "require('http').createServer((req,res)=>res.end('hello from ' + req.url)).listen(process.env.PORT);"
    );

    const { app, states } = await buildApp();
    const { server, base } = await listen(app);
    const slug = 'test-server-e2e';

    try {
      const startRes = await fetch(`${base}/api/apps/${slug}/start`, { method: 'POST' });
      assert.equal(startRes.status, 200);

      const deadline = Date.now() + 15000;
      let status = 'starting';
      while (status !== 'running' && Date.now() < deadline) {
        const res = await fetch(`${base}/api/apps`);
        const apps = await res.json();
        status = apps.find((a) => a.slug === slug).status;
        if (status === 'running') break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(status, 'running');

      // Real mountPath (redirect to trailing slash, then proxy through).
      const mountRes = await fetch(`${base}/apps/${slug}/some/path`);
      assert.equal(mountRes.status, 200);
      assert.equal(await mountRes.text(), 'hello from /some/path');

      // Slug compatibility alias, mounted separately from mountPath.
      const aliasRes = await fetch(`${base}/${slug}/other`);
      assert.equal(aliasRes.status, 200);
      assert.equal(await aliasRes.text(), 'hello from /other');

      const stopRes = await fetch(`${base}/api/apps/${slug}/stop`, { method: 'POST' });
      assert.equal(stopRes.status, 200);
      const stopBody = await stopRes.json();
      assert.equal(stopBody.status, 'stopped');
    } finally {
      const state = states.find((s) => s.app.slug === slug);
      if (state && state.child && state.child.exitCode === null) {
        const { stopApp } = require('../lib/process-manager');
        await stopApp(state);
      }
      server.close();
    }
  })
);
