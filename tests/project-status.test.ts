import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ConductorToolRuntime,
  GitHubRuntimeProvider,
  createConductorMcpServer,
} from '../src/index.js';
import type {
  ProjectPreflightProvider,
  WorkItemCandidateReadProvider,
} from '../src/index.js';

test('GitHub reconstructs same-repository PR candidates from native issue timeline cross-references', async () => {
  const headSha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  const provider = new GitHubRuntimeProvider({
    credentials: {
      async getIdentity() { return { kind: 'app' as const, appId: '12345' }; },
      async getCredential(repository: string) {
        return {
          token: 'installation-token',
          kind: 'app-installation' as const,
          identity: { kind: 'app' as const, appId: '12345', installationId: 42 },
          repository,
          permissions: { issues: 'read', pull_requests: 'read', checks: 'read', actions: 'read' },
        };
      },
    },
    allowedOwners: ['pyralisxc'],
    fetch: async (input) => {
      const url = String(input);
      if (url.includes('/issues/23/timeline')) return Response.json([
        { event: 'cross-referenced', source: { issue: {
          number: 30,
          repository_url: 'https://api.github.com/repos/pyralisxc/Conductor',
          pull_request: {},
        } } },
        { event: 'cross-referenced', source: { issue: {
          number: 99,
          repository_url: 'https://api.github.com/repos/other/project',
          pull_request: {},
        } } },
      ]);
      if (url.endsWith('/pulls/30')) return Response.json({
        number: 30,
        html_url: 'https://github.com/pyralisxc/Conductor/pull/30',
        state: 'open',
        draft: false,
        merged: false,
        mergeable: true,
        mergeable_state: 'clean',
        head: { ref: 'work/con-23-project-status', sha: headSha },
        base: { ref: 'preview', sha: baseSha },
        labels: [],
      });
      if (url.includes(`/commits/${headSha}/check-runs`)) return Response.json({
        check_runs: [
          { id: 1, name: 'verify', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
          { id: 2, name: 'Vercel', status: 'completed', conclusion: 'success', app: { slug: 'vercel' } },
        ],
      });
      if (url.includes('/actions/runs?')) return Response.json({
        workflow_runs: [{ id: 9, name: 'verify', status: 'completed', conclusion: 'success' }],
      });
      throw new Error(`Unexpected request ${url}`);
    },
  });

  const candidates = await provider.listWorkItemPullRequests({
    project: { id: 'pyralisxc/Conductor' },
    issueNumber: 23,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.pullRequestNumber, 30);
  assert.equal(candidates[0]?.head.sha, headSha);
  assert.equal(candidates[0]?.checks.successful, 2);
  assert.equal(candidates[0]?.workflowRuns[0]?.id, 9);
});

test('development status groups active work without ranking it and preserves inspect preflight', async () => {
  const items = [
    ['ready', 23], ['in-progress', 31], ['blocked', 32],
    ['review', 33], ['backlog', 34], ['done', 35],
  ] as const;
  const workProvider: WorkItemCandidateReadProvider = {
    id: 'github',
    async getCapabilities() { return []; },
    async getWorkItemStatus() { throw new Error('unused'); },
    async listWorkItems() {
      return {
        repository: 'pyralisxc/Conductor',
        truncated: false,
        items: items.map(([status, issueNumber]) => ({
          repository: 'pyralisxc/Conductor',
          issueNumber,
          url: `https://github.com/pyralisxc/Conductor/issues/${issueNumber}`,
          title: `Work ${issueNumber}`,
          body: '',
          state: status === 'done' ? 'closed' : 'open',
          status,
          statusSource: 'label' as const,
          kind: 'feature' as const,
          kindSource: 'label' as const,
          origin: 'human' as const,
          originSource: 'label' as const,
          severity: 'unknown' as const,
          severitySource: 'default' as const,
          priority: 'unknown' as const,
          prioritySource: 'default' as const,
          productionBlocking: false,
          labels: [`status:${status}`],
          createdAt: '2026-09-22T00:00:00Z',
          updatedAt: '2026-09-22T01:00:00Z',
        })),
      };
    },
    async listWorkItemPullRequests(input) {
      if (input.issueNumber !== 23) return [];
      return [{
        repository: 'pyralisxc/Conductor',
        pullRequestNumber: 30,
        url: 'https://github.com/pyralisxc/Conductor/pull/30',
        state: 'open',
        draft: false,
        merged: false,
        mergeable: true,
        mergeableState: 'clean',
        head: { ref: 'work/con-23-project-status', sha: 'a'.repeat(40) },
        base: { ref: 'preview', sha: 'b'.repeat(40) },
        labels: [],
        checks: { total: 1, pending: 0, successful: 1, failed: 0, neutral: 0, skipped: 0, items: [] },
        workflowRuns: [],
        orchestration: {
          state: 'integration-ready' as const,
          action: 'integration-merge' as const,
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
      }];
    },
  };
  const intelligence: ProjectPreflightProvider = {
    id: 'development-intelligence',
    async getCapabilities() { return []; },
    async preflightProject() {
      return [{
        check: 'development-intelligence.read' as const,
        status: 'ready' as const,
        provider: 'development-intelligence',
        summary: 'Development Intelligence can inspect project',
        diagnostics: [],
      }];
    },
  };
  const githubPreflight: ProjectPreflightProvider = {
    id: 'github',
    async getCapabilities() { return []; },
    async preflightProject() {
      return [
        { check: 'repository.access' as const, status: 'ready' as const, provider: 'github', summary: 'ready', diagnostics: [] },
        { check: 'github.read' as const, status: 'ready' as const, provider: 'github', summary: 'ready', diagnostics: [] },
      ];
    },
  };

  const runtime = new ConductorToolRuntime({
    providers: [githubPreflight, intelligence],
    workItemProvider: workProvider as any,
    workItemCandidateProvider: workProvider,
  });
  const receipt = await runtime.developmentStatus({ project: { id: 'pyralisxc/Conductor' } });
  assert.equal(receipt.status, 'succeeded');
  if (receipt.status !== 'succeeded') return;
  assert.equal(receipt.result.preflight.status, 'ready');
  assert.deepEqual(receipt.result.work.counts, {
    backlog: 1, ready: 1, inProgress: 1, blocked: 1, review: 1, done: 1, unknown: 0,
  });
  assert.equal(receipt.result.work.ready[0]?.workItem.issueNumber, 23);
  assert.equal(receipt.result.work.ready[0]?.candidates[0]?.pullRequestNumber, 30);
  assert.equal(receipt.result.work.ready[0]?.lifecycleStage, 'preview-integration');
  assert.equal(receipt.result.work.ready[0]?.artifacts[0]?.role, 'preview-integration');
  assert.equal(receipt.result.work.ready[0]?.artifacts[0]?.pullRequest.pullRequestNumber, 30);
  assert.equal(receipt.result.work.inProgress[0]?.workItem.issueNumber, 31);
  assert.equal(receipt.result.work.blocked[0]?.workItem.issueNumber, 32);
  assert.equal(receipt.result.work.review[0]?.workItem.issueNumber, 33);
});

test('MCP advertises development.status only when candidate reconstruction is configured', async () => {
  const provider: WorkItemCandidateReadProvider = {
    id: 'github',
    async getCapabilities() { return []; },
    async getWorkItemStatus() { throw new Error('unused'); },
    async listWorkItems() { return { repository: 'pyralisxc/Conductor', items: [], truncated: false }; },
    async listWorkItemPullRequests() { return []; },
  };
  const runtime = new ConductorToolRuntime({
    workItemCandidateProvider: provider,
    workItemProvider: provider as any,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createConductorMcpServer(runtime);
  const client = new Client({ name: 'development-status-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  assert.equal(listed.tools.some((tool) => tool.name === 'development.status' && tool.annotations?.readOnlyHint), true);
  await client.close();
  await server.close();
});


test('work bootstrap composes catalog freshness, topology, work state and provider posture in one runtime read', async () => {
  const workProvider: WorkItemCandidateReadProvider = {
    id: 'github-work',
    async getCapabilities() { return []; },
    async getWorkItemStatus() { throw new Error('unused'); },
    async listWorkItems() { return { repository: 'pyralisxc/Conductor', items: [], truncated: false }; },
    async listWorkItemPullRequests() { return []; },
  };
  const githubPreflight: ProjectPreflightProvider = {
    id: 'github',
    async getCapabilities() { return []; },
    async preflightProject() {
      return [
        { check: 'repository.access' as const, status: 'ready' as const, provider: 'github', summary: 'ready', diagnostics: [] },
        { check: 'github.read' as const, status: 'ready' as const, provider: 'github', summary: 'ready', diagnostics: [] },
      ];
    },
  };
  const intelligence: ProjectPreflightProvider = {
    id: 'development-intelligence',
    async getCapabilities() { return []; },
    async preflightProject() {
      return [{ check: 'development-intelligence.read' as const, status: 'degraded' as const, provider: 'development-intelligence', summary: 'canonical graph stale', diagnostics: [] }];
    },
  };
  const topology = {
    provider: 'github' as const,
    repository: 'pyralisxc/Conductor',
    defaultBranch: 'main',
    defaultHead: 'a'.repeat(40),
    integrationBranch: 'preview' as const,
    integrationHead: 'b'.repeat(40),
    observedAt: '2026-09-27T00:00:00.000Z',
  };
  const runtime = new ConductorToolRuntime({
    providers: [githubPreflight, intelligence],
    workItemProvider: workProvider as any,
    workItemCandidateProvider: workProvider,
    repositoryBootstrapProvider: {
      id: 'github-bootstrap',
      async getCapabilities() { return []; },
      async getRepositoryBootstrap() { return topology; },
    },
    now: () => new Date('2026-09-27T00:00:00.000Z'),
  });

  const first = await runtime.workBootstrap({ project: { id: 'Conductor', repository: 'pyralisxc/Conductor' } });
  assert.equal(first.status, 'succeeded');
  if (first.status !== 'succeeded') return;
  assert.match(first.result.catalogDigest, /^[0-9a-f]{64}$/u);
  assert.equal(first.result.clientCatalog.freshness, 'unknown');
  assert.deepEqual(first.result.topology, topology);
  assert.equal(first.result.intelligence.status, 'degraded');

  const current = await runtime.workBootstrap({ project: { id: 'Conductor', repository: 'pyralisxc/Conductor' }, clientCatalogDigest: first.result.catalogDigest });
  assert.equal(current.status, 'succeeded');
  if (current.status === 'succeeded') assert.equal(current.result.clientCatalog.freshness, 'current');

  const stale = await runtime.workBootstrap({ project: { id: 'Conductor', repository: 'pyralisxc/Conductor' }, clientCatalogDigest: '0'.repeat(64) });
  assert.equal(stale.status, 'succeeded');
  if (stale.status === 'succeeded') {
    assert.equal(stale.result.clientCatalog.freshness, 'stale-client-schema');
    assert.equal(stale.diagnostics.some(item => /refresh\/reconnect/u.test(item.message)), true);
  }
});


test('development status bounds active work candidate fan-out to four concurrent reads', async () => {
  let activeReads = 0;
  let peakReads = 0;
  const workProvider: WorkItemCandidateReadProvider = {
    id: 'github',
    async getCapabilities() { return []; },
    async getWorkItemStatus() { throw new Error('unused'); },
    async listWorkItems() {
      return {
        repository: 'pyralisxc/Conductor',
        truncated: false,
        items: Array.from({ length: 8 }, (_, index) => {
          const issueNumber = index + 1;
          return {
            repository: 'pyralisxc/Conductor',
            issueNumber,
            url: `https://github.com/pyralisxc/Conductor/issues/${issueNumber}`,
            title: `Work ${issueNumber}`,
            body: '',
            state: 'open',
            status: 'in-progress' as const,
            statusSource: 'label' as const,
            kind: 'feature' as const,
            kindSource: 'label' as const,
            origin: 'human' as const,
            originSource: 'label' as const,
            severity: 'unknown' as const,
            severitySource: 'default' as const,
            priority: 'unknown' as const,
            prioritySource: 'default' as const,
            productionBlocking: false,
            labels: ['status:in-progress'],
            createdAt: '2026-09-28T00:00:00Z',
            updatedAt: '2026-09-28T00:00:00Z',
          };
        }),
      };
    },
    async listWorkItemPullRequests() {
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      await new Promise(resolve => setTimeout(resolve, 10));
      activeReads -= 1;
      return [];
    },
  };
  const githubPreflight: ProjectPreflightProvider = {
    id: 'github-preflight',
    async getCapabilities() { return []; },
    async preflightProject() {
      return [
        { check: 'repository.access' as const, status: 'ready' as const, provider: 'github', summary: 'ready', diagnostics: [] },
        { check: 'github.read' as const, status: 'ready' as const, provider: 'github', summary: 'ready', diagnostics: [] },
      ];
    },
  };
  const intelligence: ProjectPreflightProvider = {
    id: 'development-intelligence',
    async getCapabilities() { return []; },
    async preflightProject() {
      return [{
        check: 'development-intelligence.read' as const,
        status: 'ready' as const,
        provider: 'development-intelligence',
        summary: 'ready',
        diagnostics: [],
      }];
    },
  };
  const runtime = new ConductorToolRuntime({
    providers: [githubPreflight, intelligence],
    workItemProvider: workProvider as any,
    workItemCandidateProvider: workProvider,
  });

  const receipt = await runtime.developmentStatus({
    project: { id: 'pyralisxc/Conductor' },
    limit: 8,
  });
  assert.equal(receipt.status, 'succeeded');
  assert.equal(peakReads, 4);
});

test('capabilities publishes a stable catalog digest including work.bootstrap', async () => {
  const provider: WorkItemCandidateReadProvider = {
    id: 'github',
    async getCapabilities() { return []; },
    async getWorkItemStatus() { throw new Error('unused'); },
    async listWorkItems() { return { repository: 'pyralisxc/Conductor', items: [], truncated: false }; },
    async listWorkItemPullRequests() { return []; },
  };
  const runtime = new ConductorToolRuntime({ workItemProvider: provider as any, workItemCandidateProvider: provider });
  const a = await runtime.capabilities();
  const b = await runtime.capabilities();
  assert.equal(a.status, 'succeeded');
  assert.equal(b.status, 'succeeded');
  if (a.status !== 'succeeded' || b.status !== 'succeeded') return;
  assert.equal(a.result.catalogDigest, b.result.catalogDigest);
  assert.match(a.result.catalogDigest, /^[0-9a-f]{64}$/u);
  assert.equal(a.result.operations.some(op => op.name === 'work.bootstrap'), true);
});


test('repository audit succeeds without DI and keeps semantic audit separate', async () => {
  const workProvider: WorkItemCandidateReadProvider = {
    id: 'github-work',
    async getCapabilities() { return []; },
    async getWorkItemStatus() { throw new Error('unused'); },
    async listWorkItems() {
      return {
        repository: 'pyralisxc/Conductor',
        truncated: false,
        items: [{
          repository: 'pyralisxc/Conductor', issueNumber: 1, url: 'https://github.test/issues/1',
          title: 'Unclassified', body: '', state: 'open' as const, status: 'ready' as const,
          statusSource: 'label' as const, kind: 'unknown' as const, kindSource: 'default' as const,
          origin: 'unknown' as const, originSource: 'default' as const,
          severity: 'unknown' as const, severitySource: 'default' as const,
          priority: 'unknown' as const, prioritySource: 'default' as const, productionBlocking: false,
          labels: ['status:ready'],
          createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z',
        }],
      };
    },
    async listWorkItemPullRequests() { return []; },
  };
  const githubPreflight: ProjectPreflightProvider = {
    id: 'github',
    async getCapabilities() { return []; },
    async preflightProject() {
      return [
        { check: 'repository.access' as const, status: 'ready' as const, provider: 'github', summary: 'ready', diagnostics: [] },
        { check: 'github.read' as const, status: 'ready' as const, provider: 'github', summary: 'ready', diagnostics: [] },
      ];
    },
  };
  const runtime = new ConductorToolRuntime({
    providers: [githubPreflight],
    workItemCandidateProvider: workProvider,
    repositoryAuditProvider: {
      id: 'github-audit',
      async getCapabilities() { return []; },
      async getRepositoryAudit() {
        return {
          provider: 'github' as const,
          repository: 'pyralisxc/Conductor',
          topology: {
            provider: 'github' as const, repository: 'pyralisxc/Conductor',
            defaultBranch: 'main', defaultHead: 'a'.repeat(40),
            integrationBranch: 'preview' as const, integrationHead: 'b'.repeat(40),
            observedAt: '2026-09-27T00:00:00Z',
          },
          developmentBranches: { items: [], truncated: false },
          openPullRequests: { items: [], truncated: false },
          observedAt: '2026-09-27T00:00:00Z',
        };
      },
    },
    now: () => new Date('2026-09-27T00:00:00Z'),
  });
  const receipt = await runtime.repositoryAudit({ project: { id: 'Conductor', repository: 'pyralisxc/Conductor' } });
  assert.equal(receipt.status, 'succeeded');
  if (receipt.status !== 'succeeded') return;
  assert.equal(receipt.result.github?.repository, 'pyralisxc/Conductor');
  assert.equal(receipt.result.intelligence.status, 'unavailable');
  assert.equal(receipt.result.intelligence.audit, null);
  assert.equal(receipt.result.work.hygiene.unknownKind, 1);
  assert.equal(receipt.result.findings.some(item => item.code === 'work-item.classification-hygiene'), true);
});

test('repository audit attaches DI findings as a separate semantic plane', async () => {
  const workProvider: WorkItemCandidateReadProvider = {
    id: 'github-work',
    async getCapabilities() { return []; },
    async getWorkItemStatus() { throw new Error('unused'); },
    async listWorkItems() { return { repository: 'pyralisxc/Conductor', items: [], truncated: false }; },
    async listWorkItemPullRequests() { return []; },
  };
  const runtime = new ConductorToolRuntime({
    providers: [],
    workItemCandidateProvider: workProvider,
    repositoryAuditProvider: {
      id: 'github-audit',
      async getCapabilities() { return []; },
      async getRepositoryAudit() {
        return {
          provider: 'github' as const, repository: 'pyralisxc/Conductor',
          topology: { provider: 'github' as const, repository: 'pyralisxc/Conductor', defaultBranch: 'main', defaultHead: 'a'.repeat(40), integrationBranch: 'preview' as const, integrationHead: 'b'.repeat(40), observedAt: '2026-09-27T00:00:00Z' },
          developmentBranches: { items: [], truncated: false },
          openPullRequests: { items: [], truncated: false },
          observedAt: '2026-09-27T00:00:00Z',
        };
      },
    },
    intelligenceAuditProvider: {
      id: 'development-intelligence',
      async getCapabilities() { return []; },
      async auditRepository() { return { findingSummary: { total: 2 }, findings: [{ category: 'relationship', status: 'candidate' }] }; },
    },
  });
  const receipt = await runtime.repositoryAudit({ project: { id: 'Conductor', repository: 'pyralisxc/Conductor' } });
  assert.equal(receipt.status, 'succeeded');
  if (receipt.status !== 'succeeded') return;
  assert.equal(receipt.result.intelligence.status, 'ready');
  assert.deepEqual(receipt.result.intelligence.audit, { findingSummary: { total: 2 }, findings: [{ category: 'relationship', status: 'candidate' }] });
  assert.equal(receipt.result.findings.some(item => item.source === 'development-intelligence'), false);
});
