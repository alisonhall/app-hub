const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireSameOrigin } = require('../lib/same-origin');

function run(headers) {
  const req = { headers };
  let statusCode = null;
  let body = null;
  let nextCalled = false;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
    },
  };
  requireSameOrigin(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled, statusCode, body };
}

test('requireSameOrigin allows a request with no Origin header (e.g. curl)', () => {
  const { nextCalled, statusCode } = run({ host: 'localhost:3000' });
  assert.equal(nextCalled, true);
  assert.equal(statusCode, null);
});

test('requireSameOrigin allows a matching Origin/Host pair', () => {
  const { nextCalled, statusCode } = run({ host: 'localhost:3000', origin: 'http://localhost:3000' });
  assert.equal(nextCalled, true);
  assert.equal(statusCode, null);
});

test('requireSameOrigin rejects a mismatched Origin', () => {
  const { nextCalled, statusCode, body } = run({ host: 'localhost:3000', origin: 'http://evil.example' });
  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);
  assert.match(body.error, /cross-origin/);
});

test('requireSameOrigin rejects a malformed Origin header instead of throwing', () => {
  const { nextCalled, statusCode, body } = run({ host: 'localhost:3000', origin: 'not a url' });
  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);
  assert.match(body.error, /invalid Origin/);
});
