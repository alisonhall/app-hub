const { execSync } = require('child_process');
const { loadApps } = require('../lib/apps');
const { isCommandAvailable } = require('../lib/deps');

// fnm is the only dependency this script knows how to install itself,
// since it's what app-hub's own .nvmrc support relies on (see README.md).
// Other requiredCommands (gh, jq, ...) are declared by individual sub-apps
// and are just flagged here, not installed, since app-hub has no way to
// know where they should come from.
function tryInstallFnm() {
  if (process.platform === 'win32') {
    console.log('Attempting to install fnm via winget...');
    execSync(
      'winget install --id Schniz.fnm --source winget --accept-source-agreements --accept-package-agreements',
      { stdio: 'inherit' }
    );
    return true;
  }
  if (process.platform === 'darwin' && isCommandAvailable('brew')) {
    console.log('Attempting to install fnm via Homebrew...');
    execSync('brew install fnm', { stdio: 'inherit' });
    return true;
  }
  return false;
}

function main() {
  const apps = loadApps().filter((app) => app.configured);
  const needsFnm = apps.some((app) => app.nodeVersion);
  const otherRequired = new Set();
  apps.forEach((app) => (app.requiredCommands || []).forEach((cmd) => otherRequired.add(cmd)));

  if (!needsFnm && otherRequired.size === 0) return;

  if (needsFnm && !isCommandAvailable('fnm')) {
    console.log('\nOne or more sub-apps pin a Node version via .nvmrc, which app-hub runs through fnm.');
    let installed = false;
    try {
      installed = tryInstallFnm();
    } catch (err) {
      console.warn(`fnm install attempt failed: ${err.message}`);
    }
    if (installed) {
      console.log(
        'fnm was installed. Restart your terminal (so PATH picks it up), then re-run `npm install` to confirm.'
      );
    } else {
      console.warn(
        [
          '',
          '⚠ fnm is required but could not be installed automatically on this platform.',
          '  Install it yourself, then re-run `npm install` to confirm:',
          '    macOS:   brew install fnm',
          '    Windows: winget install Schniz.fnm',
          '    Linux:   curl -fsSL https://fnm.vercel.app/install | bash',
          '  See https://github.com/Schniz/fnm#installation for other options.',
          '',
        ].join('\n')
      );
    }
  } else if (needsFnm) {
    console.log('fnm found on PATH — per-app Node version pinning (.nvmrc) is ready to use.');
  }

  const missingOther = [...otherRequired].filter((cmd) => !isCommandAvailable(cmd));
  if (missingOther.length) {
    console.warn(
      `\n⚠ Some sub-apps require CLI tools not found on PATH: ${missingOther.join(', ')}. Install them yourself before starting those apps.`
    );
  }
}

main();
