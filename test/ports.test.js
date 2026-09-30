const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getFreePort, assignPorts } = require('../lib/ports');

test('getFreePort returns distinct free ports', async () => {
  const a = await getFreePort();
  const b = await getFreePort();
  assert.ok(Number.isInteger(a) && a > 0);
  assert.ok(Number.isInteger(b) && b > 0);
  assert.notEqual(a, b);
});

test('assignPorts leaves explicit ports untouched and fills in missing ones uniquely', async () => {
  const apps = [
    { configured: true, slug: 'a', port: 5000 },
    { configured: true, slug: 'b', port: null },
    { configured: true, slug: 'c', port: null },
    { configured: false, slug: 'd', port: null },
  ];
  await assignPorts(apps);

  assert.equal(apps[0].port, 5000);
  assert.ok(Number.isInteger(apps[1].port));
  assert.ok(Number.isInteger(apps[2].port));
  assert.notEqual(apps[1].port, apps[2].port);
  assert.notEqual(apps[1].port, 5000);
  assert.equal(apps[3].port, null);
});
