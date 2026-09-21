import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ConductorToolRuntime,
  GitHubRuntimeProvider,
  IdempotentMutationExecutor,
  InMemoryIdempotencyStore,
  createConductorMcpServer,
} from '../src/index.js';

function githubProvider() {
  const labels = new Set(['status:ready', 'status:in-progress', 'area:di']);
  return new GitHubRuntimeProvider({
    credentials: {
      async getIdentity() { return { kind: 'app' as const, appId: '12345' }; },
      async getCredential(repository: string) {
        return {
          token: 'installation-token',
          kind: 'app-installation' as const,
          identity: { kind: 'app' as const, appId: '12345', installationId: 42 },
          repository,
          permissions: { issues: 'write' },
        };
      },
    },
    allowedOwners: ['pyralisxc'],
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.includes('/labels/status%3A') && method === 'GET') return Response.json({ name: decodeURIComponent(url.split('/').at(-1)!) });
      if (url.endsWith('/issues') && method === 'POST') {
        for (const label of body.labels ?? []) labels.add(label);
        return Response.json({
          number: 7,
          html_url: 'https://github.com/pyralisxc/Development-Intelligence/issues/7',
          title: body.title,
          body: body.body,
          state: 'open',
          labels: [...labels].filter((label) => (body.labels ?? []).includes(label)).map((name) => ({ name })),
          created_at: '2026-09-20T00:00:00Z',
          updated_at: '2026-09-20T00:00:00Z',
        });
      }
      if (url.endsWith('/issues/7') && method === 'GET') return Response.json({
        number: 7,
        html_url: 'https://github.com/pyralisxc/Development-Intelligence/issues/7',
        title: 'Improve semantic orientation',
        body: 'Benchmark Game Studio Core.',
        state: 'open',
        labels: [{ name: 'status:ready' }, { name: 'area:di' }],
        created_at: '2026-09-20T00:00:00Z',
        updated_at: '2026-09-20T00:00:00Z',
      });
      if (url.includes('/issues?') && method === 'GET') return Response.json([
        {
          number: 7,
          html_url: 'https://github.com/pyralisxc/Development-Intelligence/issues/7',
          title: 'Improve semantic orientation',
          body: 'Benchmark Game Studio Core.',
          state: 'open',
          labels: [{ name: 'status:ready' }, { name: 'area:di' }],
          created_at: '2026-09-20T00:00:00Z',
          updated_at: '2026-09-20T00:00:00Z',
        },
        {
          number: 8,
          html_url: 'https://github.com/pyralisxc/Development-Intelligence/pull/8',
          title: 'PR is not a work item',
          body: '',
          state: 'open',
          labels: [],
          created_at: '2026-09-20T00:00:00Z',
          updated_at: '2026-09-20T00:00:00Z',
          pull_request: {},
        },
      ]);
      if (url.endsWith('/issues/7') && method === 'PATCH') return Response.json({
        number: 7,
        html_url: 'https://github.com/pyralisxc/Development-Intelligence/issues/7',
        title: 'Improve semantic orientation',
        body: 'Benchmark Game Studio Core.',
        state: body.state,
        labels: [{ name: 'status:ready' }, { name: 'area:di' }],
        created_at: '2026-09-20T00:00:00Z',
        updated_at: '2026-09-20T01:00:00Z',
      });
      if (url.endsWith('/issues/7/labels') && method === 'PUT') {
        return Response.json((body.labels ?? []).map((name: string) => ({ name })));
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    },
  });
}

test('GitHub issues normalize into provider-neutral work-item statuses', async () => {
  const provider = githubProvider();
  const project = { id: 'pyralisxc/Development-Intelligence' };

  const created = await provider.createWorkItem({
    project,
    title: 'Improve semantic orientation',
    body: 'Benchmark Game Studio Core.',
    status: 'ready',
    labels: ['area:di'],
    idempotencyKey: 'work-item:create:semantic-orientation',
  });
  assert.equal(created.status, 'ready');

  const status = await provider.getWorkItemStatus({ project, issueNumber: 7 });
  assert.equal(status.status, 'ready');
  assert.equal(status.statusSource, 'label');

  const listed = await provider.listWorkItems({ project, statuses: ['ready'], limit: 20 });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0]?.issueNumber, 7);

  const updated = await provider.updateWorkItemStatus({
    project,
    issueNumber: 7,
    status: 'in-progress',
    idempotencyKey: 'work-item:status:7:in-progress',
  });
  assert.equal(updated.status, 'in-progress');
  assert.equal(updated.labels.includes('area:di'), true);
});

test('runtime and MCP expose work-item reads and human-triggered status mutations', async () => {
  const provider = githubProvider();
  const runtime = new ConductorToolRuntime({
    providers: [provider],
    projectResolver: provider,
    workItemProvider: provider,
    mutationExecutor: new IdempotentMutationExecutor({ store: new InMemoryIdempotencyStore() }),
  });

  const capabilities = await runtime.capabilities();
  assert.equal(capabilities.status, 'succeeded');
  if (capabilities.status === 'succeeded') {
    const names = capabilities.result.operations.map((operation) => operation.name);
    for (const name of ['work-item.status', 'work-item.list', 'work-item.create', 'work-item.update-status']) {
      assert.equal(names.includes(name as any), true);
    }
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createConductorMcpServer(runtime);
  const client = new Client({ name: 'work-item-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  for (const name of ['work-item.status', 'work-item.list', 'work-item.create', 'work-item.update-status']) {
    assert.equal(names.includes(name), true);
  }
  await client.close();
  await server.close();
});
