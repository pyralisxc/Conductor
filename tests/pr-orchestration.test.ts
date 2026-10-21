import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubRuntimeProvider } from '../src/index.js';

const oldHead = 'a'.repeat(40);
const newHead = 'b'.repeat(40);
const baseSha = 'c'.repeat(40);

function providerFor(input: {
  headSha?: string;
  labels?: string[];
  checks?: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
  }>;
  workflowRuns?: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    createdAt?: string;
    runAttempt?: number;
  }>;
  mergeable?: boolean | null;
  headRef?: string;
  baseRef?: string;
  defaultBranch?: string | null;
  state?: 'open' | 'closed';
  draft?: boolean;
}) {
  const headSha = input.headSha ?? oldHead;
  return new GitHubRuntimeProvider({
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
          },
        };
      },
    },
    allowedOwners: ['pyralisxc'],
    fetch: async (request) => {
      const url = String(request);
      if (url.endsWith('/pulls/12')) {
        return Response.json({
          number: 12,
          html_url: 'https://github.com/pyralisxc/Development-Intelligence/pull/12',
          state: input.state ?? 'open',
          draft: input.draft ?? false,
          merged: false,
          mergeable: input.mergeable ?? true,
          mergeable_state: 'clean',
          head: { ref: input.headRef ?? 'work/di-orchestration', sha: headSha },
          base: { ref: input.baseRef ?? 'preview', sha: baseSha, repo: input.defaultBranch === null ? { full_name: 'pyralisxc/Development-Intelligence' } : { full_name: 'pyralisxc/Development-Intelligence', default_branch: input.defaultBranch ?? 'main' } },
          labels: (input.labels ?? []).map((name) => ({ name })),
        });
      }
      if (url.includes(`/commits/${headSha}/check-runs`)) {
        return Response.json({
          check_runs: (input.checks ?? []).map((check) => ({
            ...check,
            details_url: `https://checks/${check.id}`,
            app: { slug: 'github-actions' },
          })),
        });
      }
      if (url.includes('/actions/runs?')) {
        return Response.json({
          workflow_runs: (input.workflowRuns ?? []).map((run) => ({
            id: run.id,
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            html_url: `https://actions/${run.id}`,
            created_at: run.createdAt,
            run_attempt: run.runAttempt,
          })),
        });
      }
      throw new Error(`Unexpected request ${url}`);
    },
  });
}

async function status(
  provider: GitHubRuntimeProvider,
  previous?: {
    headSha: string;
    orchestrationState?: 'merged' | 'closed-unmerged' | 'draft' | 'external-gate-pending'
      | 'pre-seal-checkpoint' | 'sealed-head-verification-required'
      | 'action-required' | 'verification-failed' | 'merge-blocked'
      | 'integration-ready' | 'promotion-ready';
  },
) {
  return await provider.getPullRequestStatus({
    project: { id: 'pyralisxc/Development-Intelligence' },
    pullRequestNumber: 12,
    previous,
  });
}

test('closed unmerged candidates remain terminal despite failed or pending checks and seal changes', async () => {
  const provider = providerFor({
    state: 'closed',
    draft: true,
    mergeable: false,
    headSha: newHead,
    labels: ['seal-b'],
    checks: [
      { id: 1, name: 'verify', status: 'completed', conclusion: 'failure' },
      { id: 2, name: 'self-seal', status: 'in_progress', conclusion: null },
    ],
    workflowRuns: [{ id: 9, name: 'verify', status: 'completed', conclusion: 'action_required' }],
  });
  const result = await status(provider, { headSha: oldHead, orchestrationState: 'verification-failed' });
  assert.equal(result.state, 'closed');
  assert.equal(result.merged, false);
  assert.equal(result.orchestration.state, 'closed-unmerged');
  assert.equal(result.orchestration.action, 'none');
  assert.equal(result.orchestration.shouldAct, false);
  assert.equal(result.orchestration.resumeWhen, null);
  assert.equal(result.orchestration.seal.exactHeadVerificationRequired, false);
  assert.equal(result.orchestration.transition.meaningful, true);
  assert.equal(result.checks.items.length, 2);
  assert.equal(result.workflowRuns.length, 1);
  assert.ok(result.orchestration.signals.failed.length);
  assert.ok(result.orchestration.signals.pending.length);

  const unchanged = await status(provider, { headSha: newHead, orchestrationState: 'closed-unmerged' });
  assert.equal(unchanged.orchestration.transition.meaningful, false);
});

