import { reviewReaderFixture, commentRow } from './helpers/github-review-reader.js';
import { requireOAuthGrant } from '../src/transport/oauth-grant-store.js';
import { GrantRedisFixture } from './helpers/oauth-grants.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { PrEvents, PR_EVENT, CHECKPOINT_EVENT, prEventCatalog, type PrEventState, type PrEventStore } from '../src/runtime/pr-events.js';
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
    const tools = await client.listTools(); assert.ok(tools.tools.some(tool => tool.name === 'capabilities')); assert.ok(tools.tools.some(tool => tool.name === 'checkpoint.publish'));
    const checkpointParams = { name: CHECKPOINT_EVENT, arguments: target, delivery };
    await client.request({ method: 'events/subscribe', params: checkpointParams }, result);
    const toolResult = await client.request({ method: 'tools/call', params: { name: 'checkpoint.publish', arguments: {
      resource: target,
      source: { conversationUrl: 'https://chatgpt.com/local/http-test-conversation', conversationId: 'http-test-conversation', replyId: null, replyState: 'unavailable' },
      checkpointId: 'http-checkpoint-0001', summary: 'Real MCP tool invocation test.',
      evidence: [{ kind: 'github', reference: 'https://github.com/pyralisxc/Conductor/pull/317' }], pending: [],
    } } }, result);
    assert.match(JSON.stringify(toolResult), /accepted/);
    assert.equal(f.posts.length, 3);
    await client.request({ method: 'events/unsubscribe', params: { ...checkpointParams, delivery: { mode: 'webhook', url: delivery.url } } }, result);
    assert.equal((await f.store.load()).state.subscription, undefined);
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
  assert.equal(await f.send('opened', { action: 'opened', pull_request: { number: 7, head: { sha: target.headSha }, base: { sha: target.baseSha } } }, 'pull_request'), 'unchanged');
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

function reviewFixture() {
  const f = fixture(); const reader = reviewReaderFixture();
  const options = { ...f.options, source: { async read() {
    const pull = await f.options.source.read();
    const reviews = await reader.read(() => requireOAuthGrant(f.options.grants, owner, auth.extra.grantGeneration));
    return { ...pull, reviews };
  } } };
  const bridge = new PrEvents(options);
  const hint = (action: string, event = 'pull_request_review', patch: Record<string, unknown> = {}) => ({ action,
    pull_request: { number: 7, head: { sha: target.headSha }, base: { sha: target.baseSha } },
    [event === 'pull_request_review' ? 'review' : 'comment']: { body: 'UNTRUSTED SIGNAL INSTRUCTIONS', state: 'APPROVED' }, ...patch });
  return { ...f, reader, bridge, reviewOptions: options, hint,
    signal: (id: string, action: string, event = 'pull_request_review', patch: Record<string, unknown> = {}, instance = bridge) => f.send(id, hint(action, event, patch), event, instance) };
}

test('all supported review/comment actions use fresh metadata; duplicates and late hints cannot restore old state', async () => {
  const f = reviewFixture(); await f.bridge.subscribe(auth, target, delivery);
  const steps: [string, string, () => void][] = [
    ['pull_request_review', 'submitted', () => { f.reader.data.reviews[0].state = 'CHANGES_REQUESTED'; }],
    ['pull_request_review', 'edited', () => { f.reader.data.reviews[0].body = 'EDITED PRIVATE REVIEW'; }],
    ['pull_request_review', 'dismissed', () => { f.reader.data.reviews[0].state = 'DISMISSED'; }],
    ['pull_request_review_comment', 'created', () => { f.reader.data.comments.push(commentRow(2)); }],
    ['pull_request_review_comment', 'edited', () => { f.reader.data.comments[0].body = 'EDITED PRIVATE COMMENT'; }],
    ['pull_request_review_comment', 'deleted', () => { f.reader.data.comments.splice(0, 1); }],
  ];
  for (const [event, action, change] of steps) {
    change(); const id = `${event}-${action}`.replaceAll('_', '-');
    assert.equal(await f.signal(id, action, event), 'accepted');
    const count = f.posts.length; await f.signal(id, action, event); assert.equal(f.posts.length, count);
  }
  const last = JSON.parse(f.posts.at(-1)!.body).data.reviews;
  assert.equal(last.latestActivity[0].state, 'DISMISSED'); assert.equal(last.currentHeadApprovals, 0);
  assert.deepEqual(last.comments.map((c: { id: number }) => c.id), [2]);
  const count = f.posts.length;
  assert.equal(await f.signal('late-approved-hint', 'submitted'), 'unchanged');
  assert.equal(f.posts.length, count);
  assert.doesNotMatch(JSON.stringify(f.posts) + f.store.raw, /PRIVATE|UNTRUSTED|INSTRUCTIONS|malicious|SECRET|test-token/);
  assert.match((await f.store.load()).state.deliveries[0].source, /^owner\/repo:123:/);
  // Delivery identity is shared across event categories within repository/installation.
  f.reader.data.comments.push(commentRow(3));
  assert.equal(await f.signal('late-approved-hint', 'created', 'pull_request_review_comment'), 'duplicate');
});

test('review hints reject forged signatures, oversize bodies, invalid delivery IDs, unsupported actions and foreign exact resources', async () => {
  const f = reviewFixture(); await f.bridge.subscribe(auth, target, delivery);
  const before = f.reader.paths.length;
  for (const event of ['pull_request_review', 'pull_request_review_comment']) {
    const action = event === 'pull_request_review' ? 'submitted' : 'created';
    for (const unsupported of ['opened', 'closed', 'synchronize', 'unknown', event === 'pull_request_review' ? 'created' : 'dismissed']) {
      assert.equal(await f.signal(`unsupported-${event}-${unsupported}`.replaceAll('_', '-'), unsupported, event), 'ignored');
    }
    for (const pull of [{ number: 8, head: { sha: target.headSha }, base: { sha: target.baseSha } },
      { number: 7, head: { sha: 'c'.repeat(40) }, base: { sha: target.baseSha } },
      { number: 7, head: { sha: target.headSha }, base: { sha: 'c'.repeat(40) } }]) {
      assert.equal(await f.signal('foreign-pr', action, event, { pull_request: pull }), 'ignored');
    }
    await assert.rejects(f.signal('foreign-install', action, event, { installation: { id: 456 } }));
    await assert.rejects(f.signal('foreign-repo', action, event, { repository: { full_name: 'foreign/repo' } }));
    const body = Buffer.from(JSON.stringify(f.hint(action, event)));
    await assert.rejects(f.bridge.ingest(body, event, 'forged', `sha256=${'0'.repeat(64)}`));
    await assert.rejects(f.signal('invalid/id', action, event));
    await assert.rejects(f.signal('oversize', action, event, { padding: 'x'.repeat(262144) }));
  }
  assert.equal(await f.signal('target', 'opened', 'pull_request_target'), 'ignored');
  assert.equal(f.reader.paths.length, before); assert.equal(f.posts.length, 1);
});

