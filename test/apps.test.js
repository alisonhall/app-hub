const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { APPS_DIR, ALIASES_CONFIG_PATH, loadApps, computeSlugAlias } = require('../lib/apps');

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

test(
  'a mountPath with a disallowed character throws',
  withTempApps(['test-unsafe-mount'], (dir) => {
    fs.writeFileSync(
      path.join(dir, 'app-hub.config.json'),
      JSON.stringify({ name: 'x', slug: 'test-unsafe-mount', start: 'x', mountPath: '/my app (backup)' })
    );
    assert.throws(() => loadApps(), /invalid mountPath/);
  })
);

// apps.config.json is gitignored and usually absent in a fresh checkout —
// these tests write/remove it directly, restoring whatever (if anything)
// was there before, since a developer's own real aliases could be sitting
// in that file.
function withAliasesConfig(config, fn) {
  return async () => {
    const hadExisting = fs.existsSync(ALIASES_CONFIG_PATH);
    const backup = hadExisting ? fs.readFileSync(ALIASES_CONFIG_PATH, 'utf8') : null;
    try {
      fs.writeFileSync(ALIASES_CONFIG_PATH, JSON.stringify(config));
      await fn();
    } finally {
      if (hadExisting) fs.writeFileSync(ALIASES_CONFIG_PATH, backup);
      else fs.rmSync(ALIASES_CONFIG_PATH, { force: true });
    }
  };
}

test(
  'an aliased app whose path no longer exists is reported as unconfigured, not thrown',
  withAliasesConfig({ apps: [path.join(APPS_DIR, '..', 'totally-nonexistent-aliased-app-xyz')] }, () => {
    const apps = loadApps();
    const aliased = apps.find((a) => a.folderName === 'totally-nonexistent-aliased-app-xyz');
    assert.ok(aliased, 'aliased entry should still appear');
    assert.equal(aliased.configured, false);
    assert.match(aliased.description, /not found/);
  })
);

test('an aliased app sharing a slug with a folder app is skipped in favor of the folder app', async () => {
  const folderDir = path.join(APPS_DIR, 'test-alias-slug-clash');
  const aliasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-hub-alias-clash-'));
  const hadExisting = fs.existsSync(ALIASES_CONFIG_PATH);
  const backup = hadExisting ? fs.readFileSync(ALIASES_CONFIG_PATH, 'utf8') : null;

  try {
    fs.mkdirSync(folderDir, { recursive: true });
    fs.writeFileSync(
      path.join(folderDir, 'app-hub.config.json'),
      JSON.stringify({ name: 'folder-version', slug: 'test-alias-slug-clash', start: 'x' })
    );
    fs.writeFileSync(
      path.join(aliasDir, 'app-hub.config.json'),
      JSON.stringify({ name: 'aliased-version', slug: 'test-alias-slug-clash', start: 'x' })
    );
    fs.writeFileSync(ALIASES_CONFIG_PATH, JSON.stringify({ apps: [aliasDir] }));

    const apps = loadApps();
    const matches = apps.filter((a) => a.slug === 'test-alias-slug-clash');
    assert.equal(matches.length, 1, 'only the folder app should survive the slug clash');
    assert.equal(matches[0].name, 'folder-version');
  } finally {
    fs.rmSync(folderDir, { recursive: true, force: true });
    fs.rmSync(aliasDir, { recursive: true, force: true });
    if (hadExisting) fs.writeFileSync(ALIASES_CONFIG_PATH, backup);
    else fs.rmSync(ALIASES_CONFIG_PATH, { force: true });
  }
});

test('computeSlugAlias returns the "/<slug>" alias when nothing conflicts', () => {
  const appConfig = { slug: 'my-app', mountPath: '/apps/my-app' };
  assert.equal(computeSlugAlias(appConfig, new Set(['/apps/my-app'])), '/my-app');
});

test('computeSlugAlias returns null when the alias would equal the real mountPath', () => {
  const appConfig = { slug: 'my-app', mountPath: '/my-app' };
  assert.equal(computeSlugAlias(appConfig, new Set(['/my-app'])), null);
});

test('computeSlugAlias returns null when the alias collides with another app\'s mountPath', () => {
  const appConfig = { slug: 'my-app', mountPath: '/apps/my-app' };
  assert.equal(computeSlugAlias(appConfig, new Set(['/apps/my-app', '/my-app'])), null);
});

test('computeSlugAlias returns null when the alias collides with a reserved prefix', () => {
  const appConfig = { slug: 'api', mountPath: '/apps/api' };
  assert.equal(computeSlugAlias(appConfig, new Set(['/apps/api'])), null);
});
