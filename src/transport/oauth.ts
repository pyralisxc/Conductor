import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { authInfoFromJwt, CONDUCTOR_READ_SCOPE, CONDUCTOR_WRITE_SCOPE, type AccessTokenVerifier } from './auth.js';
import { derivedSecret, sessionSecret } from './owner-auth.js';
import {
  sharedAuthorizationStateConfigured,
  sharedAuthorizationStateRequired,
  storeAuthorizationCode,
  takeAuthorizationCode,
} from './oauth-code-store.js';

const DEFAULT_REDIRECT_ORIGINS = ['https://chatgpt.com'];
const AUTHORIZATION_CODE_TTL_SECONDS = 300;
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  clientName: string;
  grantTypes: string[];
  responseTypes: string[];
  applicationType?: string;
}

interface SignedClientPayload {
  v: 1;
  iat: number;
  redirectUris: string[];
  clientName: string;
  grantTypes: string[];
  responseTypes: string[];
  applicationType?: string;
}

export interface OAuthAuthorizationRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  state?: string;
  codeChallenge: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizedOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('CONDUCTOR_PUBLIC_URL must not include credentials, query strings, or fragments');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('CONDUCTOR_PUBLIC_URL must be an origin without a path');
  }
  const loopback = parsed.hostname === '127.0.0.1'
    || parsed.hostname === 'localhost'
    || parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
    throw new Error('CONDUCTOR_PUBLIC_URL must use HTTPS outside loopback development');
  }
  return parsed.origin;
}

export function oauthPublicBaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const previewHostname = environment.VERCEL === '1' && environment.VERCEL_ENV === 'preview'
    ? environment.VERCEL_BRANCH_URL?.trim() || environment.VERCEL_URL?.trim()
    : '';
  const value = previewHostname
    ? `https://${previewHostname}`
    : environment.CONDUCTOR_PUBLIC_URL?.trim();
  if (!value) throw Object.assign(new Error('CONDUCTOR_PUBLIC_URL is required'), { status: 503 });
  try {
    return normalizedOrigin(value);
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 503 });
  }
}

export function oauthResourceUrl(): string {
  return `${oauthPublicBaseUrl()}/mcp`;
}

function allowedRedirectOrigins(): string[] {
  const raw = process.env.CONDUCTOR_OAUTH_ALLOWED_REDIRECT_ORIGINS?.trim();
  const values = raw ? raw.split(',').map((value) => value.trim()).filter(Boolean) : DEFAULT_REDIRECT_ORIGINS;
  return values.map((value) => new URL(value).origin);
}

function validateRedirectUri(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw Object.assign(new Error('redirect_uri must be an absolute URL'), { status: 400, oauthError: 'invalid_redirect_uri' });
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw Object.assign(new Error('redirect_uri must not contain credentials or a fragment'), { status: 400, oauthError: 'invalid_redirect_uri' });
  }
  const loopback = parsed.hostname === '127.0.0.1'
    || parsed.hostname === 'localhost'
    || parsed.hostname === '::1';
  if (loopback && parsed.protocol === 'http:' && process.env.CONDUCTOR_OAUTH_ALLOW_LOOPBACK === '1') {
    return parsed.toString();
  }
  if (parsed.protocol !== 'https:' || !allowedRedirectOrigins().includes(parsed.origin)) {
    throw Object.assign(new Error(`redirect_uri origin is not allowed: ${parsed.origin}`), { status: 400, oauthError: 'invalid_redirect_uri' });
  }
  return parsed.toString();
}

function parseStringArray(value: unknown, name: string, fallback: string[]): string[] {
  const actual = value === undefined ? fallback : value;
  if (!Array.isArray(actual) || actual.length === 0 || actual.some((item) => typeof item !== 'string' || !item)) {
    throw Object.assign(new Error(`${name} must be a non-empty string array`), { status: 400, oauthError: 'invalid_client_metadata' });
  }
  return actual as string[];
}

function clientSigningSecret(): Buffer {
  return Buffer.from(derivedSecret('oauth-client'));
}

function signClient(payload: SignedClientPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', clientSigningSecret())
    .update(`coc.${encoded}`)
    .digest('base64url');
  return `coc.${encoded}.${signature}`;
}

