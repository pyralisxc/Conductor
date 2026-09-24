import assert from 'node:assert/strict';
import test from 'node:test';
import { ConductorToolRuntime, IdempotentMutationExecutor, InMemoryIdempotencyStore, VercelDeploymentProvider } from '../src/index.js';

function fixture() {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  let envs: Record<string, unknown>[] = [];
  let production = 'dpl_old';
  const provider = new VercelDeploymentProvider({
    token: 'test-token',
    bindings: [{ id: 'app', project: 'app', teamId: 'team_1' }],
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ path: url.pathname, method, body });
      if (url.pathname === '/v9/projects/app') return Response.json({ id: 'prj_app', name: 'app', link: { org: 'owner', repo: 'app', productionBranch: 'main' }, targets: { production: { id: production } } });
      if (url.pathname === '/v13/deployments/dpl_old') return Response.json({ id: 'dpl_old', projectId: 'prj_app', readyState: 'READY', target: 'production' });
      if (url.pathname === '/v13/deployments/dpl_other') return Response.json({ id: 'dpl_other', projectId: 'prj_other', readyState: 'READY' });
      if (url.pathname === '/v13/deployments/dpl_preview') return Response.json({ id: 'dpl_preview', projectId: 'prj_app', readyState: 'READY', target: 'preview' });
      if (url.pathname === '/v13/deployments' && method === 'POST') return Response.json({ id: 'dpl_new', readyState: 'BUILDING' });
      if (url.pathname.includes('/promote/') || url.pathname.includes('/rollback/')) { production = url.pathname.split('/').at(-1)!; return new Response(null, { status: 201 }); }
      if (url.pathname === '/v10/projects/prj_app/env' && method === 'GET') return Response.json({ envs });
      if (url.pathname === '/v10/projects/prj_app/env' && method === 'POST') { envs = [{ id: 'env_1', key: body?.key, type: body?.type, target: body?.target, value: body?.value }]; return Response.json({ created: envs[0] }); }
      if (url.pathname === '/v9/projects/prj_app/env/env_1' && method === 'PATCH') { envs = [{ id: 'env_1', key: body?.key, type: body?.type, target: body?.target, value: body?.value }]; return Response.json(envs[0]); }
      if (url.pathname === '/v9/projects/prj_app/env/env_1' && method === 'DELETE') { envs = []; return Response.json({}); }
      if (url.pathname === '/v9/projects/prj_app/domains') return Response.json({ domains: [{ name: 'app.example', verified: true, secret: 'should-not-return' }] });
      if (url.pathname === '/v9/projects/prj_app/custom-environments') return Response.json({ environments: [] });
      if (url.pathname === '/v4/aliases') return Response.json({ aliases: [] });
      if (url.pathname === '/v6/deployments') return Response.json({ deployments: [] });
      if (url.pathname === '/v1/projects/prj_app/deployments/dpl_preview/runtime-logs') return Response.json({ logs: [{ message: 'TOKEN=hidden', created: 1 }] });
      return Response.json({ error: { message: 'unexpected path' } }, { status: 404 });
    },
  });
  return { provider, calls, project: { id: 'app' } };
}

test('Vercel operations scope exact deployments and require production approval', async () => {
  const { provider, calls, project } = fixture();
  const before = calls.length;
  await assert.rejects(provider.redeploy({ project, deploymentId: 'dpl_other', idempotencyKey: 'wrong-project' }), (error: unknown) => (error as { message?: string }).message?.includes('outside the bound project') === true);
  assert.equal(calls.slice(before).some(call => call.method === 'POST'), false);
  await assert.rejects(provider.redeploy({ project, deploymentId: 'dpl_old', idempotencyKey: 'need-approval' }), (error: unknown) => (error as { message?: string }).message?.includes('approval') === true);
  const deployed = await provider.redeploy({ project, deploymentId: 'dpl_preview', idempotencyKey: 'redeploy-preview' });
  assert.equal(deployed.deploymentId, 'dpl_new');
  await assert.rejects(provider.promote({ project, deploymentId: 'dpl_preview', idempotencyKey: 'need-approval' }), (error: unknown) => (error as { message?: string }).message?.includes('approval') === true);
  const promoted = await provider.promote({ project, deploymentId: 'dpl_preview', approvalReference: 'owner-approved:exact-preview-commit', idempotencyKey: 'promote-preview' });
  assert.equal(promoted.verified, true);
  const rolled = await provider.rollback({ project, deploymentId: 'dpl_old', approvalReference: 'owner-approved:exact-old-commit', idempotencyKey: 'rollback-old' });
  assert.equal(rolled.verified, true);
});

