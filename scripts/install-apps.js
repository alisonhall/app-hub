const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { APPS_DIR } = require('../lib/apps');

if (!fs.existsSync(APPS_DIR)) process.exit(0);

fs.readdirSync(APPS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .forEach((entry) => {
    const dir = path.join(APPS_DIR, entry.name);
    if (!fs.existsSync(path.join(dir, 'package.json'))) return;

    console.log(`Installing dependencies for apps/${entry.name}...`);
    execSync('npm install', { cwd: dir, stdio: 'inherit' });
  });