function signedClient(clientId: string): RegisteredClient | null {
  const [prefix, encoded, signature, extra] = clientId.split('.');
  if (prefix !== 'coc' || !encoded || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', clientSigningSecret())
    .update(`coc.${encoded}`)
    .digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedClientPayload;
    if (payload.v !== 1 || !Number.isFinite(payload.iat) || !Array.isArray(payload.redirectUris) || !payload.clientName) return null;
    return {
      clientId,
      redirectUris: payload.redirectUris,
      clientName: payload.clientName,
      grantTypes: payload.grantTypes,
      responseTypes: payload.responseTypes,
      ...(payload.applicationType ? { applicationType: payload.applicationType } : {}),
    };
  } catch {
    return null;
  }
}

function resolveClient(clientId: string): RegisteredClient {
  const client = signedClient(clientId);
  if (!client) throw Object.assign(new Error('Unknown OAuth client'), { status: 400, oauthError: 'invalid_client' });
  return client;
}

export function registerOAuthClient(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('OAuth client registration body must be an object'), { status: 400, oauthError: 'invalid_client_metadata' });
  }
  const record = body as Record<string, unknown>;
  const redirectUris = parseStringArray(record.redirect_uris, 'redirect_uris', []).map(validateRedirectUri);
  const grantTypes = parseStringArray(record.grant_types, 'grant_types', ['authorization_code', 'refresh_token']);
  const responseTypes = parseStringArray(record.response_types, 'response_types', ['code']);
  if (grantTypes.some((value) => value !== 'authorization_code' && value !== 'refresh_token') || !grantTypes.includes('authorization_code')) {
    throw Object.assign(new Error('Only authorization_code and refresh_token grants are supported'), { status: 400, oauthError: 'invalid_client_metadata' });
  }
  if (responseTypes.some((value) => value !== 'code')) {
    throw Object.assign(new Error('Only code response_type is supported'), { status: 400, oauthError: 'invalid_client_metadata' });
  }
  if ((record.token_endpoint_auth_method ?? 'none') !== 'none') {
    throw Object.assign(new Error('Only public PKCE clients are supported'), { status: 400, oauthError: 'invalid_client_metadata' });
  }
  const clientName = typeof record.client_name === 'string' && record.client_name.trim()
    ? record.client_name.trim().slice(0, 128)
    : 'MCP client';
  const applicationType = typeof record.application_type === 'string' ? record.application_type : undefined;
  const issuedAt = nowSeconds();
  const clientId = signClient({
    v: 1,
    iat: issuedAt,
    redirectUris,
    clientName,
    grantTypes,
    responseTypes,
    ...(applicationType ? { applicationType } : {}),
  });
  return {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: 'none',
    client_name: clientName,
    ...(applicationType ? { application_type: applicationType } : {}),
  };
}

function requestedScopes(value: string | null): string[] {
  const values = value
    ? value.split(/\s+/u).map((scope) => scope.trim()).filter(Boolean)
    : [CONDUCTOR_READ_SCOPE];
  const allowed = new Set([CONDUCTOR_READ_SCOPE, CONDUCTOR_WRITE_SCOPE, 'offline_access']);
  if (values.some((scope) => !allowed.has(scope))) {
    throw Object.assign(new Error('Requested scope is not supported'), { status: 400, oauthError: 'invalid_scope' });
  }
  if (!values.includes(CONDUCTOR_READ_SCOPE)) values.push(CONDUCTOR_READ_SCOPE);
  return [...new Set(values)];
}

