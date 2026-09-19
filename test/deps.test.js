const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isCommandAvailable } = require('../lib/deps');

test('isCommandAvailable returns true for a command that exists', async () => {
  assert.equal(await isCommandAvailable('node'), true);
});

test('isCommandAvailable returns false for a command that does not exist', async () => {
  assert.equal(await isCommandAvailable('totally-fake-command-xyz'), false);
});
