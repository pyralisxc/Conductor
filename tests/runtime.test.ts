import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConductorToolError,
  ConductorToolRuntime,
  IdempotentMutationExecutor,
  InMemoryIdempotencyStore,
  normalizeToolError,
} from '../src/index.js';
import type {
  CapabilityAvailability,
  PreflightCheck,
  ProjectReference,
  ToolRuntimeProvider,
  SourceControlMutationProvider,
} from '../src/index.js';

const project: ProjectReference = {
  id: 'cardforge',
  repository: 'pyralisxc/CardForge',
  workspace: '/workspace/cardforge',
  ref: 'preview',
};

function provider(input: {
  id: string;
  capabilities?: CapabilityAvailability[];
  checks?: PreflightCheck[];
  capabilityError?: unknown;
  preflightError?: unknown;
}): ToolRuntimeProvider {
  return {
    id: input.id,
    async getCapabilities() {
      if (input.capabilityError) throw input.capabilityError;
      return input.capabilities ?? [];
    },
    async preflightProject() {
      if (input.preflightError) throw input.preflightError;
      return input.checks ?? [];
    },
  };
}

function readyCheck(
  check: PreflightCheck['check'],
  source: string,
): PreflightCheck {
  return {
    check,
    status: 'ready',
    provider: source,
    summary: `${check} is ready`,
    diagnostics: [],
  };
}

test('capabilities reports only the configured runtime operations and provider facts', async () => {
  const runtime = new ConductorToolRuntime({
    providers: [
      provider({
        id: 'github',
        capabilities: [
          {
            capability: 'github.read',
            available: true,
            provider: 'github',
            access: 'read',
            auth: 'ready',
            health: 'ready',
            diagnostics: [],
          },
          {
            capability: 'github.write',
            available: false,
            provider: 'github',
            access: 'write',
            auth: 'denied',
            health: 'unavailable',
            diagnostics: [],
          },
        ],
      }),
    ],
    createOperationId: () => 'op-capabilities',
  });

  const receipt = await runtime.capabilities();
  assert.equal(receipt.status, 'succeeded');
  if (receipt.status !== 'succeeded') return;

  assert.deepEqual(
    receipt.result.operations.map((operation) => operation.name),
    ['capabilities', 'preflight_project'],
  );
  assert.deepEqual(
    receipt.result.capabilities.map((capability) => [
      capability.capability,
      capability.available,
    ]),
    [
      ['github.read', true],
      ['github.write', false],
    ],
  );
  assert.equal(receipt.operationId, 'op-capabilities');
});

test('preflight defaults to develop checks without requiring a local execution plane', async () => {
  const runtime = new ConductorToolRuntime({
    providers: [
      provider({
        id: 'github',
        checks: [
          readyCheck('repository.access', 'github'),
          readyCheck('github.read', 'github'),
          {
            check: 'github.write',
            status: 'blocked',
            provider: 'github',
            summary: 'GitHub installation is read-only',
            error: {
              code: 'PERMISSION_DENIED',
              message: 'GitHub installation is read-only',
              retryable: false,
              source: 'github',
              diagnostics: [],
            },
            diagnostics: [],
          },
        ],
      }),
      provider({
        id: 'workspace',
        checks: [
          readyCheck('workspace.access', 'workspace'),
          readyCheck('shell.execute', 'workspace'),
          readyCheck('tests.run', 'workspace'),
        ],
      }),
    ],
    createOperationId: () => 'op-preflight',
  });

  const receipt = await runtime.preflightProject(project);
  assert.equal(receipt.status, 'succeeded');
  if (receipt.status !== 'succeeded') return;

  assert.equal(receipt.result.status, 'blocked');
  assert.equal(receipt.result.intent, 'develop');
  assert.equal(receipt.result.checks.length, 4);
  assert.deepEqual(
    receipt.result.checks.map((check) => check.check),
    [
      'repository.access',
      'github.read',
      'github.write',
      'development-intelligence.read',
    ],
  );
  assert.equal(
    receipt.result.checks.at(-1)?.error?.code,
    'TOOL_UNAVAILABLE',
  );
});

