const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadApps } = require('../lib/apps');
const { isCommandAvailable } = require('../lib/deps');
const { findNvmDir, nvmHasVersion } = require('../lib/nvm');

// fnm is the only dependency this script knows how to install itself,
// since it's what app-hub's own .nvmrc support relies on (see README.md).
// Other requiredCommands (gh, jq, ...) are declared by individual sub-apps
// and are just flagged here, not installed, since app-hub has no way to
// know where they should come from.
async function tryInstallFnm() {
  if (process.platform === 'win32') {
    console.log('Attempting to install fnm via winget...');
    execSync(
      'winget install --id Schniz.fnm --source winget --accept-source-agreements --accept-package-agreements',
      { stdio: 'inherit' }
    );
    return true;
  }
  if (process.platform === 'darwin' && (await isCommandAvailable('brew'))) {
    console.log('Attempting to install fnm via Homebrew...');
    execSync('brew install fnm', { stdio: 'inherit' });
    return true;
  }
  return false;
}

async function checkFnm(apps) {
  const pinnedVersions = [...new Set(apps.filter((app) => app.nodeVersion).map((app) => app.nodeVersion))];
  if (!pinnedVersions.length) return;

  if (await isCommandAvailable('fnm')) {
    console.log('fnm found on PATH — per-app Node version pinning (.nvmrc) is ready to use.');
    return;
  }

  // Without fnm, process-manager.js still isn't stuck — it falls back to
  // nvm (if installed and it already has the pinned version), and after
  // that to app-hub's own Node. So this is no longer a hard requirement,
  // just the most reliable option. Whether it's worth skipping the
  // auto-install below depends on nvm actually having every version
  // that's needed on disk already — nvm being *installed* at all doesn't
  // mean that (it could have zero Node versions in it), so that's checked
  // explicitly rather than assumed.
  const nvmDir = findNvmDir();
  const nvmCoversEverything = nvmDir && pinnedVersions.every((version) => nvmHasVersion(nvmDir, version));

  console.log('\nOne or more sub-apps pin a Node version via .nvmrc, which app-hub prefers to run through fnm.');

  if (nvmCoversEverything) {
    // Deliberately don't run tryInstallFnm() here: it shells out to a real
    // system package manager (winget/brew), which can prompt for
    // elevation and takes real time — every `npm install`/`npm start` —
    // and nvm demonstrably already has everything that's needed, so it's
    // not pulling its weight. Installing fnm is still worth doing by hand
    // for the most reliable experience going forward, just not worth
    // forcing automatically when nothing is actually missing right now.
    console.log(
      `fnm isn't on PATH, but nvm (${nvmDir}) already has every pinned version needed (${pinnedVersions.join(', ')}) ` +
        "— app-hub will use those directly. Not installing fnm automatically since nothing's actually missing; " +
        "install it yourself later for the most reliable experience going forward (it can fetch a version that's " +
        'missing everywhere, nvm included, next time a .nvmrc changes).'
    );
    return;
  }

  if (nvmDir) {
    // nvm exists but doesn't (yet) have everything needed — it can still
    // try downloading the rest itself at spawn time, but that's subject to
    // the same kind of failure that left fnm without it, so still worth
    // attempting the more reliable fnm install below rather than skipping.
    console.log(
      `nvm was found (${nvmDir}) but doesn't yet have every pinned version needed (${pinnedVersions.join(', ')}) — ` +
        "app-hub will still try nvm as a fallback (it can download what's missing), but that's not guaranteed, so " +
        'still attempting to install fnm for the more reliable path.'
    );
  }

  let installed = false;
  try {
    installed = await tryInstallFnm();
  } catch (err) {
    console.warn(`fnm install attempt failed: ${err.message}`);
  }
  if (installed) {
    console.log('fnm was installed. Restart your terminal (so PATH picks it up), then re-run `npm install` to confirm.');
  } else {
    console.warn(
      [
        '',
        nvmDir
          ? '⚠ fnm could not be installed automatically on this platform. Pinned versions not already in nvm ' +
              "will depend on nvm downloading them itself (not guaranteed) or, failing that, fall back to " +
              "app-hub's own Node (watch for the ⚠ badge on the home page). Install fnm for the most reliable " +
              'experience:'
          : '⚠ fnm could not be installed automatically on this platform, and no nvm install was found either. Pinned ' +
              "apps will still start, but silently under app-hub's own Node instead of the version they pin (watch " +
              'for the ⚠ badge on the home page). Install fnm (or nvm) to fix that:',
        '  Install it yourself, then re-run `npm install` to confirm:',
        '    macOS:   brew install fnm',
        '    Windows: winget install Schniz.fnm',
        '    Linux:   curl -fsSL https://fnm.vercel.app/install | bash',
        '  See https://github.com/Schniz/fnm#installation for other options.',
        '',
      ].join('\n')
    );
  }
}