test('review retries and process restart retain stable IDs and bound deduplication', async () => {
  const f = reviewFixture(); await f.bridge.subscribe(auth, target, delivery);
  f.reader.data.reviews[0].state = 'DISMISSED'; f.status(503);
  assert.equal(await f.signal('retry-review', 'dismissed'), 'failed');
  const attempts = f.posts.slice(1); assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts.map(p => p.headers['webhook-id'])).size, 1);
  const restarted = new PrEvents(f.reviewOptions);
  assert.equal(await f.signal('retry-review', 'dismissed', 'pull_request_review', {}, restarted), 'failed');
  assert.equal(await f.signal('old-review', 'submitted', 'pull_request_review', {}, restarted), 'unchanged');
  assert.equal(f.posts.length, 4);
});

test('review reads and sends stop for revoked or expired grants and in-flight revocation', async () => {
  for (const mode of ['revoked', 'expired', 'in-flight']) {
    const f = reviewFixture(); await f.bridge.subscribe(auth, target, delivery);
    const before = f.reader.paths.length; f.reader.data.reviews[0].state = 'DISMISSED';
    if (mode === 'revoked') await f.options.grants.revoke(owner, auth.extra.grantGeneration);
    if (mode === 'expired') f.advance(3600001);
    if (mode === 'in-flight') f.reader.beforeFetch(async () => { f.reader.beforeFetch(); await f.options.grants.revoke(owner, auth.extra.grantGeneration); });
    assert.ok(['blocked', 'inactive'].includes(await f.signal(`stop-${mode}`, 'dismissed')));
    assert.equal(f.posts.length, 1);
    assert.equal(f.reader.paths.length, before + (mode === 'in-flight' ? 1 : 0));
  }
});

test('a delayed older review read cannot overwrite a newer committed review snapshot', async () => {
  const f = reviewFixture();
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  let hold = false;
  const bridge = new PrEvents({ ...f.reviewOptions, source: { async read() {
    const result = await f.reviewOptions.source.read();
    if (hold) { hold = false; entered(); await resume; }
    return result;
  } } });
  await bridge.subscribe(auth, target, delivery);
  f.reader.data.reviews[0].state = 'COMMENTED'; hold = true;
  const delayed = f.signal('delayed-review', 'submitted', 'pull_request_review', {}, bridge);
  await waiting;
  f.reader.data.reviews[0].state = 'DISMISSED';
  try { assert.equal(await f.signal('new-review', 'dismissed', 'pull_request_review', {}, bridge), 'accepted'); }
  finally { release(); }
  assert.equal(await delayed, 'pending');
  assert.equal(f.posts.length, 2);
  assert.equal(JSON.parse(f.posts[1].body).data.reviews.latestActivity[0].state, 'DISMISSED');
  assert.equal(await f.signal('delayed-review', 'submitted', 'pull_request_review', {}, bridge), 'unchanged');
});

test('review capability retains issuer/subject/client/generation isolation before private reads', async () => {
  const f = reviewFixture(); const before = f.reader.paths.length;
  for (const principal of [
    { ...auth, clientId: 'other' },
    { ...auth, extra: { ...auth.extra, issuer: 'https://foreign.example' } },
    { ...auth, extra: { ...auth.extra, subject: 'other' } },
    { ...auth, extra: { ...auth.extra, grantGeneration: '2:00000000-0000-4000-8000-000000000002' } },
  ]) await assert.rejects(f.bridge.subscribe(principal, target, delivery));
  assert.equal(f.reader.paths.length, before); assert.equal(f.posts.length, 0);
});

test('outbound review activity cannot hide an effective request for changes', async () => {
  const f = reviewFixture(); f.reader.data.reviews[0].state = 'CHANGES_REQUESTED';
  await f.bridge.subscribe(auth, target, delivery);
  f.reader.data.reviews.push({ ...f.reader.data.reviews[0], id: 2, state: 'COMMENTED' });
  assert.equal(await f.signal('comment-after-request', 'submitted'), 'accepted');
  const reviews = JSON.parse(f.posts.at(-1)!.body).data.reviews;
  assert.equal(reviews.latestActivity[0].state, 'COMMENTED');
  assert.equal(reviews.effectiveDecisions[0].state, 'CHANGES_REQUESTED');
  assert.equal(reviews.effectiveDecisions[0].reviewId, 1);
  assert.equal(reviews.currentHeadApprovals, 0);
  assert.doesNotMatch(JSON.stringify(reviews), /PRIVATE|UNTRUSTED/);
});

function delegatedFixture() {
  const f = fixture();
  const { callbackHostname: _hostname, ...base } = f.options;
  const mode = { clientFingerprint: createHash('sha256').update(owner.clientId).digest('hex'), approval: undefined as undefined | { id: string; expiresAt: number } };
  const options = { ...base, owner: { issuer: owner.issuer, subject: owner.subject }, delegatedRecipient: mode, validateRecipient: async (_url: string) => {} };
  const bridge = new PrEvents(options);
  const approve = () => { mode.approval = { id: randomUUID(), expiresAt: options.now() + 300000 }; };
  const pending = async () => {
    if (!mode.approval) approve();
    const save = f.store.save.bind(f.store);
    f.store.save = async (version, state) => { const saved = await save(version, state); if (saved && state.subscription?.binding?.phase === 'pending') throw new Error('isolated pending restart'); return saved; };
    try { await assert.rejects(bridge.subscribe(auth, target, delivery), /isolated pending restart/); }
    finally { f.store.save = save; }
  };
  const activate = async () => { approve(); await bridge.subscribe(auth, target, delivery); };

  return { ...f, bridge, options, mode, approve, pending, activate, applicationPosts: () => f.posts.filter(p => JSON.parse(p.body).type !== 'verification') };
}


