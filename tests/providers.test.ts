import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import {
  GitHubRuntimeProvider,
  GitHubAppCredentialProvider,
  DevelopmentIntelligenceProvider,
  UnavailableDevelopmentIntelligenceProvider,
  WorkspaceRuntimeProvider,
  parseRuntimeBindings,
  parseOwners,
} from '../src/index.js';

test('GitHub provider reports missing authentication explicitly', async () => {
  const provider = new GitHubRuntimeProvider({
    projects: [{ id: 'conductor', repository: 'pyralisxc/Conductor' }],
  });

  const capabilities = await provider.getCapabilities();
  assert.equal(capabilities.every((capability) => !capability.available), true);
  assert.equal(capabilities[0]?.auth, 'required');

  const checks = await provider.preflightProject({ id: 'conductor' });
  assert.equal(checks.every((check) => check.status === 'blocked'), true);
  assert.equal(checks[0]?.error?.code, 'AUTH_REQUIRED');
});

test('GitHub provider proves project-specific read and write permissions', async () => {
  const requested: string[] = [];
  const provider = new GitHubRuntimeProvider({
    token: 'secret',
    projects: [{ id: 'conductor', repository: 'pyralisxc/Conductor' }],
    fetch: async (input) => {
      requested.push(String(input));
      if (String(input).endsWith('/rate_limit')) {
        return Response.json({ resources: {} });
      }
      return Response.json({
        full_name: 'pyralisxc/Conductor',
        permissions: { pull: true, push: false },
      });
    },
  });

  const capabilities = await provider.getCapabilities();
  assert.equal(capabilities.find((item) => item.capability === 'github.read')?.available, true);
  const checks = await provider.preflightProject({ id: 'conductor' });
  assert.equal(checks.find((check) => check.check === 'github.read')?.status, 'ready');
  assert.equal(checks.find((check) => check.check === 'github.write')?.error?.code, 'PERMISSION_DENIED');
  assert.match(requested.at(-1) ?? '', /repos\/pyralisxc\/Conductor$/);
});

