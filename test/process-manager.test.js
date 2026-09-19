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
    // No .nvmrc pin at all — there's nothing to fall back from, so `source`
    // is "system" without `requested` being set (this is what the home
    // page's badge relies on to stay hidden for unpinned apps).
    assert.deepEqual(state.node, { requested: null, used: process.version, source: 'system' });

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

test('an app pinning a Node version via .nvmrc runs its start command under fnm\'s resolved version', async (t) => {
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
    // currentVersion was deliberately passed without a leading "v" above —
    // state.node should still normalize it to match process.version exactly.
    assert.deepEqual(state.node, { requested: process.version, used: process.version, source: 'fnm' });
  } finally {
    if (state.child && state.child.exitCode === null) await stopApp(state);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Node-version-pinned app whose start command invokes npm (not node directly) still starts', async (t) => {
  if (!(await isCommandAvailable('fnm'))) {
    t.skip('fnm is not installed on this machine — see README\'s "Pinning a sub-app\'s Node version"');
    return;
  }
  // Regression test: fnm exec spawns its target command directly rather
  // than through a shell, so on Windows it can't resolve "npm" (an
  // npm.cmd shim, not a real .exe) at all — "npm start" would fail with
  // "Can't spawn program: program not found" even though the exact same
  // command works fine outside a pinned-version app. process-manager.js
  // no longer uses `fnm exec` for this reason (see lib/fnm.js); this test
  // exercises exactly the code path ("npm start" under a pin) that broke.
  const currentVersion = process.version.replace(/^v/, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-hub-test-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'npm-start-pinned-test', scripts: { start: 'node index.js' } })
  );
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    "require('http').createServer((req,res)=>res.end('ok')).listen(process.env.PORT);"
  );
  const port = await getFreePort();

  const state = startApp({
    slug: 'npm-start-pinned-test',
    dir,
    start: 'npm start',
    port,
    healthPath: '/',
    requiredCommands: [],
    nodeVersion: currentVersion,
  });

  try {
    const deadline = Date.now() + 30000;
    while (state.status === STATUS.STARTING && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(state.status, STATUS.RUNNING, `expected running, got ${state.status} (${state.error})`);
    assert.equal(state.node.source, 'fnm');
  } finally {
    if (state.child && state.child.exitCode === null) await stopApp(state);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stopping an app while a real fnm install is still in flight kills it through the actual startApp/beginStart path', async (t) => {
  if (!(await isCommandAvailable('fnm'))) {
    t.skip('fnm is not installed on this machine — see README\'s "Pinning a sub-app\'s Node version"');
    return;
  }
  // The other installChild test (further down) injects a synthetic
  // installChild straight into stopApp/killTree, which only proves those
  // two functions cooperate correctly — it never exercises beginStart's own
  // onSpawn wiring (`installNodeVersion(app.nodeVersion, (child) => {
  // state.installChild = child; })`) at all. This one goes through the real
  // startApp() -> beginStart() path with an actual `fnm install` child, so a
  // regression in that wiring (e.g. the callback silently not firing) would
  // actually be caught here.
  const currentVersion = process.version.replace(/^v/, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-hub-test-'));
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    "require('http').createServer((req,res)=>res.end('ok')).listen(process.env.PORT);"
  );
  const port = await getFreePort();

  const state = startApp({
    slug: 'stop-during-fnm-install-test',
    dir,
    start: 'node index.js',
    port,
    healthPath: '/',
    requiredCommands: [],
    // Already installed (it's literally the Node running these tests), so
    // `fnm install` doesn't need real network access — but it still spawns
    // a genuine fnm process and takes real, non-zero wall-clock time to
    // confirm that and exit, which is the window this test races to stop
    // it inside of.
    nodeVersion: currentVersion,
  });

  // Poll for state.installChild to appear — set synchronously the instant
  // installNodeVersion's onSpawn callback fires — then stop as soon as it
  // does, to land inside that window as often as real timing allows.
  const detectDeadline = Date.now() + 5000;
  while (!state.installChild && Date.now() < detectDeadline) {
    await new Promise((r) => setTimeout(r, 1));
  }
  const installChildRef = state.installChild;

  await stopApp(state);

  try {
    assert.equal(state.status, STATUS.STOPPED, `expected a clean stop, got ${state.status} (${state.error})`);
    assert.equal(state.child, null, "the app's own process should never have been spawned");
    if (installChildRef) {
      // Whether stopApp actually had to kill it (caught mid-install) or it
      // had already finished on its own by the time stopApp ran, either way
      // it should be a real, exited process now — never left running.
      assert.ok(
        installChildRef.exitCode !== null || installChildRef.signalCode !== null,
        'the fnm install child should be a real process that has actually exited, not left running'
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a loose .nvmrc version specifier (e.g. "20") resolves to fnm\'s actual installed version, not a literal-string mismatch', async (t) => {
  if (!(await isCommandAvailable('fnm'))) {
    t.skip('fnm is not installed on this machine — see README\'s "Pinning a sub-app\'s Node version"');
    return;
  }
  // `fnm install 20` installs under a fully-qualified folder name (e.g.
  // v20.20.2), never one literally named "v20" or "20" — process-manager.js
  // asks fnm what it actually resolved to (lib/fnm.js's resolveFnmVersion)
  // rather than assuming the requested string matches a real install, so
  // this should still succeed via fnm, just with `used` != `requested`.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-hub-test-'));
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    "require('http').createServer((req,res)=>res.end('ok')).listen(process.env.PORT);"
  );
  const port = await getFreePort();

  const state = startApp({
    slug: 'loose-nvmrc-test',
    dir,
    start: 'node index.js',
    port,
    healthPath: '/',
    requiredCommands: [],
    nodeVersion: '20',
  });

  try {
    const deadline = Date.now() + 60000;
    while (state.status === STATUS.STARTING && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(state.status, STATUS.RUNNING, `expected running, got ${state.status} (${state.error})`);
    assert.equal(state.node.source, 'fnm');
    assert.equal(state.node.requested, 'v20');
    assert.match(state.node.used, /^v20\.\d+\.\d+$/, `expected a fully-qualified v20.x.x, got ${state.node.used}`);
  } finally {
    if (state.child && state.child.exitCode === null) await stopApp(state);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a machine with no fnm on PATH at all still falls through to the system Node, instead of hard-blocking on "missing required command"', async () => {
  const originalPath = process.env.PATH;
  try {
    // Empty PATH so the shell can't find an `fnm` binary at all — simulates
    // a machine that never installed fnm. Use an absolute path to node for
    // the app's own start command so this doesn't also break app-hub's own
    // final spawn (which doesn't need PATH to find node).
    process.env.PATH = '';
    const state = startApp({
      slug: 'no-fnm-on-path-test',
      dir: __dirname,
      start: `"${process.execPath}" -e "process.exit(0)"`,
      port: 1,
      requiredCommands: [],
      nodeVersion: '22.22.0',
    });
    const deadline = Date.now() + 15000;
    while (state.status === STATUS.STARTING && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.doesNotMatch(
      state.error || '',
      /missing required command/,
      'fnm being entirely absent from PATH should fall through fnm -> nvm -> system, not hard-block startup'
    );
    assert.equal(state.node.source, 'system');
  } finally {
    process.env.PATH = originalPath;
  }
});

test('when fnm cannot install the pinned version and nvm is unavailable too, the app still runs under the system Node', async (t) => {
  if (!(await isCommandAvailable('fnm'))) {
    t.skip('fnm is not installed on this machine — see README\'s "Pinning a sub-app\'s Node version"');
    return;
  }
  const state = startApp({
    slug: 'bad-nvmrc-test',
    dir: __dirname,
    start: 'node -e "process.exit(0)"',
    port: 1,
    requiredCommands: [],
    // Not a real Node version — fnm (and, if present, nvm) will fail to
    // install it, forcing the fallback-to-system-Node path.
    nodeVersion: 'not-a-real-version-xyz',
  });
  const deadline = Date.now() + 30000;
  while (state.status === STATUS.STARTING && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  // Falling back means the app still runs (under app-hub's own Node)
  // instead of being blocked entirely by a version-manager problem.
  assert.equal(state.status, STATUS.STOPPED, `expected a clean run+exit, got ${state.status} (${state.error})`);
  assert.equal(state.error, null);
  assert.deepEqual(state.node, { requested: 'vnot-a-real-version-xyz', used: process.version, source: 'system' });
});

test('pollUntilHealthy keeps polling indefinitely against a port nothing answers on yet, instead of giving up on a timeout', async () => {
  const port = await getFreePort();
  const state = {
    app: { port, healthPath: '/' },
    status: STATUS.STARTING,
    error: null,
    child: null,
  };

  // Fires the poll loop but doesn't await it — a build-heavy app's `start`
  // can take minutes, and pollUntilHealthy now has no timeout of its own to
  // wait out. A few missed checks against a dead port is enough to show it
  // hasn't given up and errored.
  pollUntilHealthy(state, 10);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(state.status, STATUS.STARTING, 'should still be starting, not erroring out on a timeout');
  assert.equal(state.error, null);

  state.status = STATUS.STOPPED;
});

test('pollUntilHealthy stops polling once stopApp() marks the state STOPPED, instead of running forever', async () => {
  const port = await getFreePort();
  const state = {
    app: { port, healthPath: '/' },
    status: STATUS.STARTING,
    error: null,
    child: null,
  };

  const pollPromise = pollUntilHealthy(state, 10);
  await new Promise((resolve) => setTimeout(resolve, 30));
  state.status = STATUS.STOPPED;

  await pollPromise;

  assert.equal(state.status, STATUS.STOPPED);
});

test('stopApp kills an in-flight installChild (e.g. a still-running fnm/nvm install), not just the app itself', async () => {
  // Mirrors how installNodeVersion/installViaNvm spawn their install
  // process (shell: true, detached off Windows) — a long-running stand-in
  // so there's something real for stopApp to actually have to kill, rather
  // than something that would exit on its own during the test.
  const { spawn } = require('node:child_process');
  const installChild = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], {
    detached: process.platform !== 'win32',
  });
  await new Promise((resolve) => installChild.once('spawn', resolve));

  const state = { app: {}, status: STATUS.STARTING, error: null, child: null, installChild };

  await stopApp(state);

  assert.equal(state.status, STATUS.STOPPED);
  // Killed via SIGTERM on POSIX, a process that dies from a signal (rather
  // than exiting normally) gets exitCode === null with signalCode holding
  // the signal name instead — only Windows' taskkill gives it a real exit
  // code. Checking exitCode alone would wrongly fail here on Mac/Linux even
  // though the kill worked, so accept either as proof it's actually dead.
  assert.ok(
    installChild.exitCode !== null || installChild.signalCode !== null,
    'the install child should actually have been killed, not left running'
  );
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
