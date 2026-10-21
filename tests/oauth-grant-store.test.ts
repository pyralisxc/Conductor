import type { Redis } from '@upstash/redis';
import { RedisPrEventStore, type PrEventState } from '../src/runtime/pr-events.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { GrantRedisFixture } from './helpers/oauth-grants.js';
import { oauthGrantKey, requireOAuthGrant, GRANT_TRANSITION_SCRIPT } from '../src/transport/oauth-grant-store.js';

const identity = { issuer: 'https://issuer.example', subject: 'owner', clientId: 'client' };
test('grant CAS rejects concurrent revocation rather than retrying an earlier consent into reactivation', async () => {
  const redis = new GrantRedisFixture(); const store = redis.store();
  await store.consent(identity, ['conductor.read'], Date.now() + 60000);
  redis.beforeEval = () => {
    redis.beforeEval = undefined;
    const key = oauthGrantKey(identity); const current = JSON.parse(redis.values.get(key)!);
    current.status = 'revoked'; current.reason = 'client-revoked';
    redis.values.set(key, JSON.stringify(current));
  };
  await assert.rejects(store.consent(identity, ['conductor.read'], Date.now() + 60000), /changed/);
  assert.equal((await store.read(identity))?.status, 'revoked');
});

test('canonical tuple and normalized scopes are distinct; corrupt records and reset counters fail closed', async () => {
  const redis = new GrantRedisFixture(); const store = redis.store();
  const grant = await store.consent(identity, ['offline_access', 'conductor.read', 'conductor.read'], Date.now() + 60000);
  assert.deepEqual(grant.scopes, ['conductor.read', 'offline_access']);
  assert.equal(oauthGrantKey(identity), oauthGrantKey({ clientId: 'client', subject: 'owner', issuer: 'https://issuer.example' }));
  for (const other of [{ ...identity, clientId: 'other' }, { ...identity, subject: 'other' }, { ...identity, issuer: 'https://other.example' }]) await assert.rejects(requireOAuthGrant(store, other, grant.generation));
  redis.values.delete(`${oauthGrantKey(identity)}:generation`);
  await assert.rejects(store.consent(identity, ['conductor.read'], Date.now() + 60000), /counter/);
  redis.values.set(oauthGrantKey(identity), 'not JSON');
  await assert.rejects(store.read(identity));
  await assert.rejects(store.consent(identity, ['conductor.read'], Date.now() + 60000));
  // The real Lua transition keeps both record and counter without automatic TTL.
  assert.ok(!GRANT_TRANSITION_SCRIPT.includes('PXAT'));
  assert.ok(GRANT_TRANSITION_SCRIPT.includes("redis.call('PERSIST', KEYS[2])"));
});


test('event Redis CAS cannot restore a subscription when revocation commits after the final read', async () => {
  const redis = new GrantRedisFixture(); const grants = redis.store();
  const grant = await grants.consent(identity, ['conductor.read'], Date.now() + 60000);
  const store = new RedisPrEventStore(redis as unknown as Redis, 'test:event');
  const state: PrEventState = { deliveries: [], subscription: { id: 'sub-test', owner: identity, generation: grant.generation, url: 'https://receiver.example/callback', secret: 'encrypted-test-placeholder', expiresAt: Date.now() + 60000, verifiedUntil: Date.now() + 10000 } };
  assert.equal(await store.save(null, state), true);
  const snapshot = await store.load();
  // A final successful check is deliberately stale by the time the write executes.
  await requireOAuthGrant(grants, identity, grant.generation);
  await grants.revoke(identity, grant.generation);
  assert.equal(await store.save(snapshot.version, state), false);
  const stopped: PrEventState = { deliveries: [] };
  assert.equal(await store.save(snapshot.version, stopped), true);
  const tombstone = await store.load();
  assert.equal(await store.save(tombstone.version, state), false);
  assert.equal((await store.load()).state.subscription, undefined);
});

test('grant expiry is checked after the authority read completes', async () => {
  const redis = new GrantRedisFixture(); const store = redis.store();
  const grant = await store.consent(identity, ['conductor.read'], Date.now() + 60000);
  let clock = grant.expiresAt - 1;
  const delayed = { ...store, read: async () => { clock = grant.expiresAt; return grant; }, consent: store.consent.bind(store), revoke: store.revoke.bind(store) };
  await assert.rejects(requireOAuthGrant(delayed, identity, grant.generation, ['conductor.read'], () => clock), /inactive/);
});
