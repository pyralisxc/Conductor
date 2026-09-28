import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ConductorToolRuntime,
  GitHubRuntimeProvider,
  IdempotentMutationExecutor,
  InMemoryIdempotencyStore,
  createConductorMcpServer,
} from '../src/index.js';

function githubProvider() {
  let currentLabels = ['status:ready', 'kind:investigation', 'origin:di-finding', 'severity:high', 'priority:p1', 'production-blocking', 'area:di'];
  let currentState = 'open';
  let currentTitle = 'Improve semantic orientation';
  let currentBody = 'Benchmark Game Studio Core.';

  const issue = () => ({
    number: 7,
    html_url: 'https://github.com/pyralisxc/Development-Intelligence/issues/7',
    title: currentTitle,
    body: currentBody,
    state: currentState,
    labels: currentLabels.map((name) => ({ name })),
    created_at: '2026-09-20T00:00:00Z',
    updated_at: '2026-09-20T01:00:00Z',
  });

  return new GitHubRuntimeProvider({
    credentials: {
      async getIdentity() { return { kind: 'app' as const, appId: '12345' }; },
      async getCredential(repository: string) {
        return {
          token: 'installation-token',
          kind: 'app-installation' as const,
          identity: { kind: 'app' as const, appId: '12345', installationId: 42 },
          repository,
          permissions: { issues: 'write' },
        };
      },
    },
    allowedOwners: ['pyralisxc'],
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;

      if (url.includes('/labels/') && method === 'GET') {
        return Response.json({ name: decodeURIComponent(url.split('/').at(-1)!) });
      }
      if (url.endsWith('/labels') && method === 'POST') {
        return Response.json(body, { status: 201 });
      }
      if (url.endsWith('/issues') && method === 'POST') {
        currentTitle = body.title;
        currentBody = body.body ?? '';
        currentState = 'open';
        currentLabels = body.labels ?? [];
        return Response.json(issue(), { status: 201 });
      }
      if (url.endsWith('/issues/7') && method === 'GET') return Response.json(issue());
      if (url.endsWith('/issues/8') && method === 'GET') return Response.json({ ...issue(), number: 8, pull_request: {} });
      if (url.endsWith('/issues/7/comments') && method === 'POST') {
        return Response.json({ id: 23, html_url: 'https://github.com/pyralisxc/Development-Intelligence/issues/7#issuecomment-23' }, { status: 201 });
      }
      if (url.includes('/issues?') && method === 'GET') return Response.json([
        issue(),
        {
          ...issue(),
          number: 8,
          html_url: 'https://github.com/pyralisxc/Development-Intelligence/pull/8',
          pull_request: {},
        },
      ]);
      if (url.endsWith('/issues/7') && method === 'PATCH') {
        currentState = body.state ?? currentState;
        return Response.json(issue());
      }
      if (url.endsWith('/issues/7/labels') && method === 'PUT') {
        currentLabels = body.labels ?? [];
        return Response.json(currentLabels.map((name: string) => ({ name })));
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    },
  });
}