test('reopened candidate resumes the normal exact-head verification gates', async () => {
  const result = await status(providerFor({
    checks: [{ id: 1, name: 'verify', status: 'in_progress', conclusion: null }],
  }), { headSha: oldHead, orchestrationState: 'closed-unmerged' });
  assert.equal(result.orchestration.state, 'external-gate-pending');
  assert.equal(result.orchestration.transition.stateChanged, true);
  assert.equal(result.orchestration.action, 'wait');
});

test('pending CI is summarized as an external gate with no agent action required', async () => {
  const provider = providerFor({
    checks: [
      { id: 1, name: 'verify', status: 'in_progress', conclusion: null },
      { id: 2, name: 'action-smoke', status: 'queued', conclusion: null },
    ],
    workflowRuns: [
      { id: 9, name: 'verify', status: 'in_progress', conclusion: null },
    ],
  });

  const result = await status(provider);
  assert.equal(result.orchestration.state, 'external-gate-pending');
  assert.equal(result.orchestration.action, 'wait');
  assert.equal(result.orchestration.shouldAct, false);
  assert.match(result.orchestration.summary, /External gate pending/);
  assert.ok(result.orchestration.resumeWhen);
  assert.deepEqual(result.orchestration.signals.failed, []);
});

test('unchanged pending observation is explicitly not a meaningful transition', async () => {
  const provider = providerFor({
    checks: [{ id: 1, name: 'verify', status: 'in_progress', conclusion: null }],
    workflowRuns: [{ id: 9, name: 'verify', status: 'in_progress', conclusion: null }],
  });

  const result = await status(provider, {
    headSha: oldHead,
    orchestrationState: 'external-gate-pending',
  });

  assert.equal(result.orchestration.state, 'external-gate-pending');
  assert.equal(result.orchestration.transition.observed, true);
  assert.equal(result.orchestration.transition.headChanged, false);
  assert.equal(result.orchestration.transition.stateChanged, false);
  assert.equal(result.orchestration.transition.meaningful, false);
});

test('seal-b distinguishes expected pre-seal action-smoke failure from source failure', async () => {
  const provider = providerFor({
    labels: ['seal-b'],
    checks: [
      { id: 1, name: 'action-smoke', status: 'completed', conclusion: 'failure' },
      { id: 2, name: 'verify', status: 'completed', conclusion: 'success' },
      { id: 3, name: 'self-seal', status: 'in_progress', conclusion: null },
    ],
    workflowRuns: [
      { id: 9, name: 'verify', status: 'in_progress', conclusion: null },
    ],
  });

  const result = await status(provider);
  assert.equal(result.orchestration.state, 'pre-seal-checkpoint');
  assert.equal(result.orchestration.action, 'wait');
  assert.equal(result.orchestration.shouldAct, false);
  assert.equal(result.orchestration.seal.requested, true);
  assert.equal(result.orchestration.seal.expectedPreSealCheckpoint, true);
  assert.deepEqual(result.orchestration.signals.failed, []);
});

test('bot-pushed sealed head with action_required asks for exact-head rerun', async () => {
  const provider = providerFor({
    headSha: newHead,
    labels: ['seal-b'],
    workflowRuns: [
      { id: 10, name: 'verify', status: 'completed', conclusion: 'action_required' },
    ],
  });

  const result = await status(provider, {
    headSha: oldHead,
    orchestrationState: 'pre-seal-checkpoint',
  });

  assert.equal(result.orchestration.state, 'sealed-head-verification-required');
  assert.equal(result.orchestration.action, 'rerun-exact-head');
  assert.equal(result.orchestration.shouldAct, true);
  assert.equal(result.orchestration.transition.headChanged, true);
  assert.equal(result.orchestration.transition.meaningful, true);
  assert.equal(result.orchestration.seal.exactHeadVerificationRequired, true);
  assert.deepEqual(result.orchestration.signals.actionRequired, ['workflow:verify']);
});

