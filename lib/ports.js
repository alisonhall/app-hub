const net = require('net');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Assigns a free port to every configured app that didn't declare one
// explicitly, mutating the entries in place. Explicit ports are left
// untouched (loadApps already validated they're unique).
async function assignPorts(apps) {
  const used = new Set(apps.filter((app) => app.configured && app.port).map((app) => app.port));

  for (const app of apps) {
    if (!app.configured || app.port) continue;
    let port = await getFreePort();
    while (used.has(port)) {
      port = await getFreePort();
    }
    used.add(port);
    app.port = port;
  }

  return apps;
}

module.exports = { getFreePort, assignPorts };