test('GitHub issues normalize lifecycle, kind, and origin without replacing native labels', async () => {
  const provider = githubProvider();
  const project = { id: 'pyralisxc/Development-Intelligence' };

  const created = await provider.createWorkItem({
    project,
    title: 'Improve semantic orientation',
    body: 'Benchmark Game Studio Core.',
    status: 'ready',
    kind: 'investigation',
    origin: 'di-finding',
    severity: 'high',
    priority: 'p1',
    productionBlocking: true,
    labels: ['area:di'],
    idempotencyKey: 'work-item:create:semantic-orientation',
  });
  assert.equal(created.status, 'ready');
  assert.equal(created.kind, 'investigation');
  assert.equal(created.origin, 'di-finding');

  const comment = await provider.commentWorkItem({
    project, issueNumber: 7, body: 'New evidence belongs on this issue.', idempotencyKey: 'work-item:comment:7:evidence',
  });
  assert.equal(comment.issueNumber, 7);
  assert.equal(comment.commentId, '23');
  await assert.rejects(provider.commentWorkItem({
    project, issueNumber: 8, body: 'This is a pull request.', idempotencyKey: 'work-item:comment:8:blocked',
  }), (error: unknown) => Boolean(error && typeof error === 'object' && 'message' in error && String(error.message).includes('not a work item')));

  const status = await provider.getWorkItemStatus({ project, issueNumber: 7 });
  assert.equal(status.status, 'ready');
  assert.equal(status.statusSource, 'label');
  assert.equal(status.kind, 'investigation');
  assert.equal(status.kindSource, 'label');
  assert.equal(status.origin, 'di-finding');
  assert.equal(status.originSource, 'label');
  assert.equal(status.severity, 'high');
  assert.equal(status.severitySource, 'label');
  assert.equal(status.priority, 'p1');
  assert.equal(status.prioritySource, 'label');
  assert.equal(status.productionBlocking, true);

  const listed = await provider.listWorkItems({
    project,
    statuses: ['ready'],
    kinds: ['investigation'],
    origins: ['di-finding'],
    limit: 20,
  });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0]?.issueNumber, 7);

  const updated = await provider.updateWorkItemStatus({
    project,
    issueNumber: 7,
    status: 'in-progress',
    idempotencyKey: 'work-item:status:7:in-progress',
  });
  assert.equal(updated.status, 'in-progress');
  assert.equal(updated.kind, 'investigation');
  assert.equal(updated.origin, 'di-finding');
  assert.equal(updated.severity, 'high');
  assert.equal(updated.priority, 'p1');
  assert.equal(updated.productionBlocking, true);
  assert.equal(updated.labels.includes('area:di'), true);

  const classified = await provider.updateWorkItemClassification({
    project,
    issueNumber: 7,
    kind: 'improvement',
    origin: 'agent-audit',
    idempotencyKey: 'work-item:classification:7:improvement',
  });
  assert.equal(classified.status, 'in-progress');
  assert.equal(classified.kind, 'improvement');
  assert.equal(classified.origin, 'agent-audit');
  assert.equal(classified.severity, 'high');
  assert.equal(classified.priority, 'p1');
  assert.equal(classified.productionBlocking, true);
  assert.equal(classified.labels.includes('area:di'), true);

  const triaged = await provider.updateWorkItemTriage({
    project,
    issueNumber: 7,
    severity: 'critical',
    priority: 'p0',
    productionBlocking: false,
    idempotencyKey: 'work-item:triage:7:critical-p0',
  });
  assert.equal(triaged.status, 'in-progress');
  assert.equal(triaged.kind, 'improvement');
  assert.equal(triaged.origin, 'agent-audit');
  assert.equal(triaged.severity, 'critical');
  assert.equal(triaged.priority, 'p0');
  assert.equal(triaged.productionBlocking, false);
  assert.equal(triaged.labels.includes('area:di'), true);

  const cleared = await provider.updateWorkItemClassification({
    project,
    issueNumber: 7,
    kind: 'unknown',
    idempotencyKey: 'work-item:classification:7:clear-kind',
  });
  assert.equal(cleared.kind, 'unknown');
  assert.equal(cleared.kindSource, 'default');
  assert.equal(cleared.origin, 'agent-audit');
});

test('reserved normalized labels cannot bypass work-item fields', async () => {
  const provider = githubProvider();
  await assert.rejects(
    provider.createWorkItem({
      project: { id: 'pyralisxc/Development-Intelligence' },
      title: 'Invalid direct classification',
      labels: ['severity:critical'],
      idempotencyKey: 'work-item:create:invalid-label',
    }),
    (error: any) => error?.code === 'CONFLICT' && /reserved/.test(error.message),
  );
});

