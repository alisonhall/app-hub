const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { startApp, stopApp, STATUS } = require('../lib/process-manager');
const { getFreePort } = require('../lib/ports');

test('startApp returns an error status for a missing requiredCommand, without spawning anything', async () => {
  const state = startApp({
    slug: 'missing-cmd-test',
    dir: __dirname,
    start: 'node -e "process.exit(0)"',
    port: 1,
    requiredCommands: ['totally-fake-command-xyz'],
    nodeVersion: null,
  });
  // The required-command check now runs asynchronously (see lib/deps.js),
  // so startApp always returns STARTING immediately — wait for it to settle.
  assert.equal(state.status, STATUS.STARTING);
  const deadline = Date.now() + 5000;
  while (state.status === STATUS.STARTING && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(state.status, STATUS.ERROR);
  assert.match(state.error, /missing required command\(s\): totally-fake-command-xyz/);
  assert.equal(state.child, null);
});

test('a spawn failure (e.g. a nonexistent cwd) sets an error status instead of crashing the process', async () => {
  const state = startApp({
    slug: 'broken-cwd-test',
    dir: path.join(os.tmpdir(), 'app-hub-test-nonexistent-dir-xyz'),
    start: 'echo hi',
    port: 1,
    requiredCommands: [],
    nodeVersion: null,
  });
  const deadline = Date.now() + 5000;
  while (state.status === STATUS.STARTING && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(state.status, STATUS.ERROR);
  assert.match(state.error, /failed to start/);
});

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

test('startApp/stopApp full cycle: spawns, becomes healthy, then stops cleanly with no lingering error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-hub-test-'));
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    "require('http').createServer((req,res)=>res.end('ok')).listen(process.env.PORT);"
  );
  const port = await getFreePort();

  const state = startApp({
    slug: 'cycle-test',
    dir,
    start: 'node index.js',
    port,
    healthPath: '/',
    requiredCommands: [],
    nodeVersion: null,
  });

  try {
    const deadline = Date.now() + 15000;
    while (state.status === STATUS.STARTING && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(state.status, STATUS.RUNNING, `expected running, got ${state.status} (${state.error})`);

    await stopApp(state);
    assert.equal(state.status, STATUS.STOPPED);
    assert.equal(state.error, null);
    assert.equal(await isPortFree(port), true, 'port should be free again after stopApp');
  } finally {
    // exitCode is the reliable signal here: `killed` only ever gets set by
    // Node when child.kill() itself was called, which isn't every path
    // stopApp takes (e.g. Windows' taskkill or POSIX process.kill() bypass
    // it entirely), so it can't tell us whether the process already exited.
    if (state.child && state.child.exitCode === null) await stopApp(state);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
