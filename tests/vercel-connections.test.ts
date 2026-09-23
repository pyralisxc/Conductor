import assert from 'node:assert/strict';
import test from 'node:test';
import { vercelConnectionCsrfToken, vercelConnectionCsrfValid } from '../src/transport/vercel-connections.js';

test('Vercel connection forms require a fresh token for the intended action', () => {
  const previous = process.env.CONDUCTOR_SESSION_SECRET;
  process.env.CONDUCTOR_SESSION_SECRET = 'vercel-connection-csrf-test-secret-is-long-enough';
  const now = Date.parse('2026-09-23T21:00:00Z');
  try {
    const token = vercelConnectionCsrfToken('start', now);
    assert.equal(vercelConnectionCsrfValid('start', token, now), true);
    assert.equal(vercelConnectionCsrfValid('disconnect', token, now), false);
    assert.equal(vercelConnectionCsrfValid('start', token, now + 15 * 60_000), false);
    assert.equal(vercelConnectionCsrfValid('start', `${token}a`, now), false);
    assert.equal(vercelConnectionCsrfValid('start', '', now), false);
  } finally {
    if (previous === undefined) delete process.env.CONDUCTOR_SESSION_SECRET;
    else process.env.CONDUCTOR_SESSION_SECRET = previous;
  }
});