test('preflight intents select only their required evidence planes', async () => {
  const runtime = new ConductorToolRuntime({
    providers: [provider({
      id: 'all',
      checks: [
        readyCheck('repository.access', 'all'), readyCheck('github.read', 'all'),
        readyCheck('github.write', 'all'), readyCheck('workspace.access', 'all'),
        readyCheck('shell.execute', 'all'), readyCheck('tests.run', 'all'),
        readyCheck('development-intelligence.read', 'all'),
      ],
    })],
  });
  const inspect = await runtime.preflightProject(project, 'inspect');
  const execute = await runtime.preflightProject(project, 'execute');
  assert.equal(inspect.status, 'succeeded');
  assert.equal(execute.status, 'succeeded');
  if (inspect.status === 'succeeded') assert.equal(inspect.result.checks.length, 3);
  if (execute.status === 'succeeded') assert.equal(execute.result.checks.length, 7);
});

test('provider failures become truthful capability health instead of hidden throws', async () => {
  const runtime = new ConductorToolRuntime({
    providers: [
      provider({
        id: 'development-intelligence',
        capabilityError: new ConductorToolError({
          code: 'AUTH_REQUIRED',
          message: 'Development Intelligence authentication is missing',
        }),
      }),
    ],
  });

  const receipt = await runtime.capabilities();
  assert.equal(receipt.status, 'succeeded');
  if (receipt.status !== 'succeeded') return;

  assert.equal(receipt.result.providers[0]?.health, 'unavailable');
  assert.equal(receipt.result.providers[0]?.error?.code, 'AUTH_REQUIRED');
});

test('tool errors normalize stable provider and command failure codes', () => {
  assert.equal(normalizeToolError({ status: 401 }).code, 'AUTH_REQUIRED');
  assert.equal(normalizeToolError({ code: 'AUTH_REQUIRED' }).code, 'AUTH_REQUIRED');
  assert.equal(normalizeToolError({ status: 403 }).code, 'PERMISSION_DENIED');
  assert.equal(normalizeToolError({ code: 'ENOENT' }).code, 'NOT_FOUND');
  assert.equal(normalizeToolError({ status: 409 }).code, 'CONFLICT');
  assert.equal(normalizeToolError({ status: 503 }).code, 'TRANSIENT');
  assert.equal(
    normalizeToolError({ exitCode: 2, message: 'tests failed' }).code,
    'COMMAND_FAILED',
  );
  assert.equal(normalizeToolError(new Error('missing adapter')).code, 'TOOL_UNAVAILABLE');
});

test('idempotent mutation retries replay one operation and preserve identifiers', async () => {
  let mutations = 0;
  let operationIds = 0;
  const executor = new IdempotentMutationExecutor({
    store: new InMemoryIdempotencyStore(),
    createOperationId: () => `op-${++operationIds}`,
    now: (() => {
      let tick = 0;
      return () => new Date(`2026-01-01T00:00:0${tick++}Z`);
    })(),
  });
  const input = {
    key: 'branch:cardforge:work/cf-1',
    fingerprint: 'sha256:branch-payload',
    operation: 'git.branch.create' as const,
    target: { kind: 'repository' as const, id: 'pyralisxc/CardForge' },
  };

  const first = await executor.execute(input, async () => {
    mutations += 1;
    return {
      result: { branch: 'work/cf-1' },
      identifiers: { branch: 'work/cf-1', commitSha: 'abc123' },
    };
  });
  const replay = await executor.execute(input, async () => {
    mutations += 1;
    return { result: { branch: 'duplicate' } };
  });

  assert.equal(mutations, 1);
  assert.equal(first.status, 'succeeded');
  assert.equal(replay.status, 'succeeded');
  assert.equal(replay.operationId, first.operationId);
  assert.equal(replay.startedAt, first.startedAt);
  assert.equal(replay.identifiers?.commitSha, 'abc123');
  assert.equal(replay.idempotency?.replayed, true);
});

test('reusing an idempotency key for a different mutation fails with conflict', async () => {
  const executor = new IdempotentMutationExecutor({
    store: new InMemoryIdempotencyStore(),
  });
  const base = {
    key: 'pr:cardforge:cf-1',
    operation: 'pull-request.create' as const,
    target: { kind: 'repository' as const, id: 'pyralisxc/CardForge' },
  };

  await executor.execute(
    { ...base, fingerprint: 'sha256:first' },
    async () => ({ result: { pullRequestNumber: 12 } }),
  );
  const conflict = await executor.execute(
    { ...base, fingerprint: 'sha256:second' },
    async () => ({ result: { pullRequestNumber: 13 } }),
  );

  assert.equal(conflict.status, 'failed');
  if (conflict.status !== 'failed') return;
  assert.equal(conflict.error.code, 'CONFLICT');
});