export function parseOAuthAuthorizationRequest(params: URLSearchParams): OAuthAuthorizationRequest {
  const responseType = params.get('response_type');
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const codeChallenge = params.get('code_challenge') ?? '';
  if (responseType !== 'code') {
    throw Object.assign(new Error('Only response_type=code is supported'), { status: 400, oauthError: 'unsupported_response_type' });
  }
  if (!clientId) throw Object.assign(new Error('client_id is required'), { status: 400, oauthError: 'invalid_request' });
  const client = resolveClient(clientId);
  const normalizedRedirect = validateRedirectUri(redirectUri);
  if (!client.redirectUris.includes(normalizedRedirect)) {
    throw Object.assign(new Error('redirect_uri is not registered for this client'), { status: 400, oauthError: 'invalid_request' });
  }
  if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge)) {
    throw Object.assign(new Error('OAuth authorization requires PKCE S256'), { status: 400, oauthError: 'invalid_request' });
  }
  const scope = requestedScopes(params.get('scope')).join(' ');
  const state = params.get('state') ?? undefined;
  return {
    clientId,
    clientName: client.clientName,
    redirectUri: normalizedRedirect,
    scope,
    codeChallenge,
    ...(state ? { state } : {}),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

export function renderOAuthConsent(request: OAuthAuthorizationRequest): string {
  const hidden = [
    ['response_type', 'code'],
    ['client_id', request.clientId],
    ['redirect_uri', request.redirectUri],
    ['scope', request.scope],
    ['code_challenge', request.codeChallenge],
    ['code_challenge_method', 'S256'],
    ...(request.state ? [['state', request.state]] : []),
  ].map(([name, value]) => `<input type="hidden" name="${escapeHtml(name!)}" value="${escapeHtml(value!)}">`).join('');
  const redirectHost = new URL(request.redirectUri).host;
  const writeRequested = request.scope.split(/\s+/).includes(CONDUCTOR_WRITE_SCOPE);
  const accessDescription = writeRequested
    ? 'This grants read access plus bounded GitHub writes on authorized work/* branches and pull requests. Main promotion remains owner-gated.'
    : 'This grants read-only access to Conductor.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize — Conductor</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#090b10;color:#f3f5f8}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 12%,#262135 0,#090b10 48%)}.card{width:min(520px,calc(100vw - 28px));border:1px solid #393346;background:#111019e8;border-radius:18px;padding:26px;box-shadow:0 26px 70px #0008}.mark{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#2b2340;border:1px solid #5b4b78;color:#e0d3ff;font-weight:800}.eyebrow{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#9a8bac;margin-top:20px}h1{font-size:24px;margin:7px 0}p{color:#aaa2b6;font-size:13px;line-height:1.55}.box{border:1px solid #40384d;background:#0c0b11;border-radius:10px;padding:12px;margin:16px 0;font-size:12px;line-height:1.6}.box strong{color:#eee7f8}button{width:100%;border:1px solid #6e5a91;background:#392d52;color:#f7f1ff;border-radius:10px;padding:11px;font-weight:700;cursor:pointer}.note{margin-top:16px;padding-top:14px;border-top:1px solid #312b3b;color:#887d94;font-size:10px;line-height:1.45}</style></head><body><main class="card"><div class="mark">C</div><div class="eyebrow">MCP authorization</div><h1>Allow ${escapeHtml(request.clientName)}?</h1><p>${accessDescription}</p><div class="box"><strong>Client</strong>: ${escapeHtml(request.clientName)}<br><strong>Return host</strong>: ${escapeHtml(redirectHost)}<br><strong>Scope</strong>: ${escapeHtml(request.scope)}</div><form method="post" action="/oauth/authorize">${hidden}<button type="submit">Authorize Conductor</button></form><div class="note">Only approve this request if you initiated it from ChatGPT or another trusted MCP client.</div></main></body></html>`;
}

export async function issueAuthorizationCode(request: OAuthAuthorizationRequest): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  await storeAuthorizationCode(code, {
    ...request,
    expiresAt: nowSeconds() + AUTHORIZATION_CODE_TTL_SECONDS,
  }, AUTHORIZATION_CODE_TTL_SECONDS);
  return code;
}

export function authorizationRedirect(request: OAuthAuthorizationRequest, code: string): string {
  const target = new URL(request.redirectUri);
  target.searchParams.set('code', code);
  if (request.state) target.searchParams.set('state', request.state);
  target.searchParams.set('iss', oauthPublicBaseUrl());
  return target.toString();
}

function positiveInt(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), minimum), maximum) : fallback;
}

function accessTokenTtl(): number {
  return positiveInt('CONDUCTOR_OAUTH_ACCESS_TOKEN_TTL_SECONDS', ACCESS_TOKEN_TTL_SECONDS, 300, 86_400);
}

function refreshTokenTtl(): number {
  return positiveInt('CONDUCTOR_OAUTH_REFRESH_TOKEN_TTL_SECONDS', REFRESH_TOKEN_TTL_SECONDS, 3_600, 90 * 24 * 60 * 60);
}

function tokenSigningKey(): Uint8Array {
  return derivedSecret('oauth-token');
}

