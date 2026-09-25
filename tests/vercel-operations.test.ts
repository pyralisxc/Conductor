import assert from 'node:assert/strict';
import test from 'node:test';
import { ConductorToolRuntime, IdempotentMutationExecutor, InMemoryIdempotencyStore, VercelDeploymentProvider } from '../src/index.js';

function fixture() {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  let envs: Record<string, unknown>[] = [];
  let vcrRepositories: Record<string, unknown>[] = [];
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
      if (url.pathname.startsWith('/v1/vcr/repository/') && method === 'GET') {
        const name = decodeURIComponent(url.pathname.split('/').at(-1)!);
        const found = vcrRepositories.find(item => item.name === name);
        return found ? Response.json(found) : Response.json({ error: { message: 'not found' } }, { status: 404 });
      }
      if (url.pathname === '/v1/vcr/repository' && method === 'POST') {
        if (body?.projectId !== 'prj_app' || typeof body?.name !== 'string') return Response.json({ error: { message: 'invalid VCR create' } }, { status: 400 });
        const created = { id: `vcr_${body.name}`, name: body.name, projectId: body.projectId, createdAt: 1, updatedAt: 1 };
        vcrRepositories = [created];
        return Response.json(created, { status: 201 });
      }
      if (url.pathname.startsWith('/v13/deployments/dpl_') && method === 'DELETE') return Response.json({ uid: url.pathname.split('/').at(-1), state: 'DELETED' });
      if (url.pathname === '/v13/deployments/dpl_old') return Response.json({ id: 'dpl_old', projectId: 'prj_app', readyState: 'READY', target: 'production' });
      if (url.pathname === '/v13/deployments/dpl_other') return Response.json({ id: 'dpl_other', projectId: 'prj_other', readyState: 'READY' });
      if (url.pathname === '/v13/deployments/dpl_preview') return Response.json({ id: 'dpl_preview', projectId: 'prj_app', readyState: 'READY', target: 'preview' });
      if (url.pathname === '/v13/deployments/dpl_prodold') return Response.json({ id: 'dpl_prodold', projectId: 'prj_app', readyState: 'READY', target: 'production' });
      if (url.pathname === '/v13/deployments/dpl_building') return Response.json({ id: 'dpl_building', projectId: 'prj_app', readyState: 'BUILDING', target: null });
      if (url.pathname === '/v13/deployments' && method === 'POST') {
        if (body?.gitSource && body.target === 'preview') return Response.json({ error: { message: 'Invalid target' } }, { status: 400 });
        return Response.json({ id: 'dpl_new', readyState: 'BUILDING' });
      }
      if (url.pathname.includes('/promote/') || url.pathname.includes('/rollback/')) { production = url.pathname.split('/').at(-1)!; return new Response(null, { status: 201 }); }
      if (url.pathname === '/v10/projects/prj_app/env' && method === 'GET') return Response.json({ envs });
      if (url.pathname === '/v10/projects/prj_app/env' && method === 'POST' && body?.value === 'secret-trigger') return Response.json({ error: { message: 'rejected secret-trigger' } }, { status: 400 });
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


test('deployment cleanup protects current production and active builds', async () => {
  const { provider, calls, project } = fixture();
  await assert.rejects(
    provider.deleteDeployment({ project, deploymentId: 'dpl_old', idempotencyKey: 'delete-current-production' }),
    (error: unknown) => {
      assert.match((error as { message?: string }).message ?? JSON.stringify(error), /currently serving production/u);
      return true;
    },
  );
  await assert.rejects(
    provider.deleteDeployment({ project, deploymentId: 'dpl_building', idempotencyKey: 'delete-active-build' }),
    (error: unknown) => {
      assert.match((error as { message?: string }).message ?? JSON.stringify(error), /terminal/u);
      return true;
    },
  );
  await assert.rejects(
    provider.deleteDeployment({ project, deploymentId: 'dpl_prodold', idempotencyKey: 'delete-historical-production' }),
    (error: unknown) => {
      assert.match((error as { message?: string }).message ?? JSON.stringify(error), /approval/u);
      return true;
    },
  );

  const preview = await provider.deleteDeployment({ project, deploymentId: 'dpl_preview', idempotencyKey: 'delete-preview' });
  assert.equal(preview.verified, true);
  assert.equal(preview.state, 'DELETED');

  const historical = await provider.deleteDeployment({
    project,
    deploymentId: 'dpl_prodold',
    approvalReference: 'owner-approved:delete-historical-production',
    idempotencyKey: 'delete-historical-production-approved',
  });
  assert.equal(historical.verified, true);
  assert.equal(historical.priorTarget, 'production');
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 2);
});