test('delegated binding status is redacted, owner/client scoped, and does not mutate the stable slot', async () => {
  const f = delegatedFixture(); f.approve();
  const emptyBefore = f.store.raw;
  const empty = await f.bridge.bindingStatus(auth);
  assert.equal(empty.status, 'empty');
  assert.equal(empty.configuredResource.repository, target.repository);
  assert.equal(empty.eventName, null);
  assert.equal(f.store.raw, emptyBefore);
  assert.equal(f.reads(), 0); assert.equal(f.posts.length, 0);
  await f.pending();
  const pendingRaw = f.store.raw;
  const pending = await f.bridge.bindingStatus(auth);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.phase, 'pending');
  assert.equal(pending.resourceMatchesConfigured, true);
  assert.equal(f.store.raw, pendingRaw);
  assert.doesNotMatch(JSON.stringify(pending), /receiver\.example|whsec_|grantGeneration|oauth-client|service-principal/);
  const challenger = await f.store.load();
  challenger.state.subscription!.binding!.phase = 'challenging';
  assert.equal(await f.store.save(challenger.version, challenger.state), true);
  assert.equal((await f.bridge.bindingStatus(auth)).status, 'challenging');
});

test('delegated binding status distinguishes active, expired and invalid grant without revealing mismatched slots', async () => {
  const f = delegatedFixture(); await f.activate();
  const activeRaw = f.store.raw;
  const active = await f.bridge.bindingStatus(auth);
  assert.equal(active.status, 'active');
  assert.equal(active.eventName, PR_EVENT);
  assert.equal(active.bindingMatchesConfigured, true);
  assert.equal(active.currentGrantValid, true);
  assert.equal(active.subscriptionGrantMatches, true);
  assert.equal(f.store.raw, activeRaw);
  const expired = delegatedFixture(); await expired.activate(); expired.advance(300001);
  const expiredStatus = await expired.bridge.bindingStatus(auth);
  assert.equal(expiredStatus.status, 'expired');
  assert.notEqual(expired.store.raw, null);
  await f.options.grants.revoke(owner, auth.extra.grantGeneration);
  const invalid = await f.bridge.bindingStatus(auth);
  assert.equal(invalid.status, 'invalid_authority');
  assert.equal(invalid.currentGrantValid, false);
  assert.equal(invalid.subscriptionGrantMatches, false);
  assert.equal(f.store.raw, activeRaw);
  const staleConfig = { ...f.options, target: { ...target, repository: 'owner/other-repo' } };
  const stale = new PrEvents(staleConfig);
  const mismatch = await stale.bindingStatus(auth);
  assert.equal(mismatch.status, 'invalid_authority');
  assert.equal(mismatch.resourceMatchesConfigured, false);
  assert.equal(mismatch.eventName, null);
  assert.equal(mismatch.subscriptionExpiresAt, null);
  assert.doesNotMatch(JSON.stringify(mismatch), /owner\/repo|receiver\.example|whsec_|1:00000000/);
  assert.equal(f.store.raw, activeRaw);
});

test('delegated binding status rejects foreign principal/client and reports unavailable store without mutation', async () => {
  const f = delegatedFixture(); await f.activate();
  await assert.rejects(f.bridge.bindingStatus({ ...auth, clientId: 'foreign-client' }), /not authorized/);
  await assert.rejects(f.bridge.bindingStatus({ ...auth, extra: { ...auth.extra, subject: 'foreign-subject' } }), /not authorized/);
  const raw = f.store.raw;
  const unavailable = new PrEvents({ ...f.options, store: { async load() { throw new Error('private redis failure'); }, async save() { throw new Error('must not save'); } } });
  const result = await unavailable.bindingStatus(auth);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.configuredResource.repository, target.repository);
  assert.doesNotMatch(JSON.stringify(result), /private redis failure|receiver\.example|whsec_|grantGeneration|oauth-client/);
  assert.equal(f.store.raw, raw);
});

test('delegated approved client binds and challenges in one request; absent approval does nothing', async () => {
  const f = delegatedFixture();
  await assert.rejects(f.bridge.subscribe(auth, target, delivery), /not approved/);
  assert.equal(f.store.raw, null); assert.equal(f.reads(), 0); assert.equal(f.posts.length, 0);
  await f.activate();
  assert.equal('clientId' in f.options.owner, false);
  assert.deepEqual((await f.store.load()).state.subscription!.owner, owner);
  assert.equal(f.posts.length, 1); assert.equal(f.applicationPosts().length, 0);
  assert.equal((await f.store.load()).state.subscription!.binding!.phase, 'active');
  await new PrEvents(f.options).subscribe(auth, target, delivery); assert.equal(f.posts.length, 1);
  f.pull.checks.pending = 0; assert.equal(await f.bridge.reconcile('change'), 'accepted');
  await f.bridge.unsubscribe(auth, target, delivery.url);
  await assert.rejects(f.bridge.subscribe(auth, target, delivery), /already consumed/);
});

test('delegated identity, exact resource, URL safety and current grant fail before pending writes or provider reads', async () => {
  for (const mutate of ['client', 'fingerprint', 'issuer', 'subject', 'repository', 'pr', 'head', 'base', 'http', 'ip', 'revoked', 'missing', 'stale', 'unavailable', 'expired'] as const) {
    const f = delegatedFixture(); f.approve(); let principal = structuredClone(auth); let args = { ...target }; let dest = { ...delivery };
    if (mutate === 'client') principal.clientId = 'other';
    if (mutate === 'fingerprint') f.mode.clientFingerprint = '0'.repeat(64);
    if (mutate === 'issuer') principal.extra.issuer = 'https://other.example';
    if (mutate === 'subject') principal.extra.subject = 'other';
    if (mutate === 'repository') args.repository = 'other/repo';
    if (mutate === 'pr') args.pullRequestNumber++;
    if (mutate === 'head') args.headSha = 'c'.repeat(40);
    if (mutate === 'base') args.baseSha = 'c'.repeat(40);
    if (mutate === 'http') dest.url = 'http://receiver.example/';
    if (mutate === 'ip') dest.url = 'https://127.0.0.1/';
    if (mutate === 'revoked') await f.options.grants.revoke(owner, auth.extra.grantGeneration);
    if (mutate === 'missing') f.options.grants.read = async () => null;
    if (mutate === 'unavailable') f.options.grants.read = async () => { throw new Error('unavailable'); };
    if (mutate === 'stale') principal.extra.grantGeneration = '2:00000000-0000-4000-8000-000000000002';
    if (mutate === 'expired') f.advance(3600001);
    await assert.rejects(f.bridge.subscribe(principal, args, dest), `reject ${mutate}`);
    assert.equal(f.store.raw, null, mutate); assert.equal(f.posts.length, 0, mutate); assert.equal(f.reads(), 0, mutate);
  }
});

