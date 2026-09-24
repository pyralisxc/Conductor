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
  const grants = new Map<string, WorkScopeGrant>();
  const store: WorkScopeStore = {
    async get(id) { return grants.get(id) ?? null; },
    async set(id, grant) { grants.set(id, grant); },
    async delete(id) { grants.delete(id); },
  };
  const runtime = new ConductorToolRuntime({
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
