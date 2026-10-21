import { GrantRedisFixture } from './helpers/oauth-grants.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { PrEvents, PR_EVENT, type PrEventState, type PrEventStore } from '../src/runtime/pr-events.js';
import { VersionedProviderCredentialVault } from '../src/connections/universal/credential-vault.js';
import { createConductorHttpHandler } from '../src/transport/http.js';
import { ConductorToolRuntime } from '../src/runtime/runtime.js';
import type { PullRequestStatus } from '../src/runtime/types.js';
import { publicCallbackAddress, callbackUrl, webhookSignature } from '../src/transport/event-callback.js';

// Persistent snapshot fake: restart and CAS behavior, not evidence of a live Redis service.
class SnapshotStore implements PrEventStore {
  raw: string | null = null;
  async load() { return { version: this.raw, state: this.raw ? JSON.parse(this.raw) as PrEventState : { deliveries: [] } }; }
  async save(version: string | null, state: PrEventState) { if (this.raw !== version) return false; this.raw = JSON.stringify(state); return true; }
}
const target = { repository: 'owner/repo', pullRequestNumber: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
const owner = { issuer: 'https://issuer.example', subject: 'service-principal', clientId: 'oauth-client' };
const auth = { token: 'test', clientId: owner.clientId, scopes: ['conductor.read'], extra: { issuer: owner.issuer, subject: owner.subject, grantGeneration: '1:00000000-0000-4000-8000-000000000001' } };
const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const delivery = { mode: 'webhook' as const, url: 'https://receiver.example/callback', secret };
function fixture() {
  let now = 1800000000000; let denied = false; let status = 204;
  let reads = 0;
  const pull = { repository: target.repository, pullRequestNumber: 7, head: { ref: 'work/7-test', sha: target.headSha }, base: { ref: 'preview', sha: target.baseSha }, state: 'open', merged: false, draft: false,
    checks: { total: 1, pending: 1, successful: 0, failed: 0, neutral: 0, skipped: 0, items: [] }, workflowRuns: [],
  } as unknown as PullRequestStatus;
  const posts: { body: string; headers: Record<string, string> }[] = [];
  const store = new SnapshotStore();
  const grantRedis = new GrantRedisFixture();
  grantRedis.seed(owner, auth.extra.grantGeneration, now + 3600000);
  const options = { grants: grantRedis.store(), target, owner, installationId: 123, callbackHostname: 'receiver.example', webhookSecret: 'local-only-webhook-secret', store,
    vault: new VersionedProviderCredentialVault({ legacyPurpose: 'test-events', currentKey: 'local-only-vault-key'.repeat(3) }), now: () => now,
    source: { async read() { reads++; if (denied) throw new Error('revoked'); return structuredClone(pull); } },
    post: async (_url: string, body: string, headers: Record<string, string>) => {
      posts.push({ body, headers }); const data = JSON.parse(body);
      return { status: data.type === 'verification' ? 200 : status, body: data.type === 'verification' ? JSON.stringify({ challenge: data.challenge }) : '' };
    },
  };
  const bridge = new PrEvents(options);
  const send = (id: string, patch: Record<string, unknown> = {}, event = 'check_run', instance = bridge) => {
    const body = Buffer.from(JSON.stringify({ action: 'completed', repository: { full_name: target.repository }, installation: { id: 123 }, check_run: { head_sha: target.headSha, pull_requests: [{ number: 7 }] }, ...patch }));
    return instance.ingest(body, event, id, `sha256=${createHmac('sha256', options.webhookSecret).update(body).digest('hex')}`);
  };
  return { bridge, options, pull, posts, store, send, grantRedis, reads: () => reads, deny: () => { denied = true; }, advance: (ms: number) => { now += ms; }, status: (value: number) => { status = value; } };
}

test('real HTTP protocol 2026-07-28 discovers and invokes authenticated event methods', async () => {
  const f = fixture();
  const handler = createConductorHttpHandler({ runtime: new ConductorToolRuntime(), publicUrl: 'http://127.0.0.1', oauthIssuer: owner.issuer, verifier: { async verifyAccessToken() { return auth; } }, events: f.bridge });
  const http = createServer((req, res) => { void handler(req, res); }); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const exchanges: { method: string; response: string }[] = [];
  const client = new Client({ name: 'protocol-proof', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer test' } }, fetch: async (input, init) => {
    const response = await fetch(input, init);
    exchanges.push({ method: typeof init?.body === 'string' ? JSON.parse(init.body).method : '', response: await response.clone().text() });
    return response;
  } });
  try {
    await client.connect(transport);
    const discovery = exchanges.find(e => e.method === 'server/discover'); assert.ok(discovery);
    assert.match(discovery.response, /2026-07-28/); assert.match(discovery.response, /"events":\{\}/);
    const result = z.looseObject({});
    const listed = await client.request({ method: 'events/list', params: {} }, result);
    assert.equal((listed.events as { name: string }[])[0].name, PR_EVENT);
    const params = { name: PR_EVENT, arguments: target, delivery };
    const subscribed = await client.request({ method: 'events/subscribe', params }, result);
    assert.match(String(subscribed.id), /^sub_/);
    assert.equal(f.posts.length, 1);
    await client.request({ method: 'events/unsubscribe', params: { ...params, delivery: { mode: 'webhook', url: delivery.url } } }, result);
    assert.equal((await f.store.load()).state.subscription, undefined);
    const tools = await client.listTools(); assert.ok(tools.tools.some(tool => tool.name === 'capabilities'));
  } finally { await client.close(); await new Promise<void>(resolve => http.close(() => resolve())); }
});