async function checkRequiredCommands(apps) {
  const otherRequired = new Set();
  apps.forEach((app) => (app.requiredCommands || []).forEach((cmd) => otherRequired.add(cmd)));

  const required = [...otherRequired];
  const availability = await Promise.all(required.map((cmd) => isCommandAvailable(cmd)));
  const missingOther = required.filter((_cmd, i) => !availability[i]);
  if (missingOther.length) {
    console.warn(
      `\n⚠ Some sub-apps require CLI tools not found on PATH: ${missingOther.join(', ')}. Install them yourself before starting those apps.`
    );
  }
}

// --- Advisory scan for a known class of proxy-breaking bug ---
//
// An app's client-side code that calls fetch()/XHR with an absolute
// root-relative path (e.g. fetch('/api/x')) resolves that path against the
// browser's origin root, not the app's mount path. It works fine when the
// app is hit directly on its own port, but can 404 once app-hub proxies it
// under a subpath (e.g. /apps/<slug>/api/x) — this bit pr-release-validation
// in exactly this way. This is a heuristic, advisory-only scan: it can't
// verify the app's logic is actually wrong (only that it does this at all),
// so expect some false positives — it's a prompt to double-check, not proof
// of a bug.
const SCAN_EXTENSIONS = new Set(['.html', '.htm', '.js', '.jsx', '.mjs']);
const SCAN_EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const MAX_SCAN_FILES = 300;
const MAX_SCAN_DEPTH = 4;
const ABSOLUTE_CALL_PATTERN = /(?:\bfetch\s*\(|\.open\s*\(\s*['"`][A-Z]+['"`]\s*,)\s*['"`]\/(?!\/)/;

function findScannableFiles(dir, depth = 0, out = []) {
  if (depth > MAX_SCAN_DEPTH || out.length >= MAX_SCAN_FILES) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_SCAN_FILES) break;
    if (entry.name.startsWith('.') || SCAN_EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findScannableFiles(full, depth + 1, out);
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function findAbsolutePathIssues(app) {
  const hits = [];
  for (const file of findScannableFiles(app.dir)) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (ABSOLUTE_CALL_PATTERN.test(content)) hits.push(path.relative(app.dir, file));
  }
  return hits;
}

function checkAbsolutePaths(apps) {
  const flagged = apps
    .map((app) => ({ app, files: findAbsolutePathIssues(app) }))
    .filter(({ files }) => files.length);

  if (!flagged.length) return;

  console.warn('\n⚠ Possible mount-path issues (advisory, not blocking — verify before assuming a bug):');
  flagged.forEach(({ app, files }) => {
    console.warn(
      `  "${app.name}" (${app.slug}): ${files.join(', ')} call fetch()/XHR with an absolute path (e.g. "/api/...").\n` +
        `    That resolves against the browser's origin root, not this app's mount path, and can 404 when proxied.\n` +
        `    app-hub usually also mounts apps at /${app.slug} as a compatibility fallback for the common case of\n` +
        `    assuming that's the mount path (skipped if it would collide with another app) — but double-check any\n` +
        `    path that isn't under /${app.slug}/... or /apps/${app.slug}/...`
    );
  });
}

async function main() {
  const apps = loadApps().filter((app) => app.configured);
  await checkFnm(apps);
  await checkRequiredCommands(apps);
  checkAbsolutePaths(apps);
}

main();
