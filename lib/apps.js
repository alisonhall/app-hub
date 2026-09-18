const fs = require('fs');
const path = require('path');

const APPS_DIR = path.join(__dirname, '..', 'apps');
const ALIASES_CONFIG_PATH = path.join(__dirname, '..', 'apps.config.json');
const APP_CONFIG_FILENAME = 'app-hub.config.json';
// Checked in order; the first one present wins.
const NODE_VERSION_FILENAMES = ['.nvmrc', '.node-version'];

// If the app pins a Node version via .nvmrc or .node-version, process-manager
// runs its `start` command through `fnm exec --using=<version>` instead of
// whatever Node started app-hub itself.
function readNodeVersion(dir) {
  for (const filename of NODE_VERSION_FILENAMES) {
    const versionPath = path.join(dir, filename);
    if (fs.existsSync(versionPath)) return fs.readFileSync(versionPath, 'utf8').trim();
  }
  return null;
}

function buildAppEntry(dir, folderName) {
  const hasOwnGit = fs.existsSync(path.join(dir, '.git'));
  const configPath = path.join(dir, APP_CONFIG_FILENAME);
  const pkgPath = path.join(dir, 'package.json');

  const hasConfig = fs.existsSync(configPath);
  const config = hasConfig ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : null;

  // app-hub.config.json is optional: any field it doesn't set falls back to
  // package.json (name, description, and `npm start` if a "start" script
  // exists). This only ever reads those fields — nothing gets executed
  // during discovery, and nothing runs until the app is actually started.
  const name = config.name || (pkg && pkg.name) || folderName;
  const slug = config.slug || folderName;
  const description = config.description || (pkg && pkg.description) || '';
  const start = config.start || (pkg && pkg.scripts && pkg.scripts.start ? 'npm start' : null);

  if (!start) {
    if (hasConfig) {
      throw new Error(
        `${dir}/${APP_CONFIG_FILENAME} is missing required field "start", and package.json has no "start" script to fall back to.`
      );
    }
    return {
      dir,
      folderName,
      configured: false,
      hasOwnGit,
      name,
      slug,
      description:
        description ||
        (pkg
          ? `package.json found, but no "start" script and no ${APP_CONFIG_FILENAME}.`
          : `No ${APP_CONFIG_FILENAME} found for this app.`),
      icon: config.icon || '❓',
      start: null,
      port: null,
      healthPath: null,
      mountPath: null,
      requiredCommands: [],
      nodeVersion: null,
      actions: [],
    };
  }

  return {
    dir,
    folderName,
    configured: true,
    hasOwnGit,
    name,
    slug,
    description,
    icon: config.icon || '\u{1F4E6}',
    start,
    // Explicit port declared in the config, or null to have app-hub assign
    // a free one at startup (see lib/ports.js). An explicit port is only
    // useful for hitting the app directly during local debugging.
    port: config.port || null,
    healthPath: config.healthPath || '/',
    mountPath: config.mountPath || `/apps/${slug}`,
    // CLI binaries the app's `start` command shells out to (e.g. "gh", "jq").
    // Checked before spawning so a missing dependency surfaces as a clear
    // error status instead of the app failing confusingly after launch.
    requiredCommands: config.requiredCommands || [],
    // Node version pinned via apps/<folder>/.nvmrc, if any. Requires fnm
    // to be installed and that version already `fnm install`-ed.
    nodeVersion: readNodeVersion(dir),
    // Optional extra buttons shown on the home page once the app is running,
    // e.g. [{ "label": "Run", "path": "/run", "method": "POST" }]. app-hub
    // just wires the button to "<mountPath><path>" — the app itself owns
    // what that endpoint does.
    actions: config.actions || [],
  };
}

// apps.config.json is gitignored (see apps.config.example.json for the
// tracked template) so each machine can point app-hub at apps that live
// outside this repo without those local paths ever getting committed.
function loadAliasedApps() {
  if (!fs.existsSync(ALIASES_CONFIG_PATH)) return [];

  const config = JSON.parse(fs.readFileSync(ALIASES_CONFIG_PATH, 'utf8'));
  const aliasPaths = config.apps || [];

  return aliasPaths.map((aliasPath) => {
    const dir = path.resolve(aliasPath);
    const folderName = path.basename(dir);

    if (!fs.existsSync(dir)) {
      return {
        dir,
        folderName,
        configured: false,
        hasOwnGit: false,
        name: folderName,
        slug: folderName,
        description: `Aliased path not found: ${dir}`,
        icon: '⚠️',
        start: null,
        port: null,
        healthPath: null,
        mountPath: null,
        requiredCommands: [],
        nodeVersion: null,
        actions: [],
      };
    }

    return buildAppEntry(dir, folderName);
  });
}

function loadApps() {
  const folderApps = fs.existsSync(APPS_DIR)
    ? fs
        .readdirSync(APPS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => buildAppEntry(path.join(APPS_DIR, entry.name), entry.name))
    : [];

  const knownSlugs = new Set(folderApps.map((a) => a.slug));
  const aliasedApps = loadAliasedApps().filter((a) => {
    if (knownSlugs.has(a.slug)) {
      console.warn(`Skipping aliased app "${a.slug}" (${a.dir}): slug already used by an app under apps/`);
      return false;
    }
    knownSlugs.add(a.slug);
    return true;
  });

  const apps = [...folderApps, ...aliasedApps];
  assertNoDuplicatePorts(apps);
  return apps;
}

// Apps that leave `port` out get one assigned automatically (see
// lib/ports.js), so only explicit ports can conflict — and only those are
// worth failing loudly on, since a config author clearly intended that
// specific port.
function assertNoDuplicatePorts(apps) {
  const bySlug = new Map();
  apps
    .filter((app) => app.configured && app.port)
    .forEach((app) => {
      const clashing = bySlug.get(app.port);
      if (clashing) {
        throw new Error(
          `Port ${app.port} is declared by both "${clashing}" and "${app.slug}" in their ${APP_CONFIG_FILENAME}. ` +
            'Pick a different port for one of them, or omit `port` to have app-hub assign one automatically.'
        );
      }
      bySlug.set(app.port, app.slug);
    });
}

module.exports = { loadApps, APPS_DIR, ALIASES_CONFIG_PATH, APP_CONFIG_FILENAME };
