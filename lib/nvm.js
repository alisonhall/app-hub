const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IS_WINDOWS } = require('./deps');

function normalizeVersion(version) {
  return version.startsWith('v') ? version : `v${version}`;
}

// nvm (the POSIX shell version most people mean by "nvm") isn't a real
// executable on PATH — it's a shell function defined by sourcing nvm.sh —
// so it can't be detected via `command -v nvm`/isCommandAvailable the way
// fnm can. Its install location is knowable instead: $NVM_DIR (defaulting
// to ~/.nvm) containing nvm.sh. nvm-windows is a different, incompatible
// tool with its own version-folder layout; it's not supported here.
function findNvmDir() {
  if (IS_WINDOWS) return null;
  const dir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
  return fs.existsSync(path.join(dir, 'nvm.sh')) ? dir : null;
}

// Installs a Node version via nvm — sourcing nvm.sh in a bash subshell,
// since nvm itself is a shell function, not a binary spawn() can invoke
// directly — and hands back the bin/ directory it landed in. Deliberately
// not copied anywhere: nvm already owns a perfectly good copy on disk, so
// process-manager.js just prepends this bin dir onto the spawned child's
// PATH instead of going through `fnm exec`. Duplicating it into fnm's own
// directory would waste disk space and risk going stale if nvm's copy is
// later removed or updated.
function installViaNvm(version) {
  return new Promise((resolve) => {
    const nvmDir = findNvmDir();
    if (!nvmDir) {
      resolve({ success: false, stderr: 'nvm not found (no ~/.nvm/nvm.sh)' });
      return;
    }

    const normalized = normalizeVersion(version);
    const script = `export NVM_DIR="${nvmDir}"; \\. "$NVM_DIR/nvm.sh"; nvm install ${normalized}`;
    let stderr = '';
    const child = spawn('bash', ['-c', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => resolve({ success: false, stderr: err.message }));
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve({ success: false, stderr: stderr.trim() || `nvm install exited with code ${code}` });
        return;
      }

      const binDir = path.join(nvmDir, 'versions', 'node', normalized, 'bin');
      if (!fs.existsSync(path.join(binDir, 'node'))) {
        resolve({ success: false, stderr: `nvm install succeeded but ${binDir}/node wasn't found` });
        return;
      }
      resolve({ success: true, binDir });
    });
  });
}

module.exports = { findNvmDir, installViaNvm, normalizeVersion };
