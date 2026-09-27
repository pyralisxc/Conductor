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


class MemoryRecordStore {
  readonly url = 'https://incidental-field.example';
  readonly values = new Map<string, string>();
  async get<T>(key: string): Promise<T | null> { return (this.values.get(key) as T | undefined) ?? null; }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async del(key: string): Promise<void> { this.values.delete(key); }
}

test('encrypted provider connection storage keeps raw credentials out of durable records', async () => {
  const previous = process.env.CONDUCTOR_SESSION_SECRET;
  process.env.CONDUCTOR_SESSION_SECRET = 'provider-connection-test-secret-that-is-long-enough';
  try {
    const { RedisProviderConnectionCredentialStore } = await import('../src/transport/provider-connections.js');
    const memory = new MemoryRecordStore();
    const store = new RedisProviderConnectionCredentialStore(memory);
    await store.put({ provider: 'stripe', connectionId: 'stripe-live', accountId: 'acct_live', token: 'rk_live_super_secret_value' });
    assert.equal([...memory.values.values()].some(value => value.includes('rk_live_super_secret_value')), false);
    assert.equal((await store.resolve({ provider: 'stripe', connectionId: 'stripe-live', accountId: 'acct_live' }))?.token, 'rk_live_super_secret_value');
    assert.equal(await store.resolve({ provider: 'stripe', connectionId: 'stripe-live', accountId: 'acct_other' }), undefined);
    await store.delete('stripe', 'stripe-live');
    assert.equal(await store.resolve({ provider: 'stripe', connectionId: 'stripe-live' }), undefined);
  } finally {
    if (previous === undefined) delete process.env.CONDUCTOR_SESSION_SECRET;
    else process.env.CONDUCTOR_SESSION_SECRET = previous;
  }
});

test('one shared Vercel runtime credential serves multiple exact project bindings and revokes centrally', async () => {
  let runtimeConnected = true;
  const runtimeConnectionId = 'vercel-runtime-primary';
  const resolver = new RoutedProviderConnectionCredentialResolver({
    vercel: async ({ connectionId, accountId }) => {
      if (connectionId === runtimeConnectionId) return runtimeConnected ? 'runtime-direct-token' : undefined;
      if (connectionId === 'icfg_a' && accountId === 'team_a') return 'installation-a';
      if (connectionId === 'icfg_b' && accountId === 'team_b') return 'installation-b';
      return undefined;
    },
  });
  const authorization = new Map<string, string>();
  const provider = new VercelDeploymentProvider({
    credentialResolver: resolver,
    runtimeConnectionId,
    bindings: [
      { id: 'a', project: 'prj_a', repository: 'owner/a', teamId: 'team_a', connectionId: 'icfg_a' },
      { id: 'b', project: 'prj_b', repository: 'owner/b', teamId: 'team_b', connectionId: 'icfg_b' },
    ],
    fetch: async (input, init) => {
      const url = new URL(String(input));
      authorization.set(url.pathname, (init?.headers as Record<string, string>).Authorization);
      if (url.pathname === '/v9/projects/prj_a') return Response.json({ id: 'prj_a', name: 'a', link: { type: 'github', org: 'owner', repo: 'a' } });
      if (url.pathname === '/v9/projects/prj_b') return Response.json({ id: 'prj_b', name: 'b', link: { type: 'github', org: 'owner', repo: 'b' } });
      if (url.pathname === '/v13/deployments/dpl_a') return Response.json({ id: 'dpl_a', projectId: 'prj_a', target: 'preview', meta: { githubCommitSha: 'a'.repeat(40), githubCommitRef: 'preview', githubCommitRepo: 'owner/a' } });
      if (url.pathname === '/v13/deployments/dpl_b') return Response.json({ id: 'dpl_b', projectId: 'prj_b', target: 'production', meta: { githubCommitSha: 'b'.repeat(40), githubCommitRef: 'main', githubCommitRepo: 'owner/b' } });
      if (url.pathname === '/api/logs/request-logs') {
        const deploymentId = url.searchParams.get('deploymentId') ?? '';
        return Response.json({ rows: [{ requestId: `req_${deploymentId}`, timestamp: '2026-09-27T00:00:00.000Z', deploymentId, requestMethod: 'GET', requestPath: '/api/test', statusCode: 200, logs: [{ level: 'info', message: 'TOKEN=hidden' }], events: [{ source: 'serverless' }] }], hasMoreRows: false });
      }
      return Response.json({ error: { message: 'unexpected' } }, { status: 404 });
    },
  });
  for (const [id, repo, deployment] of [['a','owner/a','dpl_a'], ['b','owner/b','dpl_b']] as const) {
    assert.equal((await provider.preflightOperation({ id, repository: repo }, 'deployment.runtime-logs'))?.[0]?.status, 'degraded');
    const logs = await provider.getRuntimeLogs({ project: { id, repository: repo }, deploymentId: deployment, limit: 10 });
    assert.equal(logs.sourceRepository, repo);
    assert.doesNotMatch(JSON.stringify(logs), /TOKEN=hidden/);
  }
  assert.equal(authorization.get('/v9/projects/prj_a'), 'Bearer installation-a');
  assert.equal(authorization.get('/v9/projects/prj_b'), 'Bearer installation-b');
  assert.equal(authorization.get('/api/logs/request-logs'), 'Bearer runtime-direct-token');
  runtimeConnected = false;
  assert.equal((await provider.preflightOperation({ id: 'a', repository: 'owner/a' }, 'deployment.runtime-logs'))?.[0]?.status, 'unavailable');
});


test('provider connection store accepts explicit URL/token configuration without eager network access', async () => {
  const previous = process.env.CONDUCTOR_SESSION_SECRET;
  process.env.CONDUCTOR_SESSION_SECRET = 'provider-connection-config-test-secret-long-enough';
  try {
    const { RedisProviderConnectionCredentialStore } = await import('../src/transport/provider-connections.js');
    assert.doesNotThrow(() => new RedisProviderConnectionCredentialStore({ url: 'https://example.invalid', token: 'test-token' }));
  } finally {
    if (previous === undefined) delete process.env.CONDUCTOR_SESSION_SECRET;
    else process.env.CONDUCTOR_SESSION_SECRET = previous;
  }
});
