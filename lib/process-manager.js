const { spawn } = require('child_process');
const http = require('http');

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

function startApp(app) {
  const state = { app, status: STATUS.STARTING, error: null, child: null };

  const child = spawn(app.start, {
    cwd: app.dir,
    shell: true,
    env: { ...process.env, PORT: String(app.port) },
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
  if (state.child && !state.child.killed) state.child.kill();
  state.status = STATUS.STOPPED;
  state.error = null;
}

function stopAll(states) {
  states.forEach((state) => stopApp(state));
}

module.exports = { startApp, stopApp, stopAll, STATUS };
