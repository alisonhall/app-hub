const { spawnSync } = require('child_process');

function isCommandAvailable(cmd) {
  const result = spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
  return result.status === 0;
}

module.exports = { isCommandAvailable };
