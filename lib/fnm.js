const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { IS_WINDOWS } = require('./deps');

// Reads fnm's own data directory the same way its shell hook would ($ fnm
// env), instead of guessing per-OS defaults ourselves (respects FNM_DIR if
// the user set it).
function getFnmDir() {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('fnm', ['env'], { shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => resolve(null));
    child.on('exit', () => {
      const match = stdout.match(/FNM_DIR=['"]?([^'"\r\n]+)['"]?/);
      resolve(match ? match[1] : null);
    });
  });
}

// fnm's own on-disk layout for an installed version mirrors the official
// Node distribution archive's root exactly — flat (node.exe/npm.cmd
// directly inside) on Windows, bin/lib/share on POSIX (matching what `fnm
// install` extracts either way; verified the Windows layout directly).
//
// process-manager.js prepends this onto the spawned child's PATH instead
// of running through `fnm exec --using=<version> -- <start>`: fnm exec
// spawns its target command directly, bypassing the shell, and on Windows
// that means "npm" (an `npm.cmd` shim, not a real .exe) can't be resolved
// at all — `fnm exec --using=... -- npm start` fails with "Can't spawn
// program: program not found" even though the exact same command works
// fine when run through a shell (which does PATHEXT resolution). Going
// through our own shell:true spawn instead — same mechanism already used
// for the nvm fallback — sidesteps that entirely.
function fnmVersionBinDir(fnmDir, version) {
  const installDir = path.join(fnmDir, 'node-versions', version, 'installation');
  return IS_WINDOWS ? installDir : path.join(installDir, 'bin');
}

// Resolves a (possibly loose) version specifier to the exact version fnm
// will actually run it under — e.g. requesting "20" resolves to whatever
// full version fnm installed for it, like "v20.20.2" (confirmed directly:
// `fnm exec --using=20 -- node --version` correctly prints that resolved
// version, even though no folder literally named "v20" or "20" exists on
// disk — fnm resolves this internally). Deliberately invokes `node`
// directly here (not the app's own `start` command): that's safe from the
// npm.cmd resolution bug fnmVersionBinDir's doc comment describes, since
// `node` is a real executable, not a shell shim like `npm`.
function resolveFnmVersion(version) {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('fnm', ['exec', `--using=${version}`, '--', 'node', '-p', 'process.version'], {
      shell: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      const resolved = stdout.trim();
      resolve(code === 0 && /^v\d+\.\d+\.\d+$/.test(resolved) ? resolved : null);
    });
  });
}

// Whether fnm actually has this exact version on disk. This matters
// because `fnm install` (like `nvm install`) resolves a loose specifier —
// e.g. a .nvmrc containing just "20" — to whatever full version it
// actually installs (verified directly: `fnm install 20` creates a
// `v20.20.2` folder, not one literally named `v20`), so a successful `fnm
// install` doesn't by itself guarantee fnmVersionBinDir's path is real.
// Without this check, process-manager.js would silently prepend a
// nonexistent directory onto PATH — which the shell just skips over,
// falling through to whatever Node comes next — while still reporting
// state.node as if the pinned version were actually running.
function fnmHasVersion(fnmDir, version) {
  const binDir = fnmVersionBinDir(fnmDir, version);
  return fs.existsSync(path.join(binDir, IS_WINDOWS ? 'node.exe' : 'node'));
}

module.exports = { getFnmDir, fnmVersionBinDir, fnmHasVersion, resolveFnmVersion };
