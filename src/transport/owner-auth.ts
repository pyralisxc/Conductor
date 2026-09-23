import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const SESSION_COOKIE = 'conductor_owner';
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sessionSecret(): string {
  const value = process.env.CONDUCTOR_SESSION_SECRET?.trim() ?? '';
  if (value.length < 32) {
    throw Object.assign(new Error('CONDUCTOR_SESSION_SECRET must contain at least 32 characters'), { status: 503 });
  }
  return value;
}

export function derivedSecret(purpose: string): Uint8Array {
  return createHmac('sha256', sessionSecret())
    .update(`conductor/${purpose}/v1`)
    .digest();
}

function sessionTtlSeconds(): number {
  const parsed = Number(process.env.CONDUCTOR_SESSION_TTL_SECONDS ?? DEFAULT_SESSION_TTL_SECONDS);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_TTL_SECONDS;
  return Math.min(Math.max(Math.floor(parsed), 300), 7 * 24 * 60 * 60);
}

function sessionSignature(expiresAt: number): string {
  return createHmac('sha256', derivedSecret('owner-session'))
    .update(`owner:${expiresAt}`)
    .digest('base64url');
}

function cookies(req: IncomingMessage): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    result.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return result;
}

export function ownerSessionValid(req: IncomingMessage): boolean {
  try {
    const value = cookies(req).get(SESSION_COOKIE);
    if (!value) return false;
    const [expiresRaw, signature, extra] = value.split('.');
    const expiresAt = Number(expiresRaw);
    if (extra !== undefined || !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000) || !signature) return false;
    return safeEqual(signature, sessionSignature(expiresAt));
  } catch {
    return false;
  }
}

export function ownerPasswordMatches(candidate: string): boolean {
  const expected = process.env.CONDUCTOR_OWNER_PASSWORD?.trim() ?? '';
  if (!expected) return false;
  return safeEqual(candidate, expected);
}

export function setOwnerSession(res: ServerResponse): void {
  const ttl = sessionTtlSeconds();
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const secure = process.env.CONDUCTOR_COOKIE_SECURE !== '0';
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=${expiresAt}.${sessionSignature(expiresAt)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${ttl}`,
    ...(secure ? ['Secure'] : []),
  ].join('; '));
}

export function clearOwnerSession(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function normalizeReturnTo(value: string | null): string {
  if (!value || (!value.startsWith('/oauth/authorize?') && value !== '/connections/vercel')) return '/login';
  try {
    const parsed = new URL(value, 'https://conductor.local');
    return parsed.origin === 'https://conductor.local' && (parsed.pathname === '/oauth/authorize' || (parsed.pathname === '/connections/vercel' && !parsed.search))
      ? `${parsed.pathname}${parsed.search}`
      : '/login';
  } catch {
    return '/login';
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

export function renderOwnerLogin(returnTo: string, error?: string): string {
  const message = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in — Conductor</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#090b10;color:#f3f5f8}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 12%,#262135 0,#090b10 48%)}.card{width:min(460px,calc(100vw - 28px));border:1px solid #393346;background:#111019e8;border-radius:18px;padding:26px;box-shadow:0 26px 70px #0008}.mark{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#2b2340;border:1px solid #5b4b78;color:#e0d3ff;font-weight:800}.eyebrow{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#9a8bac;margin-top:20px}h1{font-size:24px;margin:7px 0}p{color:#aaa2b6;font-size:13px;line-height:1.55}label{display:block;font-size:12px;margin:18px 0 7px}input{width:100%;border:1px solid #453c54;background:#0c0b11;color:#fff;border-radius:10px;padding:12px}button{width:100%;margin-top:14px;border:1px solid #6e5a91;background:#392d52;color:#f7f1ff;border-radius:10px;padding:11px;font-weight:700;cursor:pointer}.error{color:#ffb9b9}</style></head><body><main class="card"><div class="mark">C</div><div class="eyebrow">Single-owner authorization</div><h1>Sign in to Conductor</h1><p>Use the private owner password configured for this deployment.</p>${message}<form method="post" action="/login"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><label for="password">Owner password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">Continue</button></form></main></body></html>`;
}
