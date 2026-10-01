import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { derivedSecret, ownerSessionValid } from './owner-auth.js';
import { oauthPublicBaseUrl } from './oauth.js';
import {
  connectVercelRuntimeCredential,
  consumeVercelConnectionState,
  createVercelConnectionState,
  disconnectVercelInstallation,
  disconnectVercelRuntimeCredential,
  listVercelInstallationMetadata,
  storeVercelInstallation,
  vercelConnectionOAuthConfiguration,
  vercelRuntimeCredentialConnected,
} from '../connections/vercel/installation.js';

const csrfTtlSeconds = 15 * 60;

type ConnectionAction = 'start' | 'disconnect' | 'runtime-connect' | 'runtime-disconnect';

function csrfSignature(action: ConnectionAction, expiresAt: number): string {
  return createHmac('sha256', derivedSecret('vercel-connection-csrf'))
    .update(`${action}:${expiresAt}`)
    .digest('base64url');
}

export function vercelConnectionCsrfToken(action: ConnectionAction, now = Date.now()): string {
  const expiresAt = Math.floor(now / 1000) + csrfTtlSeconds;
  return `${expiresAt}.${csrfSignature(action, expiresAt)}`;
}

export function vercelConnectionCsrfValid(action: ConnectionAction, token: string, now = Date.now()): boolean {
  const [expiry, signature, extra] = token.split('.');
  const expiresAt = Number(expiry);
  if (extra !== undefined || !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)
    || expiresAt > Math.floor(now / 1000) + csrfTtlSeconds || !signature) return false;
  const actual = Buffer.from(signature);
  const expected = Buffer.from(csrfSignature(action, expiresAt));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function formBody(req: IncomingMessage): Promise<URLSearchParams> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
    throw Object.assign(new Error('Expected a form submission'), { status: 415 });
  }
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 4096) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  return new URLSearchParams(body);
}