test('GitHub App credentials discover the repository installation and mint a repository-scoped token', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const requests: Array<{ url: string; authorization: string | null; body?: string }> = [];
  const now = () => new Date('2026-09-20T00:00:00Z');
  const credentials = new GitHubAppCredentialProvider({
    appId: '12345',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    now,
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      if (url.endsWith('/app')) return Response.json({ id: 12345, slug: 'dev-os-conductor' });
      if (url.endsWith('/repos/pyralisxc/CardForge/installation')) {
        return Response.json({ id: 42, account: { login: 'pyralisxc' }, repository_selection: 'all' });
      }
      if (url.endsWith('/app/installations/42/access_tokens')) {
        return Response.json({
          token: 'installation-token',
          expires_at: '2026-09-20T01:00:00Z',
          repository_selection: 'selected',
          permissions: { contents: 'write', pull_requests: 'write', issues: 'write', checks: 'read' },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });

  const first = await credentials.getCredential('pyralisxc/CardForge');
  const cached = await credentials.getCredential('pyralisxc/CardForge');
  assert.equal(first.token, 'installation-token');
  assert.equal(first.identity.appSlug, 'dev-os-conductor');
  assert.equal(first.identity.installationId, 42);
  assert.equal(first.permissions?.contents, 'write');
  assert.equal(cached, first);
  assert.equal(requests.length, 3);
  assert.deepEqual(JSON.parse(requests[2]?.body ?? '{}'), { repositories: ['CardForge'] });
  assert.equal(requests.every((request) => request.authorization?.startsWith('Bearer eyJ')), true);
});

test('GitHub App preflight proves operation-specific develop permissions', async () => {
  const credentials = {
    async getIdentity() { return { kind: 'app' as const, appId: '12345', appSlug: 'dev-os-conductor' }; },
    async getCredential(repository: string) {
      return {
        token: 'installation-token',
        kind: 'app-installation' as const,
        identity: {
          kind: 'app' as const,
          appId: '12345',
          appSlug: 'dev-os-conductor',
          installationId: 42,
          account: 'pyralisxc',
        },
        repository,
        repositorySelection: 'all',
        permissions: { contents: 'write', pull_requests: 'write', issues: 'write' },
      };
    },
  };
  const provider = new GitHubRuntimeProvider({
    credentials,
    allowedOwners: ['pyralisxc'],
    fetch: async () => Response.json({
      full_name: 'pyralisxc/CardForge',
      // GitHub App installation access is proven by the successful repository
      // request plus installation-token permissions, not user/PAT role flags.
      permissions: { pull: false, push: false },
    }),
  });

  const checks = await provider.preflightProject({ id: 'pyralisxc/CardForge' });
  assert.deepEqual(checks.map((check) => check.status), ['ready', 'ready', 'ready']);
  const evidence = checks[2]?.diagnostics[0]?.details;
  assert.equal(evidence?.identityKind, 'app-installation');
  assert.equal(evidence?.installationId, 42);
  assert.equal(evidence?.['permission.contents'], 'write');
});

test('GitHub App preflight blocks develop when one advertised mutation permission is missing', async () => {
  const provider = new GitHubRuntimeProvider({
    credentials: {
      async getIdentity() { return { kind: 'app' as const, appId: '12345' }; },
      async getCredential(repository: string) {
        return {
          token: 'installation-token',
          kind: 'app-installation' as const,
          identity: { kind: 'app' as const, appId: '12345', installationId: 42 },
          repository,
          permissions: { contents: 'write', pull_requests: 'write', issues: 'read' },
        };
      },
    },
    allowedOwners: ['pyralisxc'],
    fetch: async () => Response.json({ permissions: { pull: true, push: true } }),
  });

  const checks = await provider.preflightProject({ id: 'pyralisxc/CardForge' });
  assert.equal(checks[2]?.status, 'blocked');
  assert.equal(checks[2]?.error?.code, 'PERMISSION_DENIED');
  assert.match(checks[2]?.summary ?? '', /issues:write/);
});

test('GitHub App mutations fail closed before the provider call when operation permission is missing', async () => {
  let providerCalls = 0;
  const provider = new GitHubRuntimeProvider({
    credentials: {
      async getIdentity() { return { kind: 'app' as const, appId: '12345' }; },
      async getCredential(repository: string) {
        return {
          token: 'installation-token',
          kind: 'app-installation' as const,
          identity: { kind: 'app' as const, appId: '12345', installationId: 42 },
          repository,
          permissions: { contents: 'read', pull_requests: 'write', issues: 'write' },
        };
      },
    },
    allowedOwners: ['pyralisxc'],
    fetch: async () => {
      providerCalls += 1;
      return Response.json({});
    },
  });

  await assert.rejects(
    provider.createBranch({
      project: { id: 'pyralisxc/CardForge' },
      branch: 'work/cf-authorization',
      fromSha: 'a'.repeat(40),
      idempotencyKey: 'branch:cf:authorization',
    }),
    (error: any) => error?.code === 'PERMISSION_DENIED' && /contents:write/.test(error.message),
  );
  assert.equal(providerCalls, 0);
});

test('GitHub provider rejects project identity mismatches before network access', async () => {
  let calls = 0;
  const provider = new GitHubRuntimeProvider({
    token: 'secret',
    projects: [{ id: 'conductor', repository: 'pyralisxc/Conductor' }],
    fetch: async () => {
      calls += 1;
      return Response.json({});
    },
  });

  const checks = await provider.preflightProject({
    id: 'conductor',
    repository: 'attacker/other',
  });
  assert.equal(calls, 0);
  assert.equal(checks[0]?.error?.code, 'CONFLICT');
});

test('GitHub provider resolves repositories under an authorized owner without per-repository registration', async () => {
  const requested: string[] = [];
  const provider = new GitHubRuntimeProvider({
    token: 'secret',
    allowedOwners: ['pyralisxc'],
    fetch: async (input) => {
      requested.push(String(input));
      return Response.json({ full_name: 'pyralisxc/CardForge', permissions: { pull: true, push: true } });
    },
  });
  const checks = await provider.preflightProject({ id: 'pyralisxc/CardForge' });
  assert.deepEqual(checks.map((check) => check.status), ['ready', 'ready', 'degraded']);
  assert.match(requested[0] ?? '', /repos\/pyralisxc\/CardForge$/);

  const rejected = await provider.preflightProject({ id: 'attacker/CardForge' });
  assert.equal(rejected[0]?.error?.code, 'NOT_FOUND');
  assert.equal(requested.length, 1);
});

test('GitHub provider can delete a tracked path in a bounded commit', async () => {
  const expectedHead = 'a'.repeat(40);
  const requests: Array<{ url: string; method: string; body?: any }> = [];
  const provider = new GitHubRuntimeProvider({
    credentials: {
      async getIdentity() { return { kind: 'app' as const, appId: '12345' }; },
      async getCredential(repository: string) {
        return {
          token: 'installation-token',
          kind: 'app-installation' as const,
          identity: { kind: 'app' as const, appId: '12345', installationId: 42 },
          repository,
          permissions: { contents: 'write', pull_requests: 'write', issues: 'write' },
        };
      },
    },
    allowedOwners: ['pyralisxc'],
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, method, body });
      if (method === 'GET' && url.includes('/git/ref/heads/')) return Response.json({ object: { sha: expectedHead } });
      if (method === 'GET' && url.includes('/git/commits/')) return Response.json({ tree: { sha: 'tree-base' } });
      if (method === 'POST' && url.endsWith('/git/trees')) return Response.json({ sha: 'tree-next' });
      if (method === 'POST' && url.endsWith('/git/commits')) return Response.json({ sha: 'b'.repeat(40) });
      if (method === 'PATCH' && url.includes('/git/refs/heads/')) return Response.json({});
      throw new Error(`Unexpected request ${method} ${url}`);
    },
  });

  const created = await provider.createCommit({
    project: { id: 'pyralisxc/CardForge' },
    branch: 'work/cf-cleanup',
    expectedHeadSha: expectedHead,
    message: 'remove retired skill',
    files: [{ path: '.agents/skills/cardforge-codebase-context/SKILL.md', content: null }],
    idempotencyKey: 'commit:cf:delete-retired-skill',
  });
  assert.equal(created.commitSha, 'b'.repeat(40));
  const treeRequest = requests.find(request => request.method === 'POST' && request.url.endsWith('/git/trees'));
  assert.deepEqual(treeRequest?.body?.tree, [{
    path: '.agents/skills/cardforge-codebase-context/SKILL.md',
    mode: '100644',
    type: 'blob',
    sha: null,
  }]);
  assert.equal(requests.some(request => request.url.endsWith('/git/blobs')), false);
});

