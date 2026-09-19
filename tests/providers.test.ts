import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GitHubRuntimeProvider,
  DevelopmentIntelligenceProvider,
  UnavailableDevelopmentIntelligenceProvider,
  WorkspaceRuntimeProvider,
  parseProjects,
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
  assert.equal(checks.every((check) => check.status === 'ready'), true);
  assert.match(requested[0] ?? '', /repos\/pyralisxc\/CardForge$/);

  const rejected = await provider.preflightProject({ id: 'attacker/CardForge' });
  assert.equal(rejected[0]?.error?.code, 'NOT_FOUND');
  assert.equal(requested.length, 1);
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

test('project configuration is strict and rejects duplicate identities', () => {
  assert.deepEqual(parseProjects('[{"id":"conductor","repository":"pyralisxc/Conductor"}]'), [{
    id: 'conductor',
    repository: 'pyralisxc/Conductor',
    workspace: undefined,
    githubWrite: undefined,
  }]);
  assert.deepEqual(parseOwners('pyralisxc,PYRALISXC'), ['pyralisxc']);
  assert.throws(
    () => parseProjects('[{"id":"same"},{"id":"same"}]'),
    /Duplicate project id/,
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
