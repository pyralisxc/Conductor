import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  assertOAuthConfiguration,
  ConductorToolRuntime,
  createConductorHttpHandler,
  handleOAuthHttpRequest,
  resetAuthorizationCodeStoreForTests,
  SelfHostedAccessTokenVerifier,
} from '../src/index.js';

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie');
  if (!value || !value.includes('conductor_owner=')) throw new Error('Expected Conductor owner session cookie');
  return value.split(';')[0]!;
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, 'close');
}

test('self-hosted OAuth supports ChatGPT DCR, PKCE, refresh, and exact MCP access', async () => {
  const keys = [
    'CONDUCTOR_PUBLIC_URL',
    'CONDUCTOR_OWNER_PASSWORD',
    'CONDUCTOR_SESSION_SECRET',
    'CONDUCTOR_COOKIE_SECURE',
    'CONDUCTOR_OAUTH_ALLOWED_REDIRECT_ORIGINS',
    'CONDUCTOR_OAUTH_ALLOW_LOOPBACK',
    'CONDUCTOR_REQUIRE_SHARED_OAUTH_STATE',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'KV_REST_API_URL',
    'KV_REST_API_TOKEN',
    'VERCEL',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.CONDUCTOR_OWNER_PASSWORD = 'owner-test-password';
  process.env.CONDUCTOR_SESSION_SECRET = 'conductor-oauth-session-secret-long-enough-for-tests';
  process.env.CONDUCTOR_COOKIE_SECURE = '0';
  resetAuthorizationCodeStoreForTests();

  let handler: ReturnType<typeof createConductorHttpHandler> | undefined;
  const server = createServer((request, response) => {
    if (!handler) throw new Error('HTTP handler is not ready');
    void handler(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  process.env.CONDUCTOR_PUBLIC_URL = origin;
  assertOAuthConfiguration();
  handler = createConductorHttpHandler({
    runtime: new ConductorToolRuntime({ createOperationId: () => 'op-oauth' }),
    publicUrl: origin,
    oauthIssuer: origin,
    verifier: new SelfHostedAccessTokenVerifier(),
    handleOAuthRequest: handleOAuthHttpRequest,
  });

  const redirectUri = 'https://chatgpt.com/connector/oauth/conductor-test';
  const codeVerifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
  const challenge = createHash('sha256').update(codeVerifier).digest('base64url');

  try {
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);

    const resourceResponse = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(resourceResponse.status, 200);
    const resource = await resourceResponse.json() as Record<string, unknown>;
    assert.equal(resource.resource, `${origin}/mcp`);
    assert.deepEqual(resource.authorization_servers, [origin]);
    assert.deepEqual(resource.scopes_supported, ['conductor.read']);

    const discoveryResponse = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    assert.equal(discoveryResponse.status, 200);
    const discovery = await discoveryResponse.json() as Record<string, unknown>;
    assert.equal(discovery.issuer, origin);
    assert.equal(discovery.authorization_endpoint, `${origin}/oauth/authorize`);
    assert.equal(discovery.token_endpoint, `${origin}/oauth/token`);
    assert.equal(discovery.registration_endpoint, `${origin}/oauth/register`);
    assert.deepEqual(discovery.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(discovery.grant_types_supported, ['authorization_code', 'refresh_token']);

    const denied = await fetch(`${origin}/mcp`, { method: 'POST' });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate') ?? '', /oauth-protected-resource\/mcp/u);

    const attackerRegistration = await fetch(`${origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://attacker.example/callback'] }),
    });
    assert.equal(attackerRegistration.status, 400);

    const registrationResponse = await fetch(`${origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        application_type: 'web',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(registrationResponse.status, 201);
    const registration = await registrationResponse.json() as { client_id: string };
    assert.match(registration.client_id, /^coc\./u);

    const authorizeUrl = new URL(`${origin}/oauth/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', registration.client_id);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', 'conductor.read offline_access');
    authorizeUrl.searchParams.set('state', 'test-state');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const authorizeWithoutOwner = await fetch(authorizeUrl, { redirect: 'manual' });
    assert.equal(authorizeWithoutOwner.status, 303);
    assert.match(authorizeWithoutOwner.headers.get('location') ?? '', /^\/login\?returnTo=/u);

    const badLogin = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'wrong', returnTo: `${authorizeUrl.pathname}${authorizeUrl.search}` }),
    });
    assert.equal(badLogin.status, 401);

    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'owner-test-password', returnTo: `${authorizeUrl.pathname}${authorizeUrl.search}` }),
    });
    assert.equal(login.status, 303);
    const cookie = cookieFrom(login);

    const consent = await fetch(authorizeUrl, { headers: { cookie } });
    assert.equal(consent.status, 200);
    assert.match(await consent.text(), /Authorize Conductor/u);

    const approval = await fetch(`${origin}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        response_type: 'code',
        client_id: registration.client_id,
        redirect_uri: redirectUri,
        scope: 'conductor.read offline_access',
        state: 'test-state',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    });
    assert.equal(approval.status, 303);
    const callback = new URL(approval.headers.get('location')!);
    assert.equal(callback.origin + callback.pathname, redirectUri);
    assert.equal(callback.searchParams.get('state'), 'test-state');
    assert.equal(callback.searchParams.get('iss'), origin);
    const code = callback.searchParams.get('code');
    assert.ok(code);

    const tokenResponse = await fetch(`${origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registration.client_id,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
    assert.match(tokens.access_token, /^[\w-]+\.[\w-]+\.[\w-]+$/u);
    assert.match(tokens.refresh_token, /^[\w-]+\.[\w-]+\.[\w-]+$/u);

    const replay = await fetch(`${origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registration.client_id,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });
    assert.equal(replay.status, 400);

    const client = new Client({ name: 'oauth-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ['capabilities', 'preflight_project']);
    const capabilities = await client.callTool({ name: 'capabilities', arguments: {} });
    assert.equal((capabilities.structuredContent as { receipt: { operationId: string } }).receipt.operationId, 'op-oauth');
    await client.close();

    const refreshResponse = await fetch(`${origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: registration.client_id,
        refresh_token: tokens.refresh_token,
      }),
    });
    assert.equal(refreshResponse.status, 200);
    const refreshed = await refreshResponse.json() as { access_token: string; refresh_token: string };
    assert.notEqual(refreshed.access_token, tokens.access_token);
    assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
  } finally {
    await close(server);
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAuthorizationCodeStoreForTests();
  }
});

test('horizontally scaled OAuth configuration fails closed without shared code state', () => {
  const previous = {
    VERCEL: process.env.VERCEL,
    CONDUCTOR_PUBLIC_URL: process.env.CONDUCTOR_PUBLIC_URL,
    CONDUCTOR_OWNER_PASSWORD: process.env.CONDUCTOR_OWNER_PASSWORD,
    CONDUCTOR_SESSION_SECRET: process.env.CONDUCTOR_SESSION_SECRET,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
  process.env.VERCEL = '1';
  process.env.CONDUCTOR_PUBLIC_URL = 'https://conductor.example.com';
  process.env.CONDUCTOR_OWNER_PASSWORD = 'owner-test-password';
  process.env.CONDUCTOR_SESSION_SECRET = 'conductor-vercel-secret-long-enough';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  resetAuthorizationCodeStoreForTests();
  try {
    assert.throws(() => assertOAuthConfiguration(), /Shared OAuth authorization-code state is required/u);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAuthorizationCodeStoreForTests();
  }
});
