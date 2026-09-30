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
  SourceArtifactReadProvider,
  CiReadProvider,
  RepositoryAcquisitionProvider,
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
    ['capabilities', 'preflight_project', 'evidence.bundle'],
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
    async bootstrapIntegrationBranch(input) {
      creates += 1;
      return {
        repository: input.project.repository!,
        branch: input.branch,
        commitSha: input.fromSha,
        defaultBranch: 'main',
        created: true,
        approvalReference: input.approvalReference,
      };
    },
    async deleteBranch(input) {
      creates += 1;
      return { repository: input.project.repository!, branch: input.branch, commitSha: input.expectedHeadSha, deleted: true as const, containedIn: 'preview' };
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
      'git.branch.create', 'git.integration.bootstrap', 'git.branch.delete', 'git.commit.create', 'pull-request.create', 'pull-request.comment.create',
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

  const bootstrapInput = {
    project: { id: 'cardforge', repository: 'pyralisxc/CardForge' },
    branch: 'preview' as const,
    fromSha: 'b'.repeat(40),
    approvalReference: 'owner-approved:bootstrap-preview',
    idempotencyKey: 'bootstrap:cardforge:preview',
  };
  const bootstrapped = await runtime.bootstrapIntegrationBranch(bootstrapInput);
  const bootstrapReplay = await runtime.bootstrapIntegrationBranch(bootstrapInput);
  assert.equal(bootstrapped.status, 'succeeded');
  assert.equal(bootstrapReplay.idempotency?.replayed, true);
  assert.equal(creates, 2);

  const deleteInput = {
    project: { id: 'cardforge', repository: 'pyralisxc/CardForge' },
    branch: 'work/cf-42',
    expectedHeadSha: 'a'.repeat(40),
    idempotencyKey: 'branch-delete:cardforge:cf-42',
  };
  const deleted = await runtime.deleteBranch(deleteInput);
  const deleteReplay = await runtime.deleteBranch(deleteInput);
  assert.equal(deleted.status, 'succeeded');
  assert.equal(deleteReplay.idempotency?.replayed, true);
  assert.equal(creates, 3);
});

test('runtime exposes bounded source discovery only when the source provider supports it', async () => {
  const sourceArtifactProvider: SourceArtifactReadProvider = {
    id: 'github-source',
    async getCapabilities() { return []; },
    async getSourceArtifact() { throw new Error('unused'); },
    async discoverSource(input) {
      return {
        provider: 'github' as const, repository: input.project.repository ?? input.project.id,
        revisionSha: input.sha, treeSha: 'b'.repeat(40),
        mode: input.query ? 'literal' as const : 'manifest' as const,
        query: input.query ?? null, pathPrefix: input.pathPrefix ?? null,
        totalFiles: 2, candidateFiles: 2,
        files: input.query ? [] : [{ path: 'src/index.ts', blobSha: 'c'.repeat(40), size: 20 }],
        matches: input.query ? [{ path: 'src/index.ts', blobSha: 'c'.repeat(40), size: 20, line: 1, snippet: 'needle' }] : [],
        scannedFiles: input.query ? 1 : 0, scannedBytes: input.query ? 20 : 0,
        skipped: { tooLarge: 0, binaryOrInvalidText: 0, unsupported: 0 },
        truncated: false, truncationReasons: [],
        limits: { maxFiles: 80, maxBytes: 2 * 1024 * 1024, maxFileBytes: 128 * 1024, maxMatches: 20 },
        observedAt: '2026-09-28T00:00:00Z', note: 'provider evidence',
      };
    },
  };
  const runtime = new ConductorToolRuntime({ sourceArtifactProvider });
  const capabilities = await runtime.capabilities();
  assert.equal(capabilities.status, 'succeeded');
  if (capabilities.status === 'succeeded') assert.equal(capabilities.result.operations.some((item) => item.name === 'source.discover' && !item.mutates), true);
  const receipt = await runtime.sourceDiscover({ project: { id: 'Conductor', repository: 'pyralisxc/Conductor' }, sha: 'a'.repeat(40), query: 'needle' });
  assert.equal(receipt.status, 'succeeded');
  if (receipt.status === 'succeeded') assert.equal(receipt.result.matches[0]?.path, 'src/index.ts');
});

test('runtime exposes exact source and CI evidence reads without enabling mutations', async () => {
  const sourceArtifactProvider: SourceArtifactReadProvider = {
    id: 'github-source',
    async getCapabilities() { return []; },
    async getSourceArtifact(input) {
      return {
        provider: 'github', repository: input.project.repository!, revisionSha: input.sha, path: input.path,
        blobSha: 'blob', size: 4, status: 'available', content: 'text', encoding: 'utf-8', reason: null,
        observedAt: '2026-09-25T00:00:00Z',
      };
    },
  };
  const ciReadProvider: CiReadProvider = {
    id: 'github-ci',
    async getCapabilities() { return []; },
    async getCiRunEvidence(input) {
      return {
        provider: 'github', repository: input.project.repository!, pullRequestNumber: input.pullRequestNumber,
        headSha: input.expectedHeadSha,
        workflowRun: { id: input.workflowRunId, name: 'verify', status: 'completed', conclusion: 'failure', url: null, event: 'pull_request', headSha: input.expectedHeadSha },
        jobs: [], jobsTruncated: false, observedAt: '2026-09-25T00:00:00Z',
      };
    },
  };
  const runtime = new ConductorToolRuntime({ sourceArtifactProvider, ciReadProvider });
  const capabilities = await runtime.capabilities();
  assert.equal(capabilities.status, 'succeeded');
  if (capabilities.status === 'succeeded') {
    assert.equal(capabilities.result.operations.some(item => item.name === 'source.artifact.read' && !item.mutates), true);
    assert.equal(capabilities.result.operations.some(item => item.name === 'ci.run.read' && !item.mutates), true);
  }
  const source = await runtime.sourceArtifactRead({ project: { id: 'cardforge', repository: 'pyralisxc/CardForge' }, sha: 'a'.repeat(40), path: 'src/index.ts' });
  assert.equal(source.status, 'succeeded');
  const ci = await runtime.ciRunRead({ project: { id: 'cardforge', repository: 'pyralisxc/CardForge' }, pullRequestNumber: 2, expectedHeadSha: 'b'.repeat(40), workflowRunId: 3 });
  assert.equal(ci.status, 'succeeded');
});


