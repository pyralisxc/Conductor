import test from 'node:test';
import assert from 'node:assert/strict';
import { clientFingerprint, parseWorkScopeGrant, WorkScopeAuthorizer, type WorkScopeGrant, type WorkScopeStore } from '../src/transport/work-scope.js';

process.env.CONDUCTOR_SESSION_SECRET = 'test-work-context-secret-long-enough-for-hmac';

function fixture() {
  const grants = new Map<string, WorkScopeGrant>();
  const store: WorkScopeStore = {
    async get(id) { const grant = grants.get(id); return grant && grant.expiresAt > Date.now() ? grant : null; },
    async set(id, grant) { grants.set(id, grant); },
    async delete(id) { grants.delete(id); },
  };
  const authorizer = new WorkScopeAuthorizer(store);
  const auth = { clientId: 'owner-approved-client', scopes: ['conductor.read', 'conductor.write'], token: 'test' };
  return { grants, store, authorizer, auth };
}

test('the default client may route issues broadly but work only in its primary repository', async () => {
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
