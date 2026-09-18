const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { startApp, stopApp, STATUS, pollUntilHealthy } = require('../lib/process-manager');
const { getFreePort } = require('../lib/ports');
const { isCommandAvailable } = require('../lib/deps');

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

test('stopApp called while still starting (before the child is even spawned) prevents it from ever launching', async () => {
  const state = startApp({
    slug: 'stop-during-start-test',
    dir: __dirname,
    start: 'node -e "process.exit(0)"',
    port: 1,
    requiredCommands: [],
    nodeVersion: null,
  });
  assert.equal(state.status, STATUS.STARTING);

  // Synchronous with startApp() returning: beginStart's first `await` (the
  // requiredCommands check) hasn't resolved yet, so state.child is still
  // null here — this is exactly the race the STOPPED guards in beginStart
  // exist for.
  await stopApp(state);
  assert.equal(state.status, STATUS.STOPPED);

  // Give beginStart's still-pending async steps room to run and confirm
  // they actually bail out instead of spawning anyway.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(state.child, null, 'the process should never have been spawned');
});

test('an app that exits unexpectedly on its own (not via stopApp) records the exit code as an error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-hub-test-'));
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    "const http = require('http');" +
      "const server = http.createServer((req,res)=>res.end('ok'));" +
      // Long enough that the health-check poll (every 1s) has time to see it
      // running at least once before it exits on its own.
      "server.listen(process.env.PORT, () => setTimeout(() => process.exit(7), 2500));"
  );
  const port = await getFreePort();

  const state = startApp({
    slug: 'self-crash-test',
    dir,
    start: 'node index.js',
    port,
    healthPath: '/',
    requiredCommands: [],
    nodeVersion: null,
  });

  try {
    let deadline = Date.now() + 15000;
    while (state.status === STATUS.STARTING && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(state.status, STATUS.RUNNING, `expected running, got ${state.status} (${state.error})`);

    deadline = Date.now() + 5000;
    while (state.status === STATUS.RUNNING && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(state.status, STATUS.STOPPED, 'an unexpected exit still leaves status as stopped, not error');
    assert.match(state.error, /exited with code 7/);
  } finally {
    if (state.child && state.child.exitCode === null) await stopApp(state);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an app pinning a Node version via .nvmrc runs its start command through fnm exec', async (t) => {
  if (!(await isCommandAvailable('fnm'))) {
    t.skip('fnm is not installed on this machine — see README\'s "Pinning a sub-app\'s Node version"');
    return;
  }
  const currentVersion = process.version.replace(/^v/, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-hub-test-'));
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    "require('http').createServer((req,res)=>res.end('ok')).listen(process.env.PORT);"
  );
  const port = await getFreePort();

  const state = startApp({
    slug: 'nvmrc-test',
    dir,
    start: 'node index.js',
    port,
    healthPath: '/',
    requiredCommands: [],
    // Pin to whatever Node is already running these tests, so this doesn't
    // depend on that specific version being pre-installed via `fnm install`.
    nodeVersion: currentVersion,
  });

  try {
    const deadline = Date.now() + 30000;
    while (state.status === STATUS.STARTING && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(state.status, STATUS.RUNNING, `expected running, got ${state.status} (${state.error})`);
  } finally {
    if (state.child && state.child.exitCode === null) await stopApp(state);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pollUntilHealthy gives up and sets an error after exhausting its attempts against a port nothing answers on', async () => {
  const port = await getFreePort();
  const state = { app: { port, healthPath: '/' }, status: STATUS.STARTING, error: null, child: null };

  await pollUntilHealthy(state, 2, 10);

  assert.equal(state.status, STATUS.ERROR);
  assert.match(state.error, /did not become healthy/);
});

test('a concurrent second stopApp() call shares the in-flight promise instead of sending a redundant kill', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-hub-test-'));
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    "require('http').createServer((req,res)=>res.end('ok')).listen(process.env.PORT);"
  );
  const port = await getFreePort();

  const state = startApp({
    slug: 'double-stop-test',
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

    const first = stopApp(state);
    const second = stopApp(state);
    assert.equal(first, second, 'a stop already in flight should be reused, not duplicated');

    await Promise.all([first, second]);
    assert.equal(state.status, STATUS.STOPPED);
    assert.equal(state.error, null);
    assert.equal(await isPortFree(port), true, 'port should be free again after stopApp');
  } finally {
    if (state.child && state.child.exitCode === null) await stopApp(state);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