test('GitHub provider opens work pull requests against explicit repository-native targets', async () => {
  const requests: Array<{ url: string; method: string; body?: any }> = [];
  const provider = new GitHubRuntimeProvider({
    credentials: {
      async getIdentity() { return { kind: 'app' as const, appId: '12345' }; },
      async getCredential(repository: string) {
        return {
          token: 'installation-token',
          kind: 'app-installation' as const,
          identity: { kind: 'app' as const, appId: '12345', installationId: 42 },
          repository,
          permissions: { contents: 'write', pull_requests: 'write', issues: 'write' },
        };
      },
    },
    allowedOwners: ['pyralisxc'],
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, method, body });
      if (url.endsWith('/pulls') && method === 'POST') return Response.json({ number: 12, html_url: 'https://github.com/pyralisxc/CardForge/pull/12' });
      throw new Error(`Unexpected request ${method} ${url}`);
    },
  });

  for (const base of ['vercel-preview', 'main']) {
    const created = await provider.createPullRequest({
      project: { id: 'pyralisxc/CardForge' },
      head: 'work/cf-cleanup',
      base,
      title: 'Cleanup',
      idempotencyKey: `pr:cf:cleanup:${base}`,
    });
    assert.equal(created.pullRequestNumber, 12);
    assert.equal(requests.at(-1)?.body?.base, base);
  }

  await assert.rejects(
    provider.createPullRequest({
      project: { id: 'pyralisxc/CardForge' },
      head: 'work/cf-cleanup',
      base: 'work/cf-cleanup',
      title: 'Invalid',
      idempotencyKey: 'pr:cf:self',
    }),
    (error: any) => error?.code === 'CONFLICT' && /head and base must differ/.test(error.message),
  );
});