function respond(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://vercel.com; base-uri 'none'",
  });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function page(body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vercel connections — Conductor</title><style>body{font:16px system-ui;background:#101019;color:#eee;max-width:42rem;margin:3rem auto;padding:0 1rem}section{background:#1b1b29;border:1px solid #484459;border-radius:12px;padding:1.5rem}button{background:#514371;color:white;border:0;border-radius:8px;padding:.7rem 1rem;cursor:pointer}li{margin:1rem 0}small{color:#beb8cd}</style><section><h1>Vercel connections</h1>${body}</section></html>`;
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end();
}

export async function handleVercelConnectionRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/connections/vercel')) return false;
  if (!ownerSessionValid(req)) {
    if (req.method === 'GET') redirect(res, '/login?returnTo=%2Fconnections%2Fvercel');
    else respond(res, 401, page('<p>Owner sign-in is required.</p>'));
    return true;
  }
  try {
    const { slug, clientId, clientSecret } = vercelConnectionOAuthConfiguration();
    if (url.pathname === '/connections/vercel' && req.method === 'GET') {
      const installations = await listVercelInstallationMetadata();
      const runtimeConnected = await vercelRuntimeCredentialConnected();
      const disconnectCsrf = vercelConnectionCsrfToken('disconnect');
      const list = installations.length ? `<ul>${installations.map(item => `<li>${escapeHtml(item.teamId ?? 'Personal account')} <small>(${escapeHtml(item.configurationId)})</small><form method="post" action="/connections/vercel/disconnect"><input type="hidden" name="csrf" value="${disconnectCsrf}"><input type="hidden" name="configurationId" value="${escapeHtml(item.configurationId)}"><button>Disconnect locally</button></form></li>`).join('')}</ul>` : '<p>No Vercel account is connected.</p>';
      const runtime = runtimeConnected
        ? `<p>Runtime-log direct access: connected.</p><form method="post" action="/connections/vercel/runtime/disconnect"><input type="hidden" name="csrf" value="${vercelConnectionCsrfToken('runtime-disconnect')}"><button>Disconnect runtime-log access</button></form>`
        : `<p>Runtime-log direct access: not connected.</p><form method="post" action="/connections/vercel/runtime"><input type="hidden" name="csrf" value="${vercelConnectionCsrfToken('runtime-connect')}"><label>Vercel access token <input type="password" name="token" autocomplete="off" required></label> <button>Connect runtime-log access</button></form>`;
      respond(res, 200, page(`${list}<p>Authorize an account or team in Vercel. Access remains scoped to the chosen installation.</p><form method="post" action="/connections/vercel/start"><input type="hidden" name="csrf" value="${vercelConnectionCsrfToken('start')}"><button>Connect Vercel</button></form><hr>${runtime}`));
      return true;
    }
    if (url.pathname === '/connections/vercel/start' && req.method === 'POST') {
      const form = await formBody(req);
      if (!vercelConnectionCsrfValid('start', form.get('csrf') ?? '')) { respond(res, 403, page('<p>Connection form expired. Return to connections and try again.</p>')); return true; }
      const state = randomBytes(32).toString('base64url');
      await createVercelConnectionState(state);
      const authorize = new URL(`https://vercel.com/integrations/${slug}/new`);
      authorize.searchParams.set('state', state);
      redirect(res, authorize.toString());
      return true;
    }
    if (url.pathname === '/connections/vercel/disconnect' && req.method === 'POST') {
      const form = await formBody(req);
      if (!vercelConnectionCsrfValid('disconnect', form.get('csrf') ?? '')) { respond(res, 403, page('<p>Connection form expired. Return to connections and try again.</p>')); return true; }
      const id = form.get('configurationId') ?? '';
      if (!/^icfg_[\w-]+$/u.test(id)) { respond(res, 400, page('<p>Invalid connection.</p>')); return true; }
      await disconnectVercelInstallation(id);
      redirect(res, '/connections/vercel');
      return true;
    }
    if (url.pathname === '/connections/vercel/runtime' && req.method === 'POST') {
      const form = await formBody(req);
      if (!vercelConnectionCsrfValid('runtime-connect', form.get('csrf') ?? '')) { respond(res, 403, page('<p>Connection form expired. Return to connections and try again.</p>')); return true; }
      const runtimeToken = form.get('token')?.trim() ?? '';
      if (runtimeToken.length < 20 || runtimeToken.length > 1024 || /[\u0000-\u001f\u007f]/u.test(runtimeToken)) { respond(res, 400, page('<p>Invalid Vercel access token.</p>')); return true; }
      await connectVercelRuntimeCredential(runtimeToken);
      redirect(res, '/connections/vercel');
      return true;
    }
    if (url.pathname === '/connections/vercel/runtime/disconnect' && req.method === 'POST') {
      const form = await formBody(req);
      if (!vercelConnectionCsrfValid('runtime-disconnect', form.get('csrf') ?? '')) { respond(res, 403, page('<p>Connection form expired. Return to connections and try again.</p>')); return true; }
      await disconnectVercelRuntimeCredential();
      redirect(res, '/connections/vercel');
      return true;
    }
    if (url.pathname === '/connections/vercel/callback' && req.method === 'GET') {
      const state = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code') ?? '';
      const configurationId = url.searchParams.get('configurationId') ?? '';
      if (!/^[\w-]{30,100}$/u.test(state) || !code || !/^icfg_[\w-]+$/u.test(configurationId)
        || !(await consumeVercelConnectionState(state))) {
        respond(res, 400, page('<p>Connection request expired or was not recognized. Start again from Conductor.</p>'));
        return true;
      }
      const callback = `${oauthPublicBaseUrl()}/connections/vercel/callback`;
      const response = await fetch('https://api.vercel.com/v2/oauth/access_token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callback }),
      });
      const payload = await response.json() as { access_token?: string; team_id?: string | null };
      if (!response.ok || !payload.access_token) throw new Error('Vercel did not authorize this connection');
      const teamId = payload.team_id ?? null;
      const returnedTeam = url.searchParams.get('teamId');
      if (returnedTeam && returnedTeam !== teamId) throw new Error('Vercel account selection changed during authorization');
      await storeVercelInstallation({
        configurationId,
        teamId,
        connectedAt: new Date().toISOString(),
        token: payload.access_token,
      });
      redirect(res, '/connections/vercel');
      return true;
    }
    res.writeHead(405, { allow: url.pathname === '/connections/vercel/start' || url.pathname === '/connections/vercel/disconnect' || url.pathname === '/connections/vercel/runtime' || url.pathname === '/connections/vercel/runtime/disconnect' ? 'POST' : 'GET' });
    res.end();
  } catch (error) {
    const status = (error as { status?: number }).status ?? 502;
    respond(res, status, page(`<p>${escapeHtml(error instanceof Error ? error.message : 'Connection failed')}</p><p><a href="/connections/vercel">Return to connections</a></p>`));
  }
  return true;
}