test('repository acquisition has a dedicated read preflight and idempotent mutation without code-work grant', async () => {
  let acquisitions = 0;
  const repositoryAcquisitionProvider: RepositoryAcquisitionProvider = {
    id: 'github-acquisition',
    async getCapabilities() { return []; },
    async preflightRepositoryAcquisition(input) {
      return {
        provider: 'github', status: 'ready', method: 'snapshot-existing-destination',
        upstream: { repository: input.upstreamRepository, url: 'https://github.com/example/upstream', ref: input.upstreamRef, sha: 'a'.repeat(40), treeSha: 'b'.repeat(40), fileCount: 1, totalBytes: 5 },
        destination: { repository: `${input.destinationOwner}/${input.destinationRepository}`, branch: 'main', exists: true, empty: true, authorized: true },
        limits: { maxFiles: 1500, maxTotalBytes: 25 * 1024 * 1024, maxSingleBlobBytes: 5 * 1024 * 1024 },
        reason: null, codeWorkGranted: false, observedAt: '2026-09-25T00:00:00Z',
      };
    },
    async acquireRepository(input) {
      acquisitions += 1;
      return {
        provider: 'github', destinationRepository: `${input.destinationOwner}/${input.destinationRepository}`,
        url: `https://github.com/${input.destinationOwner}/${input.destinationRepository}`, branch: 'main',
        commitSha: 'c'.repeat(40), treeSha: 'b'.repeat(40), importedFiles: 1, totalBytes: 5,
        provenance: { upstreamRepository: input.upstreamRepository, upstreamUrl: 'https://github.com/example/upstream', upstreamRef: input.upstreamRef, upstreamSha: input.expectedUpstreamSha, acquiredAt: '2026-09-25T00:00:00Z' },
        approvalReference: input.approvalReference, codeWorkGranted: false, cleanup: 'owner-provider-cleanup',
      };
    },
  };
  const runtime = new ConductorToolRuntime({
    repositoryAcquisitionProvider,
    mutationExecutor: new IdempotentMutationExecutor({ store: new InMemoryIdempotencyStore() }),
  });
  const capabilities = await runtime.capabilities();
  assert.equal(capabilities.status, 'succeeded');
  if (capabilities.status === 'succeeded') {
    assert.equal(capabilities.result.operations.some(item => item.name === 'repository.acquire.preflight' && !item.mutates), true);
    assert.equal(capabilities.result.operations.some(item => item.name === 'repository.acquire' && item.mutates), true);
  }
  const preflight = await runtime.repositoryAcquisitionPreflight({
    upstreamRepository: 'example/upstream', upstreamRef: 'main', destinationOwner: 'pyralisxc', destinationRepository: 'benchmark-copy',
  });
  assert.equal(preflight.status, 'succeeded');
  const input = {
    upstreamRepository: 'example/upstream', upstreamRef: 'main', destinationOwner: 'pyralisxc', destinationRepository: 'benchmark-copy',
    expectedUpstreamSha: 'a'.repeat(40), approvalReference: 'owner-approved:test', idempotencyKey: 'repository-acquire:runtime-test',
  };
  const first = await runtime.acquireRepository(input);
  const replay = await runtime.acquireRepository(input);
  assert.equal(first.status, 'succeeded');
  assert.equal(replay.idempotency?.replayed, true);
  assert.equal(acquisitions, 1);
  if (first.status === 'succeeded') assert.equal(first.result.codeWorkGranted, false);
});

