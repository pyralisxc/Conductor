import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { SignJWT, decodeJwt } from 'jose';
import * as z from 'zod/v4';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createConfiguredPrEvents } from '../src/config/pr-events.js';
import { createConfiguredHttpHandler } from '../src/config/http-handler.js';
import { ConductorToolRuntime } from '../src/runtime/runtime.js';
import { PrEvents, RedisPrEventStore, prEventCatalog, PR_EVENT } from '../src/runtime/pr-events.js';
import { RedisOAuthGrantStore } from '../src/transport/oauth-grant-store.js';
import { GitHubRuntimeProvider } from '../src/providers/github.js';
import { GitHubAppCredentialProvider } from '../src/connections/github/app-installation.js';
import { VersionedProviderCredentialVault } from '../src/connections/universal/credential-vault.js';
import { derivedSecret } from '../src/transport/owner-auth.js';

const preview = { VERCEL_ENV: 'preview', CONDUCTOR_PR_EVENTS_DISCOVERY_ONLY: 'true' };

test('discovery configuration is explicit, Preview-only, exclusive and does not read live dependencies', () => {
  const runtime = new ConductorToolRuntime();
  const reads: string[] = [];
  const env = new Proxy(preview, { get(target, key: string) {
    reads.push(key);
    if (!['VERCEL_ENV', 'CONDUCTOR_PR_EVENTS_DISCOVERY_ONLY', 'CONDUCTOR_PR_EVENTS_JSON'].includes(key)) throw new Error('Live dependency configuration accessed');
    return target[key as keyof typeof target];
  } });
  assert.equal(createConfiguredPrEvents(runtime, env), 'discovery-only');
  assert.deepEqual(reads, ['CONDUCTOR_PR_EVENTS_DISCOVERY_ONLY', 'VERCEL_ENV', 'CONDUCTOR_PR_EVENTS_JSON']);
  assert.equal(createConfiguredPrEvents(runtime, {}), undefined);
  for (const mode of ['', 'false', '1', 'TRUE', 'invalid']) assert.throws(() => createConfiguredPrEvents(runtime, { ...preview, CONDUCTOR_PR_EVENTS_DISCOVERY_ONLY: mode }), /explicitly true/);
  for (const host of [undefined, 'production', 'development']) assert.throws(() => createConfiguredPrEvents(runtime, { ...preview, VERCEL_ENV: host }), /limited to Preview/);
  for (const live of ['', '{}', 'invalid']) assert.throws(() => createConfiguredPrEvents(runtime, { ...preview, CONDUCTOR_PR_EVENTS_JSON: live }), /mutually exclusive/);
});

