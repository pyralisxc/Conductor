import assert from 'node:assert/strict';
import test from 'node:test';

import { RoutedProviderConnectionCredentialResolver } from '../src/transport/provider-connections.js';
import { VercelDeploymentProvider } from '../src/providers/vercel.js';

test('provider connection resolver routes explicit providers and multiple accounts without first-match behavior', async () => {
  const calls: string[] = [];
  const resolver = new RoutedProviderConnectionCredentialResolver({
    vercel: async ({ connectionId, accountId }) => {
      calls.push(`vercel:${connectionId}:${accountId ?? ''}`);
      if (connectionId === 'icfg_team_a' && accountId === 'team_a') return 'vercel-a';
      if (connectionId === 'icfg_team_b' && accountId === 'team_b') return 'vercel-b';
      return undefined;
    },
    fake: async ({ connectionId }) => {
      calls.push(`fake:${connectionId}`);
      return connectionId === 'fake-1' ? 'fake-token' : undefined;
    },
  }, { now: () => new Date('2026-09-27T00:00:00.000Z') });

  assert.equal((await resolver.resolve({ provider: 'vercel', connectionId: 'icfg_team_a', accountId: 'team_a' }))?.token, 'vercel-a');
  assert.equal((await resolver.resolve({ provider: 'vercel', connectionId: 'icfg_team_b', accountId: 'team_b' }))?.token, 'vercel-b');
  assert.equal((await resolver.resolve({ provider: 'fake', connectionId: 'fake-1' }))?.provider, 'fake');
  assert.equal(await resolver.resolve({ provider: 'unknown', connectionId: 'x' }), undefined);
  assert.equal(await resolver.resolve({ provider: 'vercel', connectionId: 'icfg_team_a', accountId: 'team_b' }), undefined);
  assert.deepEqual(calls, [
    'vercel:icfg_team_a:team_a',
    'vercel:icfg_team_b:team_b',
    'fake:fake-1',
    'vercel:icfg_team_a:team_b',
  ]);
});

test('Vercel provider consumes opaque connection credentials without exposing them in capability output', async () => {
  const resolver = new RoutedProviderConnectionCredentialResolver({
    vercel: async ({ connectionId, accountId }) =>
      connectionId === 'icfg_a' && accountId === 'team_a' ? 'super-secret-installation-token' : undefined,
  });
  const provider = new VercelDeploymentProvider({
    credentialResolver: resolver,
    bindings: [{ id: 'app', project: 'app', repository: 'owner/app', teamId: 'team_a', connectionId: 'icfg_a' }],
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer super-secret-installation-token');
      if (url.pathname === '/v9/projects/app') return Response.json({ id: 'prj_app', name: 'app', link: { type: 'github', org: 'owner', repo: 'app' } });
      return Response.json({ error: { message: 'unexpected' } }, { status: 404 });
    },
  });

  const checks = await provider.preflightOperation({ id: 'app', repository: 'owner/app' }, 'deployment.status');
  assert.equal(checks?.[0]?.status, 'ready');
  assert.doesNotMatch(JSON.stringify(checks), /super-secret-installation-token/);
});
