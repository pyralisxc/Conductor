import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ConductorToolRuntime,
  createConductorHttpHandler,
  createConductorMcpServer,
  IdempotentMutationExecutor,
  InMemoryIdempotencyStore,
} from '../src/index.js';
import type { ProjectMutationProvider } from '../src/index.js';

test('MCP adapter advertises only the two typed read-only runtime tools', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createConductorMcpServer(new ConductorToolRuntime({
    createOperationId: () => 'op-mcp',
  }));
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    'capabilities',
    'preflight_project',
  ]);
  assert.equal(listed.tools.every((tool) => tool.annotations?.readOnlyHint), true);

  const called = await client.callTool({ name: 'capabilities', arguments: {} });
  const content = called.structuredContent as { receipt: { operationId: string } };
  assert.equal(content.receipt.operationId, 'op-mcp');

  await client.close();
  await server.close();
});

test('HTTP MCP boundary publishes OAuth metadata and fails closed', async () => {
  const handler = createConductorHttpHandler({
    runtime: new ConductorToolRuntime(),
    publicUrl: 'http://127.0.0.1',
    oauthIssuer: 'https://identity.example.com',
    verifier: {
      async verifyAccessToken(token) {
        if (token !== 'valid-token') throw new Error('invalid');
        return {
          token,
          clientId: 'test-client',
          scopes: ['conductor.read'],
          resource: new URL('http://127.0.0.1/mcp'),
        };
      },
    },
  });
  const httpServer = createServer((request, response) => void handler(request, response));
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource`);
    assert.equal(metadata.status, 200);
    assert.deepEqual((await metadata.json() as { scopes_supported: string[] }).scopes_supported, ['conductor.read', 'conductor.write']);

    const unauthorized = await fetch(`${base}/mcp`, { method: 'POST' });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate') ?? '', /resource_metadata=/);

    const client = new Client({ name: 'http-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer valid-token' } },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 2);
    await client.close();
  } finally {
    httpServer.close();
    await once(httpServer, 'close');
  }
});

test('MCP advertises bounded mutations only when durable mutation infrastructure is supplied', async () => {
  const mutationProvider: ProjectMutationProvider = {
    id: 'github',
    async getCapabilities() { return []; },
    async createBranch(input) { return { repository: input.project.repository!, branch: input.branch, commitSha: input.fromSha }; },
    async createCommit() { throw new Error('unused'); },
    async createPullRequest() { throw new Error('unused'); },
    async commentPullRequest() { throw new Error('unused'); },
    async updatePullRequestLabels() { throw new Error('unused'); },
    async mergeIntegrationPullRequest() { throw new Error('unused'); },
    async promotePullRequest() { throw new Error('unused'); },
  };
  const runtime = new ConductorToolRuntime({
    mutationProvider,
    mutationExecutor: new IdempotentMutationExecutor({ store: new InMemoryIdempotencyStore() }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createConductorMcpServer(runtime);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    'capabilities', 'preflight_project', 'git.branch.create', 'git.commit.create',
    'pull-request.create', 'pull-request.comment.create', 'pull-request.labels.update',
    'pull-request.merge.integration', 'pull-request.merge.promote',
  ]);
  assert.equal(listed.tools.find((tool) => tool.name === 'git.branch.create')?.annotations?.readOnlyHint, false);
  await client.close();
  await server.close();
});