test('live configuration still initializes only with its full prerequisites', () => {
  const runtime = new ConductorToolRuntime();
  const config = JSON.stringify({ target: { repository: 'owner/private', pullRequestNumber: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, owner: { issuer: 'https://issuer.example', subject: 'owner', clientId: 'private-client' }, installationId: 123, callbackHostname: 'receiver.example' });
  const env = { VERCEL_ENV: 'preview', CONDUCTOR_PR_EVENTS_JSON: config };
  assert.throws(() => createConfiguredPrEvents(runtime, env), /require existing shared storage/);
  assert.throws(() => createConfiguredPrEvents(runtime, { ...env, VERCEL_ENV: 'production' }), /limited to Preview/);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const live = createConfiguredPrEvents(runtime, { ...env, UPSTASH_REDIS_REST_URL: 'https://unused.example', UPSTASH_REDIS_REST_TOKEN: 'test-only',
    CONDUCTOR_GITHUB_APP_ID: '123', CONDUCTOR_GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    CONDUCTOR_GITHUB_WEBHOOK_SECRET: 'test-only-webhook-secret'.repeat(3), CONDUCTOR_PROVIDER_CREDENTIAL_KEY: 'test-only-vault-key'.repeat(3) });
  assert.ok(live instanceof PrEvents);
  const parsed = JSON.parse(config); delete parsed.callbackHostname;
  parsed.delegatedRecipient = { clientFingerprint: createHash('sha256').update(parsed.owner.clientId).digest('hex') };
  delete parsed.owner.clientId;
  const delegated = createConfiguredPrEvents(runtime, { ...env, CONDUCTOR_PR_EVENTS_JSON: JSON.stringify(parsed),
    UPSTASH_REDIS_REST_URL: 'https://unused.example', UPSTASH_REDIS_REST_TOKEN: 'test-only',
    CONDUCTOR_GITHUB_APP_ID: '123', CONDUCTOR_GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    CONDUCTOR_GITHUB_WEBHOOK_SECRET: 'test-only-webhook-secret'.repeat(3), CONDUCTOR_PROVIDER_CREDENTIAL_KEY: 'test-only-vault-key'.repeat(3) });
  assert.ok(delegated instanceof PrEvents);
  // Retired project relationship configuration must not widen the exact-PR runtime.
  assert.throws(() => createConfiguredPrEvents(runtime, { ...env,
    CONDUCTOR_PR_EVENTS_JSON: JSON.stringify({ mode: 'projects', owner: { issuer: 'https://issuer.example', subject: 'owner' }, clientFingerprint: 'a'.repeat(64), relationships: [{ id: '00000000-0000-4000-8000-000000000007', repository: 'owner/another-repo', integrationBranch: 'vercel-preview', installationId: 123, expiresAt: 1800000000000 }] }) }), /Invalid input|invalid/i);
  parsed.owner.clientId = 'body-identity-not-needed';
  assert.throws(() => createConfiguredPrEvents(runtime, { ...env, CONDUCTOR_PR_EVENTS_JSON: JSON.stringify(parsed) }));

});

test('actual configured HTTP discovery uses ordinary OAuth and no live event operations', async t => {
  const oldEnv = { ...process.env };
  const relevant = (key: string) => /^(CONDUCTOR_|UPSTASH_|KV_|VERCEL|GITHUB_TOKEN|DEVINT_)/.test(key);
  for (const key of Object.keys(process.env).filter(relevant)) delete process.env[key];
  Object.assign(process.env, preview, { CONDUCTOR_OWNER_PASSWORD: 'local-owner-password', CONDUCTOR_SESSION_SECRET: 'local-discovery-session-secret'.repeat(3) });
  t.after(() => { for (const key of Object.keys(process.env).filter(relevant)) delete process.env[key]; for (const [key, value] of Object.entries(oldEnv)) if (relevant(key)) process.env[key] = value; });
  let forbiddenCalls = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('Live event dependency invoked'); };
  for (const method of ['list', 'subscribe', 'unsubscribe', 'ingest', 'reconcile'] as const) t.mock.method(PrEvents.prototype, method, forbidden);
  for (const method of ['load', 'save'] as const) t.mock.method(RedisPrEventStore.prototype, method, forbidden);
  for (const method of ['read', 'consent', 'revoke'] as const) t.mock.method(RedisOAuthGrantStore.prototype, method, forbidden);
  for (const method of ['getPullRequestStatus', 'getPullRequestReviewState'] as const) t.mock.method(GitHubRuntimeProvider.prototype, method, forbidden);
  for (const method of ['getCredential', 'getRepositoryAttestation'] as const) t.mock.method(GitHubAppCredentialProvider.prototype, method, forbidden);
  for (const method of ['seal', 'open'] as const) t.mock.method(VersionedProviderCredentialVault.prototype, method, forbidden);
  const realFetch = globalThis.fetch;
  let externalRequests = 0;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : String(input)).hostname !== '127.0.0.1') { externalRequests++; throw new Error('External request forbidden'); }
    return realFetch(input, init);
  });
  let handler!: ReturnType<typeof createConfiguredHttpHandler>;
  const http = createServer((req, res) => { void handler(req, res); }); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => new Promise<void>(resolve => http.close(() => resolve())));
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`; process.env.CONDUCTOR_PUBLIC_URL = origin;
  process.env.VERCEL_ENV = 'production';
  assert.throws(() => createConfiguredHttpHandler(), /limited to Preview/);
  process.env.VERCEL_ENV = 'preview';
  handler = createConfiguredHttpHandler(); // No event/Redis/App/vault credentials exist.
  const token = (patch: Record<string, unknown> = {}) => new SignJWT({ token_use: 'access', scope: 'conductor.read', client_id: 'discovery-client',
    iss: origin, aud: `${origin}/mcp`, sub: 'owner', exp: Math.floor(Date.now() / 1000) + 3600, ...patch }).setProtectedHeader({ alg: 'HS256' }).sign(derivedSecret('oauth-token'));
  const jwt = await token();
  const rpc = (method: string, params: unknown, bearer?: string) => fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  for (const method of ['server/discover', 'events/list', 'events/subscribe', 'events/unsubscribe']) assert.equal((await rpc(method, {})).status, 401);
  for (const bad of ['invalid-jwt', await token({ iss: 'https://foreign.example' }), await token({ aud: 'https://foreign.example/mcp' }), await token({ sub: 'other-owner' }), await token({ scope: 'other.read' }), await token({ exp: 1 }), await token({ grant_generation: '1:00000000-0000-4000-8000-000000000001' })]) {
    assert.equal((await rpc('events/list', {}, bad)).status, 401);
  }
  const malformed = await fetch(`${origin}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28' }, body: '{invalid' });
  assert.ok(malformed.status >= 400);
  assert.equal((await fetch(`${origin}/events/github`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: '{}' })).status, 404);
  const client = new Client({ name: 'discovery-proof', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const exchanges: string[] = [];
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${jwt}` } }, fetch: async (input, init) => { const response = await fetch(input, init); exchanges.push(await response.clone().text()); return response; } }));
  t.after(() => client.close());
  assert.match(exchanges[0], /2026-07-28/); assert.match(exchanges[0], /"events":\{\}/);
  const schema = z.looseObject({});
  const catalog = await client.request({ method: 'events/list', params: {} }, schema);
  assert.deepEqual(catalog.events, prEventCatalog().events);
  assert.deepEqual(Object.keys(catalog).sort(), ['_meta', 'events']);
  assert.deepEqual(catalog._meta, { 'io.modelcontextprotocol/serverInfo': { name: 'conductor', version: '0.1.0' } });
  assert.doesNotMatch(JSON.stringify(catalog), /owner\/private|discovery-client|receiver\.example|local-owner|local-discovery|grant_generation/);
  await assert.rejects(client.request({ method: 'events/list', params: { cursor: 'unsupported' } }, schema));
  const sample = { name: PR_EVENT, arguments: { repository: 'owner/private', pullRequestNumber: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret: `whsec_${Buffer.alloc(32).toString('base64')}` } };
  for (const method of ['events/subscribe', 'events/unsubscribe']) for (const params of [sample, {}, { delivery: { url: 'http://169.254.169.254/secret', secret: {} } }, { name: [], arguments: null }, undefined]) {
    await assert.rejects(client.request({ method, ...(params === undefined ? {} : { params }) }, schema), (error: unknown) => {
      assert.equal((error as { code: number }).code, -32000);
      assert.deepEqual((error as { data: unknown }).data, { reason: 'events_not_enabled' }); return true;
    });
  }
  const tools = await client.listTools(); assert.ok(tools.tools.some(tool => tool.name === 'capabilities'));
  assert.notEqual((await client.callTool({ name: 'capabilities', arguments: {} })).isError, true);
  // No new grant/revoke behavior is advertised by the discovery flag.
  const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
  assert.equal(metadata.revocation_endpoint, undefined);
  const registration = await fetch(`${origin}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'local-discovery-test', redirect_uris: ['https://chatgpt.com/connector_platform/oauth_redirect'] }) });
  assert.equal(registration.status, 201);
  const registered = await registration.json() as { client_id: string };
  const refresh = await token({ token_use: 'refresh', client_id: registered.client_id });
  const exchange = (clientId: string) => fetch(`${origin}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh }) });
  assert.equal((await exchange('other-client')).status, 400);
  const refreshed = await exchange(registered.client_id); assert.equal(refreshed.status, 200);
  const tokens = await refreshed.json() as { access_token: string; refresh_token: string };
  assert.equal(decodeJwt(tokens.access_token).grant_generation, undefined);
  assert.equal(decodeJwt(tokens.refresh_token).grant_generation, undefined);
  assert.equal(forbiddenCalls, 0); assert.equal(externalRequests, 0);
});

test('delegated recipient config is explicit, exclusive, and Preview-only', () => {
  const runtime = new ConductorToolRuntime();
  const base = { target: { repository: 'owner/private', pullRequestNumber: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, owner: { issuer: 'https://issuer.example', subject: 'owner', clientId: 'private-client' }, installationId: 123 };
  const delegatedRecipient = { clientFingerprint: '0'.repeat(64) };
  for (const config of [{ ...base }, { ...base, delegatedRecipient: true }, { ...base, delegatedRecipient: { ...delegatedRecipient, activation: {} } }, { ...base, delegatedRecipient: { ...delegatedRecipient, enabled: true } }, { ...base, delegatedRecipient, callbackHostname: 'receiver.example' }]) {
    assert.throws(() => createConfiguredPrEvents(runtime, { VERCEL_ENV: 'preview', CONDUCTOR_PR_EVENTS_JSON: JSON.stringify(config) }));
  }
  for (const env of ['production', 'development', undefined]) assert.throws(() => createConfiguredPrEvents(runtime, { VERCEL_ENV: env, CONDUCTOR_PR_EVENTS_JSON: JSON.stringify({ ...base, delegatedRecipient }) }), /limited to Preview/);
  assert.throws(() => createConfiguredPrEvents(runtime, { ...preview, CONDUCTOR_PR_EVENTS_JSON: JSON.stringify({ ...base, delegatedRecipient }) }), /mutually exclusive/);
});


test('event integration branch is a strict server-only enum', () => {
  const runtime = new ConductorToolRuntime();
  const config = { target: { repository: 'owner/private', pullRequestNumber: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, owner: { issuer: 'https://issuer.example', subject: 'owner', clientId: 'private-client' }, installationId: 123, callbackHostname: 'receiver.example' };
  for (const integrationBranch of ['preview', 'vercel-preview', undefined]) {
    assert.throws(() => createConfiguredPrEvents(runtime, { VERCEL_ENV: 'preview', CONDUCTOR_PR_EVENTS_JSON: JSON.stringify({ ...config, integrationBranch }) }), /require existing shared storage/);
  }
  for (const integrationBranch of ['main', 'master', 'arbitrary', 'Preview', 'refs/heads/preview', '*', '']) {
    assert.throws(() => createConfiguredPrEvents(runtime, { VERCEL_ENV: 'preview', CONDUCTOR_PR_EVENTS_JSON: JSON.stringify({ ...config, integrationBranch }) }), /Invalid option/);
  }
});
