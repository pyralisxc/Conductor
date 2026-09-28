import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  GitHubAppCredentialProvider,
  githubCapabilitiesFromPermissions
} from '../src/providers/github-auth.js';

function privateKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }).toString();
}

test('GitHub App installation attestation returns safe installation metadata without token', async () => {
  const seen = [];
  const provider = new GitHubAppCredentialProvider({
    appId: '123',
    privateKey: privateKey(),
    now: () => new Date('2026-09-28T02:20:00.000Z'),
    fetch: async (url, init) => {
      seen.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({
        id: 456,
        app_id: 123,
        account: {
          id: 789,
          login: 'pyralisxc',
          type: 'User',
        },
        target_type: 'User',
        repository_selection: 'selected',
        permissions: {
          metadata: 'read',
          contents: 'write',
          pull_requests: 'write',
          issues: 'read',
        },
        suspended_at: null,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result =
    await provider.getInstallationAttestation('456');

  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].url,
    'https://api.github.com/app/installations/456'
  );
  assert.match(seen[0].authorization, /^Bearer /u);
  assert.deepEqual(result, {
    installationId: '456',
    accountId: '789',
    accountLogin: 'pyralisxc',
    accountType: 'User',
    repositorySelection: 'selected',
    permissions: {
      metadata: 'read',
      contents: 'write',
      pull_requests: 'write',
      issues: 'read',
    },
    capabilities: [
      'issue.read',
      'pull_request.read',
      'pull_request.write',
      'repository.read',
      'source.read',
      'source.write',
    ],
    verifiedAt: '2026-09-28T02:20:00.000Z',
  });
  assert.equal(
    JSON.stringify(result).includes('token'),
    false
  );
});

test('GitHub installation attestation rejects a different App or suspended installation', async () => {
  for (const payload of [
    {
      id: 456,
      app_id: 999,
      account: { id: 789, login: 'pyralisxc', type: 'User' },
      repository_selection: 'all',
      permissions: { metadata: 'read' },
      suspended_at: null,
    },
    {
      id: 456,
      app_id: 123,
      account: { id: 789, login: 'pyralisxc', type: 'User' },
      repository_selection: 'all',
      permissions: { metadata: 'read' },
      suspended_at: '2026-09-28T00:00:00Z',
    },
  ]) {
    const provider = new GitHubAppCredentialProvider({
      appId: '123',
      privateKey: privateKey(),
      fetch: async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
        }),
    });

    await assert.rejects(
      () => provider.getInstallationAttestation('456'),
      (error) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (
          error.code === 'CONFLICT' ||
          error.code === 'AUTH_REQUIRED'
        )
    );
  }
});

test('GitHub permission map projects only bounded ASC capabilities', () => {
  assert.deepEqual(
    githubCapabilitiesFromPermissions({
      metadata: 'read',
      contents: 'read',
      issues: 'write',
      actions: 'admin',
      unknown_permission: 'admin',
    }),
    [
      'actions.read',
      'actions.write',
      'issue.read',
      'issue.write',
      'repository.read',
      'source.read',
    ]
  );
});
