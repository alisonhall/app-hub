const fs = require('fs');
const path = require('path');

const APPS_DIR = path.join(__dirname, '..', 'apps');
const REQUIRED_FIELDS = ['name', 'slug', 'start', 'port'];

function loadApps() {
  if (!fs.existsSync(APPS_DIR)) return [];

  return fs
    .readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(APPS_DIR, entry.name);
      const defaultsPath = path.join(dir, 'defaults.json');
      if (!fs.existsSync(defaultsPath)) {
        return {
          dir,
          folderName: entry.name,
          configured: false,
          name: entry.name,
          slug: entry.name,
          description: 'No defaults.json found for this app.',
          icon: '❓',
          start: null,
          port: null,
          healthPath: null,
          mountPath: null,
        };
      }

      const defaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
      const missing = REQUIRED_FIELDS.filter((field) => !defaults[field]);
      if (missing.length) {
        throw new Error(
          `apps/${entry.name}/defaults.json is missing required field(s): ${missing.join(', ')}`
        );
      }

      return {
        dir,
        folderName: entry.name,
        configured: true,
        name: defaults.name,
        slug: defaults.slug,
        description: defaults.description || '',
        icon: defaults.icon || '\u{1F4E6}',
        start: defaults.start,
        port: defaults.port,
        healthPath: defaults.healthPath || '/',
        mountPath: defaults.mountPath || `/apps/${defaults.slug}`,
      };
    });
}

module.exports = { loadApps, APPS_DIR };
