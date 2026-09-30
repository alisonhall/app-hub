const { spawn } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

// Async (not spawnSync) so callers running inside app-hub's own server don't
// block the whole event loop — and therefore every other app's traffic —
// while this runs. `sh` isn't guaranteed to exist on a plain Windows box
// with no Git/WSL installed, so `where` (a native Windows command) is used
// there instead.
function isCommandAvailable(cmd) {
  return new Promise((resolve) => {
    const child = IS_WINDOWS
      ? spawn('where', [cmd], { stdio: 'ignore', shell: true })
      : spawn('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

module.exports = { isCommandAvailable, IS_WINDOWS };