async function issueToken(kind: 'access' | 'refresh', clientId: string, scope: string): Promise<string> {
  const ttl = kind === 'access' ? accessTokenTtl() : refreshTokenTtl();
  return await new SignJWT({
    token_use: kind,
    scope,
    client_id: clientId,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(oauthPublicBaseUrl())
    .setAudience(oauthResourceUrl())
    .setSubject('owner')
    .setJti(randomBytes(16).toString('base64url'))
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(tokenSigningKey());
}

async function tokenResponse(clientId: string, scope: string): Promise<Record<string, unknown>> {
  return {
    access_token: await issueToken('access', clientId, scope),
    token_type: 'Bearer',
    expires_in: accessTokenTtl(),
    refresh_token: await issueToken('refresh', clientId, scope),
    scope,
  };
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) return false;
  return safeEqual(createHash('sha256').update(verifier).digest('base64url'), challenge);
}

async function verifyToken(token: string, kind: 'access' | 'refresh'): Promise<JWTPayload> {
  const verified = await jwtVerify(token, tokenSigningKey(), {
    algorithms: ['HS256'],
    issuer: oauthPublicBaseUrl(),
    audience: oauthResourceUrl(),
  });
  if (verified.payload.token_use !== kind || verified.payload.sub !== 'owner') throw new Error(`Invalid ${kind} token`);
  return verified.payload;
}

export async function exchangeOAuthToken(params: URLSearchParams): Promise<Record<string, unknown>> {
  const grantType = params.get('grant_type');
  const clientId = params.get('client_id') ?? '';
  if (!clientId) throw Object.assign(new Error('client_id is required'), { status: 400, oauthError: 'invalid_client' });
  resolveClient(clientId);
  if (grantType === 'authorization_code') {
    const record = await takeAuthorizationCode(params.get('code') ?? '');
    if (!record || record.expiresAt <= nowSeconds() || record.clientId !== clientId) {
      throw Object.assign(new Error('Authorization code is invalid or expired'), { status: 400, oauthError: 'invalid_grant' });
    }
    if ((params.get('redirect_uri') ?? '') !== record.redirectUri) {
      throw Object.assign(new Error('redirect_uri does not match the authorization request'), { status: 400, oauthError: 'invalid_grant' });
    }
    if (!pkceMatches(params.get('code_verifier') ?? '', record.codeChallenge)) {
      throw Object.assign(new Error('PKCE verification failed'), { status: 400, oauthError: 'invalid_grant' });
    }
    return await tokenResponse(clientId, record.scope);
  }
  if (grantType === 'refresh_token') {
    try {
      const payload = await verifyToken(params.get('refresh_token') ?? '', 'refresh');
      if (payload.client_id !== clientId || typeof payload.scope !== 'string') throw new Error('Refresh token client mismatch');
      return await tokenResponse(clientId, payload.scope);
    } catch {
      throw Object.assign(new Error('Refresh token is invalid or expired'), { status: 400, oauthError: 'invalid_grant' });
    }
  }
  throw Object.assign(new Error('Unsupported grant_type'), { status: 400, oauthError: 'unsupported_grant_type' });
}

export class SelfHostedAccessTokenVerifier implements AccessTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = await verifyToken(token, 'access');
    return authInfoFromJwt(token, payload, oauthResourceUrl(), [CONDUCTOR_READ_SCOPE]);
  }
}

export function oauthProtectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: oauthResourceUrl(),
    authorization_servers: [oauthPublicBaseUrl()],
    scopes_supported: [CONDUCTOR_READ_SCOPE, CONDUCTOR_WRITE_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Conductor Tool Runtime',
  };
}

export function oauthAuthorizationServerMetadata(): Record<string, unknown> {
  const base = oauthPublicBaseUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [CONDUCTOR_READ_SCOPE, CONDUCTOR_WRITE_SCOPE, 'offline_access'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  };
}

export function oauthResourceMetadataUrl(): string {
  return `${oauthPublicBaseUrl()}/.well-known/oauth-protected-resource/mcp`;
}

export function oauthWwwAuthenticate(error?: 'invalid_token'): string {
  const parts = [
    `Bearer resource_metadata="${oauthResourceMetadataUrl()}"`,
    `scope="${CONDUCTOR_READ_SCOPE}"`,
  ];
  if (error) parts.push(`error="${error}"`);
  return parts.join(', ');
}

export function assertOAuthConfiguration(): void {
  oauthPublicBaseUrl();
  sessionSecret();
  allowedRedirectOrigins();
  if (!process.env.CONDUCTOR_OWNER_PASSWORD?.trim()) {
    throw Object.assign(new Error('CONDUCTOR_OWNER_PASSWORD is required'), { status: 503 });
  }
  if (sharedAuthorizationStateRequired() && !sharedAuthorizationStateConfigured()) {
    throw Object.assign(new Error('Shared OAuth authorization-code state is required on this host'), { status: 503 });
  }
}