test('lifecycle advance integrates verified work, proves Preview, prepares promotion, and stops at human gate', async () => {
  const integrationHead = 'a'.repeat(40), integrationMerge = 'b'.repeat(40), mainHead = 'c'.repeat(40);
  let merged = false, promotionCreated = 0, cleanupCalls = 0, promotionWorkItems: number[] = [], promotionBody = '';
  let lifecycleProviderCalls = 0;
  const integrationPull = () => ({
    repository:'pyralisxc/Conductor',pullRequestNumber:10,url:'https://github.test/pull/10',state:merged?'closed':'open',draft:false,merged,mergeable:true,mergeableState:'clean',
    head:{ref:'work/169-test',sha:integrationHead},base:{ref:'preview',sha:'d'.repeat(40)},labels:[],checks:{total:1,pending:0,successful:1,failed:0,neutral:0,skipped:0,items:[]},workflowRuns:[],
    orchestration:{state:merged?'merged' as const:'integration-ready' as const,action:merged?'none' as const:'integration-merge' as const,shouldAct:!merged,summary:merged?'merged':'ready',resumeWhen:null,transition:{observed:false,previousHeadSha:null,previousState:null,headChanged:null,stateChanged:null,meaningful:null},seal:{requested:false,expectedPreSealCheckpoint:false,exactHeadVerificationRequired:false},signals:{pending:[],actionRequired:[],failed:[]}},
  });
  const promotionPull={repository:'pyralisxc/Conductor',pullRequestNumber:20,url:'https://github.test/pull/20',state:'open',draft:false,merged:false,mergeable:true,mergeableState:'clean',head:{ref:'preview',sha:integrationMerge},base:{ref:'main',sha:mainHead},labels:[],checks:{total:1,pending:0,successful:1,failed:0,neutral:0,skipped:0,items:[]},workflowRuns:[],orchestration:{state:'promotion-ready' as const,action:'promotion-gate' as const,shouldAct:true,summary:'ready for owner',resumeWhen:null,transition:{observed:false,previousHeadSha:null,previousState:null,headChanged:null,stateChanged:null,meaningful:null},seal:{requested:false,expectedPreSealCheckpoint:false,exactHeadVerificationRequired:false},signals:{pending:[],actionRequired:[],failed:[]}}};
  const sourceControlMutationProvider:any={id:'github',async getCapabilities(){return[];},async createBranch(){throw new Error('unused');},async bootstrapIntegrationBranch(){throw new Error('unused');},async deleteBranch(input:any){cleanupCalls++;return{repository:'pyralisxc/Conductor',branch:input.branch,commitSha:input.expectedHeadSha,deleted:true,containedIn:'preview via merged PR #10'};},async createCommit(){throw new Error('unused');},async createPullRequest(input:any){promotionCreated++;promotionWorkItems=input.workItemNumbers??[];promotionBody=input.body??'';return{repository:'pyralisxc/Conductor',pullRequestNumber:20,url:promotionPull.url};},async commentPullRequest(){throw new Error('unused');},async updatePullRequestLabels(){throw new Error('unused');},async mergeIntegrationPullRequest(){merged=true;return{repository:'pyralisxc/Conductor',pullRequestNumber:10,merged:true,mergeCommitSha:integrationMerge,message:'merged'};},async reconcilePreviewPullRequest(){throw new Error('unused');},async promotePullRequest(){throw new Error('Main must not be promoted by lifecycle.advance');}};
  const pullRequestProvider:any={id:'github-pr',async getCapabilities(){return[];},async findOpenPromotionPullRequest(){return null;},async getPullRequestStatus(input:any){return input.pullRequestNumber===20?promotionPull:integrationPull();}};
  const workProvider:any={id:'github-work',async getCapabilities(){return[];},getUsageSnapshot(){return{provider:'github-work',calls:lifecycleProviderCalls,duplicateReads:0,requestBodyBytes:0,reportedResponseBytes:lifecycleProviderCalls*100,responsesWithUnknownBytes:0,observedAt:'2026-09-27T00:00:00Z'};},async getWorkItemStatus(){lifecycleProviderCalls++;return{repository:'pyralisxc/Conductor',issueNumber:169,url:'https://github.test/issues/169',title:'Lifecycle',body:'',state:'open',status:'in-progress',statusSource:'label',kind:'feature',kindSource:'label',origin:'user-feedback',originSource:'label',labels:[],createdAt:'2026-09-27T00:00:00Z',updatedAt:'2026-09-27T00:00:00Z'};},async listWorkItems(){return{repository:'pyralisxc/Conductor',items:[],truncated:false};},async listWorkItemPullRequests(){lifecycleProviderCalls++;return[integrationPull()];}};
  const runtime=new ConductorToolRuntime({providers:[workProvider],sourceControlMutationProvider,pullRequestProvider,workItemCandidateProvider:workProvider,repositoryBootstrapProvider:{id:'github-topology',async getCapabilities(){return[];},async getRepositoryBootstrap(){return{provider:'github' as const,repository:'pyralisxc/Conductor',defaultBranch:'main',defaultHead:mainHead,integrationBranch:'preview' as const,integrationHead:integrationMerge,observedAt:'2026-09-27T00:00:00Z'};}},deploymentProvider:{id:'vercel',async getCapabilities(){return[];},async getDeploymentStatus(){return{provider:'vercel' as const,project:{id:'prj',name:'conductor',productionBranch:'main',teamId:'team'},production:null,latestProductionAttempt:null,recent:[{id:'dpl_preview',url:null,state:'READY',target:null,createdAt:null,readyAt:null,sourceRevision:integrationMerge,sourceRef:'preview',sourceRepository:'Conductor',aliases:[],errorCode:null,errorMessage:null}],domains:[],observedAt:'2026-09-27T00:00:00Z'};}} as any,mutationExecutor:new IdempotentMutationExecutor({store:new InMemoryIdempotencyStore()})});
  const receipt=await runtime.advanceLifecycle({project:{id:'Conductor',repository:'pyralisxc/Conductor'},issueNumber:169,maxPolls:0,pollIntervalMs:0,preparePromotion:true,promotionWorkItemNumbers:[169,170],idempotencyKey:'lifecycle-test-169'});
  assert.equal(receipt.status,'succeeded'); if(receipt.status!=='succeeded')return;
  assert.equal(receipt.result.stage,'human-gate'); assert.equal(receipt.result.gate?.kind,'human-approval'); assert.equal(receipt.result.gate?.pullRequestNumber,20); assert.equal(receipt.result.previewProof?.deploymentId,'dpl_preview'); assert.equal(promotionCreated,1); assert.equal(cleanupCalls,1); assert.deepEqual(promotionWorkItems,[169,170]); assert.match(promotionBody, /conductor-release-seal/); assert.deepEqual(receipt.result.gate?.workItemNumbers,[169,170]); assert.match(receipt.result.gate?.ownerGate?.protectedConcern ?? '', /accepted Main/iu);
  assert.equal(typeof receipt.result.elapsedMs, 'number');
  assert.deepEqual(receipt.result.providerUsage, [{
    provider: 'github-work',
    calls: 2,
    duplicateReads: 0,
    requestBodyBytes: 0,
    reportedResponseBytes: 200,
    responsesWithUnknownBytes: 0,
  }]);
});