test('GitHub provider returns exact PR identity plus checks and workflow runs', async () => {
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
          permissions: {
            contents: 'write', pull_requests: 'write', issues: 'write',
            checks: 'read', actions: 'read',
          },
        };
      },
    },
    allowedOwners: ['pyralisxc'],
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/pulls/12')) return Response.json({
        number: 12,
        html_url: 'https://github.com/pyralisxc/CardForge/pull/12',
        state: 'open',
        draft: false,
        merged: false,
        mergeable: true,
        mergeable_state: 'clean',
        head: { ref: 'work/cf-cleanup', sha: headSha },
        base: { ref: 'vercel-preview', sha: baseSha },
        labels: [{ name: 'seal-b' }],
      });
      if (url.includes(`/commits/${headSha}/check-runs`)) return Response.json({
        check_runs: [
          { id: 1, name: 'verify', status: 'completed', conclusion: 'success', details_url: 'https://checks/1', app: { slug: 'github-actions' } },
          { id: 2, name: 'Vercel', status: 'in_progress', conclusion: null, details_url: 'https://checks/2', app: { slug: 'vercel' } },
        ],
      });
      if (url.includes('/actions/runs?')) return Response.json({
        workflow_runs: [{ id: 9, name: 'verify', status: 'completed', conclusion: 'success', html_url: 'https://actions/9' }],
      });
      throw new Error(`Unexpected request ${url}`);
    },
  });

  const status = await provider.getPullRequestStatus({
    project: { id: 'pyralisxc/CardForge' },
    pullRequestNumber: 12,
  });
  assert.equal(status.head.sha, headSha);
  assert.equal(status.base.sha, baseSha);
  assert.deepEqual(status.labels, ['seal-b']);
  assert.equal(status.checks.total, 2);
  assert.equal(status.checks.pending, 1);
  assert.equal(status.checks.successful, 1);
  assert.equal(status.workflowRuns[0]?.id, 9);
});

test('GitHub provider updates PR labels without erasing unrelated labels', async () => {
  const requests: Array<{ method: string; body?: any }> = [];
  const provider = new GitHubRuntimeProvider({
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
    fetch: async (_input, init) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, body });
      if (method === 'GET') return Response.json([{ name: 'existing' }, { name: 'remove-me' }]);
      if (method === 'PUT') return Response.json([{ name: 'existing' }, { name: 'seal-b' }]);
      throw new Error(`Unexpected method ${method}`);
    },
  });

  const result = await provider.updatePullRequestLabels({
    project: { id: 'pyralisxc/Development-Intelligence' },
    pullRequestNumber: 26,
    add: ['seal-b'],
    remove: ['remove-me'],
    idempotencyKey: 'labels:di:26:seal',
  });
  assert.deepEqual(result.labels, ['existing', 'seal-b']);
  assert.deepEqual(requests.at(-1)?.body?.labels, ['existing', 'seal-b']);
});

