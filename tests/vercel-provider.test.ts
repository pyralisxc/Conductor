import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ConductorToolRuntime,
  VercelDeploymentProvider,
  createConductorMcpServer,
  parseRuntimeBindings,
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
      if (url.pathname === '/v13/deployments') {
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
