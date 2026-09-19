const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { isCommandAvailable, IS_WINDOWS } = require('./deps');
const { installViaNvm, normalizeVersion } = require('./nvm');
const { getFnmDir, fnmVersionBinDir, fnmHasVersion, resolveFnmVersion } = require('./fnm');

const STATUS = {
  STARTING: 'starting',
  RUNNING: 'running',
  ERROR: 'error',
  STOPPED: 'stopped',
  NOT_CONFIGURED: 'not-configured',
};

function checkHealth(port, healthPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: healthPath, timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Deliberately doesn't include `fnm` even when app.nodeVersion is set: fnm
// missing entirely is just another way installNodeVersion() below can fail
// (spawn() reports it via the same 'error'/non-zero-exit path as any other
// fnm failure), and beginStart's fnm → nvm → system fallback chain already
// handles that gracefully. Hard-failing here instead would block the nvm
// fallback from ever running on a machine that has nvm but not fnm.
async function missingRequiredCommands(app) {
  const required = app.requiredCommands || [];
  const availability = await Promise.all(required.map((cmd) => isCommandAvailable(cmd)));
  return required.filter((_cmd, i) => !availability[i]);
}

// Runs `fnm install` without spawnSync, so a cold install (a real network
// download of a Node version, potentially many seconds) doesn't block the
// event loop — which would otherwise freeze every other app's traffic on
// this same server for the whole download, not just this one app's start.
//
// stderr is captured (not just a pass/fail code) because "fnm failed" alone
// isn't actionable — the actual reason (no network/proxy blocking the
// download, a stale fnm install, disk/permission issues, etc.) can differ
// wildly machine to machine, and that reason is exactly what fnm prints.
function installNodeVersion(version) {
  return new Promise((resolve) => {
    let stderr = '';
    const child = spawn('fnm', ['install', version], { shell: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => resolve({ success: false, stderr: err.message }));
    child.on('exit', (code) => resolve({ success: code === 0, stderr: stderr.trim() }));
  });
}

function startApp(app) {
  const state = {
    app,
    status: STATUS.STARTING,
    error: null,
    child: null,
    // Normalized up front so the badge shows a consistent "vX.Y.Z" whether
    // the .nvmrc happened to include the leading "v" or not (fnm/nvm accept
    // either, but process.version — used for the system fallback below —
    // is always v-prefixed, so leaving this un-normalized would make the
    // two look inconsistent for no reason).
    node: { requested: app.nodeVersion ? normalizeVersion(app.nodeVersion) : null, used: null, source: null },
  };
  beginStart(app, state);
  return state;
}

// The actual work of starting an app, all off the synchronous call path:
// startApp() above returns `state` immediately (as STARTING) and this
// mutates it in place as each async step completes, exactly like
// pollUntilHealthy already did for health-checking.
async function beginStart(app, state) {
  const missing = await missingRequiredCommands(app);
  if (missing.length) {
    state.status = STATUS.ERROR;
    state.error = `missing required command(s): ${missing.join(', ')} (run \`npm run check-deps\` for install instructions)`;
    return;
  }

  // A stop requested while the check above was still running shouldn't
  // trigger a pointless (if harmless) fnm install afterward.
  if (state.status === STATUS.STOPPED) return;

  let versionBinDir = null;

  if (app.nodeVersion) {
    const fnmResult = await installNodeVersion(app.nodeVersion);
    let fnmFailureReason = fnmResult.stderr || 'unknown error';

    if (fnmResult.success) {
      // A stop requested while the fnm install above was running shouldn't
      // still trigger the pointless resolve/lookup calls below.
      if (state.status === STATUS.STOPPED) return;

      // `fnm install` resolves a loose specifier (e.g. a .nvmrc of just
      // "20") to whatever full version it actually installs, so the
      // requested string itself often isn't what's on disk — ask fnm what
      // it actually resolved to (see lib/fnm.js's resolveFnmVersion) rather
      // than assuming state.node.requested matches a real install.
      const resolvedVersion = await resolveFnmVersion(app.nodeVersion);
      if (!resolvedVersion) {
        fnmFailureReason = 'fnm installed it, but the exact resolved version could not be determined';
      } else {
        if (state.status === STATUS.STOPPED) return;
        const fnmDir = await getFnmDir();
        if (!fnmDir) {
          fnmFailureReason = "fnm installed it, but fnm's own data directory could not be determined";
        } else if (!fnmHasVersion(fnmDir, resolvedVersion)) {
          // Belt-and-suspenders: resolveFnmVersion already asked fnm
          // directly, so this "shouldn't" happen, but silently prepending
          // a nonexistent directory onto PATH (see fnmHasVersion's doc
          // comment) is exactly the kind of silent failure worth never
          // trusting on assumption alone.
          fnmFailureReason = `fnm resolved ${app.nodeVersion} to ${resolvedVersion}, but it isn't on disk under that exact name`;
        } else {
          state.node.used = resolvedVersion;
          state.node.source = 'fnm';
          versionBinDir = fnmVersionBinDir(fnmDir, resolvedVersion);
        }
      }
    }

    if (state.node.source !== 'fnm') {
      // A stop requested while any of the above was still running
      // shouldn't still trigger a pointless nvm install attempt afterward.
      if (state.status === STATUS.STOPPED) return;

      // fnm couldn't get this version itself (e.g. no arm64 build published
      // upstream for this exact patch, no network access to nodejs.org, or
      // fnm isn't even installed — missingRequiredCommands deliberately
      // doesn't hard-block on that, see above). If nvm already has it — a
      // common case when someone installed it another way before app-hub
      // ever tried — reuse that copy directly (see lib/nvm.js) instead of
      // failing outright.
      const nvmResult = await installViaNvm(app.nodeVersion);
      if (nvmResult.success) {
        state.node.used = state.node.requested;
        state.node.source = 'nvm';
        versionBinDir = nvmResult.binDir;
      } else {
        // Neither fnm nor nvm could get it. Rather than blocking the app
        // entirely over a version-manager problem, fall back to running it
        // under whatever Node started app-hub itself — degraded, but
        // running beats not running. state.node records this so the home
        // page can flag it as a fallback instead of silently mismatching.
        console.warn(
          `[${app.slug}] could not get Node ${app.nodeVersion} via fnm (${fnmFailureReason}) ` +
            `or nvm (${nvmResult.stderr}) — falling back to the system Node (${process.version}) that started app-hub.`
        );
        state.node.used = process.version;
        state.node.source = 'system';
      }
    }
  } else {
    state.node.used = process.version;
    state.node.source = 'system';
  }

  // Same, for a stop requested during a slow fnm/nvm install.
  if (state.status === STATUS.STOPPED) return;

  const child = spawn(app.start, {
    cwd: app.dir,
    // Deliberately the platform's native shell (cmd.exe on Windows), not a
    // POSIX shell like bash: Git-for-Windows' bash re-execs itself into the
    // target process (an MSYS emulation of POSIX exec()), which orphans it
    // from the PID spawn() reports — breaking stopApp's tree-kill below.
    // See README's note on `start` command portability.
    shell: true,
    env: {
      ...process.env,
      PORT: String(app.port),
      // Run under the app's pinned Node version (via .nvmrc), if fnm or nvm
      // provided one, by putting its bin dir first on PATH instead of
      // whatever Node started app-hub. Deliberately not `fnm exec
      // --using=...`: that spawns its target command directly rather than
      // through a shell, so on Windows it can't resolve `npm` (an
      // `npm.cmd` shim, not a real .exe) at all — see lib/fnm.js. Going
      // through our own shell:true spawn here instead sidesteps that.
      ...(versionBinDir ? { PATH: `${versionBinDir}${path.delimiter}${process.env.PATH}` } : {}),
    },
    // With shell: true, `child` is the shell, not the app's actual process
    // (e.g. npm start's node). On POSIX, detaching makes the shell the
    // leader of its own process group, so stopApp can kill the whole group
    // instead of just the shell wrapper and orphaning the real process.
    detached: !IS_WINDOWS,
  });
  state.child = child;

  const prefix = `[${app.slug}]`;
  child.stdout.on('data', (chunk) => process.stdout.write(`${prefix} ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`${prefix} ${chunk}`));

  // Without this, a spawn failure (e.g. a stale/deleted cwd for an aliased
  // app) is an unhandled 'error' event on the ChildProcess EventEmitter,
  // which Node treats as fatal by default — crashing this whole app-hub
  // process, taking every other running app down with it, not just this one.
  child.on('error', (err) => {
    state.status = STATUS.ERROR;
    state.error = `failed to start: ${err.message}`;
  });

  child.on('exit', (code) => {
    state.status = STATUS.STOPPED;
    // A deliberate stopApp() kill also exits non-zero (SIGTERM/taskkill), but
    // that's not a crash — don't overwrite the clean stop with a spurious error.
    if (!state.stoppedByUser && code && code !== 0) {
      state.error = `exited with code ${code}`;
    }
  });

  pollUntilHealthy(state);
}

async function pollUntilHealthy(state, attempts = 30, intervalMs = 1000) {
  for (let i = 0; i < attempts; i += 1) {
    // STOPPED: stopApp() was called. ERROR: the child already emitted
    // 'error' (e.g. a spawn failure) — either way the outcome is already
    // decided, so don't keep polling a port nothing will ever answer on.
    if (state.status === STATUS.STOPPED || state.status === STATUS.ERROR) return;
    // eslint-disable-next-line no-await-in-loop
    const healthy = await checkHealth(state.app.port, state.app.healthPath);
    if (healthy) {
      state.status = STATUS.RUNNING;
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (state.status !== STATUS.STOPPED && state.status !== STATUS.ERROR) {
    state.status = STATUS.ERROR;
    state.error = state.error || `did not become healthy within ${attempts * intervalMs / 1000}s`;
  }
}

// Resolves only once the process has actually exited (not just once the
// kill signal was issued), so callers that restart an app right after
// stopping it (ensureStarted) can't race a still-dying old process for the
// same port. Windows' taskkill in particular isn't instantaneous.
function stopApp(state) {
  state.stoppedByUser = true;

  if (!state.child || state.child.killed || state.child.exitCode !== null) {
    state.status = STATUS.STOPPED;
    state.error = null;
    return Promise.resolve();
  }

  // A second stop() call (e.g. a rapid double-click) while the first kill is
  // still in flight would otherwise attach its own 'exit' listener and send
  // a redundant taskkill/SIGTERM — harmless, but wasteful. Share the one
  // in-flight promise instead.
  if (state.stopping) return state.stopping;

  const child = state.child;
  state.stopping = new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      state.status = STATUS.STOPPED;
      state.error = null;
      state.stopping = null;
      resolve();
    };
    child.once('exit', finish);
    // Safety net in case the exit event never fires (e.g. the process was
    // already gone by the time the signal was sent).
    const safetyTimer = setTimeout(finish, 5000);

    // A plain kill() only signals the shell wrapper spawn() created for
    // `shell: true`, leaving the app's actual process (npm/node/etc.)
    // running as an orphan. Kill the whole tree instead. spawn (not
    // spawnSync) so taskkill itself can't block the event loop either.
    if (IS_WINDOWS) {
      // .on('error', ...) so a missing/unspawnable taskkill (unlikely, but
      // possible in a stripped-down environment) can't crash this whole
      // process via an unhandled EventEmitter 'error' the same way an
      // unguarded app spawn could (see the child.on('error', ...) above).
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).on('error', () => {});
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (err) {
        child.kill();
      }
    }
  });
  return state.stopping;
}

function stopAll(states) {
  return Promise.all(states.map((state) => stopApp(state)));
}

module.exports = { startApp, stopApp, stopAll, STATUS, pollUntilHealthy };
