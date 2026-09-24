import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ConductorToolRuntime,
  VercelDeploymentProvider,
  createConductorMcpServer,
  mergeVercelBindings,
  parseRuntimeBindings,
  parseVercelBindingOverlay,
} from '../src/index.js';

const oldSha = 'a'.repeat(40);
const newSha = 'b'.repeat(40);

function provider(token = 'vercel-token') {
  const requests: string[] = [];
  const instance = new VercelDeploymentProvider({
    token,
    bindings: [{ id: 'Development-Intelligence', project: 'development-intelligence', teamId: 'team_1' }],
    now: () => new Date('2026-09-23T17:00:00Z'),
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url.toString());
      if (url.pathname === '/v9/projects/development-intelligence') {
        return Response.json({
          id: 'prj_di',
          name: 'development-intelligence',
          link: { productionBranch: 'main' },
          targets: { production: { id: 'dpl_live' } },
        });
      }
      if (url.pathname === '/v6/deployments') {
        return Response.json({ deployments: [
          {
            uid: 'dpl_failed',
            url: 'failed.vercel.app',
            readyState: 'ERROR',
            target: 'production',
            created: 2000,
            meta: { githubCommitSha: newSha, githubCommitRef: 'main', githubCommitRepo: 'pyralisxc/Development-Intelligence' },
            errorCode: 'BUILD_FAILED',
            errorMessage: 'Build failed',
          },
          {
            uid: 'dpl_live',
            url: 'live.vercel.app',
            readyState: 'READY',
            target: 'production',
            created: 1000,
            readyAt: 1500,
            meta: { githubCommitSha: oldSha, githubCommitRef: 'main', githubCommitRepo: 'pyralisxc/Development-Intelligence' },
          },
        ] });
      }
      if (url.pathname === '/v9/projects/prj_di/domains') {
        return Response.json({ domains: [{ name: 'devint.cardforges.com', verified: true }] });
      }
      if (url.pathname === '/v13/deployments/dpl_failed') {
        return Response.json({ id: 'dpl_failed', projectId: 'prj_di' });
      }
      if (url.pathname === '/v3/deployments/dpl_failed/events') {
        return new Response(JSON.stringify([
          { type: 'stderr', created: 3000, payload: { text: 'Build failed TOKEN=super-secret-value' } },
          { type: 'stdout', created: 3100, payload: { text: 'See https://user:password@example.com/path' } },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return Response.json({ error: { message: `Unexpected test path ${url.pathname}` } }, { status: 404 });
    },
  });
  return { instance, requests };
}

test('Vercel provider exposes current production separately from latest failed production attempt', async () => {
  const { instance, requests } = provider();
  const preflight = await instance.preflightOperation({ id: 'Development-Intelligence' }, 'deployment.status');
  assert.equal(preflight?.[0]?.status, 'ready');

  const status = await instance.getDeploymentStatus({ project: { id: 'Development-Intelligence' }, limit: 10 });
  assert.equal(status.project.id, 'prj_di');
  assert.equal(status.project.productionBranch, 'main');
  assert.equal(status.production?.id, 'dpl_live');
  assert.equal(status.production?.sourceRevision, oldSha);
  assert.equal(status.latestProductionAttempt?.id, 'dpl_failed');
  assert.equal(status.latestProductionAttempt?.state, 'ERROR');
  assert.equal(status.latestProductionAttempt?.sourceRevision, newSha);
  assert.deepEqual(status.domains, [{ name: 'devint.cardforges.com', verified: true }]);
  assert.ok(requests.every(url => url.includes('teamId=team_1')));
});

test('Vercel deployment logs are bounded, project-scoped, and redact secret-like content', async () => {
  const { instance } = provider();
  const logs = await instance.getDeploymentLogs({
    project: { id: 'Development-Intelligence' },
    deploymentId: 'dpl_failed',
    limit: 1,
  });
  assert.equal(logs.entries.length, 1);
  assert.equal(logs.truncated, true);
  assert.match(logs.entries[0]?.text ?? '', /TOKEN=\[redacted\]/u);
  assert.doesNotMatch(logs.entries[0]?.text ?? '', /super-secret-value/u);
});

test('Vercel provider reports missing authentication without exposing deployment tools as usable', async () => {
  const instance = new VercelDeploymentProvider({
    bindings: [{ id: 'Development-Intelligence', project: 'development-intelligence' }],
  });
  const capabilities = await instance.getCapabilities();
  assert.equal(capabilities.every(item => item.available === false && item.auth === 'required'), true);
  const preflight = await instance.preflightOperation({ id: 'Development-Intelligence' }, 'deployment.status');
  assert.equal(preflight?.[0]?.error?.code, 'AUTH_REQUIRED');
});

test('Vercel account connection resolves only the selected installation and fails closed after disconnect', async () => {
  let connected = true;
  const seen: string[] = [];
  const instance = new VercelDeploymentProvider({
    bindings: [{ id: 'conductor', project: 'conductor', teamId: 'team_A', connectionId: 'icfg_A' }],
    tokenResolver: async binding => {
      seen.push(`${binding.connectionId}:${binding.teamId}`);
      return connected && binding.connectionId === 'icfg_A' && binding.teamId === 'team_A' ? 'installation-token' : undefined;
    },
    fetch: async (_url, options) => {
      assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer installation-token');
      return Response.json({ id: 'prj_conductor', name: 'conductor' });
    },
  });
  assert.equal((await instance.preflightOperation({ id: 'conductor' }, 'deployment.status'))?.[0]?.status, 'ready');
  connected = false;
  assert.equal((await instance.getCapabilities()).every(item => !item.available), true);
  assert.equal((await instance.preflightOperation({ id: 'conductor' }, 'deployment.status'))?.[0]?.error?.code, 'AUTH_REQUIRED');
  assert.ok(seen.every(value => value === 'icfg_A:team_A'));
});

test('unbound repository reads use only one connected team and verified Git linkage; writes remain bound', async () => {
  const requests: { path: string; team: string | null; method: string }[] = [];
  let connected = true;
  const instance = new VercelDeploymentProvider({
    bindings: [{ id: 'conductor', project: 'conductor', connectionId: 'icfg_A', teamId: 'team_A' }],
    tokenResolver: async () => connected ? 'installation-token' : undefined,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push({ path: url.pathname, team: url.searchParams.get('teamId'), method: init?.method ?? 'GET' });
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer installation-token');
      if (url.pathname === '/v9/projects') return Response.json({
        projects: [{ id: 'prj_di', name: 'different-slug', link: { type: 'github', org: 'pyralisxc', repo: 'Development-Intelligence' } }],
        pagination: { next: null },
      });
      if (url.pathname === '/v9/projects/prj_di') return Response.json({ id: 'prj_di', name: 'different-slug', link: { type: 'github', org: 'pyralisxc', repo: 'Development-Intelligence' } });
      if (url.pathname === '/v6/deployments') return Response.json({ deployments: [{ id: 'dpl_live', projectId: 'prj_di', target: 'production', readyState: 'READY' }] });
      if (url.pathname === '/v9/projects/prj_di/domains') return Response.json({ domains: [] });
      if (url.pathname === '/v10/projects/prj_di/env') return Response.json({ envs: [{ id: 'env_1', key: 'TOKEN', value: 'private-value', target: ['production'] }] });
      if (url.pathname === '/v13/deployments/dpl_live') return Response.json({ id: 'dpl_live', projectId: 'prj_di' });
      if (url.pathname === '/v3/deployments/dpl_live/events') return Response.json([]);
      return Response.json({ error: { message: 'unexpected path' } }, { status: 404 });
    },
  });
  const project = { id: 'Development-Intelligence', repository: 'pyralisxc/Development-Intelligence' };
  assert.equal((await instance.preflightOperation(project, 'deployment.status'))?.[0]?.status, 'ready');
  const status = await instance.getDeploymentStatus({ project });
  assert.equal(status.project.id, 'prj_di');
  assert.equal((await instance.getDeploymentLogs({ project, deploymentId: 'dpl_live' })).projectId, 'prj_di');
  assert.doesNotMatch(JSON.stringify(await instance.listEnvironment({ project })), /private-value/u);
  assert.equal(requests.every(request => request.team === 'team_A' && request.method === 'GET'), true);
  assert.equal((await instance.preflightOperation(project, 'deployment.env.upsert'))?.[0]?.error?.code, 'NOT_FOUND');
  await assert.rejects(instance.redeploy({ project, deploymentId: 'dpl_live', idempotencyKey: 'read-cannot-write' }), (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND');
  assert.equal(requests.every(request => request.method === 'GET'), true);
  connected = false;
  assert.equal((await instance.preflightOperation(project, 'deployment.status'))?.[0]?.error?.code, 'AUTH_REQUIRED');
});

test('unbound Vercel discovery rejects ambiguous installations and mismatched or duplicate Git links', async () => {
  const project = { id: 'Development-Intelligence', repository: 'pyralisxc/Development-Intelligence' };
  const bindings = [
    { id: 'conductor', project: 'conductor', connectionId: 'icfg_A', teamId: 'team_A' },
    { id: 'another', project: 'another', connectionId: 'icfg_B', teamId: 'team_B' },
  ];
  const ambiguous = new VercelDeploymentProvider({ bindings, tokenResolver: async () => 'token', fetch: async () => { throw new Error('must not access Vercel'); } });
  assert.equal((await ambiguous.preflightOperation(project, 'deployment.status'))?.[0]?.error?.code, 'CONFLICT');

  for (const projects of [
    [{ id: 'prj_di', link: { type: 'github', org: 'somebody-else', repo: 'Development-Intelligence' } }],
    [{ id: 'prj_a', link: { type: 'github', org: 'pyralisxc', repo: 'Development-Intelligence' } }, { id: 'prj_b', link: { type: 'github', org: 'pyralisxc', repo: 'Development-Intelligence' } }],
  ]) {
    const instance = new VercelDeploymentProvider({
      bindings: [bindings[0]!], tokenResolver: async () => 'token',
      fetch: async input => new URL(String(input)).pathname === '/v9/projects'
        ? Response.json({ projects, pagination: { next: null } })
        : Response.json({ error: 'No matching detail' }, { status: 404 }),
    });
    assert.equal((await instance.preflightOperation(project, 'deployment.status'))?.[0]?.error?.code, 'NOT_FOUND');
  }

  const linked = { id: 'prj_di', link: { type: 'github', org: 'pyralisxc', repo: 'Development-Intelligence' } };
  const stale = new VercelDeploymentProvider({
    bindings: [bindings[0]!], tokenResolver: async () => 'token',
    fetch: async input => new URL(String(input)).pathname === '/v9/projects'
      ? Response.json({ projects: [linked], pagination: { next: null } })
      : Response.json({ id: 'prj_di', link: { type: 'github', org: 'different-owner', repo: 'Development-Intelligence' } }),
  });
  assert.equal((await stale.preflightOperation(project, 'deployment.status'))?.[0]?.error?.code, 'NOT_FOUND');

  const incomplete = new VercelDeploymentProvider({
    bindings: [bindings[0]!], tokenResolver: async () => 'token',
    fetch: async input => new URL(String(input)).pathname === '/v9/projects'
      ? Response.json({ projects: [linked], pagination: { next: 123 } })
      : Response.json(linked),
  });
  assert.equal((await incomplete.preflightOperation(project, 'deployment.status'))?.[0]?.error?.code, 'NOT_FOUND');
});

test('runtime and MCP expose Vercel deployment reads only when a deployment provider is configured', async () => {
  const { instance } = provider();
  const runtime = new ConductorToolRuntime({
    providers: [instance],
    deploymentProvider: instance,
    createOperationId: () => 'op-vercel',
  });

  const capabilities = await runtime.capabilities();
  assert.equal(capabilities.status, 'succeeded');
  if (capabilities.status === 'succeeded') {
    const names = capabilities.result.operations.map(item => item.name);
    assert.equal(names.includes('deployment.status'), true);
    assert.equal(names.includes('deployment.logs'), true);
  }

  const status = await runtime.deploymentStatus({ project: { id: 'Development-Intelligence' }, limit: 2 });
  assert.equal(status.status, 'succeeded');
  if (status.status === 'succeeded') assert.equal(status.result.production?.id, 'dpl_live');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createConductorMcpServer(runtime);
  const client = new Client({ name: 'vercel-provider-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  assert.equal(listed.tools.some(tool => tool.name === 'deployment.status' && tool.annotations?.readOnlyHint), true);
  assert.equal(listed.tools.some(tool => tool.name === 'deployment.logs' && tool.annotations?.readOnlyHint), true);
  await client.close();
  await server.close();
});

test('runtime bindings accept Vercel deployment routing without creating project semantics', () => {
  const bindings = parseRuntimeBindings(JSON.stringify([
    {
      id: 'Development-Intelligence',
      repository: 'pyralisxc/Development-Intelligence',
      vercelProject: 'development-intelligence',
      vercelTeamId: 'team_1',
    },
  ]));
  assert.deepEqual(bindings[0], {
    id: 'Development-Intelligence',
    repository: 'pyralisxc/Development-Intelligence',
    workspace: undefined,
    githubWrite: undefined,
    vercelProject: 'development-intelligence',
    vercelTeamId: 'team_1',
  });
});

test('runtime binding requires an installation identifier for connected Vercel credentials', () => {
  assert.equal(parseRuntimeBindings('[{"id":"conductor","vercelProject":"conductor","vercelConnectionId":"icfg_123"}]')[0]?.vercelConnectionId, 'icfg_123');
  assert.throws(() => parseRuntimeBindings('[{"id":"conductor","vercelConnectionId":"other"}]'), /vercelConnectionId/u);
});

test('additive Vercel binding preserves existing routing and rejects conflicting or loose permissions', () => {
  const base = parseRuntimeBindings('[{"id":"conductor","repository":"pyralisxc/Conductor","vercelProject":"conductor","vercelConnectionId":"icfg_A","vercelTeamId":"team_A"},{"id":"Development-Intelligence","repository":"pyralisxc/Development-Intelligence","githubWrite":false}]');
  const overlay = parseVercelBindingOverlay('[{"id":"Development-Intelligence","repository":"pyralisxc/Development-Intelligence","vercelProject":"prj_DI123","vercelConnectionId":"icfg_A","vercelTeamId":"team_A"}]');
  const merged = mergeVercelBindings(base, overlay);
  assert.equal(merged[0]?.vercelProject, 'conductor');
  assert.equal(merged[1]?.vercelProject, 'prj_DI123');
  assert.equal(merged[1]?.githubWrite, false);
  assert.equal(base[1]?.vercelProject, undefined);
  assert.throws(() => mergeVercelBindings(base, [{ ...overlay[0]!, repository: 'other/Development-Intelligence' }]), /conflicts/u);
  assert.throws(() => mergeVercelBindings(base, [{ ...overlay[0]!, id: 'other-alias' }]), /already bound/u);
  assert.throws(() => parseVercelBindingOverlay('[{"id":"DI","repository":"pyralisxc/DI","vercelProject":"di","vercelConnectionId":"icfg_A"}]'), /exact project ID/u);
  assert.throws(() => parseVercelBindingOverlay('[{"id":"DI","repository":"pyralisxc/DI","vercelProject":"prj_DI123","vercelConnectionId":"icfg_A","githubWrite":true}]'), /unsupported field/u);
});
