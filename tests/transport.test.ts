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
import type { SourceControlMutationProvider, SourceArtifactReadProvider, CiReadProvider } from '../src/index.js';
import { compositeMutationOutputSchema } from '../src/transport/mcp.js';

async function within<T>(promise: Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`test operation exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('MCP adapter advertises only the core typed read-only runtime tools', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createConductorMcpServer(new ConductorToolRuntime({
    createOperationId: () => 'op-mcp',
  }));
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await within(client.listTools());
    assert.deepEqual(listed.tools.map((tool) => tool.name), [
      'capabilities',
      'preflight_project',
      'evidence.bundle',
    ]);
    assert.equal(listed.tools.every((tool) => tool.annotations?.readOnlyHint), true);

    const called = await client.callTool({ name: 'capabilities', arguments: {} });
    const result = called.structuredContent as { receipt: { operationId: string } };
    assert.equal(result.receipt.operationId, 'op-mcp');
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
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
    try {
      await client.connect(transport);
      const tools = await within(client.listTools());
      assert.equal(tools.tools.length, 3);
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    httpServer.close();
    await once(httpServer, 'close');
  }
});

test('MCP advertises bounded mutations only when durable mutation infrastructure is supplied', async () => {
  const sourceControlMutationProvider: SourceControlMutationProvider = {
    id: 'github',
    async getCapabilities() { return []; },
    async createBranch(input) { return { repository: input.project.repository!, branch: input.branch, commitSha: input.fromSha }; },
    async bootstrapIntegrationBranch(input) {
      return {
        repository: input.project.repository!,
        branch: input.branch,
        commitSha: input.fromSha,
        defaultBranch: 'main',
        created: true,
        approvalReference: input.approvalReference,
      };
    },
    async deleteBranch(input) { return { repository: input.project.repository!, branch: input.branch, commitSha: input.expectedHeadSha, deleted: true as const, containedIn: 'preview' }; },
    async createCommit() { throw new Error('unused'); },
    async createPullRequest() { throw new Error('unused'); },
    async commentPullRequest() { throw new Error('unused'); },
    async updatePullRequestLabels() { throw new Error('unused'); },
    async mergeIntegrationPullRequest() { throw new Error('unused'); },
    async reconcilePreviewPullRequest() { throw new Error('unused'); },
    async promotePullRequest() { throw new Error('unused'); },
  };
  const runtime = new ConductorToolRuntime({
    sourceControlMutationProvider,
    mutationExecutor: new IdempotentMutationExecutor({ store: new InMemoryIdempotencyStore() }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createConductorMcpServer(runtime);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await within(client.listTools());
    assert.deepEqual(listed.tools.map((tool) => tool.name), [
      'capabilities', 'preflight_project', 'evidence.bundle', 'git.branch.create', 'git.integration.bootstrap', 'git.branch.delete', 'git.commit.create',
      'pull-request.create', 'pull-request.comment.create', 'pull-request.labels.update',
      'pull-request.merge.integration', 'pull-request.merge.reconcile-preview', 'pull-request.merge.promote',
    ]);
    assert.equal(listed.tools.find((tool) => tool.name === 'git.branch.create')?.annotations?.readOnlyHint, false);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

test('MCP publishes DI-first exact source and CI drill-down reads when their providers are configured', async () => {
  const sourceArtifactProvider: SourceArtifactReadProvider = {
    id: 'source',
    async getCapabilities() { return []; },
    async getSourceArtifact(input) {
      return { provider: 'github', repository: input.project.repository!, revisionSha: input.sha, path: input.path, blobSha: 'blob', size: 4, status: 'available', content: 'text', encoding: 'utf-8', reason: null, observedAt: '2026-09-25T00:00:00Z' };
    },
  };
  const ciReadProvider: CiReadProvider = {
    id: 'ci',
    async getCapabilities() { return []; },
    async getCiRunEvidence(input) {
      return { provider: 'github', repository: input.project.repository!, pullRequestNumber: input.pullRequestNumber, headSha: input.expectedHeadSha, workflowRun: { id: input.workflowRunId, name: 'verify', status: 'completed', conclusion: 'failure', url: null, event: null, headSha: input.expectedHeadSha }, jobs: [], jobsTruncated: false, observedAt: '2026-09-25T00:00:00Z' };
    },
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createConductorMcpServer(new ConductorToolRuntime({ sourceArtifactProvider, ciReadProvider }));
  const client = new Client({ name: 'evidence-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await within(client.listTools());
  const names = listed.tools.map(tool => tool.name);
  assert.equal(names.includes('source.artifact.read'), true);
  assert.equal(names.includes('ci.run.read'), true);
  assert.equal(listed.tools.find(tool => tool.name === 'source.artifact.read')?.annotations?.readOnlyHint, true);
  assert.equal(listed.tools.find(tool => tool.name === 'ci.run.read')?.annotations?.readOnlyHint, true);
  await client.close();
  await server.close();
});


test('HTTP root redirects browsers to the owner Vercel connection entry point', async () => {
  const handler = createConductorHttpHandler({
    runtime: new ConductorToolRuntime(),
    publicUrl: 'http://127.0.0.1',
    oauthIssuer: 'http://127.0.0.1',
    verifier: { async verifyAccessToken(token) { return { token, clientId: 'test', scopes: ['conductor.read'], resource: new URL('http://127.0.0.1/mcp') }; } },
  });
  const server = createServer((request, response) => void handler(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`, { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/connections/vercel');
  } finally {
    server.close();
    await once(server, 'close');
  }
});


test('composite lifecycle receipt schema accepts success without fabricated outer idempotency', () => {
  const parsed = compositeMutationOutputSchema.safeParse({
    receipt: {
      contractVersion: 'conductor.tool-runtime.v0',
      operationId: 'op-lifecycle',
      operation: 'lifecycle.advance',
      target: { kind: 'project', id: 'Conductor' },
      startedAt: '2026-09-27T00:00:00Z',
      finishedAt: '2026-09-27T00:00:01Z',
      diagnostics: [],
      status: 'succeeded',
      result: {
        contractVersion: 'conductor.tool-runtime.v0',
        project: { id: 'Conductor', repository: 'pyralisxc/Conductor' },
        issueNumber: 170,
        stage: 'external-wait',
        summary: 'waiting',
        transitions: [],
        previewProof: null,
        gate: {
          kind: 'external-wait',
          allowedNextOperation: 'lifecycle.advance',
          issueNumber: 170,
          summary: 'waiting',
          resumeWhen: 'provider changes',
          pullRequestNumber: 183,
          expectedHeadSha: 'a'.repeat(40),
          expectedBaseSha: 'b'.repeat(40),
        },
        continuation: { handle: 'signed-gate', expiresAt: 123, gateId: 'gate-1' },
      },
    },
  });
  assert.equal(parsed.success, true);
});