test('newer successful verify supersedes historical action_required evidence on the exact head', async () => {
  const provider = providerFor({
    headSha: newHead,
    labels: ['seal-b'],
    checks: [
      { id: 20, name: 'verify', status: 'completed', conclusion: 'success' },
      { id: 21, name: 'action-smoke', status: 'completed', conclusion: 'success' },
      { id: 22, name: 'self-seal', status: 'completed', conclusion: 'success' },
    ],
    workflowRuns: [
      { id: 10, name: 'verify', status: 'completed', conclusion: 'action_required', createdAt: '2026-09-25T00:00:00Z' },
      { id: 11, name: 'verify', status: 'completed', conclusion: 'success', createdAt: '2026-09-25T00:01:00Z' },
    ],
  });

  const result = await status(provider, {
    headSha: newHead,
    orchestrationState: 'sealed-head-verification-required',
  });

  assert.equal(result.workflowRuns.find((run) => run.id === 10)?.historical, true);
  assert.equal(result.workflowRuns.find((run) => run.id === 11)?.historical, false);
  assert.equal(result.orchestration.state, 'integration-ready');
  assert.deepEqual(result.orchestration.signals.actionRequired, []);
});

test('historical cancelled same-SHA verification stays inspectable without blocking newer success', async () => {
  const provider = providerFor({
    headSha: newHead,
    checks: [
      { id: 30, name: 'verify', status: 'completed', conclusion: 'cancelled' },
      { id: 31, name: 'verify', status: 'completed', conclusion: 'success' },
      { id: 32, name: 'action-smoke', status: 'completed', conclusion: 'success' },
    ],
    workflowRuns: [
      { id: 40, name: 'verify', status: 'completed', conclusion: 'cancelled', createdAt: '2026-10-02T19:20:00Z', runAttempt: 1 },
      { id: 41, name: 'verify', status: 'completed', conclusion: 'success', createdAt: '2026-10-02T19:21:00Z', runAttempt: 1 },
    ],
  });

  const result = await status(provider, {
    headSha: newHead,
    orchestrationState: 'external-gate-pending',
  });

  assert.equal(result.checks.items.find((check) => check.id === 30)?.historical, true);
  assert.equal(result.checks.items.find((check) => check.id === 31)?.historical, false);
  assert.equal(result.workflowRuns.find((run) => run.id === 40)?.historical, true);
  assert.equal(result.workflowRuns.find((run) => run.id === 41)?.historical, false);
  assert.equal(result.checks.failed, 0);
  assert.equal(result.orchestration.state, 'integration-ready');
  assert.equal(result.orchestration.action, 'integration-merge');
  assert.deepEqual(result.orchestration.signals.failed, []);
  assert.deepEqual(result.orchestration.signals.pending, []);
});

test('real source verification failure remains actionable even during seal-b', async () => {
  const provider = providerFor({
    labels: ['seal-b'],
    checks: [
      { id: 1, name: 'action-smoke', status: 'completed', conclusion: 'failure' },
      { id: 2, name: 'verify', status: 'completed', conclusion: 'failure' },
      { id: 3, name: 'self-seal', status: 'completed', conclusion: 'skipped' },
    ],
    workflowRuns: [
      { id: 9, name: 'verify', status: 'completed', conclusion: 'failure' },
    ],
  });

  const result = await status(provider);
  assert.equal(result.orchestration.state, 'verification-failed');
  assert.equal(result.orchestration.action, 'inspect-failure');
  assert.equal(result.orchestration.shouldAct, true);
  assert.equal(result.orchestration.seal.expectedPreSealCheckpoint, false);
  assert.deepEqual(result.orchestration.signals.failed, [
    'check:action-smoke',
    'check:verify',
    'workflow:verify',
  ]);
});

test('settled work head reports integration readiness without calling CI Preview proof', async () => {
  const provider = providerFor({
    headSha: newHead,
    labels: ['seal-b'],
    checks: [
      { id: 1, name: 'action-smoke', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'verify', status: 'completed', conclusion: 'success' },
      { id: 3, name: 'self-seal', status: 'completed', conclusion: 'success' },
    ],
    workflowRuns: [
      { id: 10, name: 'verify', status: 'completed', conclusion: 'success' },
    ],
  });

  const result = await status(provider, {
    headSha: oldHead,
    orchestrationState: 'sealed-head-verification-required',
  });

  assert.equal(result.orchestration.state, 'integration-ready');
  assert.equal(result.orchestration.action, 'integration-merge');
  assert.equal(result.orchestration.shouldAct, true);
  assert.equal(result.orchestration.transition.headChanged, true);
  assert.equal(result.orchestration.transition.meaningful, true);
  assert.equal(result.orchestration.seal.exactHeadVerificationRequired, false);
  assert.match(result.orchestration.summary, /not Preview deployment\/proof/);
});

