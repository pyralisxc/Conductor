import test from 'node:test';
import assert from 'node:assert/strict';
import { clientFingerprint, issueBootstrapEvidence, issueLifecycleGate, issueWorkScopeApprovalGate, parseWorkScopeGrant, verifyBootstrapEvidence, verifyLifecycleGate, verifyWorkScopeApprovalGate, WorkScopeAuthorizer, type ContextWorkScopeGrant, type WorkScopeGrant, type WorkScopeStore } from '../src/transport/work-scope.js';

process.env.CONDUCTOR_SESSION_SECRET = 'test-work-context-secret-long-enough-for-hmac';

function fixture() {
  const grants = new Map<string, WorkScopeGrant>();
  const contextGrants = new Map<string, ContextWorkScopeGrant>();
  const store: WorkScopeStore = {
    async get(id) { const grant = grants.get(id); return grant && grant.expiresAt > Date.now() ? grant : null; },
    async set(id, grant) { grants.set(id, grant); },
    async delete(id) { grants.delete(id); },
    async getContext(id) { const grant = contextGrants.get(id); return grant && grant.expiresAt > Date.now() ? grant : null; },
    async setContext(id, grant) { contextGrants.set(id, grant); },
    async deleteContext(id) { contextGrants.delete(id); },
  };
  const authorizer = new WorkScopeAuthorizer(store);
  const auth = { clientId: 'owner-approved-client', scopes: ['conductor.read', 'conductor.write'], token: 'test' };
  return { grants, contextGrants, store, authorizer, auth };
}

test('a declared repository permits its code work while issue routing remains broad', async () => {
  const { authorizer, auth } = fixture();
  const { workContext } = authorizer.begin(auth.clientId, 'pyralisxc/Conductor');
  await authorizer.assertAllowed(auth, 'develop', { id: 'conductor', repository: 'pyralisxc/Conductor' }, workContext);
  await authorizer.assertAllowed(auth, 'route-work', { id: 'conductor', repository: 'pyralisxc/Conductor' });
  await authorizer.assertAllowed(auth, 'route-work', { id: 'other', repository: 'pyralisxc/Other' });
  await assert.rejects(authorizer.assertAllowed(auth, 'develop', { id: 'other', repository: 'pyralisxc/Other' }, workContext), /outside/);
  await assert.rejects(authorizer.assertAllowed(auth, 'develop', { id: 'conductor', repository: 'pyralisxc/Conductor' }), /Begin a work context/);
  await assert.rejects(authorizer.assertAllowed(undefined, 'develop', { id: 'conductor', repository: 'pyralisxc/Conductor' }), /identity/);
  await assert.rejects(authorizer.assertAllowed(undefined, 'route-work', { id: 'other', repository: 'pyralisxc/Other' }), /identity/);
  await assert.rejects(authorizer.assertAllowed(auth, 'route-work', { id: 'invalid' }), /exact/);
});

test('owner grant separates routing from development and is bound to one client', async () => {
  const { store, authorizer, auth } = fixture();
  const { workContext } = authorizer.begin(auth.clientId, 'pyralisxc/Conductor');
  const id = clientFingerprint(auth.clientId);
  await store.set(id, parseWorkScopeGrant({
    primaryRepository: 'pyralisxc/Conductor',
    developRepositories: ['pyralisxc/Construction'],
    expiresAt: Date.now() + 60_000,
  }));
  await authorizer.assertAllowed(auth, 'route-work', { id: 'Development-OS', repository: 'pyralisxc/Development-OS' });
  await assert.rejects(authorizer.assertAllowed(auth, 'develop', { id: 'Development-OS', repository: 'pyralisxc/Development-OS' }, workContext), /outside/);
  await authorizer.assertAllowed(auth, 'develop', { id: 'Construction', repository: 'pyralisxc/Construction' }, workContext);
  await assert.rejects(authorizer.assertAllowed({ ...auth, clientId: 'another-client' }, 'develop', { id: 'Construction', repository: 'pyralisxc/Construction' }, workContext), /mismatched/);
  await store.delete(id);
  await assert.rejects(authorizer.assertAllowed(auth, 'develop', { id: 'Construction', repository: 'pyralisxc/Construction' }, workContext), /outside/);
});

test('expired and malformed grants fail closed', async () => {
  assert.throws(() => parseWorkScopeGrant({ primaryRepository: 'pyralisxc/Conductor', expiresAt: Date.now() - 1 }), /expire/);
  assert.throws(() => parseWorkScopeGrant({ primaryRepository: 'not-a-repository', expiresAt: Date.now() + 60_000 }), /exact/);
  const { grants, authorizer, auth } = fixture();
  const { workContext } = authorizer.begin(auth.clientId, 'pyralisxc/Conductor');
  grants.set(clientFingerprint(auth.clientId), { primaryRepository: 'pyralisxc/Conductor', developRepositories: [], expiresAt: Date.now() - 1 });
  await assert.rejects(authorizer.assertAllowed(auth, 'develop', { id: 'other', repository: 'pyralisxc/Other' }, workContext), /outside/);
});

