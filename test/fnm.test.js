const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getFnmDir, fnmVersionBinDir, fnmHasVersion, resolveFnmVersion } = require('../lib/fnm');
const { isCommandAvailable } = require('../lib/deps');

const IS_WINDOWS = process.platform === 'win32';
const NODE_BIN_NAME = IS_WINDOWS ? 'node.exe' : 'node';

test('fnmVersionBinDir mirrors fnm\'s on-disk layout for this platform (flat on Windows, bin/ elsewhere)', () => {
  const binDir = fnmVersionBinDir('C:/fake-fnm', 'v20.11.1');
  const expectedInstallDir = path.join('C:/fake-fnm', 'node-versions', 'v20.11.1', 'installation');
  assert.equal(binDir, IS_WINDOWS ? expectedInstallDir : path.join(expectedInstallDir, 'bin'));
});

test('fnmHasVersion reflects whether that exact version is actually on disk, not just whether fnm installed something', () => {
  const fnmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-hub-fake-fnm-'));
  try {
    assert.equal(fnmHasVersion(fnmDir, 'v20.11.1'), false, 'empty fnm dir should not claim to have any version');

    const binDir = fnmVersionBinDir(fnmDir, 'v20.11.1');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, NODE_BIN_NAME), '');

    assert.equal(fnmHasVersion(fnmDir, 'v20.11.1'), true);
    // The exact scenario this guards against: `fnm install 20` resolves to
    // and stores under a fully-qualified version like v20.20.2, never a
    // folder literally named "v20" — so asking for the loose specifier
    // itself must not falsely match a different, unrelated exact version.
    assert.equal(fnmHasVersion(fnmDir, 'v20'), false, 'a loose specifier should not match an installed exact version');
    assert.equal(fnmHasVersion(fnmDir, 'v20.11.2'), false, 'a different exact version should not match');
  } finally {
    fs.rmSync(fnmDir, { recursive: true, force: true });
  }
});

test('getFnmDir resolves fnm\'s own configured data directory', async (t) => {
  if (!(await isCommandAvailable('fnm'))) {
    t.skip('fnm is not installed on this machine');
    return;
  }
  const dir = await getFnmDir();
  assert.ok(dir, 'fnm env should report FNM_DIR');
  assert.ok(fs.existsSync(dir), `${dir} should actually exist`);
});

test('resolveFnmVersion resolves a loose specifier to the exact fully-qualified version fnm actually installed', async (t) => {
  if (!(await isCommandAvailable('fnm'))) {
    t.skip('fnm is not installed on this machine');
    return;
  }
  // Assumes some v20.x.x is already installed (true on this machine as of
  // earlier testing in this session) — this test is about resolution, not
  // installation, so it doesn't install anything itself.
  const resolved = await resolveFnmVersion('20');
  assert.match(resolved, /^v20\.\d+\.\d+$/, `expected a fully-qualified v20.x.x, got ${resolved}`);
});

test('resolveFnmVersion resolves an already-exact version to itself', async (t) => {
  if (!(await isCommandAvailable('fnm'))) {
    t.skip('fnm is not installed on this machine');
    return;
  }
  const resolved = await resolveFnmVersion(process.version);
  assert.equal(resolved, process.version);
});

test('resolveFnmVersion returns null for a version fnm has never installed, instead of throwing or hanging', async (t) => {
  if (!(await isCommandAvailable('fnm'))) {
    t.skip('fnm is not installed on this machine');
    return;
  }
  const resolved = await resolveFnmVersion('not-a-real-version-xyz');
  assert.equal(resolved, null);
});
