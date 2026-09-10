const fs = require('fs');
const path = require('path');

const APPS_DIR = path.join(__dirname, '..', 'apps');
const ALIASES_CONFIG_PATH = path.join(__dirname, '..', 'apps.config.json');
const APP_CONFIG_FILENAME = 'app-hub.config.json';
const REQUIRED_FIELDS = ['name', 'slug', 'start', 'port'];

function buildAppEntry(dir, folderName) {
  const hasOwnGit = fs.existsSync(path.join(dir, '.git'));
  const defaultsPath = path.join(dir, APP_CONFIG_FILENAME);

  if (!fs.existsSync(defaultsPath)) {
    return {
      dir,
      folderName,
      configured: false,
      hasOwnGit,
      name: folderName,
      slug: folderName,
      description: `No ${APP_CONFIG_FILENAME} found for this app.`,
      icon: '❓',
      start: null,
      port: null,
      healthPath: null,
      mountPath: null,
      requiredCommands: [],
      actions: [],
    };
  }

  const defaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
  const missing = REQUIRED_FIELDS.filter((field) => !defaults[field]);
  if (missing.length) {
    throw new Error(`${dir}/${APP_CONFIG_FILENAME} is missing required field(s): ${missing.join(', ')}`);
  }

  return {
    dir,
    folderName,
    configured: true,
    hasOwnGit,
    name: defaults.name,
    slug: defaults.slug,
    description: defaults.description || '',
    icon: defaults.icon || '\u{1F4E6}',
    start: defaults.start,
    port: defaults.port,
    healthPath: defaults.healthPath || '/',
    mountPath: defaults.mountPath || `/apps/${defaults.slug}`,
    // CLI binaries the app's `start` command shells out to (e.g. "gh", "jq").
    // Checked before spawning so a missing dependency surfaces as a clear
    // error status instead of the app failing confusingly after launch.
    requiredCommands: defaults.requiredCommands || [],
    // Optional extra buttons shown on the home page once the app is running,
    // e.g. [{ "label": "Run", "path": "/run", "method": "POST" }]. app-hub
    // just wires the button to "<mountPath><path>" — the app itself owns
    // what that endpoint does.
    actions: defaults.actions || [],
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

  return [...folderApps, ...aliasedApps];
}

module.exports = { loadApps, APPS_DIR, ALIASES_CONFIG_PATH, APP_CONFIG_FILENAME };
