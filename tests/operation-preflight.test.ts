import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ConductorToolRuntime,
  GitHubRuntimeProvider,
  createConductorMcpServer,
  IdempotentMutationExecutor,
  InMemoryIdempotencyStore,
} from '../src/index.js';
import type {
  OperationPreflightProvider,
  ProjectMutationProvider,
  WorkItemCandidateReadProvider,
} from '../src/index.js';

test('GitHub App operation preflight proves exact read permissions and blocks missing write permission', async () => {
  const provider = new GitHubRuntimeProvider({
    credentials: {
      async getIdentity() { return { kind: 'app' as const, appId: '12345' }; },
      async getCredential(repository: string) {
        return {
          token: 'installation-token',
          kind: 'app-installation' as const,
          identity: { kind: 'app' as const, appId: '12345', installationId: 42 },
          repository,
          permissions: {
            pull_requests: 'read',
            checks: 'read',
            actions: 'read',
            contents: 'read',
          },
        };
      },
    },
    allowedOwners: ['pyralisxc'],
  });

  const read = await provider.preflightOperation(
    { id: 'pyralisxc/Conductor' },
    'pull-request.status',
  );
  assert.equal(read?.[0]?.status, 'ready');

  const write = await provider.preflightOperation(
    { id: 'pyralisxc/Conductor' },
    'git.branch.create',
  );
  assert.equal(write?.[0]?.status, 'blocked');
  assert.equal(write?.[0]?.error?.code, 'PERMISSION_DENIED');
  assert.match(write?.[0]?.summary ?? '', /contents:write/);
});

test('static GitHub token operation preflight remains degraded when repository role allows access', async () => {
  const provider = new GitHubRuntimeProvider({
    token: 'static-token',
    allowedOwners: ['pyralisxc'],
    fetch: async () => Response.json({
      full_name: 'pyralisxc/Conductor',
      permissions: { pull: true, push: true },
    }),
  });

  const read = await provider.preflightOperation(
    { id: 'pyralisxc/Conductor' },
    'pull-request.status',
  );
  const write = await provider.preflightOperation(
    { id: 'pyralisxc/Conductor' },
    'git.branch.create',
  );

  assert.equal(read?.[0]?.status, 'degraded');
  assert.equal(write?.[0]?.status, 'degraded');
  assert.match(read?.[0]?.summary ?? '', /cannot prove operation-specific permissions/);
});

test('runtime operation preflight fails closed when an operation is not exposed', async () => {
  const runtime = new ConductorToolRuntime();
  const receipt = await runtime.preflightOperation({
    project: { id: 'pyralisxc/Conductor' },
    operation: 'git.push',
  });

  assert.equal(receipt.status, 'succeeded');
  if (receipt.status !== 'succeeded') return;
  assert.equal(receipt.result.exposed, false);
  assert.equal(receipt.result.status, 'blocked');
  assert.equal(receipt.result.checks[0]?.error?.code, 'TOOL_UNAVAILABLE');
});

test('runtime operation preflight uses provider evidence for an exposed GitHub mutation', async () => {
  const github = new GitHubRuntimeProvider({
    credentials: {
      async getIdentity() { return { kind: 'app' as const, appId: '12345' }; },
      async getCredential(repository: string) {
        return {
          token: 'installation-token',
          kind: 'app-installation' as const,
          identity: { kind: 'app' as const, appId: '12345', installationId: 42 },
          repository,
          permissions: { contents: 'read' },
        };
      },
    },
    allowedOwners: ['pyralisxc'],
  });
  const mutationProvider: ProjectMutationProvider = github;
  const runtime = new ConductorToolRuntime({
    providers: [github],
    projectResolver: github,
    mutationProvider,
    mutationExecutor: new IdempotentMutationExecutor({ store: new InMemoryIdempotencyStore() }),
  });

  const receipt = await runtime.preflightOperation({
    project: { id: 'pyralisxc/Conductor' },
    operation: 'git.branch.create',
  });
  assert.equal(receipt.status, 'succeeded');
  if (receipt.status !== 'succeeded') return;
  assert.equal(receipt.result.exposed, true);
  assert.equal(receipt.result.status, 'blocked');
  assert.equal(receipt.result.checks.some((check) => check.provider === 'github' && check.error?.code === 'PERMISSION_DENIED'), true);
});

test('development status operation preflight aggregates every responsible provider', async () => {
  const workProvider: WorkItemCandidateReadProvider = {
    id: 'github-work',
    async getCapabilities() { return []; },
    async getWorkItemStatus() { throw new Error('unused'); },
    async listWorkItems() { return { repository: 'pyralisxc/Conductor', items: [], truncated: false }; },
    async listWorkItemPullRequests() { return []; },
  };
  const githubEvidence: OperationPreflightProvider = {
    id: 'github',
    async getCapabilities() { return []; },
    async preflightOperation(_project, operation) {
      if (operation !== 'development.status') return undefined;
      return [{ provider: 'github', status: 'ready', summary: 'GitHub evidence ready', diagnostics: [] }];
    },
  };
  const intelligenceEvidence: OperationPreflightProvider = {
    id: 'development-intelligence',
    async getCapabilities() { return []; },
    async preflightOperation(_project, operation) {
      if (operation !== 'development.status') return undefined;
      return [{
        provider: 'development-intelligence',
        status: 'blocked',
        summary: 'DI unavailable',
        diagnostics: [],
      }];
    },
  };
  const runtime = new ConductorToolRuntime({
    providers: [githubEvidence, intelligenceEvidence],
    workItemProvider: workProvider as any,
    workItemCandidateProvider: workProvider,
  });

  const receipt = await runtime.preflightOperation({
    project: { id: 'pyralisxc/Conductor' },
    operation: 'development.status',
  });
  assert.equal(receipt.status, 'succeeded');
  if (receipt.status !== 'succeeded') return;
  assert.equal(receipt.result.exposed, true);
  assert.equal(receipt.result.status, 'blocked');
  assert.deepEqual(
    receipt.result.checks.filter((check) => check.provider !== 'conductor').map((check) => check.provider),
    ['github', 'development-intelligence'],
  );
});


test('MCP exposes preflight_operation when an operation-evidence provider is configured', async () => {
  const provider: OperationPreflightProvider = {
    id: 'evidence',
    async getCapabilities() { return []; },
    async preflightOperation() {
      return [{ provider: 'evidence', status: 'ready', summary: 'ready', diagnostics: [] }];
    },
  };
  const runtime = new ConductorToolRuntime({ providers: [provider] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createConductorMcpServer(runtime);
  const client = new Client({ name: 'operation-preflight-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  assert.equal(listed.tools.some((tool) => tool.name === 'preflight_operation' && tool.annotations?.readOnlyHint), true);
  await client.close();
  await server.close();
});