test('lifecycle advance blocks Preview integration while a sealed release candidate is open', async () => {
  const sealedHead = 'a'.repeat(40);
  const sealedBase = 'b'.repeat(40);
  let mergeCalls = 0;
  const releasePull:any={
    repository:'pyralisxc/Conductor',pullRequestNumber:90,url:'https://github.test/pull/90',state:'open',draft:false,merged:false,mergeable:true,mergeableState:'clean',
    head:{ref:'preview',sha:sealedHead},base:{ref:'main',sha:sealedBase},labels:[],checks:{total:1,pending:0,successful:1,failed:0,neutral:0,skipped:0,items:[]},workflowRuns:[],
    orchestration:{state:'promotion-ready',action:'promotion-gate',shouldAct:true,summary:'ready',resumeWhen:null,transition:{observed:false,previousHeadSha:null,previousState:null,headChanged:null,stateChanged:null,meaningful:null},seal:{requested:false,expectedPreSealCheckpoint:false,exactHeadVerificationRequired:false},signals:{pending:[],actionRequired:[],failed:[]}},
  };
  const provider:any={id:'github',async getCapabilities(){return[];},async createBranch(){throw new Error('unused');},async bootstrapIntegrationBranch(){throw new Error('unused');},async deleteBranch(){throw new Error('unused');},async createCommit(){throw new Error('unused');},async createPullRequest(){throw new Error('unused');},async commentPullRequest(){throw new Error('unused');},async updatePullRequestLabels(){throw new Error('unused');},async mergeIntegrationPullRequest(){mergeCalls++;throw new Error('must not merge');},async reconcilePreviewPullRequest(){throw new Error('unused');},async promotePullRequest(){throw new Error('unused');}};
  const pullProvider:any={id:'github-pr',async getCapabilities(){return[];},async findOpenPromotionPullRequest(){return{pullRequest:releasePull,seal:{version:1,expectedHeadSha:sealedHead,expectedBaseSha:sealedBase,workItemNumbers:[231,232]},sealState:'current'};},async getPullRequestStatus(){return releasePull;}};
  const workProvider:any={id:'work',async getCapabilities(){return[];},async getWorkItemStatus(){return{repository:'pyralisxc/Conductor',issueNumber:236,url:'https://github.test/issues/236',title:'Seal',body:'',state:'open',status:'ready',statusSource:'label',kind:'improvement',kindSource:'label',origin:'agent-audit',originSource:'label',labels:[],createdAt:'2026-09-30T00:00:00Z',updatedAt:'2026-09-30T00:00:00Z'};},async listWorkItems(){return{repository:'pyralisxc/Conductor',items:[],truncated:false};},async listWorkItemPullRequests(){return[];}};
  const runtime=new ConductorToolRuntime({sourceControlMutationProvider:provider,pullRequestProvider:pullProvider,workItemCandidateProvider:workProvider,repositoryBootstrapProvider:{id:'topology',async getCapabilities(){return[];},async getRepositoryBootstrap(){throw new Error('must not reach topology');}},deploymentProvider:{id:'vercel',async getCapabilities(){return[];}} as any,mutationExecutor:new IdempotentMutationExecutor({store:new InMemoryIdempotencyStore()})});
  const result=await runtime.advanceLifecycle({project:{id:'Conductor',repository:'pyralisxc/Conductor'},issueNumber:236,idempotencyKey:'sealed-release-block'});
  assert.equal(result.status,'succeeded'); if(result.status!=='succeeded')return;
  assert.equal(result.result.stage,'action-required');
  assert.match(result.result.summary,/sealed for #231, #232/);
  assert.equal(mergeCalls,0);
});

test('lifecycle advance rejects a promotion candidate whose live head drifted from its release seal', async () => {
  const sealedHead='a'.repeat(40), liveHead='c'.repeat(40), base='b'.repeat(40);
  const releasePull:any={repository:'pyralisxc/Conductor',pullRequestNumber:91,url:'https://github.test/pull/91',state:'open',draft:false,merged:false,mergeable:true,mergeableState:'clean',head:{ref:'preview',sha:liveHead},base:{ref:'main',sha:base},labels:[],checks:{total:1,pending:0,successful:1,failed:0,neutral:0,skipped:0,items:[]},workflowRuns:[],orchestration:{state:'promotion-ready',action:'promotion-gate',shouldAct:true,summary:'ready',resumeWhen:null,transition:{observed:false,previousHeadSha:null,previousState:null,headChanged:null,stateChanged:null,meaningful:null},seal:{requested:false,expectedPreSealCheckpoint:false,exactHeadVerificationRequired:false},signals:{pending:[],actionRequired:[],failed:[]}}};
  const provider:any={id:'github',async getCapabilities(){return[];},async createBranch(){throw new Error('unused');},async bootstrapIntegrationBranch(){throw new Error('unused');},async deleteBranch(){throw new Error('unused');},async createCommit(){throw new Error('unused');},async createPullRequest(){throw new Error('unused');},async commentPullRequest(){throw new Error('unused');},async updatePullRequestLabels(){throw new Error('unused');},async mergeIntegrationPullRequest(){throw new Error('must not merge');},async reconcilePreviewPullRequest(){throw new Error('unused');},async promotePullRequest(){throw new Error('unused');}};
  const pullProvider:any={id:'github-pr',async getCapabilities(){return[];},async findOpenPromotionPullRequest(){return{pullRequest:releasePull,seal:{version:1,expectedHeadSha:sealedHead,expectedBaseSha:base,workItemNumbers:[231]},sealState:'stale'};},async getPullRequestStatus(){return releasePull;}};
  const workProvider:any={id:'work',async getCapabilities(){return[];},async getWorkItemStatus(){return{repository:'pyralisxc/Conductor',issueNumber:231,url:'https://github.test/issues/231',title:'Wait',body:'',state:'open',status:'ready',statusSource:'label',kind:'improvement',kindSource:'label',origin:'user-feedback',originSource:'label',labels:[],createdAt:'2026-09-30T00:00:00Z',updatedAt:'2026-09-30T00:00:00Z'};},async listWorkItems(){return{repository:'pyralisxc/Conductor',items:[],truncated:false};},async listWorkItemPullRequests(){return[];}};
  const runtime=new ConductorToolRuntime({sourceControlMutationProvider:provider,pullRequestProvider:pullProvider,workItemCandidateProvider:workProvider,repositoryBootstrapProvider:{id:'topology',async getCapabilities(){return[];},async getRepositoryBootstrap(){throw new Error('must not reach topology');}},deploymentProvider:{id:'vercel',async getCapabilities(){return[];}} as any,mutationExecutor:new IdempotentMutationExecutor({store:new InMemoryIdempotencyStore()})});
  const result=await runtime.advanceLifecycle({project:{id:'Conductor',repository:'pyralisxc/Conductor'},issueNumber:231,preparePromotion:true,promotionWorkItemNumbers:[231],idempotencyKey:'stale-release-block'});
  assert.equal(result.status,'succeeded'); if(result.status!=='succeeded')return;
  assert.equal(result.result.stage,'verification-failed');
  assert.match(result.result.summary,/drifted from sealed head/);
});

test('lifecycle advance stops at READY Preview by default without preparing Main', async () => {
  const integrationHead = '1'.repeat(40);
  const integrationMerge = '2'.repeat(40);
  const mainHead = '3'.repeat(40);
  let merged = false;
  let promotionCreates = 0;
  const integrationPull = () => ({
    repository:'pyralisxc/Conductor',pullRequestNumber:31,url:'https://github.test/pull/31',state:merged?'closed':'open',draft:false,merged,mergeable:true,mergeableState:'clean',
    head:{ref:'work/231-wait-stewardship',sha:integrationHead},base:{ref:'preview',sha:'4'.repeat(40)},labels:[],checks:{total:1,pending:0,successful:1,failed:0,neutral:0,skipped:0,items:[]},workflowRuns:[],
    orchestration:{state:merged?'merged' as const:'integration-ready' as const,action:merged?'none' as const:'integration-merge' as const,shouldAct:!merged,summary:merged?'merged':'ready',resumeWhen:null,transition:{observed:false,previousHeadSha:null,previousState:null,headChanged:null,stateChanged:null,meaningful:null},seal:{requested:false,expectedPreSealCheckpoint:false,exactHeadVerificationRequired:false},signals:{pending:[],actionRequired:[],failed:[]}},
  });
  const sourceControlMutationProvider:any={id:'github',async getCapabilities(){return[];},async createBranch(){throw new Error('unused');},async bootstrapIntegrationBranch(){throw new Error('unused');},async deleteBranch(input:any){return{repository:'pyralisxc/Conductor',branch:input.branch,commitSha:input.expectedHeadSha,deleted:true,containedIn:'preview'};},async createCommit(){throw new Error('unused');},async createPullRequest(){promotionCreates++;throw new Error('promotion must not be prepared');},async commentPullRequest(){throw new Error('unused');},async updatePullRequestLabels(){throw new Error('unused');},async mergeIntegrationPullRequest(){merged=true;return{repository:'pyralisxc/Conductor',pullRequestNumber:31,merged:true,mergeCommitSha:integrationMerge,message:'merged'};},async reconcilePreviewPullRequest(){throw new Error('unused');},async promotePullRequest(){throw new Error('unused');}};
  const pullRequestProvider:any={id:'github-pr',async getCapabilities(){return[];},async findOpenPromotionPullRequest(){return null;},async getPullRequestStatus(){return integrationPull();}};
  const workProvider:any={id:'github-work',async getCapabilities(){return[];},async getWorkItemStatus(){return{repository:'pyralisxc/Conductor',issueNumber:231,url:'https://github.test/issues/231',title:'Wait',body:'',state:'open',status:'in-progress',statusSource:'label',kind:'improvement',kindSource:'label',origin:'user-feedback',originSource:'label',labels:[],createdAt:'2026-09-30T00:00:00Z',updatedAt:'2026-09-30T00:00:00Z'};},async listWorkItems(){return{repository:'pyralisxc/Conductor',items:[],truncated:false};},async listWorkItemPullRequests(){return[integrationPull()];}};
  const runtime=new ConductorToolRuntime({sourceControlMutationProvider,pullRequestProvider,workItemCandidateProvider:workProvider,repositoryBootstrapProvider:{id:'github-topology',async getCapabilities(){return[];},async getRepositoryBootstrap(){return{provider:'github' as const,repository:'pyralisxc/Conductor',defaultBranch:'main',defaultHead:mainHead,integrationBranch:'preview' as const,integrationHead:integrationMerge,observedAt:'2026-09-30T00:00:00Z'};}},deploymentProvider:{id:'vercel',async getCapabilities(){return[];},async getDeploymentStatus(){return{provider:'vercel' as const,project:{id:'prj',name:'conductor',productionBranch:'main',teamId:'team'},production:null,latestProductionAttempt:null,recent:[{id:'dpl_preview',url:null,state:'READY',target:null,createdAt:null,readyAt:null,sourceRevision:integrationMerge,sourceRef:'preview',sourceRepository:'Conductor',aliases:[],errorCode:null,errorMessage:null}],domains:[],observedAt:'2026-09-30T00:00:00Z'};}} as any,mutationExecutor:new IdempotentMutationExecutor({store:new InMemoryIdempotencyStore()})});
  const receipt=await runtime.advanceLifecycle({project:{id:'Conductor',repository:'pyralisxc/Conductor'},issueNumber:231,maxPolls:0,pollIntervalMs:0,idempotencyKey:'preview-ready-no-promotion'});
  assert.equal(receipt.status,'succeeded'); if(receipt.status!=='succeeded')return;
  assert.equal(receipt.result.stage,'preview-ready');
  assert.equal(receipt.result.previewProof?.deploymentId,'dpl_preview');
  assert.equal(promotionCreates,0);
});



test('lifecycle resume carries exact blocker overrides through the human gate and preserves provider metrics', async () => {
  const headSha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  let calls = 0;
  const candidate = {
    repository: 'pyralisxc/Conductor',
    pullRequestNumber: 208,
    url: 'https://github.test/pull/208',
    state: 'open',
    draft: false,
    merged: false,
    mergeable: true,
    mergeableState: 'clean',
    head: { ref: 'preview', sha: headSha },
    base: { ref: 'main', sha: baseSha },
    labels: [],
    checks: { total: 1, pending: 0, successful: 1, failed: 0, neutral: 0, skipped: 0, items: [] },
    workflowRuns: [],
    orchestration: {
      state: 'promotion-ready' as const,
      action: 'promotion-gate' as const,
      shouldAct: true,
      summary: 'ready',
      resumeWhen: null,
      transition: { observed: false, previousHeadSha: null, previousState: null, headChanged: null, stateChanged: null, meaningful: null },
      seal: { requested: false, expectedPreSealCheckpoint: false, exactHeadVerificationRequired: false },
      signals: { pending: [], actionRequired: [], failed: [] },
    },
  };
  const provider: any = {
    id: 'github',
    async getCapabilities() { return []; },
    getUsageSnapshot() {
      return {
        provider: 'github',
        calls,
        duplicateReads: 0,
        requestBodyBytes: 0,
        reportedResponseBytes: calls * 100,
        responsesWithUnknownBytes: 0,
        observedAt: '2026-09-29T00:00:00Z',
      };
    },
    async getPullRequestStatus() {
      calls += 1;
      return candidate;
    },
    async createBranch() { throw new Error('unused'); },
    async bootstrapIntegrationBranch() { throw new Error('unused'); },
    async deleteBranch() { throw new Error('unused'); },
    async createCommit() { throw new Error('unused'); },
    async createPullRequest() { throw new Error('unused'); },
    async commentPullRequest() { throw new Error('unused'); },
    async updatePullRequestLabels() { throw new Error('unused'); },
    async mergeIntegrationPullRequest() { throw new Error('unused'); },
    async reconcilePreviewPullRequest() { throw new Error('unused'); },
    async promotePullRequest(input: any) {
      calls += 1;
      const overrides = input.overrideBlockerIssueNumbers ?? [];
      if (JSON.stringify(overrides) !== JSON.stringify([193, 205])) {
        throw { code: 'PERMISSION_DENIED', message: 'Exact blocker overrides #193 and #205 are required' };
      }
      return {
        repository: 'pyralisxc/Conductor',
        pullRequestNumber: 208,
        merged: true,
        mergeCommitSha: 'c'.repeat(40),
        message: 'merged',
        approvalReference: input.approvalReference,
        overriddenBlockerIssueNumbers: overrides,
      };
    },
  };
  const runtime = new ConductorToolRuntime({
    providers: [provider],
    sourceControlMutationProvider: provider,
    pullRequestProvider: provider,
    mutationExecutor: new IdempotentMutationExecutor({ store: new InMemoryIdempotencyStore() }),
  });
  const base = {
    project: { id: 'Conductor', repository: 'pyralisxc/Conductor' },
    issueNumber: 211,
    gateId: 'gate-211',
    pullRequestNumber: 208,
    expectedHeadSha: headSha,
    expectedBaseSha: baseSha,
    approvalReference: 'owner-approved:resume-override-test',
  };

  const missing = await runtime.resumeLifecycle({ ...base, idempotencyKey: 'resume-override-missing' });
  assert.equal(missing.status, 'failed');
  if (missing.status === 'failed') assert.equal(missing.error.code, 'PERMISSION_DENIED');

  const partial = await runtime.resumeLifecycle({ ...base, overrideBlockerIssueNumbers: [193], idempotencyKey: 'resume-override-partial' });
  assert.equal(partial.status, 'failed');
  if (partial.status === 'failed') assert.equal(partial.error.code, 'PERMISSION_DENIED');

  const exact = await runtime.resumeLifecycle({ ...base, overrideBlockerIssueNumbers: [193, 205], idempotencyKey: 'resume-override-exact' });
  assert.equal(exact.status, 'succeeded');
  if (exact.status !== 'succeeded') return;
  assert.equal(exact.result.stage, 'complete');
  assert.equal(exact.result.transitions[0]?.operation, 'pull-request.merge.promote');
  assert.equal(typeof exact.result.elapsedMs, 'number');
  assert.deepEqual(exact.result.providerUsage, [{
    provider: 'github',
    calls: 2,
    duplicateReads: 0,
    requestBodyBytes: 0,
    reportedResponseBytes: 200,
    responsesWithUnknownBytes: 0,
  }]);
});

test('lifecycle advance recognizes an exact current Preview head that was already promoted', async () => {
  const previewHead = 'b'.repeat(40);
  const mainHead = 'c'.repeat(40);
  let promotionCreates = 0;
  let deploymentReads = 0;

  const mergedIntegration = {
    repository: 'pyralisxc/Conductor',
    pullRequestNumber: 30,
    url: 'https://github.test/pull/30',
    state: 'closed',
    draft: false,
    merged: true,
    mergeable: true,
    mergeableState: 'clean',
    head: { ref: 'work/170-done', sha: 'a'.repeat(40) },
    base: { ref: 'preview', sha: 'd'.repeat(40) },
    labels: [],
    checks: { total: 1, pending: 0, successful: 1, failed: 0, neutral: 0, skipped: 0, items: [] },
    workflowRuns: [],
    orchestration: {
      state: 'merged' as const,
      action: 'none' as const,
      shouldAct: false,
      summary: 'merged',
      resumeWhen: null,
      transition: { observed: false, previousHeadSha: null, previousState: null, headChanged: null, stateChanged: null, meaningful: null },
      seal: { requested: false, expectedPreSealCheckpoint: false, exactHeadVerificationRequired: false },
      signals: { pending: [], actionRequired: [], failed: [] },
    },
  };
  const mergedPromotion = {
    repository: 'pyralisxc/Conductor',
    pullRequestNumber: 31,
    url: 'https://github.test/pull/31',
    state: 'closed',
    draft: false,
    merged: true,
    mergeable: true,
    mergeableState: 'clean',
    head: { ref: 'preview', sha: previewHead },
    base: { ref: 'main', sha: mainHead },
    labels: [],
    checks: { total: 1, pending: 0, successful: 1, failed: 0, neutral: 0, skipped: 0, items: [] },
    workflowRuns: [],
    orchestration: {
      state: 'merged' as const,
      action: 'none' as const,
      shouldAct: false,
      summary: 'merged',
      resumeWhen: null,
      transition: { observed: false, previousHeadSha: null, previousState: null, headChanged: null, stateChanged: null, meaningful: null },
      seal: { requested: false, expectedPreSealCheckpoint: false, exactHeadVerificationRequired: false },
      signals: { pending: [], actionRequired: [], failed: [] },
    },
  };

  const sourceControlMutationProvider: any = {
    id: 'github',
    async getCapabilities() { return []; },
    async createBranch() { throw new Error('unused'); },
    async bootstrapIntegrationBranch() { throw new Error('unused'); },
    async deleteBranch() { throw new Error('unused'); },
    async createCommit() { throw new Error('unused'); },
    async createPullRequest() { promotionCreates += 1; throw new Error('duplicate promotion must not be created'); },
    async commentPullRequest() { throw new Error('unused'); },
    async updatePullRequestLabels() { throw new Error('unused'); },
    async mergeIntegrationPullRequest() { throw new Error('unused'); },
    async reconcilePreviewPullRequest() { throw new Error('unused'); },
    async promotePullRequest() { throw new Error('unused'); },
  };
  const workProvider: any = {
    id: 'github-work',
    async getCapabilities() { return []; },
    async getWorkItemStatus() {
      return {
        repository: 'pyralisxc/Conductor',
        issueNumber: 170,
        url: 'https://github.test/issues/170',
        title: 'Bundle',
        body: '',
        state: 'open',
        status: 'review',
        statusSource: 'label',
        kind: 'feature',
        kindSource: 'label',
        origin: 'user-feedback',
        originSource: 'label',
        labels: [],
        createdAt: '2026-09-27T00:00:00Z',
        updatedAt: '2026-09-27T00:00:00Z',
      };
    },
    async listWorkItems() { return { repository: 'pyralisxc/Conductor', items: [], truncated: false }; },
    async listWorkItemPullRequests() {
      return [
        { ...mergedIntegration, pullRequestNumber: 29, url: 'https://github.test/pull/29', head: { ref: 'work/older-pass', sha: 'e'.repeat(40) } },
        mergedIntegration,
        mergedPromotion,
      ];
    },
  };
  const runtime = new ConductorToolRuntime({
    sourceControlMutationProvider,
    pullRequestProvider: {
      id: 'github-pr',
      async getCapabilities() { return []; },
      async findOpenPromotionPullRequest() { return null; },
      async getPullRequestStatus() { throw new Error('no PR reread required for already-promoted exact Preview'); },
    } as any,
    workItemCandidateProvider: workProvider,
    repositoryBootstrapProvider: {
      id: 'github-topology',
      async getCapabilities() { return []; },
      async getRepositoryBootstrap() {
        return {
          provider: 'github' as const,
          repository: 'pyralisxc/Conductor',
          defaultBranch: 'main',
          defaultHead: mainHead,
          integrationBranch: 'preview' as const,
          integrationHead: previewHead,
          observedAt: '2026-09-27T00:00:00Z',
        };
      },
    },
    deploymentProvider: {
      id: 'vercel',
      async getCapabilities() { return []; },
      async getDeploymentStatus() { deploymentReads += 1; throw new Error('deployment proof is unnecessary after exact promotion is already merged'); },
    } as any,
    mutationExecutor: new IdempotentMutationExecutor({ store: new InMemoryIdempotencyStore() }),
  });

  const receipt = await runtime.advanceLifecycle({
    project: { id: 'Conductor', repository: 'pyralisxc/Conductor' },
    issueNumber: 170,
    maxPolls: 0,
    pollIntervalMs: 0,
    idempotencyKey: 'lifecycle-already-promoted-test',
  });

  assert.equal(receipt.status, 'succeeded');
  if (receipt.status !== 'succeeded') return;
  assert.equal(receipt.result.stage, 'complete');
  assert.equal(receipt.result.transitions.at(-1)?.pullRequestNumber, 31);
  assert.equal(promotionCreates, 0);
  assert.equal(deploymentReads, 0);
});

test('evidence bundle enforces concurrency, preserves order, and isolates partial failure', async () => {
  let active = 0;
  let peak = 0;
  let providerCalls = 0;
  const provider: any = {
    id: 'vercel',
    async getCapabilities() { return []; },
    getUsageSnapshot() {
      return {
        provider: 'vercel',
        calls: providerCalls,
        duplicateReads: 0,
        requestBodyBytes: 0,
        reportedResponseBytes: providerCalls * 100,
        responsesWithUnknownBytes: 0,
        observedAt: '2026-09-27T00:00:00Z',
      };
    },
    async getDeploymentStatus(input: any) {
      providerCalls += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      active -= 1;
      if (input.project.id === 'fail') throw { code: 'TRANSIENT', message: 'provider throttled' };
      return {
        provider: 'vercel' as const,
        project: { id: `prj_${input.project.id}`, name: input.project.id, productionBranch: 'main', teamId: 'team' },
        production: { id: `dpl_${input.project.id}`, url: null, state: 'READY', target: 'production', createdAt: null, readyAt: null, sourceRevision: 'a'.repeat(40), sourceRef: 'main', sourceRepository: input.project.id, aliases: [], errorCode: null, errorMessage: null },
        latestProductionAttempt: null,
        recent: [],
        domains: [],
        observedAt: '2026-09-27T00:00:00Z',
      };
    },
  };
  const runtime = new ConductorToolRuntime({ providers: [provider], deploymentProvider: provider });
  const receipt = await runtime.evidenceBundle({
    concurrency: 2,
    items: [
      { key: 'one', operation: 'deployment.status', project: { id: 'one' } },
      { key: 'fail', operation: 'deployment.status', project: { id: 'fail' } },
      { key: 'three', operation: 'deployment.status', project: { id: 'three' } },
      { key: 'four', operation: 'deployment.status', project: { id: 'four' } },
    ],
  });
  assert.equal(receipt.status, 'succeeded');
  if (receipt.status !== 'succeeded') return;
  assert.equal(peak, 2);
  assert.deepEqual(receipt.result.items.map(item => item.key), ['one', 'fail', 'three', 'four']);
  assert.deepEqual(receipt.result.items.map(item => item.status), ['succeeded', 'failed', 'succeeded', 'succeeded']);
  assert.equal(receipt.result.items[1]?.error?.code, 'TRANSIENT');
  assert.equal(receipt.result.succeeded, 3);
  assert.equal(receipt.result.failed, 1);
  assert.deepEqual(receipt.result.providerUsage, [{
    provider: 'vercel',
    calls: 4,
    duplicateReads: 0,
    requestBodyBytes: 0,
    reportedResponseBytes: 400,
    responsesWithUnknownBytes: 0,
  }]);
});

test('evidence bundle refuses duplicate keys before provider work', async () => {
  let calls = 0;
  const runtime = new ConductorToolRuntime({
    deploymentProvider: {
      id: 'vercel',
      async getCapabilities() { return []; },
      async getDeploymentStatus() { calls += 1; throw new Error('should not execute'); },
    } as any,
  });
  const receipt = await runtime.evidenceBundle({
    items: [
      { key: 'same', operation: 'deployment.status', project: { id: 'one' } },
      { key: 'same', operation: 'deployment.status', project: { id: 'two' } },
    ],
  });
  assert.equal(receipt.status, 'failed');
  assert.equal(calls, 0);
});

test('Main promotion creates or observes the exact Vercel Production deployment without risking the Git merge', async () => {
  const mergeSha = 'c'.repeat(40);
  const headSha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  const createdInputs: any[] = [];
  let mergeCalls = 0;
  const source: any = {
    id: 'github',
    async getCapabilities() { return []; },
    async createBranch() { throw new Error('unused'); },
    async bootstrapIntegrationBranch() { throw new Error('unused'); },
    async deleteBranch() { throw new Error('unused'); },
    async createCommit() { throw new Error('unused'); },
    async createPullRequest() { throw new Error('unused'); },
    async commentPullRequest() { throw new Error('unused'); },
    async updatePullRequestLabels() { throw new Error('unused'); },
    async mergeIntegrationPullRequest() { throw new Error('unused'); },
    async reconcilePreviewPullRequest() { throw new Error('unused'); },
    async promotePullRequest(input: any) {
      mergeCalls += 1;
      return {
        repository: 'pyralisxc/Development-Intelligence',
        pullRequestNumber: input.pullRequestNumber,
        merged: true,
        mergeCommitSha: mergeSha,
        message: 'merged',
        approvalReference: input.approvalReference,
        overriddenBlockerIssueNumbers: [],
      };
    },
  };
  const deployment: any = {
    id: 'vercel',
    async getCapabilities() { return []; },
    async getDeploymentStatus() {
      return {
        provider: 'vercel',
        project: { id: 'prj_di', name: 'development-intelligence', productionBranch: 'main', teamId: 'team' },
        production: { id: 'dpl_old', url: null, state: 'READY', target: 'production', createdAt: null, readyAt: null, sourceRevision: baseSha, sourceRef: 'main', sourceRepository: 'Development-Intelligence', aliases: [], errorCode: null, errorMessage: null },
        latestProductionAttempt: null,
        recent: [],
        domains: [],
        observedAt: '2026-09-30T00:00:00Z',
      };
    },
    async createGitDeployment(input: any) {
      createdInputs.push(input);
      return { provider: 'vercel', projectId: 'prj_di', deploymentId: 'dpl_exact', sourceRevision: input.sha, sourceRef: input.ref, target: input.target, state: 'INITIALIZING' };
    },
  };
  const runtime = new ConductorToolRuntime({
    sourceControlMutationProvider: source,
    deploymentProvider: deployment,
    mutationExecutor: new IdempotentMutationExecutor({ store: new InMemoryIdempotencyStore() }),
  });
  const input = {
    project: { id: 'Development-Intelligence', repository: 'pyralisxc/Development-Intelligence' },
    pullRequestNumber: 187,
    expectedHeadSha: headSha,
    expectedBaseSha: baseSha,
    approvalReference: 'owner-approved:user approved exact Main release',
    mergeMethod: 'merge' as const,
    idempotencyKey: 'promotion-production-handoff',
  };
  const first = await runtime.promotePullRequest(input);
  assert.equal(first.status, 'succeeded');
  if (first.status !== 'succeeded') return;
  assert.equal((first.result as any).productionHandoff.status, 'created');
  assert.equal((first.result as any).productionHandoff.deploymentId, 'dpl_exact');
  assert.equal(first.identifiers?.deploymentId, 'dpl_exact');
  assert.equal(createdInputs.length, 1);
  assert.equal(createdInputs[0].repository, 'pyralisxc/Development-Intelligence');
  assert.equal(createdInputs[0].ref, 'main');
  assert.equal(createdInputs[0].sha, mergeSha);
  assert.equal(createdInputs[0].target, 'production');

  const replay = await runtime.promotePullRequest(input);
  assert.equal(replay.status, 'succeeded');
  assert.equal(replay.idempotency?.replayed, true);
  assert.equal(mergeCalls, 1);
  assert.equal(createdInputs.length, 1);
});

test('Main promotion reuses an exact existing Production deployment and keeps missing Vercel binding non-fatal', async () => {
  const mergeSha = 'd'.repeat(40);
  const baseResult = {
    repository: 'pyralisxc/Conductor',
    pullRequestNumber: 240,
    merged: true,
    mergeCommitSha: mergeSha,
    message: 'merged',
    approvalReference: 'owner-approved:user approved release',
    overriddenBlockerIssueNumbers: [],
  };
  const source = (number: number): any => ({
    id: `github-${number}`,
    async getCapabilities() { return []; },
    async createBranch() { throw new Error('unused'); },
    async bootstrapIntegrationBranch() { throw new Error('unused'); },
    async deleteBranch() { throw new Error('unused'); },
    async createCommit() { throw new Error('unused'); },
    async createPullRequest() { throw new Error('unused'); },
    async commentPullRequest() { throw new Error('unused'); },
    async updatePullRequestLabels() { throw new Error('unused'); },
    async mergeIntegrationPullRequest() { throw new Error('unused'); },
    async reconcilePreviewPullRequest() { throw new Error('unused'); },
    async promotePullRequest() { return { ...baseResult, pullRequestNumber: number }; },
  });

  let createCalls = 0;
  const existingDeployment: any = {
    id: 'vercel',
    async getCapabilities() { return []; },
    async getDeploymentStatus() {
      return {
        provider: 'vercel',
        project: { id: 'prj_conductor', name: 'conductor', productionBranch: 'main', teamId: 'team' },
        production: null,
        latestProductionAttempt: { id: 'dpl_exact', url: null, state: 'BUILDING', target: 'production', createdAt: null, readyAt: null, sourceRevision: mergeSha, sourceRef: 'main', sourceRepository: 'Conductor', aliases: [], errorCode: null, errorMessage: null },
        recent: [],
        domains: [],
        observedAt: '2026-09-30T00:00:00Z',
      };
    },
    async createGitDeployment() { createCalls += 1; throw new Error('must not create duplicate'); },
  };
  const observedRuntime = new ConductorToolRuntime({
    sourceControlMutationProvider: source(240),
    deploymentProvider: existingDeployment,
    mutationExecutor: new IdempotentMutationExecutor({ store: new InMemoryIdempotencyStore() }),
  });
  const observed = await observedRuntime.promotePullRequest({
    project: { id: 'Conductor', repository: 'pyralisxc/Conductor' },
    pullRequestNumber: 240,
    expectedHeadSha: 'a'.repeat(40),
    expectedBaseSha: 'b'.repeat(40),
    approvalReference: 'owner-approved:user approved release',
    idempotencyKey: 'promotion-observe-existing-production',
  });
  assert.equal(observed.status, 'succeeded');
  if (observed.status !== 'succeeded') return;
  assert.equal((observed.result as any).productionHandoff.status, 'observed');
  assert.equal((observed.result as any).productionHandoff.deploymentId, 'dpl_exact');
  assert.equal(createCalls, 0);

  const unavailableRuntime = new ConductorToolRuntime({
    sourceControlMutationProvider: source(241),
    deploymentProvider: {
      id: 'vercel',
      async getCapabilities() { return []; },
      async getDeploymentStatus() { throw { code: 'NOT_FOUND', source: 'vercel', message: 'No bound Vercel project' }; },
    } as any,
    mutationExecutor: new IdempotentMutationExecutor({ store: new InMemoryIdempotencyStore() }),
  });
  const unavailable = await unavailableRuntime.promotePullRequest({
    project: { id: 'Conductor', repository: 'pyralisxc/Conductor' },
    pullRequestNumber: 241,
    expectedHeadSha: 'a'.repeat(40),
    expectedBaseSha: 'b'.repeat(40),
    approvalReference: 'owner-approved:user approved release',
    idempotencyKey: 'promotion-no-vercel-binding',
  });
  assert.equal(unavailable.status, 'succeeded');
  if (unavailable.status !== 'succeeded') return;
  assert.equal((unavailable.result as any).productionHandoff.status, 'unavailable');
  assert.match(JSON.stringify(unavailable.diagnostics), /Git promotion succeeded/u);
});

