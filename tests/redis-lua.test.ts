import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { disposableRedis } from './helpers/disposable-redis.js';
import { RedisOAuthGrantStore, GRANT_TRANSITION_SCRIPT, oauthGrantKey, requireOAuthGrant } from '../src/transport/oauth-grant-store.js';
import { VersionedProviderCredentialVault } from '../src/connections/universal/credential-vault.js';
import type { PullRequestStatus } from '../src/runtime/types.js';
import { PrEvents, RedisPrEventStore, type PrEventState } from '../src/runtime/pr-events.js';

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
  await t.test('delegated pending/challenge/active serialization retains CAS and current-grant fences', async () => {
    const owner = identity('delegated'); const grant = await grants.consent(owner, ['conductor.read'], expiry());
    const events = new RedisPrEventStore(redis.client, 'test:delegated'); const pending = state(owner, grant.generation);
    pending.subscription!.binding = { id: randomUUID(), approvalId: randomUUID(), phase: 'pending', fingerprint: 'a'.repeat(64),
      target: { repository: 'owner/repo', pullRequestNumber: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) } };
    assert.equal(await events.save(null, pending), true);
    const first = await events.load(); first.state.subscription!.binding!.phase = 'challenging';
    first.state.subscription!.binding!.attemptId = randomUUID();
    first.state.usedBindingAttempts = [first.state.subscription!.binding!.attemptId!];
    assert.equal(await events.save(first.version, first.state), true);
    assert.equal(await events.save(first.version, pending), false);
    const claim = await events.load(); assert.equal(claim.state.usedBindingAttempts!.length, 1);
    await grants.revoke(owner, grant.generation);
    claim.state.subscription!.binding!.phase = 'active';
    assert.equal(await events.save(claim.version, claim.state), false);
    assert.equal((await events.load()).state.subscription!.binding!.phase, 'challenging');
  });

  await t.test('consumed approval marker is durable and missing authority cannot be reconstructed', async () => {
    const owner = identity('approval-marker'); const grant = await grants.consent(owner, ['conductor.read'], expiry());
    const events = new RedisPrEventStore(redis.client, 'test:approval-marker'); const pending = state(owner, grant.generation);
    const approvalId = randomUUID();
    pending.subscription!.binding = { id: randomUUID(), approvalId, attemptId: randomUUID(), phase: 'pending', fingerprint: 'a'.repeat(64),
      target: { repository: 'owner/repo', pullRequestNumber: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) } };
    assert.equal(await events.save(null, pending), true);
    const marker = `conductor:preview:pr-events:approval:${approvalId}`;
    assert.equal(await redis.command(['PTTL', marker]), -1);
    const loaded = await events.load(); await redis.command(['DEL', marker]);
    loaded.state.subscription!.binding!.phase = 'challenging';
    assert.equal(await events.save(loaded.version, loaded.state), false);
    loaded.state.subscription!.binding!.phase = 'pending';
    assert.equal(await events.save(loaded.version, loaded.state), false);
    assert.equal(await redis.command(['GET', marker]), null);
  });

  await t.test('concurrent delegated subscribe and activation have one winner through production Lua', { timeout: 30000 }, async () => {
    const owner = identity('concurrent-delegated'); const grant = await grants.consent(owner, ['conductor.read'], expiry());
    const auth = { token: 'isolated-test', clientId: owner.clientId, scopes: ['conductor.read'], extra: { ...owner, grantGeneration: grant.generation } };
    const target = { repository: 'owner/repo', pullRequestNumber: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
    const key = 'test:concurrent-delegated';
    const store = new RedisPrEventStore(redis.client, key);
    const delivery = { url: 'https://unused.example/callback', secret: `whsec_${Buffer.alloc(32, 9).toString('base64')}` };
    const mode = { clientFingerprint: createHash('sha256').update(owner.clientId).digest('hex'), approval: { id: randomUUID(), expiresAt: expiry() } };
    const posts: string[][] = [[], []]; const reads = [0, 0];
    const makeCallers = () => posts.map((sent, caller) => new PrEvents({ target, owner: { issuer: owner.issuer, subject: owner.subject }, installationId: 123, delegatedRecipient: mode,
      webhookSecret: 'isolated-only', grants, store: new RedisPrEventStore(redis.client, key), validateRecipient: async () => {},
      vault: new VersionedProviderCredentialVault({ legacyPurpose: 'isolated', currentKey: 'isolated-vault-key'.repeat(3) }),
      source: { async read() { reads[caller]++; return { ...target, head: { sha: target.headSha }, base: { sha: target.baseSha, ref: 'preview' },
        state: 'open', merged: false, draft: false, checks: { total: 0, pending: 0, successful: 0, failed: 0, neutral: 0, skipped: 0 } } as unknown as PullRequestStatus; } },
      post: async (_url, body) => { sent.push(body); const data = JSON.parse(body); return { status: 200, body: JSON.stringify({ challenge: data.challenge }) }; },
    }));
    let callers = makeCallers();
    // Hold both actual EVAL requests at the adapter boundary, then let Redis arbitrate.
    // No modeled save result or modified production Lua is used.
    const race = async (phase: string) => {
      let arrivals = 0; const release = deferred();
      redis.before(async args => {
        if (String(args[0]).toLowerCase() !== 'eval' || args[3] !== key) return;
        const serialized = args[Number(args[2]) + 4];
        if (JSON.parse(String(serialized)).subscription?.binding?.phase !== phase) return;
        if (++arrivals === 2) release.resolve();
        await release.promise;
      });
      try {
        const results = await Promise.allSettled(callers.map(caller => caller.subscribe(auth, target, delivery)));
        assert.equal(arrivals, 2); return results;
      } finally { redis.before(); }
    };
    const created = await race('pending');
    assert.equal(created.filter(r => r.status === 'fulfilled').length, 1);
    let loser = created.findIndex(r => r.status === 'rejected');
    assert.match(String((created[loser] as PromiseRejectedResult).reason), /Pending binding changed/);
    assert.deepEqual(posts[loser], []); assert.equal(reads[loser], 0);
    assert.equal(posts.flat().length, 1); assert.equal(JSON.parse(posts.flat()[0]).type, 'verification');
    assert.equal((await store.load()).state.subscription!.binding!.phase, 'active');
    await callers[0].unsubscribe(auth, target, delivery.url);
    await assert.rejects(callers[0].subscribe(auth, target, delivery), /already consumed/);
    // Even loss of the bounded state record cannot reconsume this approved attempt.
    await redis.command(['DEL', key]);
    await assert.rejects(callers[0].subscribe(auth, target, delivery), /Pending binding changed/);
    assert.equal(posts.flat().length, 1);

    mode.approval = { id: randomUUID(), expiresAt: expiry() };
    // Interrupt after the real pending EVAL commits, before any challenge claim.
    redis.before(async args => {
      if (String(args[0]).toLowerCase() === 'get' && args[1] === key && (await redis.command(['GET', key]))) {
        redis.before(); throw new Error('isolated restart after pending');
      }
    });
    await assert.rejects(callers[0].subscribe(auth, target, delivery), /isolated restart/);
    const binding = (await store.load()).state.subscription!.binding!;
    assert.equal(binding.phase, 'pending');
    posts.forEach(p => p.length = 0); reads.fill(0); callers = makeCallers();
    const activated = await race('challenging');
    assert.equal(activated.filter(r => r.status === 'fulfilled').length, 1);
    loser = activated.findIndex(r => r.status === 'rejected'); assert.notEqual(loser, -1);
    assert.match(String((activated[loser] as PromiseRejectedResult).reason), /Challenge claim changed/);
    assert.deepEqual(posts[loser], []); assert.equal(reads[loser], 0);
    assert.equal(posts.flat().length, 1); assert.equal(JSON.parse(posts.flat()[0]).type, 'verification');
    const active = (await store.load()).state;
    assert.equal(active.subscription!.binding!.id, binding.id); assert.equal(active.subscription!.binding!.phase, 'active');
    assert.deepEqual(active.usedBindingAttempts, [mode.approval.id]);
    assert.equal(active.deliveries.length, 0);
    await callers[0].unsubscribe(auth, target, delivery.url);
    mode.approval = { id: randomUUID(), expiresAt: expiry() };
    redis.before(async args => {
      if (String(args[0]).toLowerCase() === 'get' && args[1] === key) {
        const raw = await redis.command(['GET', key]);
        if (raw && JSON.parse(String(raw)).subscription?.binding?.phase === 'pending') { redis.before(); throw new Error('isolated restart'); }
      }
    });
    await assert.rejects(callers[0].subscribe(auth, target, delivery), /isolated restart/);
    const obsolete = (await store.load()).state.subscription!.binding!.id;
    await grants.revoke(owner, grant.generation);
    await assert.rejects(callers[0].unsubscribe(auth, target, delivery.url));
    const freshGrant = await grants.consent(owner, ['conductor.read'], expiry());
    const freshAuth = { ...auth, extra: { ...auth.extra, grantGeneration: freshGrant.generation } };
    await assert.rejects(callers[0].subscribe(freshAuth, target, delivery), /teardown/);
    await callers[0].unsubscribe(freshAuth, target, delivery.url);
    await assert.rejects(callers[0].subscribe(freshAuth, target, delivery), /already consumed/);
    mode.approval = { id: randomUUID(), expiresAt: expiry() };
    await callers[0].subscribe(freshAuth, target, delivery);
    assert.notEqual((await store.load()).state.subscription!.binding!.id, obsolete);
    assert.equal(posts.flat().length, 2);

  });

});
