import assert from 'node:assert/strict';
import {
  createCipheriv,
  createHmac,
  randomBytes
} from 'node:crypto';
import test from 'node:test';

import {
  ProviderCredentialVaultUnavailableError,
  VersionedProviderCredentialVault
} from '../src/transport/credential-vault.js';

function legacyEncrypt(
  plaintext: string,
  sessionSecret: string,
  purpose: string,
): string {
  const iv = randomBytes(12);
  const key = createHmac('sha256', sessionSecret)
    .update(`conductor/${purpose}/v1`)
    .digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ].map((part) => part.toString('base64url')).join('.');
}

test('dedicated provider vault migrates legacy Vercel records without reconnect', () => {
  const sessionSecret =
    'legacy-owner-session-secret-that-is-long-enough';
  const vaultKey =
    'dedicated-provider-vault-key-that-is-long-enough';
  const legacy = legacyEncrypt(
    JSON.stringify({
      configurationId: 'icfg_test',
      teamId: 'team_test',
      connectedAt: '2026-09-29T00:00:00.000Z',
      token: 'vercel-installation-token'
    }),
    sessionSecret,
    'vercel-installation',
  );

  const migrating = new VersionedProviderCredentialVault({
    legacyPurpose: 'vercel-installation',
    currentKey: vaultKey,
    legacySessionSecret: sessionSecret,
  });
  const opened = migrating.open(legacy);

  assert.equal(opened.source, 'legacy');
  assert.match(opened.replacement ?? '', /^v2\./);
  assert.match(opened.plaintext, /vercel-installation-token/);

  const afterCutover = new VersionedProviderCredentialVault({
    legacyPurpose: 'vercel-installation',
    currentKey: vaultKey,
  });
  assert.equal(
    afterCutover.open(opened.replacement!).plaintext,
    opened.plaintext,
    'the migrated credential no longer depends on the owner-session secret',
  );
});

test('provider vault rotation rewrites previous-key records under the current key', () => {
  const keyA =
    'provider-vault-key-a-that-is-long-enough-0001';
  const keyB =
    'provider-vault-key-b-that-is-long-enough-0002';
  const first = new VersionedProviderCredentialVault({
    legacyPurpose: 'provider-connection-credential-v1',
    currentKey: keyA,
  });
  const original = first.seal('secret-payload');

  const rotating = new VersionedProviderCredentialVault({
    legacyPurpose: 'provider-connection-credential-v1',
    currentKey: keyB,
    previousKeys: [keyA],
  });
  const opened = rotating.open(original);

  assert.equal(opened.source, 'previous');
  assert.equal(opened.plaintext, 'secret-payload');
  assert.match(opened.replacement ?? '', /^v2\./);
  assert.notEqual(opened.replacement, original);

  const currentOnly = new VersionedProviderCredentialVault({
    legacyPurpose: 'provider-connection-credential-v1',
    currentKey: keyB,
  });
  assert.equal(
    currentOnly.open(opened.replacement!).plaintext,
    'secret-payload',
  );
});

test('provider vault fails closed when a record key is unavailable', () => {
  const original = new VersionedProviderCredentialVault({
    legacyPurpose: 'provider-connection-credential-v1',
    currentKey:
      'provider-vault-original-key-that-is-long-enough',
  }).seal('secret-payload');

  const wrong = new VersionedProviderCredentialVault({
    legacyPurpose: 'provider-connection-credential-v1',
    currentKey:
      'provider-vault-wrong-key-that-is-long-enough-00',
  });

  assert.throws(
    () => wrong.open(original),
    ProviderCredentialVaultUnavailableError,
  );
});

test('legacy-only compatibility remains available until the dedicated key is configured', () => {
  const legacyOnly = new VersionedProviderCredentialVault({
    legacyPurpose: 'provider-connection-credential-v1',
    legacySessionSecret:
      'legacy-provider-session-secret-that-is-long-enough',
  });
  const record = legacyOnly.seal('legacy-payload');

  assert.equal(record.split('.').length, 3);
  assert.equal(legacyOnly.open(record).plaintext, 'legacy-payload');
});
