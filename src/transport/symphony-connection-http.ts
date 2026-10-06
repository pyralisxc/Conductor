import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { derivedSecret, ownerSessionValid } from './owner-auth.js';
import {
  connectSymphonyRuntimeCredential,
  disconnectSymphonyRuntimeCredential,
  symphonyRuntimeCredentialConnected,
  type SymphonyRuntimeCredentialBinding,
} from '../connections/symphony/runtime-connection.js';

const csrfTtlSeconds = 15 * 60;
type Action = 'connect' | 'disconnect';

function signature(action: Action, expiresAt: number): string {
  return createHmac('sha256', derivedSecret('symphony-connection-csrf')).update(`${action}:${expiresAt}`).digest('base64url');
}

function csrf(action: Action, now = Date.now()): string {
  const expiresAt = Math.floor(now / 1000) + csrfTtlSeconds;
  return `${expiresAt}.${signature(action, expiresAt)}`;
}

function csrfValid(action: Action, token: string, now = Date.now()): boolean {
  const [expiry, supplied, extra] = token.split('.');
  const expiresAt = Number(expiry);
  if (extra !== undefined || !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000) || expiresAt > Math.floor(now / 1000) + csrfTtlSeconds || !supplied) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(signature(action, expiresAt));
  return left.length === right.length && timingSafeEqual(left, right);
}

async function formBody(req: IncomingMessage): Promise<URLSearchParams> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) throw Object.assign(new Error('Expected a form submission'), { status: 415 });
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 8192) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  return new URLSearchParams(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function page(body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Symphony connection — Conductor</title><style>body{font:16px system-ui;background:#101019;color:#eee;max-width:42rem;margin:3rem auto;padding:0 1rem}section{background:#1b1b29;border:1px solid #484459;border-radius:12px;padding:1.5rem}button{background:#514371;color:white;border:0;border-radius:8px;padding:.7rem 1rem;cursor:pointer}input{max-width:100%;padding:.5rem}small{color:#beb8cd}</style><section><h1>Worker runtime</h1>${body}</section></html>`;
}

function respond(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end();
}

export interface SymphonyConnectionHttpOptions {
  binding?: SymphonyRuntimeCredentialBinding & { endpoint: string };
}

export async function handleSymphonyConnectionRequest(req: IncomingMessage, res: ServerResponse, url: URL, options: SymphonyConnectionHttpOptions): Promise<boolean> {
  if (!url.pathname.startsWith('/connections/symphony')) return false;
  if (!ownerSessionValid(req)) {
    if (req.method === 'GET') redirect(res, '/login?returnTo=%2Fconnections%2Fsymphony');
    else respond(res, 401, page('<p>Owner sign-in is required.</p>'));
    return true;
  }
  const binding = options.binding;
  if (!binding) {
    respond(res, 503, page('<p>No Symphony runtime binding is configured for this Conductor deployment.</p>'));
    return true;
  }
  try {
    if (url.pathname === '/connections/symphony' && req.method === 'GET') {
      const connected = await symphonyRuntimeCredentialConnected(binding);
      const identity = `<p><strong>${escapeHtml(binding.repository)}</strong><br><small>${escapeHtml(binding.endpoint)}</small></p>`;
      const controls = connected
        ? `<p>Authenticated runtime credential: connected.</p><form method="post" action="/connections/symphony/disconnect"><input type="hidden" name="csrf" value="${csrf('disconnect')}"><button>Disconnect credential</button></form>`
        : `<p>Authenticated runtime credential: not connected.</p><form method="post" action="/connections/symphony/connect"><input type="hidden" name="csrf" value="${csrf('connect')}"><label>Symphony API token <input type="password" name="token" autocomplete="off" required></label> <button>Connect runtime</button></form>`;
      respond(res, 200, page(identity + controls));
      return true;
    }
    if (url.pathname === '/connections/symphony/connect' && req.method === 'POST') {
      const form = await formBody(req);
      if (!csrfValid('connect', form.get('csrf') ?? '')) { respond(res, 403, page('<p>Connection form expired.</p>')); return true; }
      const token = form.get('token')?.trim() ?? '';
      if (token.length < 16 || token.length > 4096 || /[\u0000-\u001f\u007f]/u.test(token)) { respond(res, 400, page('<p>Invalid runtime credential.</p>')); return true; }
      await connectSymphonyRuntimeCredential(binding, token);
      redirect(res, '/connections/symphony');
      return true;
    }
    if (url.pathname === '/connections/symphony/disconnect' && req.method === 'POST') {
      const form = await formBody(req);
      if (!csrfValid('disconnect', form.get('csrf') ?? '')) { respond(res, 403, page('<p>Connection form expired.</p>')); return true; }
      await disconnectSymphonyRuntimeCredential(binding);
      redirect(res, '/connections/symphony');
      return true;
    }
    res.writeHead(405, { allow: url.pathname.endsWith('/connect') || url.pathname.endsWith('/disconnect') ? 'POST' : 'GET' });
    res.end();
  } catch (error) {
    const status = (error as { status?: number }).status ?? 502;
    respond(res, status, page(`<p>${escapeHtml(error instanceof Error ? error.message : 'Connection failed')}</p>`));
  }
  return true;
}
