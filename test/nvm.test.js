const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findNvmDir, installViaNvm, normalizeVersion, nvmHasVersion } = require('../lib/nvm');

test('normalizeVersion adds a leading "v" if missing', () => {
  assert.equal(normalizeVersion('22.22.0'), 'v22.22.0');
  assert.equal(normalizeVersion('v22.22.0'), 'v22.22.0');
});

test('findNvmDir returns null when NVM_DIR has no nvm.sh (also covers Windows, where nvm-sh isn\'t supported)', () => {
  const originalNvmDir = process.env.NVM_DIR;
  try {
    process.env.NVM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'app-hub-fake-nvm-'));
    assert.equal(findNvmDir(), null);
  } finally {
    if (originalNvmDir === undefined) delete process.env.NVM_DIR;
    else process.env.NVM_DIR = originalNvmDir;
  }
});

test('nvmHasVersion reflects whether that exact version is actually on disk, not just whether nvm is installed', () => {
  const nvmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-hub-fake-nvm-'));
  try {
    assert.equal(nvmHasVersion(nvmDir, '20.11.1'), false, 'empty nvm dir should not claim to have any version');

    const binDir = path.join(nvmDir, 'versions', 'node', 'v20.11.1', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'node'), '');

    assert.equal(nvmHasVersion(nvmDir, '20.11.1'), true, 'without a leading v');
    assert.equal(nvmHasVersion(nvmDir, 'v20.11.1'), true, 'with a leading v');
    assert.equal(nvmHasVersion(nvmDir, '20.11.2'), false, 'a different version should not match');
  } finally {
    fs.rmSync(nvmDir, { recursive: true, force: true });
  }
});

test('installViaNvm fails clearly when nvm isn\'t found', async () => {
  const originalNvmDir = process.env.NVM_DIR;
  try {
    process.env.NVM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'app-hub-fake-nvm-'));
    const result = await installViaNvm('22.22.0');
    assert.equal(result.success, false);
    assert.match(result.stderr, /nvm not found/);
    assert.equal(result.binDir, undefined, 'no binDir should be reported on failure');
  } finally {
    if (originalNvmDir === undefined) delete process.env.NVM_DIR;
    else process.env.NVM_DIR = originalNvmDir;
  }
});