test('a retry while the first mutation is running cannot execute a duplicate', async () => {
  let releaseMutation!: () => void;
  const mutationCanFinish = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  let mutations = 0;
  const executor = new IdempotentMutationExecutor({
    store: new InMemoryIdempotencyStore(),
  });
  const input = {
    key: 'comment:cardforge:pr-12:summary',
    fingerprint: 'sha256:comment',
    operation: 'pull-request.comment.create' as const,
    target: { kind: 'repository' as const, id: 'pyralisxc/CardForge' },
  };

  const first = executor.execute(input, async () => {
    mutations += 1;
    await mutationCanFinish;
    return {
      result: { commentId: 'comment-1' },
      identifiers: { commentId: 'comment-1', pullRequestNumber: 12 },
    };
  });
  const retry = await executor.execute(input, async () => {
    mutations += 1;
    return { result: { commentId: 'duplicate' } };
  });

  assert.equal(retry.status, 'failed');
  if (retry.status === 'failed') {
    assert.equal(retry.error.code, 'TRANSIENT');
    assert.equal(retry.error.retryable, true);
  }
  assert.equal(mutations, 1);

  releaseMutation();
  const completed = await first;
  assert.equal(completed.status, 'succeeded');
});

test('runtime exposes PR status as a read operation when a PR provider is configured', async () => {
  const pullRequestProvider = {
    id: 'github',
    async getCapabilities() { return []; },
    async getPullRequestStatus(input: any) {
      return {
        repository: input.project.repository,
        pullRequestNumber: input.pullRequestNumber,
        url: 'https://github.com/pyralisxc/CardForge/pull/12',
        state: 'open',
        draft: false,
        merged: false,
        mergeable: true,
        mergeableState: 'clean',
        head: { ref: 'work/cf', sha: 'a'.repeat(40) },
        base: { ref: 'vercel-preview', sha: 'b'.repeat(40) },
        labels: [],
        checks: { total: 0, pending: 0, successful: 0, failed: 0, neutral: 0, skipped: 0, items: [] },
        workflowRuns: [],
        orchestration: {
          state: 'promotion-ready' as const,
          action: 'promotion-gate' as const,
          shouldAct: true,
          summary: 'ready',
          resumeWhen: null,
          transition: {
            observed: false,
            previousHeadSha: null,
            previousState: null,
            headChanged: null,
            stateChanged: null,
            meaningful: null,
          },
          seal: {
            requested: false,
            expectedPreSealCheckpoint: false,
            exactHeadVerificationRequired: false,
          },
          signals: { pending: [], actionRequired: [], failed: [] },
        },
      };
    },
  };
  const runtime = new ConductorToolRuntime({ pullRequestProvider });
  const capabilities = await runtime.capabilities();
  assert.equal(capabilities.status, 'succeeded');
  if (capabilities.status === 'succeeded') {
    assert.equal(capabilities.result.operations.some((item) => item.name === 'pull-request.status' && !item.mutates), true);
  }
  const receipt = await runtime.pullRequestStatus({
    project: { id: 'cardforge', repository: 'pyralisxc/CardForge' },
    pullRequestNumber: 12,
  });
  assert.equal(receipt.status, 'succeeded');
  if (receipt.status === 'succeeded') assert.equal(receipt.result.pullRequestNumber, 12);
});

test('runtime exposes bounded mutations only with a provider and idempotency executor', async () => {
  let creates = 0;
  const sourceControlMutationProvider: SourceControlMutationProvider = {
    id: 'github',
    async getCapabilities() { return []; },
    async createBranch(input) {
      creates += 1;
      return { repository: input.project.repository!, branch: input.branch, commitSha: input.fromSha };
    },
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
  const capabilities = await runtime.capabilities();
  assert.equal(capabilities.status, 'succeeded');
  if (capabilities.status === 'succeeded') {
    assert.deepEqual(capabilities.result.operations.filter((item) => item.mutates).map((item) => item.name), [
      'git.branch.create', 'git.commit.create', 'pull-request.create', 'pull-request.comment.create',
      'pull-request.labels.update', 'pull-request.merge.integration', 'pull-request.merge.reconcile-preview', 'pull-request.merge.promote',
    ]);
  }
  const input = {
    project: { id: 'cardforge', repository: 'pyralisxc/CardForge' },
    branch: 'work/cf-42',
    fromSha: 'a'.repeat(40),
    idempotencyKey: 'branch:cardforge:cf-42',
  };
  const first = await runtime.createBranch(input);
  const replay = await runtime.createBranch(input);
  assert.equal(first.status, 'succeeded');
  assert.equal(replay.idempotency?.replayed, true);
  assert.equal(creates, 1);
});

