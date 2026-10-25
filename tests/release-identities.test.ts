import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReleaseIdentityTransport, releaseIdentityFitsTransport, RELEASE_IDENTITY_MAX_BYTES } from '../src/runtime/release-identities.js';

test('inline release identities are bounded by serialized bytes rather than issue count', () => {
  const coherent = Array.from({ length: 100 }, (_, index) => 1000 + index);
  assert.equal(releaseIdentityFitsTransport(coherent), true);
  assert.doesNotThrow(() => assertReleaseIdentityTransport(coherent));
  const oversized = Array.from({ length: RELEASE_IDENTITY_MAX_BYTES }, (_, index) => index + 1);
  assert.equal(releaseIdentityFitsTransport(oversized), false);
  assert.throws(() => assertReleaseIdentityTransport(oversized), (error: any) => error.code === 'CONFLICT' && /byte transport budget/.test(error.message));
});
