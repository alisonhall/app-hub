const { spawn, spawnSync } = require('child_process');
const http = require('http');
const { isCommandAvailable } = require('./deps');

const IS_WINDOWS = process.platform === 'win32';

const STATUS = {
  STARTING: 'starting',
  RUNNING: 'running',
  ERROR: 'error',
  STOPPED: 'stopped',
  NOT_CONFIGURED: 'not-configured',
};

function checkHealth(port, healthPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port, path: healthPath, timeout: 1500 }, (res) => {
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

function missingRequiredCommands(app) {
  const required = [...(app.requiredCommands || [])];
  if (app.nodeVersion) required.push('fnm');
  return required.filter((cmd) => !isCommandAvailable(cmd));
}

function startApp(app) {
  const missing = missingRequiredCommands(app);
  if (missing.length) {
    const hints = missing.map((cmd) => (cmd === 'fnm' ? `${cmd} (run \`npm run check-deps\` for install instructions)` : cmd));
    return {
      app,
      status: STATUS.ERROR,
      error: `missing required command(s): ${hints.join(', ')}`,
      child: null,
    };
  }

  if (app.nodeVersion) {
    const install = spawnSync('fnm', ['install', app.nodeVersion], { shell: true, stdio: 'ignore' });
    if (install.status !== 0) {
      return {
        app,
        status: STATUS.ERROR,
        error: `fnm failed to install Node ${app.nodeVersion} (from .nvmrc)`,
        child: null,
      };
    }
  }

  const state = { app, status: STATUS.STARTING, error: null, child: null };

  // Run under the app's pinned Node version (via .nvmrc) instead of
  // whatever Node started app-hub, so each sub-app can use its own version.
  const command = app.nodeVersion ? `fnm exec --using=${app.nodeVersion} -- ${app.start}` : app.start;

  const child = spawn(command, {
    cwd: app.dir,
    shell: true,
    env: { ...process.env, PORT: String(app.port) },
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

  child.on('exit', (code) => {
    state.status = STATUS.STOPPED;
    if (code && code !== 0) {
      state.error = `exited with code ${code}`;
    }
  });

  pollUntilHealthy(state);

  return state;
}

async function pollUntilHealthy(state, attempts = 30, intervalMs = 1000) {
  for (let i = 0; i < attempts; i += 1) {
    if (state.status === STATUS.STOPPED) return;
    // eslint-disable-next-line no-await-in-loop
    const healthy = await checkHealth(state.app.port, state.app.healthPath);
    if (healthy) {
      state.status = STATUS.RUNNING;
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (state.status !== STATUS.STOPPED) {
    state.status = STATUS.ERROR;
    state.error = state.error || `did not become healthy within ${attempts * intervalMs / 1000}s`;
  }
}

function stopApp(state) {
  if (state.child && !state.child.killed) {
    // A plain kill() only signals the shell wrapper spawn() created for
    // `shell: true`, leaving the app's actual process (npm/node/etc.)
    // running as an orphan. Kill the whole tree instead.
    if (IS_WINDOWS) {
      spawnSync('taskkill', ['/pid', String(state.child.pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-state.child.pid, 'SIGTERM');
      } catch (err) {
        state.child.kill();
      }
    }
  }
  state.status = STATUS.STOPPED;
  state.error = null;
}

function stopAll(states) {
  states.forEach((state) => stopApp(state));
}

module.exports = { startApp, stopApp, stopAll, STATUS };
