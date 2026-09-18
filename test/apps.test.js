const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { APPS_DIR, loadApps } = require('../lib/apps');

// These tests create real folders under apps/, since APPS_DIR isn't
// injectable, and clean them up afterwards even if an assertion fails.
function withTempApps(dirs, fn) {
  const paths = dirs.map((name) => path.join(APPS_DIR, name));
  return async () => {
    try {
      for (const p of paths) fs.mkdirSync(p, { recursive: true });
      await fn(...paths);
    } finally {
      for (const p of paths) fs.rmSync(p, { recursive: true, force: true });
    }
  };
}

test(
  'app-hub.config.json is optional: falls back to package.json for name/description/start',
  withTempApps(['test-pkg-fallback'], (dir) => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'pkg-app', description: 'from pkg', scripts: { start: 'node index.js' } })
    );
    const app = loadApps().find((a) => a.dir === dir);
    assert.ok(app, 'app should be discovered');
    assert.equal(app.configured, true);
    assert.equal(app.name, 'pkg-app');
    assert.equal(app.description, 'from pkg');
    assert.equal(app.start, 'npm start');
  })
);

test(
  'a package.json with no start script is left unconfigured',
  withTempApps(['test-pkg-no-start'], (dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'no-start-app', scripts: { build: 'x' } }));
    const app = loadApps().find((a) => a.dir === dir);
    assert.equal(app.configured, false);
    assert.match(app.description, /no "start" script/);
  })
);

test(
  'a config with no start and no package.json fallback throws',
  withTempApps(['test-broken-config'], (dir) => {
    fs.writeFileSync(path.join(dir, 'app-hub.config.json'), JSON.stringify({ name: 'broken' }));
    assert.throws(() => loadApps(), /missing required field "start"/);
  })
);

test(
  'malformed JSON produces a clear, file-identifying error',
  withTempApps(['test-bad-json'], (dir) => {
    fs.writeFileSync(path.join(dir, 'app-hub.config.json'), '{ not valid json');
    assert.throws(() => loadApps(), /Failed to parse .*app-hub\.config\.json as JSON/);
  })
);

test(
  '.nvmrc is preferred over .node-version when both are present',
  withTempApps(['test-nvmrc-precedence'], (dir) => {
    fs.writeFileSync(path.join(dir, 'app-hub.config.json'), JSON.stringify({ name: 'x', slug: 'test-nvmrc-precedence', start: 'node index.js' }));
    fs.writeFileSync(path.join(dir, '.node-version'), '18.0.0');
    fs.writeFileSync(path.join(dir, '.nvmrc'), '20.0.0');
    const app = loadApps().find((a) => a.dir === dir);
    assert.equal(app.nodeVersion, '20.0.0');
  })
);

test(
  'two apps declaring the same explicit port throws',
  withTempApps(['test-dup-port-a', 'test-dup-port-b'], (dirA, dirB) => {
    fs.writeFileSync(path.join(dirA, 'app-hub.config.json'), JSON.stringify({ name: 'a', slug: 'test-dup-port-a', start: 'x', port: 59991 }));
    fs.writeFileSync(path.join(dirB, 'app-hub.config.json'), JSON.stringify({ name: 'b', slug: 'test-dup-port-b', start: 'x', port: 59991 }));
    assert.throws(() => loadApps(), /Port 59991 is declared by both/);
  })
);

test(
  'two apps declaring the same explicit mountPath throws',
  withTempApps(['test-dup-mount-a', 'test-dup-mount-b'], (dirA, dirB) => {
    fs.writeFileSync(
      path.join(dirA, 'app-hub.config.json'),
      JSON.stringify({ name: 'a', slug: 'test-dup-mount-a', start: 'x', mountPath: '/test-shared-mount' })
    );
    fs.writeFileSync(
      path.join(dirB, 'app-hub.config.json'),
      JSON.stringify({ name: 'b', slug: 'test-dup-mount-b', start: 'x', mountPath: '/test-shared-mount' })
    );
    assert.throws(() => loadApps(), /mountPath "\/test-shared-mount" is declared by both/);
  })
);

test(
  'a mountPath of a reserved prefix throws',
  withTempApps(['test-reserved-mount'], (dir) => {
    fs.writeFileSync(path.join(dir, 'app-hub.config.json'), JSON.stringify({ name: 'x', slug: 'test-reserved-mount', start: 'x', mountPath: '/api' }));
    assert.throws(() => loadApps(), /reserves for its own routes/);
  })
);

test(
  'two apps declaring the same explicit slug throws',
  withTempApps(['test-dup-slug-a', 'test-dup-slug-b'], (dirA, dirB) => {
    fs.writeFileSync(path.join(dirA, 'app-hub.config.json'), JSON.stringify({ name: 'a', slug: 'test-shared-slug', start: 'x' }));
    fs.writeFileSync(path.join(dirB, 'app-hub.config.json'), JSON.stringify({ name: 'b', slug: 'test-shared-slug', start: 'x' }));
    assert.throws(() => loadApps(), /Slug "test-shared-slug" is declared by both/);
  })
);

test(
  'a slug with regex/path-unsafe characters throws instead of crashing later in Express',
  withTempApps(['test-unsafe-slug'], (dir) => {
    fs.writeFileSync(path.join(dir, 'app-hub.config.json'), JSON.stringify({ name: 'x', slug: 'my(app', start: 'x' }));
    assert.throws(() => loadApps(), /isn't a valid slug/);
  })
);