test('pending binding rejects changed identity, resource, generation, secret and recipient instead of migrating', async () => {
  for (const change of ['url', 'generation', 'secret', 'fingerprint', 'resource'] as const) {
    const f = delegatedFixture(); await f.pending(); const before = f.store.raw;
    let principal = structuredClone(auth); let dest = { ...delivery };
    if (change === 'url') dest.url += '/changed';
    if (change === 'secret') dest.secret = `whsec_${Buffer.alloc(32, 8).toString('base64')}`;
    if (change === 'fingerprint') f.mode.clientFingerprint = '0'.repeat(64);
    if (change === 'resource') f.options.target = { ...target, headSha: 'c'.repeat(40) };
    if (change === 'generation') { principal.extra.grantGeneration = '2:00000000-0000-4000-8000-000000000002'; f.grantRedis.seed(owner, principal.extra.grantGeneration, f.options.now() + 3600000); }
    await assert.rejects(new PrEvents(f.options).subscribe(principal, f.options.target, dest));
    assert.equal(f.store.raw, before); assert.equal(f.posts.length, 0); assert.equal(f.reads(), 0);
  }
});

test('failed challenge, timeout, storage loss and CAS conflict never activate or replay incomplete binding', async () => {
  for (const failure of ['mismatch', 'timeout', 'redirect', 'lost', 'cas', 'revoke', 'expiry'] as const) {
    const f = delegatedFixture(); await f.pending(); let challenges = 0;
    const bridge = new PrEvents({ ...f.options, post: async (_url, body) => {
      challenges++; const data = JSON.parse(body); assert.equal(data.type, 'verification');
      if (failure === 'timeout') throw new Error('timeout');
      if (failure === 'lost') f.store.raw = null;
      if (failure === 'cas') f.store.raw = JSON.stringify({ ...(await f.store.load()).state, baseline: 'concurrent' });
      if (failure === 'revoke') await f.options.grants.revoke(owner, auth.extra.grantGeneration);
      if (failure === 'expiry') f.advance(3600001);
      return { status: failure === 'redirect' ? 302 : 200, body: JSON.stringify({ challenge: failure === 'mismatch' ? 'wrong' : data.challenge }) };
    } });
    await assert.rejects(bridge.subscribe(auth, target, delivery), failure);
    const state = (await f.store.load()).state;
    assert.notEqual(state.subscription?.binding?.phase, 'active');
    assert.equal(await new PrEvents(f.options).reconcile('restart'), 'inactive');
    assert.equal(challenges, 1); assert.equal(f.applicationPosts().length, 0);
  }
  const f = delegatedFixture(); f.approve(); f.store.save = async () => false;
  await assert.rejects(f.bridge.subscribe(auth, target, delivery), /Pending binding changed/);
  assert.equal(f.posts.length, 0); assert.equal(f.reads(), 0);
});

test('delegated active sends stop on changed approval, revoked grant and expiry, including in-flight retry', async () => {
  for (const change of ['approval', 'recipient', 'resource', 'fingerprint', 'grant', 'expiry', 'in-flight'] as const) {
    const f = delegatedFixture(); await f.activate(); f.pull.checks.pending = 0;
    if (change === 'approval') f.mode.approval = undefined;
    if (change === 'recipient') f.mode.approval!.id = randomUUID();
    if (change === 'resource') f.options.target = { ...target, headSha: 'c'.repeat(40) };
    if (change === 'fingerprint') f.mode.clientFingerprint = '0'.repeat(64);
    if (change === 'grant') await f.options.grants.revoke(owner, auth.extra.grantGeneration);
    if (change === 'expiry') f.advance(300001);
    const reads = f.reads(); let attempts = 0;
    const bridge = new PrEvents({ ...f.options, post: async (...params) => {
      attempts++; await f.options.grants.revoke(owner, auth.extra.grantGeneration); return { status: 503, body: '' };
    } });
    assert.equal(await bridge.reconcile('stop'), change === 'expiry' ? 'inactive' : 'blocked');
    assert.equal(attempts, change === 'in-flight' ? 1 : 0);
    if (change !== 'in-flight') assert.equal(f.reads(), reads);
    assert.equal((await f.store.load()).state.subscription, undefined);
  }
});

