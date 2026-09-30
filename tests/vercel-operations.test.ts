import assert from 'node:assert/strict';
import test from 'node:test';
import { ConductorToolRuntime, IdempotentMutationExecutor, InMemoryIdempotencyStore, VercelDeploymentProvider } from '../src/index.js';

function fixture() {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  let envs: Record<string, unknown>[] = [];
  let vcrRepositories: Record<string, unknown>[] = [];
  const vcrImages: Record<string, unknown>[] = [
    { id: 'img_safe', repositoryId: 'vcr_dockerfile', manifestDigest: 'sha256:abc123', sizeInBytes: 1234, status: 'ready', tags: ['latest'], createdAt: 1, updatedAt: 2 },
    { id: 'img_untagged', repositoryId: 'vcr_dockerfile', manifestDigest: 'sha256:def456', sizeInBytes: 4321, status: 'ready', tags: [], createdAt: 1, updatedAt: 2 },
  ];
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
      if (url.pathname === '/v1/vcr/repository' && method === 'GET') {
        return Response.json({ repositories: vcrRepositories, pagination: { next: null } });
      }
      if (url.pathname === '/v1/vcr/repository/dockerfile/images' && method === 'GET') {
        const onlyUntagged = url.searchParams.get('untagged') === 'true';
        return Response.json({ images: onlyUntagged ? vcrImages.filter(item => Array.isArray(item.tags) && item.tags.length === 0) : vcrImages, pagination: { next: null } });
      }
      if (url.pathname.startsWith('/v1/vcr/repository/dockerfile/images/') && method === 'GET') {
        const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
        const found = vcrImages.find(item => item.id === id);
        return found ? Response.json({ image: found }) : Response.json({ error: { message: 'not found' } }, { status: 404 });
      }
      if (url.pathname.startsWith('/v1/vcr/repository/') && method === 'GET') {
        const name = decodeURIComponent(url.pathname.split('/').at(-1)!);
        const found = vcrRepositories.find(item => item.name === name);
        return found ? Response.json(found) : Response.json({ error: { message: 'not found' } }, { status: 404 });
      }
      if (url.pathname.includes('/images/') && method === 'DELETE') throw new Error('VCR image DELETE must not be sent without reachability proof');
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
      if (url.pathname === '/api/logs/request-logs') return Response.json({ rows: [{ requestId: 'req_1', timestamp: '2026-09-27T00:00:00.000Z', deploymentId: 'dpl_preview', requestMethod: 'GET', requestPath: '/api/test', statusCode: 200, environment: 'preview', branch: 'preview', logs: [{ level: 'info', message: 'TOKEN=hidden' }], events: [{ source: 'serverless' }] }], hasMoreRows: false });
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

test('uniquely linked connected Vercel project supports bounded mutations without a duplicate explicit project binding', async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const provider = new VercelDeploymentProvider({
    bindings: [{ id: 'shared-installation', project: 'seed', teamId: 'team_1', connectionId: 'icfg_1' }],
    tokenResolver: async () => 'installation-token',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({ path: url.pathname, method });
      if (url.pathname === '/v9/projects' && method === 'GET') {
        return Response.json({
          projects: [{ id: 'prj_app', name: 'app', link: { type: 'github', org: 'owner', repo: 'app', productionBranch: 'main' } }],
          pagination: { next: null },
        });
      }
      if (url.pathname === '/v9/projects/prj_app' && method === 'GET') {
        return Response.json({ id: 'prj_app', name: 'app', link: { type: 'github', org: 'owner', repo: 'app', productionBranch: 'main' } });
      }
      if (url.pathname === '/v13/deployments/dpl_preview' && method === 'GET') {
        return Response.json({ id: 'dpl_preview', projectId: 'prj_app', readyState: 'READY', target: 'preview' });
      }
      if (url.pathname === '/v13/deployments' && method === 'POST') {
        return Response.json({ id: 'dpl_new', readyState: 'BUILDING' });
      }
      return Response.json({ error: { message: 'unexpected path' } }, { status: 404 });
    },
  });
  const project = { id: 'CardForge', repository: 'owner/app' };

  const preflight = (await provider.preflightOperation(project, 'deployment.redeploy'))?.[0];
  assert.notEqual(preflight?.status, 'blocked');

  const redeployed = await provider.redeploy({ project, deploymentId: 'dpl_preview', idempotencyKey: 'unbound-redeploy' });
  assert.equal(redeployed.projectId, 'prj_app');
  assert.equal(redeployed.deploymentId, 'dpl_new');

  const created = await provider.createGitDeployment({
    project,
    repository: 'owner/app',
    ref: 'preview',
    sha: 'a'.repeat(40),
    target: 'preview',
    idempotencyKey: 'unbound-git-deploy',
  });
  assert.equal(created.projectId, 'prj_app');
  assert.equal(created.sourceRevision, 'a'.repeat(40));
  assert.equal(calls.some(call => call.path === '/v9/projects' && call.method === 'GET'), true);
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
  assert.match(preflight?.diagnostics[0]?.message ?? '', /authoritative for provider health/u);
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
  assert.equal(calls.some(path => path.includes('/runtime-logs') || path === '/api/logs/request-logs'), false);
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

test('VCR inventory is bounded and ambiguous image deletion remains fail-closed', async () => {
  const { provider, calls, project } = fixture();
  await provider.createVcrRepository({ project, name: 'dockerfile', idempotencyKey: 'vcr-create-before-inventory' });

  const repositories = await provider.listVcrRepositories({ project, limit: 20 });
  assert.equal((repositories.repositories as Record<string, unknown>[]).length, 1);
  assert.equal((repositories.capacity as Record<string, unknown>).status, 'unsupported');

  const images = await provider.listVcrImages({ project, name: 'dockerfile', limit: 20 });
  assert.equal((images.images as Record<string, unknown>[]).length, 2);
  assert.equal(images.knownBytes, 5555);
  assert.equal(images.knownBytesScope, 'returned-page-only');
  assert.equal((images.capacity as Record<string, unknown>).status, 'unsupported');

  const untagged = await provider.listVcrImages({ project, name: 'dockerfile', limit: 20, untagged: true });
  assert.equal((untagged.images as Record<string, unknown>[]).length, 1);
  assert.equal((untagged.images as Record<string, unknown>[])[0]?.imageId, 'img_untagged');

  const beforeDeleteCalls = calls.filter(call => call.method === 'DELETE').length;
  await assert.rejects(
    provider.deleteVcrImage({
      project,
      name: 'dockerfile',
      imageId: 'img_untagged',
      expectedManifestDigest: 'sha256:def456',
      idempotencyKey: 'vcr-delete-fail-closed',
    }),
    (error: unknown) => (error as { code?: string }).code === 'TOOL_UNAVAILABLE'
      && (error as { message?: string }).message?.includes('immutable-looking Git SHA tags') === true,
  );
  assert.equal(calls.filter(call => call.method === 'DELETE').length, beforeDeleteCalls);

  await assert.rejects(
    provider.deleteVcrImage({
      project,
      name: 'dockerfile',
      imageId: 'img_safe',
      expectedManifestDigest: 'sha256:wrong',
      idempotencyKey: 'vcr-delete-digest-mismatch',
    }),
    (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
  );
});

test('VCR deletes only a SHA-tagged image proven outside current Production, latest Preview, and active builds', async () => {
  const prodSha = 'a'.repeat(40);
  const previewSha = 'b'.repeat(40);
  const oldSha = 'c'.repeat(40);
  let oldExists = true;
  const calls: { path: string; method: string }[] = [];
  const provider = new VercelDeploymentProvider({
    token: 'test-token',
    bindings: [{ id: 'app', project: 'app', repository: 'owner/app', teamId: 'team_1' }],
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({ path: url.pathname, method });
      if (url.pathname === '/v9/projects/app') return Response.json({
        id: 'prj_app',
        name: 'app',
        link: { type: 'github', org: 'owner', repo: 'app', productionBranch: 'main' },
        targets: { production: { id: 'dpl_prod' } },
      });
      if (url.pathname === '/v1/vcr/repository/dockerfile') return Response.json({ id: 'vcr_dockerfile', name: 'dockerfile', projectId: 'prj_app' });
      if (url.pathname === '/v1/vcr/repository/dockerfile/images/img_old' && method === 'GET') {
        return oldExists
          ? Response.json({ image: { id: 'img_old', repositoryId: 'vcr_dockerfile', manifestDigest: 'sha256:old', tags: [oldSha.slice(0, 12)] } })
          : Response.json({ error: { message: 'not found' } }, { status: 404 });
      }
      if (url.pathname === '/v1/vcr/repository/dockerfile/images/img_old' && method === 'DELETE') {
        oldExists = false;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/v1/vcr/repository/dockerfile/images/img_preview' && method === 'GET') {
        return Response.json({ image: { id: 'img_preview', repositoryId: 'vcr_dockerfile', manifestDigest: 'sha256:preview', tags: [previewSha.slice(0, 12)] } });
      }
      if (url.pathname === '/v6/deployments') return Response.json({ deployments: [
        { id: 'dpl_prod', projectId: 'prj_app', readyState: 'READY', target: 'production', createdAt: 3, meta: { githubCommitSha: prodSha, githubCommitRef: 'main', githubCommitRepo: 'owner/app' } },
        { id: 'dpl_preview', projectId: 'prj_app', readyState: 'READY', target: null, createdAt: 2, meta: { githubCommitSha: previewSha, githubCommitRef: 'preview', githubCommitRepo: 'owner/app' } },
        { id: 'dpl_old', projectId: 'prj_app', readyState: 'READY', target: null, createdAt: 1, meta: { githubCommitSha: oldSha, githubCommitRef: 'preview', githubCommitRepo: 'owner/app' } },
      ] });
      if (url.pathname === '/v9/projects/prj_app/domains') return Response.json({ domains: [] });
      return Response.json({ error: { message: 'unexpected path' } }, { status: 404 });
    },
  });
  const project = { id: 'app', repository: 'owner/app' };

  await assert.rejects(
    provider.deleteVcrImage({
      project,
      name: 'dockerfile',
      imageId: 'img_preview',
      expectedManifestDigest: 'sha256:preview',
      idempotencyKey: 'vcr-delete-protected-preview',
    }),
    (error: unknown) => (error as { code?: string }).code === 'CONFLICT'
      && (error as { message?: string }).message?.includes('protected') === true,
  );
  assert.equal(calls.some(call => call.path.endsWith('/img_preview') && call.method === 'DELETE'), false);

  const deleted = await provider.deleteVcrImage({
    project,
    name: 'dockerfile',
    imageId: 'img_old',
    expectedManifestDigest: 'sha256:old',
    idempotencyKey: 'vcr-delete-old-safe',
  });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.verified, true);
  assert.equal(oldExists, false);
  assert.equal(calls.filter(call => call.path.endsWith('/img_old') && call.method === 'DELETE').length, 1);
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
    logsBaseUrl: 'https://vercel.test',
    bindings: [{ id: 'app', project: 'app', teamId: 'team_1', connectionId: 'icfg_1', runtimeLogsDirect: true }],
    tokenResolver: async () => 'installation-token',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      authorization.set(url.pathname, (init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
      if (url.pathname === '/v9/projects/app') return Response.json({ id: 'prj_app', name: 'app' });
      if (url.pathname === '/v13/deployments/dpl_preview') return Response.json({ id: 'dpl_preview', projectId: 'prj_app', readyState: 'READY', target: 'preview' });
      if (url.pathname === '/api/logs/request-logs') return Response.json({ rows: [{ requestId: 'req_direct', timestamp: '2026-09-27T00:00:00.000Z', deploymentId: 'dpl_preview', requestMethod: 'GET', requestPath: '/api/direct', statusCode: 200, environment: 'preview', logs: [{ level: 'info', message: 'TOKEN=hidden' }], events: [{ source: 'serverless' }] }], hasMoreRows: false });
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
  assert.equal(authorization.get('/api/logs/request-logs'), 'Bearer direct-token');
  assert.doesNotMatch(JSON.stringify(logs), /TOKEN=hidden/);
  assert.match(JSON.stringify(logs), /redacted/);
});

test('runtime request-log snapshot is exact and uses current CLI query shape', async () => {
  const seen: URL[] = [];
  const provider = new VercelDeploymentProvider({
    token: 'direct-token',
    logsBaseUrl: 'https://vercel.test',
    now: () => new Date('2026-09-27T05:00:00.000Z'),
    bindings: [{ id: 'app', project: 'app', teamId: 'team_1', repository: 'owner/app' }],
    fetch: async input => {
      const url = new URL(String(input));
      seen.push(url);
      if (url.pathname === '/v9/projects/app') return Response.json({ id: 'prj_app', name: 'app', link: { type: 'github', org: 'owner', repo: 'app' } });
      if (url.pathname === '/v13/deployments/dpl_snapshot') return Response.json({ id: 'dpl_snapshot', projectId: 'prj_app', createdAt: Date.parse('2026-09-27T04:00:00.000Z'), readyState: 'READY', target: 'production', meta: { githubCommitSha: 'a'.repeat(40), githubCommitRef: 'main', githubCommitRepo: 'owner/app' } });
      if (url.pathname === '/api/logs/request-logs') return Response.json({ rows: [{ requestId: 'req_snapshot', timestamp: '2026-09-27T04:59:00.000Z', deploymentId: 'dpl_snapshot', requestMethod: 'POST', requestPath: '/api/example?token=hidden', statusCode: 500, environment: 'production', branch: 'main', logs: [{ level: 'error', message: 'api_key=super-secret-value' }], events: [{ source: 'serverless' }] }], hasMoreRows: false });
      return Response.json({ error: { message: 'unexpected' } }, { status: 404 });
    },
  });
  const logs = await provider.getRuntimeLogs({ project: { id: 'app', repository: 'owner/app' }, deploymentId: 'dpl_snapshot', limit: 10 });
  const u = seen.find(url => url.pathname === '/api/logs/request-logs');
  assert.ok(u);
  assert.equal(u.searchParams.get('projectId'), 'prj_app');
  assert.equal(u.searchParams.get('ownerId'), 'team_1');
  assert.equal(u.searchParams.get('deploymentId'), 'dpl_snapshot');
  assert.equal(u.searchParams.get('page'), '0');
  assert.equal(u.searchParams.get('environment'), 'production');
  assert.equal(u.searchParams.get('branch'), 'main');
  assert.equal(u.searchParams.get('startDate'), String(Date.parse('2026-09-27T04:00:00.000Z')));
  assert.equal(u.searchParams.get('endDate'), String(Date.parse('2026-09-27T05:00:00.000Z')));
  assert.equal(logs.source, 'request-logs');
  assert.equal(logs.sourceRevision, 'a'.repeat(40));
  assert.doesNotMatch(JSON.stringify(logs), /super-secret-value/);
  assert.match(JSON.stringify(logs), /redacted/);
});

test('runtime request-log snapshot fails closed on crossed deployment evidence', async () => {
  const provider = new VercelDeploymentProvider({
    token: 'direct-token',
    logsBaseUrl: 'https://vercel.test',
    bindings: [{ id: 'app', project: 'app', teamId: 'team_1' }],
    fetch: async input => {
      const url = new URL(String(input));
      if (url.pathname === '/v9/projects/app') return Response.json({ id: 'prj_app', name: 'app' });
      if (url.pathname === '/v13/deployments/dpl_expected') return Response.json({ id: 'dpl_expected', projectId: 'prj_app', readyState: 'READY', target: 'production' });
      if (url.pathname === '/api/logs/request-logs') return Response.json({ rows: [{ deploymentId: 'dpl_other' }] });
      return Response.json({ error: { message: 'unexpected' } }, { status: 404 });
    },
  });
  await assert.rejects(provider.getRuntimeLogs({ project: { id: 'app' }, deploymentId: 'dpl_expected', limit: 10 }), (error: unknown) => (error as { code?: string }).code === 'PERMISSION_DENIED');
});


test('runtime request-log snapshot caps old deployments to the current CLI 24-hour window and preserves exact filters', async () => {
  const seen: URL[] = [];
  const now = new Date('2026-09-27T05:00:00.000Z');
  const provider = new VercelDeploymentProvider({
    token: 'direct-token',
    logsBaseUrl: 'https://vercel.test',
    now: () => now,
    bindings: [{ id: 'app', project: 'app', teamId: 'team_1', repository: 'owner/app' }],
    fetch: async input => {
      const url = new URL(String(input));
      seen.push(url);
      if (url.pathname === '/v9/projects/app') return Response.json({ id: 'prj_app', name: 'app', link: { type: 'github', org: 'owner', repo: 'app' } });
      if (url.pathname === '/v13/deployments/dpl_old') return Response.json({
        id: 'dpl_old',
        projectId: 'prj_app',
        createdAt: Date.parse('2026-09-20T00:00:00.000Z'),
        readyState: 'READY',
        target: 'production',
        meta: { githubCommitSha: 'b'.repeat(40), githubCommitRef: 'main', githubCommitRepo: 'owner/app' },
      });
      if (url.pathname === '/api/logs/request-logs') return Response.json({ rows: [], hasMoreRows: false });
      return Response.json({ error: { message: 'unexpected' } }, { status: 404 });
    },
  });
  const logs = await provider.getRuntimeLogs({ project: { id: 'app', repository: 'owner/app' }, deploymentId: 'dpl_old', limit: 10 });
  const u = seen.find(url => url.pathname === '/api/logs/request-logs');
  assert.ok(u);
  assert.equal(u.searchParams.get('startDate'), String(now.getTime() - 24 * 60 * 60 * 1000));
  assert.equal(u.searchParams.get('environment'), 'production');
  assert.equal(u.searchParams.get('branch'), 'main');
  assert.deepEqual(logs.entries, []);
});


test('fresh bootstrap read evidence skips the repeated Vercel project identity fetch while live status remains current', async () => {
  const paths: string[] = [];
  const provider = new VercelDeploymentProvider({
    token: 'direct-token',
    bindings: [{ id: 'app', project: 'prj_app', repository: 'owner/app', teamId: 'team_1' }],
    fetch: async input => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === '/v9/projects/prj_app') {
        return Response.json({
          id: 'prj_app',
          name: 'app',
          link: { type: 'github', org: 'owner', repo: 'app', productionBranch: 'main' },
          targets: { production: { id: 'dpl_prod' } },
        });
      }
      if (url.pathname === '/v6/deployments') {
        return Response.json({ deployments: [
          { id: 'dpl_prod', projectId: 'prj_app', readyState: 'READY', target: 'production', meta: { githubCommitSha: 'a'.repeat(40), githubCommitRef: 'main', githubCommitRepo: 'owner/app' } },
          { id: 'dpl_preview', projectId: 'prj_app', readyState: 'READY', target: null, meta: { githubCommitSha: 'b'.repeat(40), githubCommitRef: 'preview', githubCommitRepo: 'owner/app' } },
        ] });
      }
      if (url.pathname === '/v9/projects/prj_app/domains') return Response.json({ domains: [{ name: 'app.example', verified: true }] });
      return Response.json({ error: { message: 'unexpected' } }, { status: 404 });
    },
  });

  const fresh = await provider.getDeploymentStatus({ project: { id: 'app', repository: 'owner/app' }, limit: 5 });
  assert.equal(fresh.production?.id, 'dpl_prod');
  assert.equal(paths.filter(path => path === '/v9/projects/prj_app').length, 1);

  paths.length = 0;
  const reused = await provider.getDeploymentStatus({
    project: { id: 'app', repository: 'owner/app' },
    limit: 5,
    readEvidence: {
      provider: 'vercel',
      projectId: 'prj_app',
      teamId: 'team_1',
      repository: 'owner/app',
      projectName: 'app',
      productionBranch: 'main',
      productionDeploymentId: 'dpl_prod',
      observedAt: '2026-09-27T00:00:00.000Z',
    },
  });
  assert.equal(reused.production?.id, 'dpl_prod');
  assert.equal(reused.project.productionBranch, 'main');
  assert.equal(paths.filter(path => path === '/v9/projects/prj_app').length, 0);
  assert.deepEqual(paths.sort(), ['/v6/deployments', '/v9/projects/prj_app/domains'].sort());
});