test('deployment cleanup replays durable idempotency instead of deleting twice', async () => {
  const { provider, calls, project } = fixture();
  const runtime = new ConductorToolRuntime({
    providers: [provider],
    deploymentProvider: provider,
    mutationExecutor: new IdempotentMutationExecutor({ store: new InMemoryIdempotencyStore() }),
  });
  const input = { project, deploymentId: 'dpl_preview', idempotencyKey: 'deployment-delete-replay' };
  const first = await runtime.vercelDeleteDeployment(input);
  assert.equal(first.status, 'succeeded');
  const replay = await runtime.vercelDeleteDeployment(input);
  assert.equal(replay.status, 'succeeded');
  assert.equal(replay.idempotency?.replayed, true);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
});

test('exact Git source must match the linked project and full SHA', async () => {
  const { provider, calls, project } = fixture();
  await assert.rejects(provider.createGitDeployment({ project, repository: 'other/app', ref: 'preview', sha: 'a'.repeat(40), target: 'preview', idempotencyKey: 'wrong-source' }), (error: unknown) => (error as { message?: string }).message?.includes('linkage') === true);
  const deployed = await provider.createGitDeployment({ project, repository: 'owner/app', ref: 'preview', sha: 'a'.repeat(40), target: 'preview', idempotencyKey: 'exact-source' });
  assert.equal(deployed.sourceRevision, 'a'.repeat(40));
  const body = calls.find(call => call.path === '/v13/deployments' && call.method === 'POST')?.body as Record<string, unknown>;
  assert.deepEqual(body.gitSource, { type: 'github', org: 'owner', repo: 'app', ref: 'preview', sha: 'a'.repeat(40) });
  assert.equal('target' in body, false);
});

test('explicit repository binding blocks a mismatched Vercel project before deployment writes', async () => {
  const calls: string[] = [];
  const provider = new VercelDeploymentProvider({
    token: 'test-token',
    bindings: [{ id: 'DI', project: 'prj_DI123', teamId: 'team_1', repository: 'pyralisxc/Development-Intelligence' }],
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/v9/projects/prj_DI123') return Response.json({ id: 'prj_DI123', link: { type: 'github', org: 'somebody-else', repo: 'Development-Intelligence' } });
      return Response.json({ error: { message: 'unexpected path' } }, { status: 404 });
    },
  });
  await assert.rejects(provider.redeploy({ project: { id: 'DI', repository: 'pyralisxc/Development-Intelligence' }, deploymentId: 'dpl_preview', idempotencyKey: 'wrong-linked-project' }), (error: unknown) => (error as { code?: string }).code === 'PERMISSION_DENIED');
  assert.deepEqual(calls, ['GET /v9/projects/prj_DI123']);
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

test('runtime log preflight does not claim endpoint permission from a direct token project read', async () => {
  const { provider, project } = fixture();
  const preflight = (await provider.preflightOperation(project, 'deployment.runtime-logs'))?.[0];
  assert.equal(preflight?.status, 'degraded');
  assert.match(preflight?.diagnostics[0]?.message ?? '', /runtime-log endpoint access is unverified/u);
});

test('connected Vercel integration reports the documented runtime-log scope boundary without calling the endpoint', async () => {
  const calls: string[] = [];
  const provider = new VercelDeploymentProvider({
    bindings: [{ id: 'app', project: 'app', teamId: 'team_1', connectionId: 'icfg_1' }],
    tokenResolver: async () => 'installation-token',
    fetch: async input => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === '/v9/projects/app') return Response.json({ id: 'prj_app', name: 'app' });
      if (path === '/v13/deployments/dpl_preview') return Response.json({ id: 'dpl_preview', projectId: 'prj_app', readyState: 'READY', target: 'preview' });
      if (path.includes('/runtime-logs')) throw new Error('runtime-log endpoint must not be called with an integration installation token');
      return Response.json({ error: { message: 'unexpected path' } }, { status: 404 });
    },
  });
  const project = { id: 'app' };
  const preflight = (await provider.preflightOperation(project, 'deployment.runtime-logs'))?.[0];
  assert.equal(preflight?.status, 'unavailable');
  assert.match(preflight?.diagnostics[0]?.message ?? '', /installation tokens do not authorize/u);

  await assert.rejects(
    provider.getRuntimeLogs({ project, deploymentId: 'dpl_preview', limit: 10 }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'TOOL_UNAVAILABLE');
      assert.match((error as { message?: string }).message ?? '', /Integration API installation tokens/u);
      return true;
    },
  );
  assert.equal(calls.some(path => path.includes('/runtime-logs')), false);
});