test('delegated mode over real HTTP authenticates signed identity, rejects body identity claims, and binds in one approved request', async () => {
  const { SignJWT, jwtVerify } = await import('jose');
  const { authInfoFromJwt } = await import('../src/transport/auth.js');
  const f = delegatedFixture(); const key = Buffer.alloc(32, 19); const audience = 'https://local.example/mcp';
  const token = (changes: Record<string, unknown> = {}) => new SignJWT({ iss: owner.issuer, aud: audience, sub: owner.subject, client_id: owner.clientId,
    scope: 'conductor.read', grant_generation: auth.extra.grantGeneration, exp: Math.floor(Date.now() / 1000) + 3600, ...changes }).setProtectedHeader({ alg: 'HS256' }).sign(key);
  const handler = createConductorHttpHandler({ runtime: new ConductorToolRuntime(), publicUrl: 'http://127.0.0.1', oauthIssuer: owner.issuer,
    verifier: { async verifyAccessToken(value) { const result = await jwtVerify(value, key, { issuer: owner.issuer, audience }); return authInfoFromJwt(value, result.payload, audience); } }, events: f.bridge });
  const server = createServer((req, res) => { void handler(req, res); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const rpc = (bearer?: string, params: unknown = { name: PR_EVENT, arguments: target, delivery }) => fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: {
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/subscribe', params }) });
  const invoke = async (bearer: string, params: Record<string, unknown> = { name: PR_EVENT, arguments: target, delivery }) => {
    const client = new Client({ name: 'delegated-proof', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
      await client.request({ method: 'events/subscribe', params }, z.looseObject({}));
      return 'subscribed';
    } catch (error) { return String(error); }
    finally { await client.close(); }
  };
  try {
    for (const invalid of [undefined, 'invalid', await token({ iss: 'https://wrong.example' }), await token({ aud: 'wrong' }), await token({ scope: 'wrong' }), await token({ exp: 1 })]) assert.equal((await rpc(invalid)).status, 401);
    for (const claims of [{ client_id: 'other' }, { sub: 'other' }, { grant_generation: '2:00000000-0000-4000-8000-000000000002' }]) {
      assert.match(await invoke(await token(claims)), /not authorized|grant|Grant/); assert.equal(f.store.raw, null);
    }
    // Test clock must agree with the JWT expiry supplied by the real verifier.
    f.advance(Date.now() - f.options.now()); f.grantRedis.seed(owner, auth.extra.grantGeneration, Date.now() + 3600000);
    const jwt = await token();
    assert.match(await invoke(jwt, { name: PR_EVENT, arguments: { ...target, clientId: owner.clientId }, delivery }), /Invalid|invalid|Unrecognized/);
    assert.equal(f.store.raw, null);
    assert.match(await invoke(jwt, { name: PR_EVENT, arguments: { ...target, integrationBranch: 'vercel-preview' }, delivery }), /Invalid|invalid|Unrecognized/);
    assert.equal(f.store.raw, null);
    assert.match(await invoke(jwt), /not approved/);
    assert.equal(f.reads(), 0); assert.equal(f.posts.length, 0);
    f.approve(); assert.equal(await invoke(jwt), 'subscribed'); assert.equal(f.posts.length, 1);
    const statusClient = new Client({ name: 'binding-status-proof', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    try {
      await statusClient.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + address.port + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + jwt } } }));
      const tools = await statusClient.listTools();
      assert.ok(tools.tools.some(tool => tool.name === 'events.binding.status'));
      const result = await statusClient.callTool({ name: 'events.binding.status', arguments: {} });
      assert.match(JSON.stringify(result), /"status":"active"/);
      assert.doesNotMatch(JSON.stringify(result), /receiver\.example|whsec_|grant_generation|oauth-client|service-principal/);
    } finally { await statusClient.close(); }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('delegated preflight, challenge claim and before-read revocation failures send no application data', async () => {
  for (const failure of ['dns', 'preflight-revoke', 'claim-cas', 'before-read', 'read-revoke', 'before-challenge', 'wrong-approval', 'lost-pending'] as const) {
    const f = delegatedFixture(); f.approve();
    if (failure === 'dns' || failure === 'preflight-revoke') {
      const bridge = new PrEvents({ ...f.options, validateRecipient: async () => {
        if (failure === 'dns') throw new Error('unsafe DNS');
        await f.options.grants.revoke(owner, auth.extra.grantGeneration);
      } });
      await assert.rejects(bridge.subscribe(auth, target, delivery)); assert.equal(f.store.raw, null);
    } else {
      await f.pending();
      if (failure === 'claim-cas') f.store.save = async () => false;
      if (failure === 'before-read') await f.options.grants.revoke(owner, auth.extra.grantGeneration);
      if (failure === 'read-revoke') f.options.source.read = async () => { await f.options.grants.revoke(owner, auth.extra.grantGeneration); return f.pull; };
      if (failure === 'before-challenge') {
        let providerReturned = false;
        f.options.source.read = async () => { providerReturned = true; return f.pull; };
        const load = f.store.load.bind(f.store);
        f.store.load = async () => { if (providerReturned) { providerReturned = false; await f.options.grants.revoke(owner, auth.extra.grantGeneration); } return load(); };
      }
      if (failure === 'wrong-approval') f.mode.approval!.id = randomUUID();
      if (failure === 'lost-pending') { f.store.raw = null; f.store.save = async () => false; }
      await assert.rejects(new PrEvents(f.options).subscribe(auth, target, delivery));
    }
    assert.equal(f.posts.length, 0, failure); assert.equal(f.applicationPosts().length, 0, failure);
  }
});

test('fresh consent can explicitly unsubscribe an obsolete pending binding without inheriting it', async () => {
  const f = delegatedFixture(); await f.pending();
  const originalId = (await f.store.load()).state.subscription!.binding!.id;
  await f.options.grants.revoke(owner, auth.extra.grantGeneration);
  await assert.rejects(f.bridge.unsubscribe(auth, target, delivery.url));
  assert.equal(await f.bridge.reconcile('revoked-pending'), 'inactive');
  const grant = await f.options.grants.consent(owner, ['conductor.read'], f.options.now() + 3600000);
  const fresh = { ...auth, extra: { ...auth.extra, grantGeneration: grant.generation } };
  await assert.rejects(f.bridge.subscribe(fresh, target, delivery), /teardown/);
  await assert.rejects(f.bridge.unsubscribe({ ...fresh, clientId: 'foreign' }, target, delivery.url));
  await assert.rejects(f.bridge.unsubscribe(fresh, { ...target, pullRequestNumber: 8 }, delivery.url));
  await f.bridge.unsubscribe(fresh, target, delivery.url + '/other');
  assert.equal((await f.store.load()).state.subscription!.binding!.id, originalId);
  await f.bridge.unsubscribe(fresh, target, delivery.url);
  assert.equal((await f.store.load()).state.subscription, undefined);
  await assert.rejects(f.bridge.subscribe(fresh, target, delivery), /already consumed/);
  f.approve(); await f.bridge.subscribe(fresh, target, delivery);
  assert.notEqual((await f.store.load()).state.subscription!.binding!.id, originalId);
  assert.equal(f.posts.length, 1); assert.equal(f.applicationPosts().length, 0);
});


test('delegated approval expiry and maximum window fail before state or callback activity', async () => {
  for (const offset of [-1, 0, 3600001]) {
    const f = delegatedFixture(); f.approve(); f.mode.approval!.expiresAt = f.options.now() + offset;
    await assert.rejects(f.bridge.subscribe(auth, target, delivery), /not approved/);
    assert.equal(f.store.raw, null); assert.equal(f.posts.length, 0); assert.equal(f.reads(), 0);
  }
});

test('fixed and delegated exact waits support only the server-selected integration branch', async () => {
  for (const branch of ['preview', 'vercel-preview'] as const) for (const delegated of [false, true]) {
    const f = delegated ? delegatedFixture() : fixture();
    if ('approve' in f) f.approve();
    f.pull.base.ref = branch;
    const bridge = new PrEvents({ ...f.options, integrationBranch: branch });
    await bridge.subscribe(auth, target, delivery);
    if (delegated) assert.equal((await f.store.load()).state.subscription!.binding!.integrationBranch, branch);
    f.pull.checks.pending = 0;
    assert.equal(await bridge.reconcile('good'), 'accepted');
    const count = f.posts.length;
    const active = f.store.raw;
    for (const wrong of ['main', 'master', 'other', branch === 'preview' ? 'vercel-preview' : 'preview']) {
      f.store.raw = active; f.pull.base.ref = wrong;
      assert.equal(await bridge.reconcile(`wrong-${wrong}`), 'blocked');
    }
    assert.equal(f.posts.length, count);
    await assert.rejects(bridge.subscribe(auth, { ...target, integrationBranch: branch } as typeof target, delivery), /not authorized/);
    const badIngress = { action: 'synchronize', pull_request: { number: target.pullRequestNumber, head: { sha: target.headSha }, base: { sha: target.baseSha, ref: 'main' } } };
    assert.equal(await f.send('wrong-branch', badIngress, 'pull_request', bridge), 'ignored');
    assert.equal(await f.send('wrong-pr', { check_run: { head_sha: target.headSha, pull_requests: [{ number: 8 }] } }, 'check_run', bridge), 'ignored');
  }
});

test('delegated stable slot cannot reinterpret branch; legacy absent means preview only', async () => {
  const f = delegatedFixture(); await f.activate();
  const legacy = (await f.store.load()).state;
  delete legacy.subscription!.binding!.integrationBranch;
  f.store.raw = JSON.stringify(legacy);
  await new PrEvents({ ...f.options, integrationBranch: 'preview' }).subscribe(auth, target, delivery);
  const count = f.posts.length; const reads = f.reads();
  const changed = new PrEvents({ ...f.options, integrationBranch: 'vercel-preview' });
  await assert.rejects(changed.subscribe(auth, target, delivery), /teardown/);
  assert.equal(await changed.reconcile('changed-branch'), 'blocked');
  assert.equal(f.posts.length, count); assert.equal(f.reads(), reads);
});

test('checkpoint publication uses the scoped callback, redacted envelope and stable dedupe identity', async () => {
  const f = fixture();
  const payload = {
    resource: target,
    source: { conversationUrl: 'https://chatgpt.com/local/conversation-123', conversationId: 'conversation-123', replyId: null, replyState: 'unavailable' as const },
    checkpointId: 'checkpoint-20261022-0001',
    summary: 'Exact-head Preview integration is verified.',
    evidence: [{ kind: 'github' as const, reference: 'https://github.com/pyralisxc/Conductor/pull/316' }],
    pending: ['Receiver wake remains unproven.'],
  };
  assert.deepEqual(prEventCatalog().events.map(event => event.name), [PR_EVENT, CHECKPOINT_EVENT]);
  await assert.rejects(f.bridge.publishCheckpoint(auth, payload), /No exact checkpoint subscription/);
  await f.bridge.subscribe(auth, target, delivery, undefined, CHECKPOINT_EVENT);
  const result = await f.bridge.publishCheckpoint(auth, payload);
  assert.equal(result.status, 'accepted');
  assert.equal(f.posts.length, 2);
  const message = JSON.parse(f.posts[1].body);
  assert.equal(message.name, CHECKPOINT_EVENT);
  assert.equal(message.data.origin, 'conductor-project-agent');
  assert.equal(message.data.eventClass, 'agent.work_result');
  assert.equal(message.data.project, target.repository);
  assert.equal(message.data.source.conversationUrl, payload.source.conversationUrl);
  assert.equal(message.data.checkpointId, payload.checkpointId);
  for (const secret of [delivery.url, delivery.secret, auth.token, owner.clientId, auth.extra.grantGeneration]) assert.equal(f.posts[1].body.includes(secret), false);
  assert.equal((await f.bridge.publishCheckpoint(auth, payload)).status, 'duplicate');
  assert.equal(f.posts.length, 2);
  await assert.rejects(f.bridge.publishCheckpoint(auth, { ...payload, summary: 'Changed content for same identity.' }), /identity reused with different content/);
  await assert.rejects(f.bridge.publishCheckpoint({ ...auth, clientId: 'foreign-client' }, payload), /not authorized/);
  await assert.rejects(f.bridge.publishCheckpoint(auth, { ...payload, resource: { ...target, pullRequestNumber: 8 } }), /not authorized/);
  await assert.rejects(f.bridge.publishCheckpoint(auth, { ...payload, source: { ...payload.source, conversationUrl: 'https://evil.example/c/1' } }), /Canonical HTTPS ChatGPT/);
  await assert.rejects(f.bridge.publishCheckpoint(auth, { ...payload, summary: 'Bearer abcdefghijklmnop' }), /Sensitive material/);
  assert.equal(f.posts.length, 2);
});

test('checkpoint subscriptions ignore provider hints and fail closed on revoked grants', async () => {
  const f = fixture();
  await f.bridge.subscribe(auth, target, delivery, undefined, CHECKPOINT_EVENT);
  assert.equal(await f.bridge.reconcile('provider-webhook-id'), 'inactive');
  await f.options.grants.revoke(owner, auth.extra.grantGeneration);
  await assert.rejects(f.bridge.publishCheckpoint(auth, {
    resource: target, source: { conversationUrl: 'https://chatgpt.com/local/conversation-123', conversationId: null, replyId: null, replyState: 'unavailable' },
    checkpointId: 'checkpoint-revoked-0001', summary: 'Must not publish.', evidence: [], pending: [],
  }));
  assert.equal(f.posts.length, 1);
});

test('delegated checkpoint subscription uses event identity for activation and unsubscribe', async () => {
  const f = delegatedFixture(); f.approve();
  const subscribed = await f.bridge.subscribe(auth, target, delivery, undefined, CHECKPOINT_EVENT);
  const active = (await f.store.load()).state.subscription!;
  assert.equal(active.eventName, CHECKPOINT_EVENT);
  assert.equal(active.binding?.phase, 'active');
  assert.equal(active.id, subscribed.id);
  const count = f.posts.length;
  await f.bridge.unsubscribe(auth, target, delivery.url, CHECKPOINT_EVENT);
  assert.equal((await f.store.load()).state.subscription, undefined);
  assert.equal(f.posts.length, count);
});

test('checkpoint ambiguous delivery becomes terminal uncertain and is never replayed after lease expiry', async () => {
  const f = fixture();
  await f.bridge.subscribe(auth, target, delivery, undefined, CHECKPOINT_EVENT);
  const payload = { resource: target, source: { conversationUrl: 'https://chatgpt.com/local/conversation-123', conversationId: null, replyId: null, replyState: 'unavailable' as const },
    checkpointId: 'checkpoint-crash-0001', summary: 'A bounded result.', evidence: [], pending: [] };
  assert.equal((await f.bridge.publishCheckpoint(auth, payload)).status, 'accepted');
  const loaded = await f.store.load();
  const record = loaded.state.deliveries.find(d => d.source.endsWith(':checkpoint-crash-0001'))!;
  record.status = 'pending'; record.attempts = 1; record.leaseUntil = 0;
  assert.equal(await f.store.save(loaded.version, loaded.state), true);
  const count = f.posts.length;
  assert.equal((await f.bridge.publishCheckpoint(auth, payload)).status, 'uncertain');
  assert.equal(f.posts.length, count);
  assert.equal((await f.store.load()).state.deliveries.find(d => d.id === record.id)?.status, 'uncertain');
});

test('checkpoint pre-dispatch CAS contention safely resumes an unclaimed publication', async () => {
  const f = fixture();
  await f.bridge.subscribe(auth, target, delivery, undefined, CHECKPOINT_EVENT);
  const payload = { resource: target, source: { conversationUrl: 'https://chatgpt.com/local/conversation-123', conversationId: null, replyId: null, replyState: 'unavailable' as const },
    checkpointId: 'checkpoint-cas-0001', summary: 'A bounded result.', evidence: [], pending: [] };
  const save = f.store.save.bind(f.store); let rejectClaim = true;
  f.store.save = async (version, state) => {
    if (rejectClaim && state.deliveries.some(d => d.source.endsWith(':checkpoint-cas-0001') && d.attempts === 1)) { rejectClaim = false; return false; }
    return save(version, state);
  };
  assert.equal((await f.bridge.publishCheckpoint(auth, payload)).status, 'pending');
  const count = f.posts.length;
  assert.equal((await f.bridge.publishCheckpoint(auth, payload)).status, 'accepted');
  assert.equal(f.posts.length, count + 1);
});

test('checkpoint superseded before dispatch is terminal and sends no callback', async () => {
  const f = fixture();
  await f.bridge.subscribe(auth, target, delivery, undefined, CHECKPOINT_EVENT);
  const payload = { resource: target, source: { conversationUrl: 'https://chatgpt.com/local/conversation-123', conversationId: null, replyId: null, replyState: 'unavailable' as const },
    checkpointId: 'checkpoint-superseded-0001', summary: 'A bounded result.', evidence: [], pending: [] };
  const save = f.store.save.bind(f.store); let change = true;
  f.store.save = async (version, state) => {
    const saved = await save(version, state);
    if (saved && change && state.deliveries.some(d => d.source.endsWith(':checkpoint-superseded-0001'))) { change = false; f.pull.checks.pending = 0; f.pull.checks.successful = 1; }
    return saved;
  };
  const count = f.posts.length;
  assert.equal((await f.bridge.publishCheckpoint(auth, payload)).status, 'superseded');
  assert.equal(f.posts.length, count);
});

test('checkpoint redaction screens all caller-controlled identifiers and URL paths', async () => {
  const f = fixture();
  await f.bridge.subscribe(auth, target, delivery, undefined, CHECKPOINT_EVENT);
  const payload = { resource: target, source: { conversationUrl: 'https://chatgpt.com/local/conversation-123', conversationId: null, replyId: null, replyState: 'unavailable' as const },
    checkpointId: 'checkpoint-safe-0001', summary: 'A bounded result.', evidence: [], pending: [] };
  const invalid = [
    { ...payload, source: { ...payload.source, conversationId: 'ghp_abcdefghijklmnopqrstuvwxyz' } },
    { ...payload, source: { ...payload.source, replyId: 'Bearer abcdefghijklmnop' } },
    { ...payload, checkpointId: 'sk-abcdefghijklmnopqrstuvwxyz' },
    { ...payload, source: { ...payload.source, conversationUrl: 'https://chatgpt.com/local/ghp_abcdefghijklmnopqrstuvwxyz' } },
    { ...payload, evidence: [{ kind: 'github' as const, reference: 'https://github.com/owner/repo/ghp_abcdefghijklmnopqrstuvwxyz' }] },
    { ...payload, pending: ['api_key=supersecret'] },
  ];
  for (const bad of invalid) await assert.rejects(f.bridge.publishCheckpoint(auth, bad));
  assert.equal(f.posts.length, 1);
});

test('checkpoint HTTP 410 stops the delivery and removes the active subscription', async () => {
  const f = fixture();
  await f.bridge.subscribe(auth, target, delivery, undefined, CHECKPOINT_EVENT);
  f.status(410);
  const payload = {
    resource: target,
    source: { conversationUrl: 'https://chatgpt.com/local/conversation-410', conversationId: null, replyId: null, replyState: 'unavailable' as const },
    checkpointId: 'checkpoint-http-410-0001', summary: 'Receiver rejected the subscription.',
    evidence: [], pending: [],
  };
  assert.equal((await f.bridge.publishCheckpoint(auth, payload)).status, 'stopped');
  const state = (await f.store.load()).state;
  assert.equal(state.subscription, undefined);
  assert.equal(state.deliveries.find(d => d.source.endsWith(':checkpoint-http-410-0001'))?.status, 'stopped');
  const callbackCount = f.posts.length;
  assert.equal((await f.bridge.publishCheckpoint(auth, payload).catch(() => ({ status: 'no-subscription' }))).status, 'no-subscription');
  assert.equal(f.posts.length, callbackCount);
});

test('checkpoint HTTP 503 becomes terminal uncertain and is never replayed', async () => {
  const f = fixture();
  await f.bridge.subscribe(auth, target, delivery, undefined, CHECKPOINT_EVENT);
  f.status(503);
  const payload = {
    resource: target,
    source: { conversationUrl: 'https://chatgpt.com/local/conversation-503', conversationId: null, replyId: null, replyState: 'unavailable' as const },
    checkpointId: 'checkpoint-http-503-0001', summary: 'Transient receiver failure.',
    evidence: [], pending: [],
  };
  assert.equal((await f.bridge.publishCheckpoint(auth, payload)).status, 'uncertain');
  const count = f.posts.length;
  assert.equal((await f.bridge.publishCheckpoint(auth, payload)).status, 'uncertain');
  assert.equal(f.posts.length, count);
  assert.equal((await f.store.load()).state.deliveries.find(d => d.source.endsWith(':checkpoint-http-503-0001'))?.status, 'uncertain');
});

test('checkpoint callback timeout becomes terminal uncertain and is never replayed', async () => {
  const f = fixture();
  await f.bridge.subscribe(auth, target, delivery, undefined, CHECKPOINT_EVENT);
  const originalPost = f.options.post;
  f.options.post = async (url, body, headers) => {
    if (JSON.parse(body).type === 'verification') return originalPost(url, body, headers);
    await originalPost(url, body, headers); // Receiver accepts the callback, but the sender loses the response.
    throw new Error('simulated callback timeout after receiver acceptance');
  };
  const payload = {
    resource: target,
    source: { conversationUrl: 'https://chatgpt.com/local/conversation-timeout', conversationId: null, replyId: null, replyState: 'unavailable' as const },
    checkpointId: 'checkpoint-timeout-0001', summary: 'Callback timed out.',
    evidence: [], pending: [],
  };
  assert.equal((await f.bridge.publishCheckpoint(auth, payload)).status, 'uncertain');
  const count = f.posts.length;
  assert.equal((await f.bridge.publishCheckpoint(auth, payload)).status, 'uncertain');
  assert.equal(f.posts.length, count);
  assert.equal((await f.store.load()).state.deliveries.find(d => d.source.endsWith(':checkpoint-timeout-0001'))?.status, 'uncertain');
});

test('simultaneous duplicate checkpoint publications claim at most one callback', async () => {
  const f = fixture();
  await f.bridge.subscribe(auth, target, delivery, undefined, CHECKPOINT_EVENT);
  const payload = {
    resource: target,
    source: { conversationUrl: 'https://chatgpt.com/local/conversation-concurrent', conversationId: null, replyId: null, replyState: 'unavailable' as const },
    checkpointId: 'checkpoint-concurrent-0001', summary: 'One logical work result.',
    evidence: [], pending: [],
  };
  const before = f.posts.length;
  const results = await Promise.all([
    f.bridge.publishCheckpoint(auth, payload),
    f.bridge.publishCheckpoint(auth, payload),
  ]);
  assert.ok(results.every(result => ['accepted', 'pending', 'duplicate'].includes(result.status)));
  assert.equal(f.posts.length - before, 1);
  const state = (await f.store.load()).state;
  const rows = state.deliveries.filter(d => d.source.endsWith(':checkpoint-concurrent-0001'));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].attempts <= 1);
});

test('grant revoked during initial checkpoint provider read prevents enqueue', async () => {
  const f = fixture();
  await f.bridge.subscribe(auth, target, delivery, undefined, CHECKPOINT_EVENT);
  const originalRead = f.options.source.read;
  let revokedDuringRead = false;
  f.options.source.read = async (...args) => {
    const snapshot = await originalRead(...args);
    if (!revokedDuringRead) {
      revokedDuringRead = true;
      await f.options.grants.revoke(owner, auth.extra.grantGeneration);
    }
    return snapshot;
  };
  const payload = {
    resource: target,
    source: { conversationUrl: 'https://chatgpt.com/local/conversation-revoke', conversationId: null, replyId: null, replyState: 'unavailable' as const },
    checkpointId: 'checkpoint-revoked-final-read-0001', summary: 'Must not reach callback.',
    evidence: [], pending: [],
  };
  const before = f.posts.length;
  await assert.rejects(f.bridge.publishCheckpoint(auth, payload), /revoked|grant|Grant|active/i);
  assert.equal(f.posts.length, before);
  assert.equal((await f.store.load()).state.deliveries.some(d => d.source.endsWith(':checkpoint-revoked-final-read-0001')), false);
});

test('grant revoked during final claimed checkpoint provider read marks blocked and suppresses callback', async () => {
  const f = fixture();
  await f.bridge.subscribe(auth, target, delivery, undefined, CHECKPOINT_EVENT);
  const originalRead = f.options.source.read;
  let revokedAfterClaim = false;
  f.options.source.read = async (...args) => {
    const snapshot = await originalRead(...args);
    const loaded = await f.store.load();
    const claimed = loaded.state.deliveries.find(d => d.source.endsWith(':checkpoint-revoked-final-claim-0001'));
    if (claimed?.attempts === 1 && !revokedAfterClaim) {
      revokedAfterClaim = true;
      await f.options.grants.revoke(owner, auth.extra.grantGeneration);
    }
    return snapshot;
  };
  const payload = {
    resource: target,
    source: { conversationUrl: 'https://chatgpt.com/local/conversation-final-revoke', conversationId: null, replyId: null, replyState: 'unavailable' as const },
    checkpointId: 'checkpoint-revoked-final-claim-0001',
    summary: 'Must be blocked after the final provider read.',
    evidence: [], pending: [],
  };
  const callbacksBefore = f.posts.length;
  assert.equal((await f.bridge.publishCheckpoint(auth, payload)).status, 'blocked');
  assert.equal(revokedAfterClaim, true);
  assert.equal(f.posts.length, callbacksBefore);
  const state = (await f.store.load()).state;
  assert.equal(state.deliveries.find(d => d.source.endsWith(':checkpoint-revoked-final-claim-0001'))?.status, 'blocked');
});
