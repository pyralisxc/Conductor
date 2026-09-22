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
  }>;
  mergeable?: boolean | null;
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
          state: 'open',
          draft: false,
          merged: false,
          mergeable: input.mergeable ?? true,
          mergeable_state: 'clean',
          head: { ref: 'work/di-orchestration', sha: headSha },
          base: { ref: 'preview', sha: baseSha },
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
            ...run,
            html_url: `https://actions/${run.id}`,
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
    orchestrationState?: 'merged' | 'draft' | 'external-gate-pending'
      | 'pre-seal-checkpoint' | 'sealed-head-verification-required'
      | 'action-required' | 'verification-failed' | 'merge-blocked'
      | 'promotion-ready';
  },
) {
  return await provider.getPullRequestStatus({
    project: { id: 'pyralisxc/Development-Intelligence' },
    pullRequestNumber: 12,
    previous,
  });
}

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
  ]);
});

test('settled sealed head reports technical promotion readiness without inferring approval', async () => {
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

  assert.equal(result.orchestration.state, 'promotion-ready');
  assert.equal(result.orchestration.action, 'promotion-gate');
  assert.equal(result.orchestration.shouldAct, true);
  assert.equal(result.orchestration.transition.headChanged, true);
  assert.equal(result.orchestration.transition.meaningful, true);
  assert.equal(result.orchestration.seal.exactHeadVerificationRequired, false);
  assert.match(result.orchestration.summary, /authorization gate/);
});