test('GitHub provider separates integration merge from accepted-branch promotion', async () => {
  const headSha = 'a'.repeat(40);
  const integrationBaseSha = 'b'.repeat(40);
  const defaultBaseSha = 'c'.repeat(40);
  const mergeRequests: any[] = [];
  const provider = new GitHubRuntimeProvider({
    credentials: {
      async getIdentity() { return { kind: 'app' as const, appId: '12345' }; },
      async getCredential(repository: string) {
        return {
          token: 'installation-token',
          kind: 'app-installation' as const,
          identity: { kind: 'app' as const, appId: '12345', installationId: 42 },
          repository,
          permissions: { contents: 'write' },
        };
      },
    },
    allowedOwners: ['pyralisxc'],
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.endsWith('/pulls/12') && method === 'GET') return Response.json({
        number: 12, html_url: 'https://github.com/pyralisxc/CardForge/pull/12', state: 'open',
        draft: false, merged: false, head: { ref: 'work/cf-cleanup', sha: headSha },
        base: { ref: 'vercel-preview', sha: integrationBaseSha },
      });
      if (url.endsWith('/pulls/13') && method === 'GET') return Response.json({
        number: 13, html_url: 'https://github.com/pyralisxc/CardForge/pull/13', state: 'open',
        draft: false, merged: false, head: { ref: 'vercel-preview', sha: headSha },
        base: { ref: 'main', sha: defaultBaseSha },
      });
      if (url.endsWith('/pulls/14') && method === 'GET') return Response.json({
        number: 14, html_url: 'https://github.com/pyralisxc/CardForge/pull/14', state: 'open',
        draft: false, merged: false, head: { ref: 'main', sha: headSha },
        base: { ref: 'vercel-preview', sha: integrationBaseSha },
      });
      if (/\/repos\/pyralisxc\/CardForge$/u.test(url) && method === 'GET') return Response.json({
        full_name: 'pyralisxc/CardForge', default_branch: 'main',
      });
      if (url.endsWith('/merge') && method === 'PUT') {
        mergeRequests.push(body);
        return Response.json({ merged: true, sha: 'd'.repeat(40), message: 'merged' });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    },
  });

  const integration = await provider.mergeIntegrationPullRequest({
    project: { id: 'pyralisxc/CardForge' },
    pullRequestNumber: 12,
    expectedHeadSha: headSha,
    expectedBaseSha: integrationBaseSha,
    mergeMethod: 'squash',
    idempotencyKey: 'merge:cf:12:integration',
  });
  assert.equal(integration.merged, true);
  assert.deepEqual(mergeRequests[0], { sha: headSha, merge_method: 'squash' });

  await assert.rejects(
    provider.mergeIntegrationPullRequest({
      project: { id: 'pyralisxc/CardForge' },
      pullRequestNumber: 13,
      expectedHeadSha: headSha,
      expectedBaseSha: defaultBaseSha,
      idempotencyKey: 'merge:cf:13:wrong-lane',
    }),
    (error: any) => error?.code === 'PERMISSION_DENIED' && /accepted\/default branch main/.test(error.message),
  );

  const reconciled = await provider.reconcilePreviewPullRequest({
    project: { id: 'pyralisxc/CardForge' },
    pullRequestNumber: 14,
    expectedHeadSha: headSha,
    expectedBaseSha: integrationBaseSha,
    idempotencyKey: 'merge:cf:14:reconcile-preview',
  });
  assert.equal(reconciled.merged, true);
  assert.deepEqual(mergeRequests[1], { sha: headSha, merge_method: 'merge' });

  await assert.rejects(
    provider.reconcilePreviewPullRequest({
      project: { id: 'pyralisxc/CardForge' },
      pullRequestNumber: 12,
      expectedHeadSha: headSha,
      expectedBaseSha: integrationBaseSha,
      idempotencyKey: 'merge:cf:12:wrong-reconcile-source',
    }),
    (error: any) => error?.code === 'PERMISSION_DENIED' && /source must be repository default branch main/.test(error.message),
  );

  const promoted = await provider.promotePullRequest({
    project: { id: 'pyralisxc/CardForge' },
    pullRequestNumber: 13,
    expectedHeadSha: headSha,
    expectedBaseSha: defaultBaseSha,
    approvalReference: 'owner approved exact candidate in interactive session',
    idempotencyKey: 'merge:cf:13:promotion',
  });
  assert.equal(promoted.merged, true);
  assert.match(promoted.approvalReference, /owner approved/);

  await assert.rejects(
    provider.promotePullRequest({
      project: { id: 'pyralisxc/CardForge' },
      pullRequestNumber: 13,
      expectedHeadSha: 'e'.repeat(40),
      expectedBaseSha: defaultBaseSha,
      approvalReference: 'owner approved',
      idempotencyKey: 'merge:cf:13:stale',
    }),
    (error: any) => error?.code === 'CONFLICT' && /head changed/.test(error.message),
  );
});

