import test from 'node:test';
import assert from 'node:assert/strict';
import { clientFingerprint, parseWorkScopeGrant, WorkScopeAuthorizer, type WorkScopeGrant, type WorkScopeStore } from '../src/transport/work-scope.js';

function fixture() {
  const grants = new Map<string, WorkScopeGrant>();
  const store: WorkScopeStore = {
    async get(id) { const grant = grants.get(id); return grant && grant.expiresAt > Date.now() ? grant : null; },
    async set(id, grant) { grants.set(id, grant); },
    async delete(id) { grants.delete(id); },
  };
  const authorizer = new WorkScopeAuthorizer(store, 'pyralisxc/Conductor');
  const auth = { clientId: 'owner-approved-client', scopes: ['conductor.read', 'conductor.write'], token: 'test' };
  return { grants, store, authorizer, auth };
}

test('the default client may route issues broadly but work only in its primary repository', async () => {
  const { authorizer, auth } = fixture();
  await authorizer.assertAllowed(auth, 'develop', { id: 'conductor', repository: 'pyralisxc/Conductor' });
  await authorizer.assertAllowed(auth, 'route-work', { id: 'conductor', repository: 'pyralisxc/Conductor' });
  await authorizer.assertAllowed(auth, 'route-work', { id: 'other', repository: 'pyralisxc/Other' });
  await assert.rejects(authorizer.assertAllowed(auth, 'develop', { id: 'other', repository: 'pyralisxc/Other' }), /outside/);
  await assert.rejects(authorizer.assertAllowed(undefined, 'develop', { id: 'conductor', repository: 'pyralisxc/Conductor' }), /identity/);
  await assert.rejects(authorizer.assertAllowed(undefined, 'route-work', { id: 'other', repository: 'pyralisxc/Other' }), /identity/);
  await assert.rejects(authorizer.assertAllowed(auth, 'route-work', { id: 'invalid' }), /exact/);
});

test('owner grant separates routing from development and is bound to one client', async () => {
  const { store, authorizer, auth } = fixture();
  const id = clientFingerprint(auth.clientId);
  await store.set(id, parseWorkScopeGrant({
    primaryRepository: 'pyralisxc/Conductor',
    developRepositories: ['pyralisxc/Construction'],
    expiresAt: Date.now() + 60_000,
  }));
  await authorizer.assertAllowed(auth, 'route-work', { id: 'Development-OS', repository: 'pyralisxc/Development-OS' });
  await assert.rejects(authorizer.assertAllowed(auth, 'develop', { id: 'Development-OS', repository: 'pyralisxc/Development-OS' }), /outside/);
  await authorizer.assertAllowed(auth, 'develop', { id: 'Construction', repository: 'pyralisxc/Construction' });
  await assert.rejects(authorizer.assertAllowed({ ...auth, clientId: 'another-client' }, 'develop', { id: 'Construction', repository: 'pyralisxc/Construction' }), /outside/);
  await store.delete(id);
  await assert.rejects(authorizer.assertAllowed(auth, 'develop', { id: 'Construction', repository: 'pyralisxc/Construction' }), /outside/);
});

test('expired and malformed grants fail closed', async () => {
  assert.throws(() => parseWorkScopeGrant({ primaryRepository: 'pyralisxc/Conductor', expiresAt: Date.now() - 1 }), /expire/);
  assert.throws(() => parseWorkScopeGrant({ primaryRepository: 'not-a-repository', expiresAt: Date.now() + 60_000 }), /exact/);
  const { grants, authorizer, auth } = fixture();
  grants.set(clientFingerprint(auth.clientId), { primaryRepository: 'pyralisxc/Conductor', developRepositories: [], expiresAt: Date.now() - 1 });
  await assert.rejects(authorizer.assertAllowed(auth, 'develop', { id: 'other', repository: 'pyralisxc/Other' }), /outside/);
});
