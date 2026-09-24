import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConductorToolRuntime, createConductorHttpHandler, IdempotentMutationExecutor, InMemoryIdempotencyStore } from '../src/index.js';
import { clientFingerprint, parseWorkScopeGrant, WorkScopeAuthorizer, type WorkScopeGrant, type WorkScopeStore } from '../src/transport/work-scope.js';

process.env.CONDUCTOR_SESSION_SECRET = 'test-work-context-secret-long-enough-for-hmac';

test('MCP refuses cross-repository branch writes before the provider executes', async () => {
  let providerCalls = 0;
  let routedComments = 0;
  let routedStatuses = 0;
  let routedClassifications = 0;
  const grants = new Map<string, WorkScopeGrant>();
  const store: WorkScopeStore = {
    async get(id) { return grants.get(id) ?? null; },
    async set(id, grant) { grants.set(id, grant); },
    async delete(id) { grants.delete(id); },
  };
  const runtime = new ConductorToolRuntime({
    workItemProvider: {
      id: 'github-issues',
      async getCapabilities() { return []; },
      async getWorkItemStatus() { throw new Error('unused'); },
      async listWorkItems() { throw new Error('unused'); },
      async createWorkItem() { throw new Error('unused'); },
      async commentWorkItem(input) {
        routedComments++;
        return { repository: input.project.repository!, issueNumber: input.issueNumber, commentId: '3', url: 'https://github.com/pyralisxc/Other/issues/7#issuecomment-3' };
      },
      async updateWorkItemStatus(input) {
        routedStatuses++;
        return { ...workItem(input.project.repository!), status: input.status, state: input.status === 'done' ? 'closed' as const : 'open' as const };
      },
      async updateWorkItemClassification(input) {
        routedClassifications++;
        return { ...workItem(input.project.repository!), kind: input.kind ?? 'unknown', origin: input.origin ?? 'unknown' };
      },
    },
    sourceControlMutationProvider: {
      id: 'github',
      async getCapabilities() { return []; },
      async createBranch(input) { providerCalls++; return { repository: input.project.repository!, branch: input.branch, commitSha: input.fromSha }; },
      async createCommit() { throw new Error('unused'); },
      async createPullRequest() { throw new Error('unused'); },
      async commentPullRequest() { throw new Error('unused'); },
      async updatePullRequestLabels() { throw new Error('unused'); },
      async mergeIntegrationPullRequest() { throw new Error('unused'); },
      async reconcilePreviewPullRequest() { throw new Error('unused'); },
      async promotePullRequest() { throw new Error('unused'); },
    },
    mutationExecutor: new IdempotentMutationExecutor({ store: new InMemoryIdempotencyStore() }),
  });
  const server = createServer((req, res) => void createConductorHttpHandler({
    runtime,
    publicUrl: 'http://127.0.0.1',
    oauthIssuer: 'http://127.0.0.1',
    workScope: new WorkScopeAuthorizer(store),
    verifier: { async verifyAccessToken(token) { return { token, clientId: 'test-client', scopes: ['conductor.read', 'conductor.write'], resource: new URL('http://127.0.0.1/mcp') }; } },
  })(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new Client({ name: 'scope-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer test-token' } },
    }));
    const context = await client.callTool({ name: 'work-scope.begin', arguments: { repository: 'pyralisxc/Conductor' } });
    assert.notEqual(context.isError, true);
    const workContext = JSON.parse(((context.content as Array<{ text: string }>)[0]).text).workContext as string;
    const input = { project: { id: 'Other', repository: 'pyralisxc/Other' }, workContext, branch: 'work/scope-test', fromSha: 'a'.repeat(40), idempotencyKey: 'scope-boundary-test' };
    const blocked = await client.callTool({ name: 'git.branch.create', arguments: input });
    assert.equal(blocked.isError, true);
    assert.equal(providerCalls, 0);

    const destination = { id: 'Other', repository: 'pyralisxc/Other' };
    const commentInput = { project: destination, issueNumber: 7, body: 'Additional evidence for the existing issue.', idempotencyKey: 'route-existing-evidence' };
    assert.notEqual((await client.callTool({ name: 'work-item.comment.create', arguments: commentInput })).isError, true);
    assert.notEqual((await client.callTool({ name: 'work-item.comment.create', arguments: commentInput })).isError, true);
    assert.equal(routedComments, 1);
    assert.notEqual((await client.callTool({ name: 'work-item.classification.update', arguments: { project: destination, issueNumber: 7, kind: 'bug', idempotencyKey: 'route-classify-existing' } })).isError, true);
    assert.notEqual((await client.callTool({ name: 'work-item.update-status', arguments: { project: destination, issueNumber: 7, status: 'done', idempotencyKey: 'route-close-duplicate' } })).isError, true);
    assert.equal(routedClassifications, 1);
    assert.equal(routedStatuses, 1);
    assert.equal(providerCalls, 0);

    await store.set(clientFingerprint('test-client'), parseWorkScopeGrant({
      primaryRepository: 'pyralisxc/Conductor',
      developRepositories: [], expiresAt: Date.now() + 60_000,
    }));
    const routeOnly = await client.callTool({ name: 'git.branch.create', arguments: input });
    assert.equal(routeOnly.isError, true);
    assert.equal(providerCalls, 0);

    await store.set(clientFingerprint('test-client'), parseWorkScopeGrant({
      primaryRepository: 'pyralisxc/Conductor',
      developRepositories: ['pyralisxc/Other'], expiresAt: Date.now() + 60_000,
    }));
    const allowed = await client.callTool({ name: 'git.branch.create', arguments: input });
    assert.notEqual(allowed.isError, true);
    assert.equal(providerCalls, 1);
  } finally {
    await client.close();
    server.close();
    await once(server, 'close');
  }
});

function workItem(repository: string) {
  return {
    repository, issueNumber: 7, url: `https://github.com/${repository}/issues/7`,
    title: 'Existing issue', body: 'Original description', state: 'open' as const,
    status: 'ready' as const, statusSource: 'label' as const,
    kind: 'unknown' as const, kindSource: 'default' as const,
    origin: 'unknown' as const, originSource: 'default' as const,
    labels: [], createdAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z',
  };
}
