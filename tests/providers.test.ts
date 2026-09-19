import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GitHubRuntimeProvider,
  UnavailableDevelopmentIntelligenceProvider,
  WorkspaceRuntimeProvider,
  parseProjects,
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
  }]);
  assert.throws(
    () => parseProjects('[{"id":"same"},{"id":"same"}]'),
    /Duplicate project id/,
  );
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