test('exact Git source must match the linked project and full SHA', async () => {
  const { provider, calls, project } = fixture();
  await assert.rejects(provider.createGitDeployment({ project, repository: 'other/app', ref: 'preview', sha: 'a'.repeat(40), target: 'preview', idempotencyKey: 'wrong-source' }), (error: unknown) => (error as { message?: string }).message?.includes('linkage') === true);
  const deployed = await provider.createGitDeployment({ project, repository: 'owner/app', ref: 'preview', sha: 'a'.repeat(40), target: 'preview', idempotencyKey: 'exact-source' });
  assert.equal(deployed.sourceRevision, 'a'.repeat(40));
  assert.deepEqual((calls.find(call => call.path === '/v13/deployments' && call.method === 'POST')?.body as Record<string, unknown>).gitSource, { type: 'github', org: 'owner', repo: 'app', ref: 'preview', sha: 'a'.repeat(40) });
});

test('variable values stay out of audit, receipts and durable idempotency state', async () => {
  const { provider, project } = fixture();
  const runtime = new ConductorToolRuntime({ providers: [provider], deploymentProvider: provider, mutationExecutor: new IdempotentMutationExecutor({ store: new InMemoryIdempotencyStore() }) });
  const input = { project, key: 'API_TOKEN', value: 'top-secret-test-value', type: 'sensitive' as const, target: ['preview' as const], idempotencyKey: 'variable-upsert-1' };
  const receipt = await runtime.vercelEnvUpsert(input);
  assert.equal(receipt.status, 'succeeded');
  assert.doesNotMatch(JSON.stringify(receipt), /top-secret-test-value/);
  const replay = await runtime.vercelEnvUpsert(input);
  assert.equal(replay.idempotency?.replayed, true);
  assert.doesNotMatch(JSON.stringify(replay), /top-secret-test-value/);
  const metadata = await provider.listEnvironment({ project });
  assert.doesNotMatch(JSON.stringify(metadata), /top-secret-test-value/);
  const audit = await provider.getAudit({ project });
  assert.doesNotMatch(JSON.stringify(audit), /top-secret-test-value|should-not-return/);
  assert.equal((audit.usageAndBilling as Record<string, unknown>).status, 'unavailable');
  await assert.rejects(provider.updateEnvironment({ ...input, envId: 'env_wrong' }), (error: unknown) => (error as { message?: string }).message?.includes('do not match') === true);
  const updated = await provider.updateEnvironment({ ...input, envId: 'env_1', value: 'new-secret' });
  assert.doesNotMatch(JSON.stringify(updated), /new-secret/);
  const removed = await provider.removeEnvironment({ project, envId: 'env_1', key: 'API_TOKEN', idempotencyKey: 'variable-remove-1' });
  assert.equal(removed.verifiedRemoved, true);
});

test('runtime logs stay bound and redact secrets', async () => {
  const { provider, project } = fixture();
  const logs = await provider.getRuntimeLogs({ project, deploymentId: 'dpl_preview', limit: 10 });
  assert.doesNotMatch(JSON.stringify(logs), /TOKEN=hidden/);
  assert.match(JSON.stringify(logs), /redacted/);
});
