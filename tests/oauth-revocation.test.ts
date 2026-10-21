import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { GrantRedisFixture } from './helpers/oauth-grants.js';
import { oauthGrantKey, requireOAuthGrant, type GrantIdentity } from '../src/transport/oauth-grant-store.js';
import { SelfHostedAccessTokenVerifier } from '../src/transport/oauth.js';
import { resetAuthorizationCodeStoreForTests } from '../src/transport/oauth-code-store.js';
import { handleOAuthHttpRequest } from '../src/transport/oauth-http.js';
import { PrEvents, type PrEventState, type PrEventStore } from '../src/runtime/pr-events.js';
import type { PullRequestStatus } from '../src/runtime/types.js';
import { VersionedProviderCredentialVault } from '../src/connections/universal/credential-vault.js';

const target = { repository: 'owner/repo', pullRequestNumber: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
const delivery = { url: 'https://receiver.example/callback', secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}` };

test('real OAuth consent and authenticated revoke enforce current grants through event races', async t => {
  const keys = ['CONDUCTOR_PUBLIC_URL', 'CONDUCTOR_OWNER_PASSWORD', 'CONDUCTOR_SESSION_SECRET', 'CONDUCTOR_COOKIE_SECURE', 'CONDUCTOR_PR_EVENTS_JSON', 'VERCEL', 'VERCEL_ENV', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.CONDUCTOR_OWNER_PASSWORD = 'local-test-owner';
  process.env.CONDUCTOR_SESSION_SECRET = 'local-oauth-revocation-test-secret-over-32-bytes';
  process.env.CONDUCTOR_COOKIE_SECURE = '0';
  process.env.CONDUCTOR_PR_EVENTS_JSON = '{}';
  process.env.VERCEL_ENV = 'preview';
  resetAuthorizationCodeStoreForTests();
  const redis = new GrantRedisFixture(); const grants = redis.store();
  const verifier = new SelfHostedAccessTokenVerifier(grants);
  let origin = '';
  const server = createServer((req, res) => { void handleOAuthHttpRequest(req, res, new URL(req.url!, origin), grants).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`; process.env.CONDUCTOR_PUBLIC_URL = origin;
  const form = (path: string, values: Record<string, string>, headers: Record<string, string> = {}) => fetch(`${origin}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(values) });
  const login = await form('/login', { password: 'local-test-owner', returnTo: '/' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const redirect = 'https://chatgpt.com/connector/oauth/revocation-test';
  const codeVerifier = 'a'.repeat(64);
  const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
  async function register(name: string) {
    const response = await fetch(`${origin}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect] }) });
    assert.equal(response.status, 201); return (await response.json()).client_id as string;
  }
  async function consent(clientId: string) {
    const response = await form('/oauth/authorize', { response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: 'conductor.read offline_access', code_challenge_method: 'S256', code_challenge: challenge }, { cookie });
    assert.equal(response.status, 303); return new URL(response.headers.get('location')!).searchParams.get('code')!;
  }
  const exchange = (clientId: string, code: string) => form('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, code_verifier: codeVerifier });
  const refresh = (clientId: string, token: string) => form('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: token });
  const revoke = (clientId: string, token?: string) => form('/oauth/revoke', { client_id: clientId }, token ? { authorization: `Bearer ${token}` } : {});
  async function authorize(name: string) {
    const clientId = await register(name); const response = await exchange(clientId, await consent(clientId));
    assert.equal(response.status, 200);
    const tokens = await response.json() as { access_token: string; refresh_token: string };
    const auth = await verifier.verifyAccessToken(tokens.access_token);
    const identity = { issuer: origin, subject: 'owner', clientId };
    return { clientId, tokens, auth, identity };
  }
  function events(auth: AuthInfo) {
    const owner: GrantIdentity = { issuer: String(auth.extra?.issuer), subject: String(auth.extra?.subject), clientId: auth.clientId };
    let raw: string | null = null; let reads = 0; let posts = 0; let clock = Date.now();
    let beforeSave: (() => Promise<void>) | undefined;
    let beforeReadReturn: (() => Promise<void>) | undefined;
    let onPost: (() => Promise<void>) | undefined;
    const stateStore: PrEventStore = {
      async load() { return { version: raw, state: raw ? JSON.parse(raw) as PrEventState : { deliveries: [] } }; },
      async save(version, state) {
        if (beforeSave) await beforeSave();
        if (version !== raw) return false;
        if (state.subscription) {
          try { await requireOAuthGrant(grants, owner, state.subscription.generation, ['conductor.read'], () => clock); } catch { return false; }
          if (state.subscription.expiresAt <= clock) return false;
        }
        raw = JSON.stringify(state); return true;
      },
    };
    const pull = { ...target, head: { ref: 'work/test', sha: target.headSha }, base: { ref: 'preview', sha: target.baseSha }, state: 'open', merged: false, draft: false,
      checks: { total: 1, pending: 1, successful: 0, failed: 0, neutral: 0, skipped: 0, items: [] }, workflowRuns: [],
    } as unknown as PullRequestStatus;
    const bridge = new PrEvents({ target, owner, grants, installationId: 123, callbackHostname: 'receiver.example', webhookSecret: 'test-only', store: stateStore, now: () => clock,
      vault: new VersionedProviderCredentialVault({ legacyPurpose: 'tests', currentKey: 'local-only-vault-key'.repeat(3) }),
      source: { async read() { reads++; if (beforeReadReturn) await beforeReadReturn(); return structuredClone(pull); } },
      post: async (_url, body) => {
        const data = JSON.parse(body);
        if (data.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
        posts++; if (onPost) await onPost(); return { status: 503, body: '' };
      },
    });
    return { bridge, stateStore, pull, reads: () => reads, posts: () => posts, advance: () => { clock += 2000; },
      onSave: (fn?: () => Promise<void>) => { beforeSave = fn; }, onRead: (fn?: () => Promise<void>) => { beforeReadReturn = fn; }, onPost: (fn?: () => Promise<void>) => { onPost = fn; } };
  }
  try {
    await t.test('default-off legacy issuance/refresh never creates authority or upgrades through refresh', async () => {
      delete process.env.CONDUCTOR_PR_EVENTS_JSON;
      const legacy = await authorize('legacy');
      assert.equal(legacy.auth.extra?.grantGeneration, undefined);
      assert.equal(await grants.read(legacy.identity), null);
      const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
      assert.equal(metadata.revocation_endpoint, undefined);
      process.env.CONDUCTOR_PR_EVENTS_JSON = '{}';
      const response = await refresh(legacy.clientId, legacy.tokens.refresh_token); assert.equal(response.status, 200);
      const auth = await verifier.verifyAccessToken((await response.json()).access_token);
      assert.equal(auth.extra?.grantGeneration, undefined); assert.equal(await grants.read(legacy.identity), null);
      const e = events(auth); await assert.rejects(e.bridge.list(auth)); await assert.rejects(e.bridge.subscribe(auth, target, delivery)); assert.equal(e.reads(), 0);
      assert.equal((await revoke(legacy.clientId, legacy.tokens.access_token)).status, 401);
    });
    await t.test('client-bound revoke invalidates access, refresh and events without touching same-subject client B', async () => {
      const a = await authorize('client-a'); const b = await authorize('client-b'); const e = events(a.auth);
      await e.bridge.subscribe(a.auth, target, delivery); const before = e.reads();
      assert.equal((await revoke(a.clientId)).status, 401);
      assert.equal((await revoke(b.clientId, a.tokens.access_token)).status, 401);
      assert.equal((await revoke(a.clientId, a.tokens.access_token)).status, 200);
      await assert.rejects(verifier.verifyAccessToken(a.tokens.access_token));
      assert.equal((await refresh(a.clientId, a.tokens.refresh_token)).status, 400);
      await assert.rejects(e.bridge.list(a.auth)); await assert.rejects(e.bridge.subscribe(a.auth, target, delivery));
      assert.equal(await e.bridge.reconcile('revoked-before-read'), 'blocked');
      assert.equal(e.reads(), before); assert.equal(e.posts(), 0); assert.equal((await e.stateStore.load()).state.subscription, undefined);
      await verifier.verifyAccessToken(b.tokens.access_token); assert.equal((await refresh(b.clientId, b.tokens.refresh_token)).status, 200);
      assert.equal((await grants.read(a.identity))?.status, 'revoked');
      const stored = JSON.stringify([...redis.values.values()]);
      assert.ok(!stored.includes(a.tokens.access_token)); assert.ok(!stored.includes(a.tokens.refresh_token));
    });
    await t.test('new consent fences old access, refresh, revoke and outstanding authorization codes', async () => {
      const a = await authorize('new-consent'); const oldCode = await consent(a.clientId); const newCode = await consent(a.clientId);
      assert.equal((await exchange(a.clientId, oldCode)).status, 400);
      assert.equal((await revoke(a.clientId, a.tokens.access_token)).status, 401);
      assert.equal((await refresh(a.clientId, a.tokens.refresh_token)).status, 400);
      const response = await exchange(a.clientId, newCode); assert.equal(response.status, 200);
      await verifier.verifyAccessToken((await response.json()).access_token);
    });
    await t.test('missing, corrupt and unavailable authority cannot authorize events or refresh or recreate a grant', async () => {
      for (const mode of ['missing', 'corrupt', 'unavailable'] as const) {
        const a = await authorize(mode); const e = events(a.auth); await e.bridge.subscribe(a.auth, target, delivery); const before = e.reads();
        if (mode === 'missing') redis.values.delete(oauthGrantKey(a.identity));
        if (mode === 'corrupt') redis.values.set(oauthGrantKey(a.identity), '{"status":"active"}');
        if (mode === 'unavailable') redis.unavailable = true;
        await assert.rejects(verifier.verifyAccessToken(a.tokens.access_token));
        assert.equal((await refresh(a.clientId, a.tokens.refresh_token)).status, 400);
        assert.equal((await revoke(a.clientId, a.tokens.access_token)).status, 401);
        await assert.rejects(e.bridge.subscribe(a.auth, target, delivery));
        assert.equal(await e.bridge.reconcile(mode), 'blocked'); assert.equal(e.reads(), before); assert.equal(e.posts(), 0);
        redis.unavailable = false;
        if (mode === 'missing') assert.equal(await grants.read(a.identity), null);
      }
    });
    await t.test('grant key loss and full key reset require new consent and never reuse generation identity', async () => {
      const a = await authorize('loss'); const original = a.auth.extra!.grantGeneration;
      redis.values.delete(oauthGrantKey(a.identity));
      let response = await exchange(a.clientId, await consent(a.clientId)); assert.equal(response.status, 200);
      let next = await verifier.verifyAccessToken((await response.json()).access_token);
      assert.notEqual(next.extra!.grantGeneration, original);
      assert.ok(Number(String(next.extra!.grantGeneration).split(':')[0]) > Number(String(original).split(':')[0]));
      redis.values.delete(oauthGrantKey(a.identity)); redis.values.delete(`${oauthGrantKey(a.identity)}:generation`);
      response = await exchange(a.clientId, await consent(a.clientId)); assert.equal(response.status, 200);
      next = await verifier.verifyAccessToken((await response.json()).access_token);
      assert.notEqual(next.extra!.grantGeneration, original);
      await assert.rejects(verifier.verifyAccessToken(a.tokens.access_token));
      assert.equal((await refresh(a.clientId, a.tokens.refresh_token)).status, 400);
    });
    await t.test('revocation after provider read and before send prevents the private callback', async () => {
      const a = await authorize('read-race'); const e = events(a.auth); await e.bridge.subscribe(a.auth, target, delivery); e.pull.checks.pending = 0;
      e.onRead(async () => { e.onRead(); assert.equal((await revoke(a.clientId, a.tokens.access_token)).status, 200); });
      assert.equal(await e.bridge.reconcile('before-send'), 'blocked'); assert.equal(e.posts(), 0);
      assert.equal((await e.stateStore.load()).state.subscription, undefined);
    });
    await t.test('check-to-network-start and in-flight revocation may finish one call but never retry or restore', async () => {
      for (const phase of ['check-to-start', 'in-flight']) {
        const a = await authorize(phase); const e = events(a.auth); await e.bridge.subscribe(a.auth, target, delivery); e.pull.checks.pending = 0;
        // The controlled transport runs after the publisher's final check. In the
        // first case revoke precedes simulated network work; in the second it
        // occurs while that work is pending. Neither is atomically cancellable.
        e.onPost(async () => { if (phase === 'in-flight') await new Promise(resolve => setImmediate(resolve)); assert.equal((await revoke(a.clientId, a.tokens.access_token)).status, 200); });
        assert.equal(await e.bridge.reconcile(phase), 'blocked'); assert.equal(e.posts(), 1);
        assert.equal((await e.stateStore.load()).state.subscription, undefined);
        assert.equal(await e.bridge.reconcile(`${phase}-retry`), 'inactive'); assert.equal(e.posts(), 1);
      }
    });
    await t.test('expiry during a callback cannot restore a subscription or schedule another attempt', async () => {
      const a = await authorize('expiry-race'); const e = events(a.auth); await e.bridge.subscribe(a.auth, target, delivery, 1000); e.pull.checks.pending = 0;
      e.onPost(async () => e.advance());
      assert.equal(await e.bridge.reconcile('expiry'), 'blocked'); assert.equal(e.posts(), 1);
      assert.equal((await e.stateStore.load()).state.subscription, undefined);
      assert.equal(await e.bridge.reconcile('expiry-retry'), 'inactive');
    });
    await t.test('final callback check observes revocation committed after the attempt claim', async () => {
      const a = await authorize('final-check'); const e = events(a.auth); await e.bridge.subscribe(a.auth, target, delivery); e.pull.checks.pending = 0;
      const load = e.stateStore.load.bind(e.stateStore); let revoked = false;
      e.stateStore.load = async () => {
        const snapshot = await load();
        if (!revoked && snapshot.state.deliveries.some(d => d.attempts > 0)) {
          revoked = true; assert.equal((await revoke(a.clientId, a.tokens.access_token)).status, 200);
        }
        return snapshot;
      };
      assert.equal(await e.bridge.reconcile('final-check'), 'blocked'); assert.equal(e.posts(), 0);
      assert.equal((await e.stateStore.load()).state.subscription, undefined);
    });
    await t.test('revocation at subscription persistence cannot activate stale authority', async () => {
      const a = await authorize('subscribe-race'); const e = events(a.auth);
      e.onSave(async () => { e.onSave(); assert.equal((await revoke(a.clientId, a.tokens.access_token)).status, 200); });
      await assert.rejects(e.bridge.subscribe(a.auth, target, delivery));
      assert.equal((await e.stateStore.load()).state.subscription, undefined); assert.equal(e.posts(), 0);
    });
    await t.test('grant expiry blocks access, refresh and provider reads independently of JWT expiry', async () => {
      const a = await authorize('grant-expired'); const e = events(a.auth); await e.bridge.subscribe(a.auth, target, delivery);
      const raw = JSON.parse(redis.values.get(oauthGrantKey(a.identity))!); raw.expiresAt = 1;
      redis.values.set(oauthGrantKey(a.identity), JSON.stringify(raw)); const before = e.reads();
      await assert.rejects(verifier.verifyAccessToken(a.tokens.access_token));
      assert.equal((await refresh(a.clientId, a.tokens.refresh_token)).status, 400);
      assert.equal(await e.bridge.reconcile('expired-grant'), 'blocked'); assert.equal(e.reads(), before); assert.equal(e.posts(), 0);
    });
    await t.test('consent and code exchange fail closed on unavailable or lost grant authority', async () => {
      const clientId = await register('consent-unavailable'); redis.unavailable = true;
      const denied = await form('/oauth/authorize', { response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: 'conductor.read', code_challenge_method: 'S256', code_challenge: challenge }, { cookie });
      assert.notEqual(denied.status, 303); redis.unavailable = false;
      assert.equal(await grants.read({ issuer: origin, subject: 'owner', clientId }), null);
      for (const mode of ['missing', 'unavailable', 'revoked']) {
        const client = await register(`code-${mode}`); const code = await consent(client);
        const identity = { issuer: origin, subject: 'owner', clientId: client };
        if (mode === 'missing') redis.values.delete(oauthGrantKey(identity));
        if (mode === 'unavailable') redis.unavailable = true;
        if (mode === 'revoked') await grants.revoke(identity, (await grants.read(identity))!.generation);
        assert.equal((await exchange(client, code)).status, 400); redis.unavailable = false;
        assert.equal((await exchange(client, code)).status, 400); // Code stays consumed; no authority reconstruction.
      }
    });
    await t.test('lost write acknowledgment cannot report successful revocation', async () => {
      const a = await authorize('uncertain-revoke'); redis.ambiguousWrite = true;
      assert.equal((await revoke(a.clientId, a.tokens.access_token)).status, 401); redis.ambiguousWrite = false;
      assert.equal((await grants.read(a.identity))?.status, 'revoked'); await assert.rejects(verifier.verifyAccessToken(a.tokens.access_token));
    });
    await t.test('logout clears only owner session; metadata advertises the implemented revoke endpoint', async () => {
      const a = await authorize('logout'); const response = await fetch(`${origin}/logout`, { headers: { cookie }, redirect: 'manual' });
      assert.equal(response.status, 303); await verifier.verifyAccessToken(a.tokens.access_token);
      assert.equal((await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()).revocation_endpoint, `${origin}/oauth/revoke`);
    });
  } finally {
    redis.unavailable = false; redis.ambiguousWrite = false;
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resetAuthorizationCodeStoreForTests();
  }
});