test('runtime and MCP expose human-directed work routing and classification', async () => {
  const provider = githubProvider();
  const runtime = new ConductorToolRuntime({
    providers: [provider],
    projectResolver: provider,
    workItemProvider: provider,
    mutationExecutor: new IdempotentMutationExecutor({ store: new InMemoryIdempotencyStore() }),
  });

  const capabilities = await runtime.capabilities();
  assert.equal(capabilities.status, 'succeeded');
  if (capabilities.status === 'succeeded') {
    const names = capabilities.result.operations.map((operation) => operation.name);
    for (const name of [
      'work-item.status',
      'work-item.list',
      'work-item.create',
      'work-item.comment.create',
      'work-item.update-status',
      'work-item.classification.update',
      'work-item.triage.update',
    ]) {
      assert.equal(names.includes(name as any), true);
    }
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createConductorMcpServer(runtime);
  const client = new Client({ name: 'work-item-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  for (const name of [
    'work-item.status',
    'work-item.list',
    'work-item.create',
    'work-item.comment.create',
    'work-item.update-status',
    'work-item.classification.update',
    'work-item.triage.update',
  ]) {
    assert.equal(names.includes(name), true);
  }
  await client.close();
  await server.close();
});


test('audit is a first-class work kind and preserves unrelated labels', async () => {
  let labels = ['customer-visible'];
  const provider = new GitHubRuntimeProvider({
    token: 'secret',
    allowedOwners: ['pyralisxc'],
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname.endsWith('/issues/44') && method === 'GET') {
        return Response.json({
          number: 44,
          html_url: 'https://github.test/issues/44',
          title: 'Audit repository health',
          body: '',
          state: 'open',
          labels: labels.map(name => ({ name })),
          created_at: '2026-09-27T00:00:00Z',
          updated_at: '2026-09-27T00:00:00Z',
        });
      }
      if (url.pathname.endsWith('/issues/44/labels') && method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        labels = body.labels;
        return Response.json(labels.map(name => ({ name })));
      }
      if (url.pathname.endsWith('/labels/kind%3Aaudit') && method === 'GET') return Response.json({ name: 'kind:audit' });
      if (url.pathname.endsWith('/labels') && method === 'POST') return Response.json({ name: 'kind:audit' });
      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    },
  });
  const updated = await provider.updateWorkItemClassification({
    project: { id: 'Conductor', repository: 'pyralisxc/Conductor' },
    issueNumber: 44,
    kind: 'audit',
    idempotencyKey: 'audit-kind-test',
  });
  assert.equal(updated.kind, 'audit');
  assert.equal(updated.labels.includes('customer-visible'), true);
  assert.equal(updated.labels.includes('kind:audit'), true);
});


test('Main promotion fails closed on production blockers and exact overrides are auditable', async () => {
  const headSha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  let blockers = [194];
  let merges = 0;
  const provider = new GitHubRuntimeProvider({
    token: 'secret',
    allowedOwners: ['pyralisxc'],
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/repos/pyralisxc/Conductor' && method === 'GET') {
        return Response.json({ full_name: 'pyralisxc/Conductor', default_branch: 'main', permissions: { pull: true, push: true } });
      }
      if (url.pathname.endsWith('/pulls/9') && method === 'GET') {
        return Response.json({
          number: 9, html_url: 'https://github.test/pull/9', state: 'open', draft: false, merged: false,
          head: { ref: 'preview', sha: headSha }, base: { ref: 'main', sha: baseSha }, labels: [],
        });
      }
      if (url.pathname.endsWith('/issues') && method === 'GET' && url.searchParams.get('labels') === 'production-blocking') {
        return Response.json(blockers.map((number) => ({
          number, html_url: `https://github.test/issues/${number}`, title: 'Blocker', body: '', state: 'open',
          labels: [{ name: 'production-blocking' }], created_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-28T00:00:00Z',
        })));
      }
      if (url.pathname.endsWith('/pulls/9/merge') && method === 'PUT') {
        merges++;
        return Response.json({ merged: true, sha: 'c'.repeat(40), message: 'merged' });
      }
      throw new Error(`Unexpected request ${method} ${url.pathname}${url.search}`);
    },
  });
  const base = {
    project: { id: 'Conductor', repository: 'pyralisxc/Conductor' },
    pullRequestNumber: 9, expectedHeadSha: headSha, expectedBaseSha: baseSha,
    approvalReference: 'owner-approved:blocker-gate-test', idempotencyKey: 'promotion-blocker-test',
  };
  await assert.rejects(provider.promotePullRequest(base), (error: any) => error?.code === 'PERMISSION_DENIED' && /#194/.test(error.message));
  await assert.rejects(provider.promotePullRequest({ ...base, overrideBlockerIssueNumbers: [999] }), (error: any) => error?.code === 'PERMISSION_DENIED' && /#999/.test(error.message));
  const overridden = await provider.promotePullRequest({ ...base, overrideBlockerIssueNumbers: [194] });
  assert.deepEqual(overridden.overriddenBlockerIssueNumbers, [194]);
  assert.equal(merges, 1);
  blockers = [];
  const clear = await provider.promotePullRequest({ ...base, overrideBlockerIssueNumbers: undefined });
  assert.deepEqual(clear.overriddenBlockerIssueNumbers, []);
  assert.equal(merges, 2);
});
