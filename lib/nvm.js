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

// The one place that knows nvm's on-disk layout for a given version, so
// nvmHasVersion and installViaNvm below can't drift apart on it.
function versionBinDir(nvmDir, version) {
  return path.join(nvmDir, 'versions', 'node', normalizeVersion(version), 'bin');
}

// Whether nvm already has this exact version on disk, without going
// through nvm.sh (or spawning anything) at all — lets a caller (see
// scripts/check-deps.js) judge whether nvm actually covers what's needed,
// rather than assuming it does just because nvm is installed at all.
function nvmHasVersion(nvmDir, version) {
  return fs.existsSync(path.join(versionBinDir(nvmDir, version), 'node'));
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

      if (!nvmHasVersion(nvmDir, normalized)) {
        resolve({ success: false, stderr: `nvm install succeeded but ${normalized} still isn't on disk where expected` });
        return;
      }
      resolve({ success: true, binDir: versionBinDir(nvmDir, normalized) });
    });
  });
}

module.exports = { findNvmDir, installViaNvm, normalizeVersion, nvmHasVersion };
