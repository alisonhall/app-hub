const fs = require('fs');
const path = require('path');

const APPS_DIR = path.join(__dirname, '..', 'apps');
const ALIASES_CONFIG_PATH = path.join(__dirname, '..', 'apps.config.json');
const APP_CONFIG_FILENAME = 'app-hub.config.json';
// Checked in order; the first one present wins.
const NODE_VERSION_FILENAMES = ['.nvmrc', '.node-version'];
// Top-level path prefixes app-hub reserves for its own routes; no app's
// mountPath (or slug alias, see server.js) may use one of these.
const RESERVED_MOUNT_PREFIXES = new Set(['/api']);

// Express compiles app.use(path, ...) mount paths (and server.js mounts
// both `mountPath` and a bare "/<slug>" alias) via path-to-regexp, which
// throws at server *startup* for a string with unbalanced parens or other
// regex-special syntax — a very plausible folder name (e.g. "my-app
// (backup)") would otherwise crash the whole server with a cryptic error
// deep inside Express's router. A strict allowlist sidesteps that entirely.
const VALID_SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;
const VALID_MOUNT_PATH_PATTERN = /^\/[A-Za-z0-9_\-./]+$/;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${filePath} as JSON: ${err.message}`);
  }
}

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
  const config = hasConfig ? readJson(configPath) : {};
  const pkg = fs.existsSync(pkgPath) ? readJson(pkgPath) : null;

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

  const config = readJson(ALIASES_CONFIG_PATH);
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
  assertNoDuplicateSlugs(folderApps, 'apps/<folder>/' + APP_CONFIG_FILENAME);

  const rawAliasedApps = loadAliasedApps();
  assertNoDuplicateSlugs(rawAliasedApps, ALIASES_CONFIG_PATH);

  const knownSlugs = new Set(folderApps.map((a) => a.slug));
  const aliasedApps = rawAliasedApps.filter((a) => {
    if (knownSlugs.has(a.slug)) {
      console.warn(`Skipping aliased app "${a.slug}" (${a.dir}): slug already used by an app under apps/`);
      return false;
    }
    knownSlugs.add(a.slug);
    return true;
  });

  const apps = [...folderApps, ...aliasedApps];
  assertNoDuplicatePorts(apps);
  assertValidMountPaths(apps);
  return apps;
}

// Two DIFFERENT apps (different source dirs) declaring the same slug is
// always a config mistake — it makes mountPaths collide and makes
// /api/apps/:slug/* ambiguous. Checked within folder apps and within
// aliased apps separately; a folder app silently wins over a stale aliased
// one with the same slug (handled separately, right after this runs).
function assertNoDuplicateSlugs(apps, source) {
  const bySlug = new Map();
  apps
    .filter((app) => app.configured)
    .forEach((app) => {
      const clashing = bySlug.get(app.slug);
      if (clashing && clashing !== app.dir) {
        throw new Error(`Slug "${app.slug}" is declared by both "${clashing}" and "${app.dir}" in ${source}. Slugs must be unique.`);
      }
      bySlug.set(app.slug, app.dir);
    });
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

// mountPath is either a default derived from a (unique) slug, or an
// explicit override — only the override case can actually collide, either
// with another app's mountPath or with a route app-hub itself reserves.
function assertValidMountPaths(apps) {
  const byMountPath = new Map();
  apps
    .filter((app) => app.configured)
    .forEach((app) => {
      if (!VALID_SLUG_PATTERN.test(app.slug)) {
        throw new Error(
          `"${app.slug}" (from ${app.dir}) isn't a valid slug: only letters, numbers, "-" and "_" are allowed. ` +
            `Set an explicit "slug" in ${APP_CONFIG_FILENAME} to fix this — the folder name is used as the default and can't contain other characters.`
        );
      }
      if (!VALID_MOUNT_PATH_PATTERN.test(app.mountPath)) {
        throw new Error(`"${app.slug}" declares an invalid mountPath "${app.mountPath}" — only letters, numbers, "-", "_", "." and "/" are allowed.`);
      }
      if (RESERVED_MOUNT_PREFIXES.has(app.mountPath)) {
        throw new Error(
          `"${app.slug}" declares mountPath "${app.mountPath}", which app-hub reserves for its own routes. Choose a different mountPath.`
        );
      }
      const clashing = byMountPath.get(app.mountPath);
      if (clashing) {
        throw new Error(
          `mountPath "${app.mountPath}" is declared by both "${clashing}" and "${app.slug}". Give one of them a different mountPath.`
        );
      }
      byMountPath.set(app.mountPath, app.slug);
    });
}

// The "/<slug>" compatibility alias (see server.js's mountApp) is skipped
// when it would be a no-op (same as the app's real mountPath already), or
// collide with another app's mountPath, or with a path app-hub reserves for
// its own routes (e.g. a slug that happens to be "api").
function computeSlugAlias(appConfig, usedPrefixes) {
  const slugAlias = `/${appConfig.slug}`;
  if (slugAlias === appConfig.mountPath) return null;
  if (usedPrefixes.has(slugAlias)) return null;
  if (RESERVED_MOUNT_PREFIXES.has(slugAlias)) return null;
  return slugAlias;
}

module.exports = {
  loadApps,
  APPS_DIR,
  ALIASES_CONFIG_PATH,
  APP_CONFIG_FILENAME,
  RESERVED_MOUNT_PREFIXES,
  computeSlugAlias,
};
