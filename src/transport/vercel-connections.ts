import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Redis } from '@upstash/redis';
import { derivedSecret, ownerSessionValid } from './owner-auth.js';
import { oauthPublicBaseUrl } from './oauth.js';

type Installation = { configurationId: string; teamId: string | null; connectedAt: string; token: string };
const prefix = 'conductor:vercel:connection:v1';
const stateTtl = 600;

function configuration(): { redis: Redis; slug: string; clientId: string; clientSecret: string } {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  const slug = process.env.CONDUCTOR_VERCEL_INTEGRATION_SLUG;
  const clientId = process.env.CONDUCTOR_VERCEL_CLIENT_ID;
  const clientSecret = process.env.CONDUCTOR_VERCEL_CLIENT_SECRET;
  if (!url || !token || !slug || !clientId || !clientSecret) {
    throw Object.assign(new Error('Vercel connection requires Redis and integration slug, client ID, and client secret'), { status: 503 });
  }
  if (!/^[a-z0-9-]+$/u.test(slug)) throw new Error('Invalid Vercel integration slug');
  return { redis: new Redis({ url, token, enableTelemetry: false }), slug, clientId, clientSecret };
}

function encrypt(value: Installation): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedSecret('vercel-installation'), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(buffer => buffer.toString('base64url')).join('.');
}

function decrypt(value: string): Installation {
  const [iv, tag, ciphertext] = value.split('.').map(part => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !ciphertext) throw new Error('Invalid Vercel connection record');
  const decipher = createDecipheriv('aes-256-gcm', derivedSecret('vercel-installation'), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as Installation;
}

export async function vercelInstallationToken(configurationId: string, teamId?: string): Promise<string | undefined> {
  const record = await configuration().redis.get<string>(`${prefix}:installation:${configurationId}`);
  if (!record) return undefined;
  const installation = decrypt(record);
  if ((installation.teamId ?? undefined) !== teamId) return undefined;
  return installation.token;
}

function respond(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
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

function sameOrigin(req: IncomingMessage): boolean {
  return req.headers.origin === oauthPublicBaseUrl();
}

export async function handleVercelConnectionRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/connections/vercel')) return false;
  if (!ownerSessionValid(req)) {
    if (req.method === 'GET') redirect(res, '/login?returnTo=%2Fconnections%2Fvercel');
    else respond(res, 401, page('<p>Owner sign-in is required.</p>'));
    return true;
  }
  try {
    const { redis, slug, clientId, clientSecret } = configuration();
    if (url.pathname === '/connections/vercel' && req.method === 'GET') {
      const ids = await redis.smembers<string[]>(`${prefix}:ids`);
      const records = await Promise.all(ids.map(id => redis.get<string>(`${prefix}:installation:${id}`)));
      const installations = records.flatMap(record => record ? [decrypt(record)] : []);
      const list = installations.length ? `<ul>${installations.map(item => `<li>${escapeHtml(item.teamId ?? 'Personal account')} <small>(${escapeHtml(item.configurationId)})</small><form method="post" action="/connections/vercel/disconnect"><input type="hidden" name="configurationId" value="${escapeHtml(item.configurationId)}"><button>Disconnect locally</button></form></li>`).join('')}</ul>` : '<p>No Vercel account is connected.</p>';
      respond(res, 200, page(`${list}<p>Authorize an account or team in Vercel. Access remains scoped to the chosen installation.</p><form method="post" action="/connections/vercel/start"><button>Connect Vercel</button></form>`));
      return true;
    }
    if (url.pathname === '/connections/vercel/start' && req.method === 'POST') {
      if (!sameOrigin(req)) { respond(res, 403, page('<p>Request origin was not accepted.</p>')); return true; }
      const state = randomBytes(32).toString('base64url');
      await redis.set(`${prefix}:state:${state}`, 'pending', { ex: stateTtl, nx: true });
      const authorize = new URL(`https://vercel.com/integrations/${slug}/new`);
      authorize.searchParams.set('state', state);
      redirect(res, authorize.toString());
      return true;
    }
    if (url.pathname === '/connections/vercel/disconnect' && req.method === 'POST') {
      if (!sameOrigin(req)) { respond(res, 403, page('<p>Request origin was not accepted.</p>')); return true; }
      let body = '';
      for await (const chunk of req) {
        body += String(chunk);
        if (body.length > 4096) { respond(res, 413, page('<p>Request too large.</p>')); return true; }
      }
      const id = new URLSearchParams(body).get('configurationId') ?? '';
      if (!/^icfg_[\w-]+$/u.test(id)) { respond(res, 400, page('<p>Invalid connection.</p>')); return true; }
      await redis.del(`${prefix}:installation:${id}`);
      await redis.srem(`${prefix}:ids`, id);
      redirect(res, '/connections/vercel');
      return true;
    }
    if (url.pathname === '/connections/vercel/callback' && req.method === 'GET') {
      const state = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code') ?? '';
      const configurationId = url.searchParams.get('configurationId') ?? '';
      if (!/^[\w-]{30,100}$/u.test(state) || !code || !/^icfg_[\w-]+$/u.test(configurationId)
        || await redis.getdel(`${prefix}:state:${state}`) !== 'pending') {
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
      await redis.set(`${prefix}:installation:${configurationId}`, encrypt({ configurationId, teamId, connectedAt: new Date().toISOString(), token: payload.access_token }));
      await redis.sadd(`${prefix}:ids`, configurationId);
      redirect(res, '/connections/vercel');
      return true;
    }
    res.writeHead(405, { allow: url.pathname === '/connections/vercel/start' || url.pathname === '/connections/vercel/disconnect' ? 'POST' : 'GET' });
    res.end();
  } catch (error) {
    const status = (error as { status?: number }).status ?? 502;
    respond(res, status, page(`<p>${escapeHtml(error instanceof Error ? error.message : 'Connection failed')}</p><p><a href="/connections/vercel">Return to connections</a></p>`));
  }
  return true;
}