test('two fresh conversations sharing one OAuth client keep independent active repositories', async () => {
  const { authorizer, auth } = fixture();
  const a = authorizer.begin(auth.clientId, 'pyralisxc/Construction').workContext;
  const b = authorizer.begin(auth.clientId, 'pyralisxc/Arcanum').workContext;
  await authorizer.assertAllowed(auth, 'develop', { id: 'construction', repository: 'pyralisxc/Construction' }, a);
  await authorizer.assertAllowed(auth, 'develop', { id: 'arcanum', repository: 'pyralisxc/Arcanum' }, b);
  await assert.rejects(authorizer.assertAllowed(auth, 'develop', { id: 'arcanum', repository: 'pyralisxc/Arcanum' }, a), /outside/);
  await assert.rejects(authorizer.assertAllowed(auth, 'develop', { id: 'construction', repository: 'pyralisxc/Construction' }, b), /outside/);
  await assert.rejects(authorizer.assertAllowed(auth, 'develop', { id: 'construction', repository: 'pyralisxc/Construction' }, `${a}x`), /Invalid work context/);
});


test('bootstrap evidence is short-lived, client-bound, repository-bound and credential-free', () => {
  const issued = issueBootstrapEvidence('owner-approved-client', {
    repository: 'pyralisxc/Conductor',
    projectId: 'Conductor',
    catalogDigest: 'a'.repeat(64),
    observedAt: '2026-09-27T00:00:00.000Z',
    vercel: {
      provider: 'vercel',
      projectId: 'prj_conductor',
      teamId: 'team_owner',
      repository: 'pyralisxc/Conductor',
      projectName: 'conductor',
      productionBranch: 'main',
      productionDeploymentId: 'dpl_production',
      observedAt: '2026-09-27T00:00:00.000Z',
    },
  });
  const value = verifyBootstrapEvidence(issued.handle, 'owner-approved-client', {
    repository: 'pyralisxc/Conductor',
    projectId: 'Conductor',
    catalogDigest: 'a'.repeat(64),
  });
  assert.equal(value.repository, 'pyralisxc/conductor');
  assert.equal(value.projectId, 'Conductor');
  assert.equal(value.vercel?.projectId, 'prj_conductor');
  assert.equal(value.vercel?.repository, 'pyralisxc/conductor');
  assert.doesNotMatch(issued.handle, /token|secret|credential/iu);
  assert.throws(() => verifyBootstrapEvidence(issued.handle, 'different-client'), /mismatched/);
  assert.throws(() => verifyBootstrapEvidence(issued.handle, 'owner-approved-client', { repository: 'pyralisxc/Other' }), /repository mismatch/);
});

test('lifecycle gates are client/repository/issue bound and carry exact continuation identity', () => {
  const issued = issueLifecycleGate('owner-client', {
    repository: 'pyralisxc/Conductor', projectId: 'Conductor',
    gate: { kind: 'human-approval', allowedNextOperation: 'lifecycle.resume', issueNumber: 169, summary: 'Ready for Main', resumeWhen: 'Owner approves exact candidate', pullRequestNumber: 200, expectedHeadSha: 'a'.repeat(40), expectedBaseSha: 'b'.repeat(40) },
  });
  const value = verifyLifecycleGate(issued.handle, 'owner-client', { repository: 'pyralisxc/Conductor', projectId: 'Conductor', issueNumber: 169, kind: 'human-approval', allowedNextOperation: 'lifecycle.resume' });
  assert.equal(value.id, issued.gateId);
  assert.equal(value.pullRequestNumber, 200);
  assert.throws(() => verifyLifecycleGate(issued.handle, 'other-client', { repository: 'pyralisxc/Conductor', projectId: 'Conductor' }), /mismatched/);
});


test('chat-native additional repository approval is exact-context-bound and does not change routing semantics', async () => {
  const { authorizer, auth } = fixture();
  const first = authorizer.begin(auth.clientId, 'pyralisxc/CardForge').workContext;
  const second = authorizer.begin(auth.clientId, 'pyralisxc/Conductor').workContext;
  const issued = issueWorkScopeApprovalGate(auth.clientId, {
    workContext: first,
    developRepositories: ['pyralisxc/Development-Intelligence'],
    durationMinutes: 60,
  });
  assert.equal(issued.gate.primaryRepository, 'pyralisxc/cardforge');
  assert.deepEqual(issued.gate.developRepositories, ['pyralisxc/development-intelligence']);
  assert.match(issued.gate.protectedConcern, /silently expand/iu);
  const gate = verifyWorkScopeApprovalGate(issued.handle, auth.clientId, first);
  const grant = await authorizer.approveAdditionalScope(auth.clientId, first, gate);
  assert.deepEqual(grant.developRepositories, ['pyralisxc/development-intelligence']);

  await authorizer.assertAllowed(auth, 'develop', { id: 'di', repository: 'pyralisxc/Development-Intelligence' }, first);
  await assert.rejects(
    authorizer.assertAllowed(auth, 'develop', { id: 'di', repository: 'pyralisxc/Development-Intelligence' }, second),
    /outside/,
  );
  await authorizer.assertAllowed(auth, 'route-work', { id: 'other', repository: 'pyralisxc/Other' });
  assert.throws(() => verifyWorkScopeApprovalGate(issued.handle, 'different-client', first), /mismatched|Invalid/);
});
