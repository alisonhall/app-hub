const { spawnSync } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

// `sh` isn't guaranteed to exist on a plain Windows box with no Git/WSL
// installed, so `where` (a native Windows command) is used there instead.
function isCommandAvailable(cmd) {
  const result = IS_WINDOWS
    ? spawnSync('where', [cmd], { stdio: 'ignore', shell: true })
    : spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
  return result.status === 0;
}

module.exports = { isCommandAvailable, IS_WINDOWS };
