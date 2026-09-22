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

test('project status groups active work without ranking it and preserves inspect preflight', async () => {
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
  const receipt = await runtime.projectStatus({ project: { id: 'pyralisxc/Conductor' } });
  assert.equal(receipt.status, 'succeeded');
  if (receipt.status !== 'succeeded') return;
  assert.equal(receipt.result.preflight.status, 'ready');
  assert.deepEqual(receipt.result.work.counts, {
    backlog: 1, ready: 1, inProgress: 1, blocked: 1, review: 1, done: 1, unknown: 0,
  });
  assert.equal(receipt.result.work.ready[0]?.workItem.issueNumber, 23);
  assert.equal(receipt.result.work.ready[0]?.candidates[0]?.pullRequestNumber, 30);
  assert.equal(receipt.result.work.inProgress[0]?.workItem.issueNumber, 31);
  assert.equal(receipt.result.work.blocked[0]?.workItem.issueNumber, 32);
  assert.equal(receipt.result.work.review[0]?.workItem.issueNumber, 33);
});

test('MCP advertises project.status only when candidate reconstruction is configured', async () => {
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
  const client = new Client({ name: 'project-status-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  assert.equal(listed.tools.some((tool) => tool.name === 'project.status' && tool.annotations?.readOnlyHint), true);
  await client.close();
  await server.close();
});