test('runtime logs stay bound and redact secrets', async () => {
  const { provider, project } = fixture();
  const logs = await provider.getRuntimeLogs({ project, deploymentId: 'dpl_preview', limit: 10 });
  assert.doesNotMatch(JSON.stringify(logs), /TOKEN=hidden/);
  assert.match(JSON.stringify(logs), /redacted/);
});

test('provider write errors cannot echo submitted secret values', async () => {
  const { provider, project } = fixture();
  const runtime = new ConductorToolRuntime({ providers: [provider], deploymentProvider: provider, mutationExecutor: new IdempotentMutationExecutor({ store: new InMemoryIdempotencyStore() }) });
  const input = { project, key: 'API_TOKEN', value: 'secret-trigger', type: 'sensitive' as const, target: ['preview' as const], idempotencyKey: 'variable-failed-secret' };
  const failed = await runtime.vercelEnvUpsert(input);
  assert.equal(failed.status, 'failed');
  assert.doesNotMatch(JSON.stringify(failed), /secret-trigger/);
  assert.doesNotMatch(JSON.stringify(await runtime.vercelEnvUpsert(input)), /secret-trigger/);
});

test('environment preflight checks environment permission independently of project read', async () => {
  const calls: string[] = [];
  const provider = new VercelDeploymentProvider({
    token: 'test-token',
    bindings: [{ id: 'app', project: 'app', teamId: 'team_1' }],
    fetch: async input => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === '/v9/projects/app') return Response.json({ id: 'prj_app', name: 'app' });
      return Response.json({ error: { message: 'Project not found.' } }, { status: 404 });
    },
  });
  const project = { id: 'app' };
  assert.equal((await provider.preflightOperation(project, 'deployment.status'))?.[0]?.status, 'ready');
  for (const operation of ['deployment.env.list', 'deployment.env.upsert', 'deployment.env.update', 'deployment.env.remove'] as const) {
    const result = (await provider.preflightOperation(project, operation))?.[0];
    assert.equal(result?.status, 'blocked');
    assert.equal(result?.error?.code, 'NOT_FOUND');
  }
  assert.equal(calls.filter(path => path === '/v10/projects/prj_app/env').length, 4);
});