test('unrelated successful provider checks do not manufacture verification readiness', async () => {
  const provider = providerFor({
    checks: [{ id: 8, name: 'Vercel Preview Comments', status: 'completed', conclusion: 'success' }],
  });
  const result = await status(provider);
  assert.equal(result.orchestration.state, 'external-gate-pending');
  assert.equal(result.orchestration.action, 'wait');
  assert.equal(result.orchestration.shouldAct, false);
  assert.match(result.orchestration.summary, /No recognized verification result/);
});

test('verified Preview head is promotion-ready while preserving the owner gate', async () => {
  const provider = providerFor({
    headRef: 'preview',
    baseRef: 'main',
    checks: [{ id: 1, name: 'verify', status: 'completed', conclusion: 'success' }],
    workflowRuns: [{ id: 9, name: 'verify', status: 'completed', conclusion: 'success' }],
  });
  const result = await status(provider);
  assert.equal(result.orchestration.state, 'promotion-ready');
  assert.equal(result.orchestration.action, 'promotion-gate');
  assert.equal(result.orchestration.shouldAct, true);
  assert.match(result.orchestration.summary, /Main promotion\/authorization gate/);
});


test('integration readiness requires a supported source branch and supported Preview base', async () => {
  const cases = [
    { name: 'work to preview', headRef: 'work/fix', baseRef: 'preview', expected: 'integration-ready' },
    { name: 'repair to vercel-preview', headRef: 'repair/fix', baseRef: 'vercel-preview', expected: 'integration-ready' },
    { name: 'audit to preview', headRef: 'audit/fix', baseRef: 'preview', expected: 'integration-ready' },
    { name: 'Dependabot to Main', headRef: 'dependabot/npm_and_yarn/pkg-1', baseRef: 'main', expected: 'external-gate-pending' },
    { name: 'work to Main', headRef: 'work/fix', baseRef: 'main', expected: 'external-gate-pending' },
    { name: 'Dependabot to Preview', headRef: 'dependabot/npm_and_yarn/pkg-1', baseRef: 'preview', expected: 'external-gate-pending' },
    { name: 'work to arbitrary branch', headRef: 'work/fix', baseRef: 'staging', expected: 'external-gate-pending' },
  ] as const;
  for (const candidate of cases) {
    const provider = providerFor({
      headRef: candidate.headRef,
      baseRef: candidate.baseRef,
      checks: [{ id: 1, name: 'verify', status: 'completed', conclusion: 'success' }],
      workflowRuns: [{ id: 9, name: 'verify', status: 'completed', conclusion: 'success' }],
    });
    const result = await status(provider);
    assert.equal(result.orchestration.state, candidate.expected, candidate.name);
    if (candidate.expected === 'integration-ready') {
      assert.equal(result.orchestration.action, 'integration-merge', candidate.name);
      assert.equal(result.orchestration.shouldAct, true, candidate.name);
    } else {
      assert.equal(result.orchestration.action, 'wait', candidate.name);
      assert.equal(result.orchestration.shouldAct, false, candidate.name);
      assert.match(result.orchestration.summary, /outside supported automatic integration or promotion paths/, candidate.name);
    }
  }
});

test('Preview-to-default is promotion-ready only with authoritative default-branch metadata', async () => {
  const checks = [{ id: 1, name: 'verify', status: 'completed', conclusion: 'success' }];
  const workflowRuns = [{ id: 9, name: 'verify', status: 'completed', conclusion: 'success' }];
  const eligible = await status(providerFor({ headRef: 'preview', baseRef: 'main', defaultBranch: 'main', checks, workflowRuns }));
  assert.equal(eligible.orchestration.state, 'promotion-ready');
  assert.equal(eligible.orchestration.action, 'promotion-gate');
  assert.equal(eligible.orchestration.shouldAct, true);
  const missing = await status(providerFor({ headRef: 'preview', baseRef: 'main', defaultBranch: null, checks, workflowRuns }));
  assert.equal(missing.orchestration.state, 'external-gate-pending');
  assert.equal(missing.orchestration.action, 'wait');
  assert.equal(missing.orchestration.shouldAct, false);
  const wrong = await status(providerFor({ headRef: 'preview', baseRef: 'release', defaultBranch: 'main', checks, workflowRuns }));
  assert.equal(wrong.orchestration.state, 'external-gate-pending');
  assert.equal(wrong.orchestration.shouldAct, false);
});