test('workspace provider verifies an allowlisted workspace, shell, and test script', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'conductor-workspace-'));
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    scripts: { test: 'node --test' },
  }));
  const provider = new WorkspaceRuntimeProvider({
    projects: [{ id: 'fixture', workspace }],
  });

  const checks = await provider.preflightProject({ id: 'fixture' });
  assert.deepEqual(checks.map((check) => check.status), ['ready', 'ready', 'ready']);
});

test('runtime binding configuration is strict and rejects duplicate identities', () => {
  assert.deepEqual(parseRuntimeBindings('[{"id":"conductor","repository":"pyralisxc/Conductor"}]'), [{
    id: 'conductor',
    repository: 'pyralisxc/Conductor',
    workspace: undefined,
    githubWrite: undefined,
  }]);
  assert.deepEqual(parseOwners('pyralisxc,PYRALISXC'), ['pyralisxc']);
  assert.throws(
    () => parseRuntimeBindings('[{"id":"same"},{"id":"same"}]'),
    /Duplicate runtime binding id/,
  );
});

test('Development Intelligence provider verifies MCP discovery and project status with its machine token', async () => {
  const requests: Array<{ authorization: string | null; body: any }> = [];
  const provider = new DevelopmentIntelligenceProvider({
    endpoint: 'https://devint.example.com/mcp',
    token: 'machine-token',
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push({
        authorization: new Headers(init?.headers).get('authorization'),
        body,
      });
      if (body.method === 'tools/list') {
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'project_status' }] } });
      }
      return Response.json({
        jsonrpc: '2.0', id: body.id,
        result: {
          structuredContent: {
            project: 'pyralisxc/CardForge',
            upstreamSha: 'abc',
            graph: { revision: 'abc' },
          },
        },
      });
    },
  });

  assert.equal((await provider.getCapabilities())[0]?.available, true);
  assert.equal((await provider.preflightProject({ id: 'cardforge', repository: 'pyralisxc/CardForge' }))[0]?.status, 'ready');
  assert.equal(requests.every((request) => request.authorization === 'Bearer machine-token'), true);
  assert.equal(requests[1]?.body.params.arguments.project, 'pyralisxc/CardForge');
});

test('Development Intelligence preflight fails closed when project source or graph is unavailable', async () => {
  const statuses = [
    {
      upstreamSha: null,
      upstreamError: 'git failed: HTTP 403: Write access to repository not granted',
      graph: null,
      graphError: 'git failed: HTTP 403: Write access to repository not granted',
    },
    {
      upstreamSha: 'abc',
      upstreamError: null,
      graph: null,
      graphError: 'analyzer failed to build the project graph',
    },
  ];

  const provider = new DevelopmentIntelligenceProvider({
    endpoint: 'https://devint.example.com/mcp',
    token: 'machine-token',
    fetch: async () => Response.json({
      jsonrpc: '2.0',
      id: 'conductor',
      result: { structuredContent: statuses.shift() },
    }),
  });

  const denied = (await provider.preflightProject({
    id: 'development-os',
    repository: 'pyralisxc/Development-OS',
  }))[0];
  assert.equal(denied?.status, 'blocked');
  assert.equal(denied?.error?.code, 'PERMISSION_DENIED');
  assert.match(denied?.summary ?? '', /cannot read pyralisxc\/Development-OS/);

  const failedGraph = (await provider.preflightProject({
    id: 'development-os',
    repository: 'pyralisxc/Development-OS',
  }))[0];
  assert.equal(failedGraph?.status, 'unavailable');
  assert.equal(failedGraph?.error?.code, 'COMMAND_FAILED');
  assert.match(failedGraph?.summary ?? '', /cannot inspect pyralisxc\/Development-OS/);
});

test('unconfigured Development Intelligence is explicit and read-only', async () => {
  const provider = new UnavailableDevelopmentIntelligenceProvider();
  const capabilities = await provider.getCapabilities();
  assert.deepEqual(capabilities.map((capability) => [
    capability.capability,
    capability.available,
    capability.access,
  ]), [['development-intelligence.read', false, 'read']]);
  const checks = await provider.preflightProject({ id: 'conductor' });
  assert.equal(checks[0]?.error?.code, 'TOOL_UNAVAILABLE');
});