test('principal, issuer, OAuth client, exact resource and callback guards fail closed', async () => {
  const f = fixture();
  for (const altered of [{ ...auth, clientId: 'other' }, { ...auth, extra: { ...auth.extra, issuer: 'https://other' } }, { ...auth, extra: { ...auth.extra, subject: auth.clientId } }, { ...auth, extra: {} }]) {
    await assert.rejects(f.bridge.subscribe(altered, target, delivery));
  }
  await assert.rejects(f.bridge.subscribe(auth, { ...target, pullRequestNumber: 8 }, delivery));
  await assert.rejects(f.bridge.subscribe(auth, target, { ...delivery, url: 'http://receiver.example/callback' }));
  await assert.rejects(f.bridge.subscribe(auth, target, { ...delivery, secret: 'whsec_bad' }));
  assert.equal(f.posts.length, 0);
});

test('signed hints cause authoritative reads, stable signatures, deduplication and restart recovery', async () => {
  const f = fixture();
  await f.bridge.subscribe(auth, target, delivery);
  await f.bridge.subscribe(auth, { ...target }, delivery); assert.equal(f.posts.length, 1);
  f.pull.checks.pending = 0; f.pull.checks.successful = 1;
  assert.equal(await f.send('delivery-one'), 'accepted');
  assert.equal(await f.send('delivery-one'), 'accepted');
  const restarted = new PrEvents(f.options);
  assert.equal(await f.send('delivery-old', {}, 'check_run', restarted), 'unchanged');
  assert.equal(f.posts.length, 2); assert.ok(f.reads() >= 5);
  const post = f.posts[1]; const data = JSON.parse(post.body);
  assert.equal(post.headers['webhook-id'], data.eventId);
  assert.equal(post.headers['webhook-signature'], webhookSignature(secret, data.eventId, post.headers['webhook-timestamp'], post.body));
  assert.equal(data.data.checks.successful, 1); assert.equal(data.cursor, null);
  assert.ok(!f.store.raw!.includes(secret)); assert.ok(!f.store.raw!.includes(auth.token + '"'));
  assert.equal(await f.send('wrong-pr', { check_run: { head_sha: target.headSha, pull_requests: [{ number: 9 }] } }), 'ignored');
  assert.equal(await f.send('excluded', {}, 'pull_request_target'), 'ignored');
  await assert.rejects(f.send('wrong-install', { installation: { id: 456 } }));
  await assert.rejects(f.bridge.ingest(Buffer.from('{}'), 'check_run', 'invalid', 'sha256=' + '0'.repeat(64)));
});

test('expiry, unsubscribe, revocation and exact-head changes stop delivery', async () => {
  for (const stop of ['expiry', 'unsubscribe', 'revocation', 'head'] as const) {
    const f = fixture(); await f.bridge.subscribe(auth, target, delivery, 1000);
    f.pull.checks.pending = 0;
    if (stop === 'expiry') f.advance(1001);
    if (stop === 'unsubscribe') await f.bridge.unsubscribe(auth, target, delivery.url);
    if (stop === 'revocation') f.deny();
    if (stop === 'head') f.pull.head.sha = 'c'.repeat(40);
    assert.ok(['inactive', 'blocked'].includes(await f.send('stop')));
    assert.equal(f.posts.length, 1);
  }
});

test('retries are bounded with stable event identity and 410/413 are terminal', async () => {
  for (const status of [503, 410, 413]) {
    const f = fixture(); await f.bridge.subscribe(auth, target, delivery); f.status(status); f.pull.checks.pending = 0;
    await f.send('retry'); await f.send('retry');
    const events = f.posts.slice(1);
    assert.equal(events.length, status === 503 ? 3 : 1);
    assert.equal(new Set(events.map(p => p.headers['webhook-id'])).size, 1);
    assert.equal((await f.store.load()).state.deliveries[0].status, status === 503 ? 'failed' : 'stopped');
  }
});

test('callback destination validation rejects nonpublic IPv4 and all unsupported IPv6', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', '2001:db8::1']) assert.equal(publicCallbackAddress(ip), false);
  assert.equal(publicCallbackAddress('8.8.8.8'), true);
  for (const url of ['https://127.0.0.1', 'https://receiver.example:8443/x', 'https://user@receiver.example/x', 'https://receiver.example/x#fragment', 'https://other.example/x']) assert.throws(() => callbackUrl(url, 'receiver.example'));
});