test('stale bootstrap project evidence falls back to a fresh authoritative Vercel project read', async () => {
  const paths: string[] = [];
  const provider = new VercelDeploymentProvider({
    token: 'direct-token',
    bindings: [{ id: 'app', project: 'prj_app', repository: 'owner/app', teamId: 'team_1' }],
    fetch: async input => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === '/v9/projects/prj_app') return Response.json({ id: 'prj_app', name: 'app', link: { type: 'github', org: 'owner', repo: 'app', productionBranch: 'main' } });
      if (url.pathname === '/v6/deployments') return Response.json({ deployments: [] });
      if (url.pathname === '/v9/projects/prj_app/domains') return Response.json({ domains: [] });
      return Response.json({ error: { message: 'unexpected' } }, { status: 404 });
    },
  });
  await provider.getDeploymentStatus({
    project: { id: 'app', repository: 'owner/app' },
    readEvidence: {
      provider: 'vercel',
      projectId: 'prj_old',
      teamId: 'team_1',
      repository: 'owner/app',
      projectName: 'old',
      productionBranch: 'main',
      productionDeploymentId: null,
      observedAt: '2026-09-27T00:00:00.000Z',
    },
  });
  assert.equal(paths.includes('/v9/projects/prj_app'), true);
});

test('Vercel mutations still re-read project and deployment identity after bootstrap reuse exists', async () => {
  const paths: string[] = [];
  const provider = new VercelDeploymentProvider({
    token: 'direct-token',
    bindings: [{ id: 'app', project: 'prj_app', repository: 'owner/app', teamId: 'team_1' }],
    fetch: async (input, init) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === '/v9/projects/prj_app') return Response.json({ id: 'prj_app', name: 'app', link: { type: 'github', org: 'owner', repo: 'app' } });
      if (url.pathname === '/v13/deployments/dpl_source' && (!init?.method || init.method === 'GET')) return Response.json({ id: 'dpl_source', projectId: 'prj_app', readyState: 'READY', target: 'preview' });
      if (url.pathname === '/v13/deployments' && init?.method === 'POST') return Response.json({ id: 'dpl_new', readyState: 'BUILDING' });
      return Response.json({ error: { message: 'unexpected' } }, { status: 404 });
    },
  });
  const result = await provider.redeploy({ project: { id: 'app', repository: 'owner/app' }, deploymentId: 'dpl_source', idempotencyKey: 'mutation-fresh-read' });
  assert.equal(result.deploymentId, 'dpl_new');
  assert.equal(paths.includes('/v9/projects/prj_app'), true);
  assert.equal(paths.includes('/v13/deployments/dpl_source'), true);
});
