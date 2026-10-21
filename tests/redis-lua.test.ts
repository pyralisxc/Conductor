import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { disposableRedis } from './helpers/disposable-redis.js';
import { RedisOAuthGrantStore, GRANT_TRANSITION_SCRIPT, oauthGrantKey, requireOAuthGrant } from '../src/transport/oauth-grant-store.js';
import { RedisPrEventStore, type PrEventState } from '../src/runtime/pr-events.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const identity = (clientId: string) => ({ issuer: 'https://local-test.example', subject: 'owner', clientId });
test('production OAuth/event Lua against disposable Redis (Docker required; never skipped)', { timeout: 180000 }, async t => {
  const redis = await disposableRedis(); t.after(() => redis.close());
  t.diagnostic(String(await redis.command(['EVAL', "return redis.call('INFO', 'server')", 0])).match(/redis_version:[^\r\n]+/)![0]);
  const grants = new RedisOAuthGrantStore(redis.client);
  const expiry = () => Date.now() + 60000;
  const state = (owner: ReturnType<typeof identity>, generation: string): PrEventState => ({ deliveries: [], subscription: {
    id: 'test-subscription', owner, generation, url: 'https://unused.example/callback', secret: 'unused', expiresAt: expiry(), verifiedUntil: expiry(),
  } });

  await t.test('concurrent consent and revoke fence both commit orderings', async () => {
    for (const heldStatus of ['active', 'revoked']) {
      const owner = identity(`race-${heldStatus}`); const initial = await grants.consent(owner, ['conductor.read'], expiry());
      const entered = deferred(); const release = deferred();
      redis.before(async args => {
        if (String(args[0]).toLowerCase() === 'eval' && args[1] === GRANT_TRANSITION_SCRIPT && JSON.parse(String(args[6])).status === heldStatus) {
          redis.before(); entered.resolve(); await release.promise;
        }
      });
      const held = heldStatus === 'active' ? grants.consent(owner, ['conductor.read'], expiry()) : grants.revoke(owner, initial.generation);
      const rejected = assert.rejects(held, /changed/);
      await entered.promise;
      try {
        if (heldStatus === 'active') await grants.revoke(owner, initial.generation);
        else await grants.consent(owner, ['conductor.read'], expiry());
      } finally { release.resolve(); }
      await rejected;
      const current = await grants.read(owner);
      assert.equal(current?.status, heldStatus === 'active' ? 'revoked' : 'active');
      assert.notEqual(current?.generation, initial.generation);
    }
  });

  await t.test('real cjson round trip, durable counter and stale grant CAS rejection', async () => {
    const owner = identity('cas'); const grant = await grants.consent(owner, ['conductor.read'], expiry());
    const key = oauthGrantKey(owner); const raw = await redis.client.get<string>(key);
    assert.deepEqual(await grants.read(owner), grant);
    await redis.command(['PEXPIRE', `${key}:generation`, 60000]);
    await grants.revoke(owner, grant.generation);
    assert.equal(await redis.command(['PTTL', key]), -1);
    assert.equal(await redis.command(['PTTL', `${key}:generation`]), -1);
    const revoked = await redis.client.get(key);
    assert.equal(await redis.client.eval(GRANT_TRANSITION_SCRIPT, [key, `${key}:generation`], [raw!, JSON.stringify(grant), randomUUID()]), null);
    assert.equal(await redis.client.get(key), revoked);
  });

  await t.test('missing and reset generation counters reject without changing grant', async () => {
    for (const counter of [null, '0']) {
      const owner = identity(`counter-${counter}`); await grants.consent(owner, ['conductor.read'], expiry());
      const key = oauthGrantKey(owner); const raw = await redis.client.get(key);
      if (counter === null) await redis.command(['DEL', `${key}:generation`]);
      else await redis.command(['SET', `${key}:generation`, counter]);
      await assert.rejects(grants.consent(owner, ['conductor.read'], expiry()), /counter missing or reset/);
      assert.equal(await redis.client.get(key), raw);
    }
  });

  await t.test('Redis TIME rejects expired grant issuance and event persistence despite a stale application clock', async () => {
    const time = await redis.command(['TIME']) as string[];
    const serverNow = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
    const owner = identity('server-time'); const grant = await grants.consent(owner, ['conductor.read'], expiry());
    const events = new RedisPrEventStore(redis.client, 'test:server-time');
    const expired = state(owner, grant.generation); expired.subscription!.expiresAt = serverNow - 1000;
    t.mock.method(Date, 'now', () => serverNow - 10000);
    try {
      await assert.rejects(grants.consent(identity('expired-issuance'), ['conductor.read'], serverNow - 1000), /expired before write/);
      assert.equal(await events.save(null, expired), false);
      expired.subscription!.expiresAt = serverNow + 60000;
      await redis.command(['SET', oauthGrantKey(owner), JSON.stringify({ ...grant, expiresAt: serverNow - 1000 })]);
      assert.equal(await events.save(null, expired), false);
      assert.equal((await events.load()).version, null);
    } finally { t.mock.restoreAll(); }
  });

  await t.test('revocation after authorization blocks event persistence and stale writes after cancellation', async () => {
    const owner = identity('event-revoke'); const grant = await grants.consent(owner, ['conductor.read'], expiry());
    const events = new RedisPrEventStore(redis.client, 'test:event-revoke'); const active = state(owner, grant.generation);
    assert.equal(await events.save(null, active), true);
    const snapshot = await events.load();
    await requireOAuthGrant(grants, owner, grant.generation);
    await grants.revoke(owner, grant.generation);
    assert.equal(await events.save(snapshot.version, active), false);
    assert.equal(await events.save(snapshot.version, { deliveries: [] }), true);
    const cancelled = await events.load();
    assert.equal(await events.save(snapshot.version, active), false);
    assert.equal(await events.save(cancelled.version, active), false);
    assert.equal((await events.load()).state.subscription, undefined);
  });

  await t.test('stale event-state CAS cannot overwrite a newer active state', async () => {
    const owner = identity('event-cas'); const grant = await grants.consent(owner, ['conductor.read'], expiry());
    const events = new RedisPrEventStore(redis.client, 'test:event-cas'); const active = state(owner, grant.generation);
    assert.equal(await events.save(null, active), true); const first = await events.load();
    const newer = { ...active, baseline: 'newer' }; assert.equal(await events.save(first.version, newer), true);
    assert.equal(await events.save(first.version, active), false);
    assert.equal((await events.load()).state.baseline, 'newer');
  });
});