test('callback challenge failure cannot activate a subscription', async () => {
  const f = fixture();
  const bridge = new PrEvents({ ...f.options, post: async () => ({ status: 200, body: '{"challenge":"wrong"}' }) });
  await assert.rejects(bridge.subscribe(auth, target, delivery), (error: unknown) => {
    assert.equal((error as { code: number }).code, -32015); return true;
  });
  assert.equal((await f.store.load()).state.subscription, undefined);
});

test('baseline reconciliation detects a transition during subscription creation', async () => {
  const f = fixture(); let reads = 0;
  const bridge = new PrEvents({ ...f.options, source: { async read() {
    if (++reads === 2) { f.pull.checks.pending = 0; f.pull.checks.successful = 1; }
    return structuredClone(f.pull);
  } } });
  await bridge.subscribe(auth, target, delivery);
  assert.equal(f.posts.length, 2);
  assert.equal(JSON.parse(f.posts[1].body).data.checks.successful, 1);
});

test('canonical arguments refresh one subscription; rotation signs with both keys briefly', async () => {
  const f = fixture(); const first = await f.bridge.subscribe(auth, target, delivery);
  const rotated = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
  const second = await f.bridge.subscribe(auth, { baseSha: target.baseSha, headSha: target.headSha, pullRequestNumber: 7, repository: target.repository }, { ...delivery, secret: rotated });
  assert.equal(first.id, second.id); assert.equal(f.posts.length, 2);
  f.pull.checks.pending = 0;
  await f.send('rotated');
  const post = f.posts.at(-1)!;
  assert.equal(post.headers['webhook-signature'], [rotated, secret].map(key => webhookSignature(key, post.headers['webhook-id'], post.headers['webhook-timestamp'], post.body)).join(' '));
  f.advance(61000); f.pull.checks.failed = 1; await f.send('after-rotation');
  assert.equal(f.posts.at(-1)!.headers['webhook-signature'].split(' ').length, 1);
});

test('one callback slot, token-bounded expiration and concurrent duplicate claims', async () => {
  const f = fixture();
  const subscribed = await f.bridge.subscribe({ ...auth, expiresAt: 1800000002 }, target, delivery);
  assert.equal(subscribed.refreshBefore, new Date(1800000002000).toISOString());
  await assert.rejects(f.bridge.subscribe(auth, target, { ...delivery, url: 'https://receiver.example/another-chat' }));
  f.pull.checks.pending = 0;
  const results = await Promise.all([f.send('concurrent'), f.send('concurrent')]);
  assert.ok(results.includes('accepted')); assert.equal(f.posts.length, 2);
});

test('unsubscribe during an in-flight receipt cannot be overwritten by completion', async () => {
  const f = fixture();
  const bridge = new PrEvents({ ...f.options, post: async (url, body, headers) => {
    if (!JSON.parse(body).type) await f.bridge.unsubscribe(auth, target, delivery.url);
    return f.options.post(url, body, headers);
  } });
  await bridge.subscribe(auth, target, delivery); f.pull.checks.pending = 0;
  assert.equal(await f.send('in-flight', {}, 'check_run', bridge), 'pending');
  assert.equal((await f.store.load()).state.subscription, undefined);
  assert.equal(await f.send('in-flight', {}, 'check_run', bridge), 'inactive');
  assert.equal(f.posts.length, 2);
});

test('signed PR and suite signals reconcile while nonmatching repository, head and actions do not', async () => {
  const f = fixture(); await f.bridge.subscribe(auth, target, delivery);
  assert.equal(await f.send('opened', { action: 'opened', pull_request: { number: 7, head: { sha: target.headSha } } }, 'pull_request'), 'unchanged');
  f.pull.checks.pending = 0;
  assert.equal(await f.send('suite', { check_suite: { head_sha: target.headSha, pull_requests: [{ number: 7 }] } }, 'check_suite'), 'accepted');
  assert.equal(await f.send('wrong-head', { check_run: { head_sha: 'c'.repeat(40), pull_requests: [{ number: 7 }] } }), 'ignored');
  assert.equal(await f.send('action', { action: 'deleted' }), 'ignored');
  await assert.rejects(f.send('wrong-repo', { repository: { full_name: 'other/repo' } }));
  assert.equal(f.posts.length, 2);
});

test('an unchanged source delivery is deduplicated before a later unrelated transition', async () => {
  const f = fixture(); await f.bridge.subscribe(auth, target, delivery);
  assert.equal(await f.send('unchanged-source'), 'unchanged');
  f.pull.checks.pending = 0;
  assert.equal(await f.send('unchanged-source'), 'duplicate');
  assert.equal(f.posts.length, 1);
  assert.equal(await f.send('new-source'), 'accepted');
});