test('VCR repository read and create stay exact-project scoped and verify provider state', async () => {
  const { provider, calls, project } = fixture();

  await assert.rejects(
    provider.getVcrRepository({ project, name: 'dockerfile' }),
    (error: unknown) => (error as { status?: number }).status === 404,
  );

  const created = await provider.createVcrRepository({ project, name: 'dockerfile', idempotencyKey: 'vcr-create-dockerfile' });
  assert.equal(created.projectId, 'prj_app');
  assert.equal(created.name, 'dockerfile');
  assert.equal(created.created, true);
  assert.equal(created.verified, true);

  const read = await provider.getVcrRepository({ project, name: 'dockerfile' });
  assert.equal(read.repositoryId, 'vcr_dockerfile');
  assert.equal(read.projectId, 'prj_app');

  const second = await provider.createVcrRepository({ project, name: 'dockerfile', idempotencyKey: 'vcr-create-dockerfile-again' });
  assert.equal(second.created, false);
  assert.equal(second.verified, true);
  assert.equal(calls.filter(call => call.path === '/v1/vcr/repository' && call.method === 'POST').length, 1);
  assert.deepEqual(calls.find(call => call.path === '/v1/vcr/repository' && call.method === 'POST')?.body, { projectId: 'prj_app', name: 'dockerfile' });

  await assert.rejects(
    provider.createVcrRepository({ project, name: '../bad', idempotencyKey: 'vcr-invalid-name' }),
    (error: unknown) => (error as { message?: string }).message?.includes('repository name') === true,
  );
});

test('VCR create is durably idempotent through the runtime', async () => {
  const { provider, calls, project } = fixture();
  const runtime = new ConductorToolRuntime({
    providers: [provider],
    deploymentProvider: provider,
    mutationExecutor: new IdempotentMutationExecutor({ store: new InMemoryIdempotencyStore() }),
  });
  const input = { project, name: 'dockerfile', idempotencyKey: 'runtime-vcr-create' };
  const first = await runtime.vercelVcrCreate(input);
  const replay = await runtime.vercelVcrCreate(input);
  assert.equal(first.status, 'succeeded');
  assert.equal(replay.status, 'succeeded');
  if (first.status === 'succeeded' && replay.status === 'succeeded') {
    assert.equal((first.result as Record<string, unknown>).verified, true);
    assert.equal(replay.idempotency?.replayed, true);
  }
  assert.equal(calls.filter(call => call.path === '/v1/vcr/repository' && call.method === 'POST').length, 1);
});


test('runtime-log direct opt-in preserves installation identity checks and uses the direct token only for runtime output', async () => {
  const authorization = new Map<string, string>();
  const provider = new VercelDeploymentProvider({
    token: 'direct-token',
    bindings: [{ id: 'app', project: 'app', teamId: 'team_1', connectionId: 'icfg_1', runtimeLogsDirect: true }],
    tokenResolver: async () => 'installation-token',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      authorization.set(url.pathname, (init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
      if (url.pathname === '/v9/projects/app') return Response.json({ id: 'prj_app', name: 'app' });
      if (url.pathname === '/v13/deployments/dpl_preview') return Response.json({ id: 'dpl_preview', projectId: 'prj_app', readyState: 'READY', target: 'preview' });
      if (url.pathname === '/v1/projects/prj_app/deployments/dpl_preview/runtime-logs') return Response.json({ logs: [{ message: 'TOKEN=hidden', created: 1 }] });
      return Response.json({ error: { message: 'unexpected path' } }, { status: 404 });
    },
  });
  const project = { id: 'app' };
  const preflight = (await provider.preflightOperation(project, 'deployment.runtime-logs'))?.[0];
  assert.equal(preflight?.status, 'degraded');
  assert.match(preflight?.diagnostics[0]?.message ?? '', /direct token/u);
  const logs = await provider.getRuntimeLogs({ project, deploymentId: 'dpl_preview', limit: 10 });
  assert.equal(authorization.get('/v9/projects/app'), 'Bearer installation-token');
  assert.equal(authorization.get('/v13/deployments/dpl_preview'), 'Bearer installation-token');
  assert.equal(authorization.get('/v1/projects/prj_app/deployments/dpl_preview/runtime-logs'), 'Bearer direct-token');
  assert.doesNotMatch(JSON.stringify(logs), /TOKEN=hidden/);
  assert.match(JSON.stringify(logs), /redacted/);
});
