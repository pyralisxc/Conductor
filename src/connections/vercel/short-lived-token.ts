import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from '@upstash/redis';
import type { VersionedProviderCredentialVault } from '../universal/credential-vault.js';

interface CachedToken { token?: string; expiresAt: number; refreshAt?: number; retryAt: number; failures: number; error?: string }
interface Options {
  redis: Redis; vault: VersionedProviderCredentialVault;
  installationKey: string; installationRecord: string;
  installationId: string; teamId: string | null; clientId: string; clientSecret: string;
  fetch?: typeof fetch; now?: () => number;
}
const endpoint = 'https://api.vercel.com/v2/oauth/access_token';
const publish = `if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('GET',KEYS[2])~=ARGV[2] then return 0 end
redis.call('SET',KEYS[3],ARGV[3]); if tonumber(ARGV[4])>0 then redis.call('PEXPIRE',KEYS[3],ARGV[4]) end; return 1`;
const unlock = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0`;
function unavailable(code = 'unavailable'): Error {
  // Never propagate provider bodies, fetch errors, credentials or Redis key material.
  return Object.assign(new Error(`Vercel installation token ${code}`), { code: 'AUTH_REQUIRED', source: 'vercel' });
}

/** Shared encrypted cache; the existing installation record remains the authority, never a token fallback. */
export async function shortLivedInstallationToken(o: Options): Promise<string> {
  const now = o.now ?? Date.now;
  const digest = createHash('sha256').update(JSON.stringify([o.clientId, o.clientSecret, o.installationRecord])).digest('hex');
  const key = `conductor:vercel:short-lived:v1:${o.installationId}:${digest}`;
  const lock = `${key}:lock`;
  const fresh = async () => {
    if (await o.redis.get<string>(o.installationKey) !== o.installationRecord) throw unavailable('connection changed');
  };
  const usable = (c: CachedToken) => typeof c.token === 'string' && c.expiresAt > now() + 5000;
  const read = async (): Promise<CachedToken> => {
    const raw = await o.redis.get<string>(key);
    if (!raw) return { expiresAt: 0, retryAt: 0, failures: 0 };
    let c: CachedToken;
    try { c = JSON.parse(o.vault.open(raw).plaintext); } catch { throw unavailable('cache invalid'); }
    if (!Number.isFinite(c.expiresAt) || !Number.isFinite(c.retryAt) || !Number.isInteger(c.failures)
      || (c.token !== undefined && typeof c.token !== 'string')) throw unavailable('cache invalid');
    return c;
  };
  // Bounded contention wait, not a refresh scheduler. The distributed lease exceeds the HTTP timeout.
  for (let attempt = 0; attempt < 100; attempt++) {
    await fresh();
    const cached = await read();
    if (cached.error === 'invalid_grant' || cached.error === 'invalid_client') throw unavailable(cached.error);
    if (cached.retryAt > now()) {
      if (usable(cached)) { await fresh(); return cached.token!; }
      throw unavailable('temporarily unavailable');
    }
    if (usable(cached) && cached.token && (cached.refreshAt ?? cached.expiresAt - 180000) > now()) { await fresh(); return cached.token; }
    const claim = randomUUID();
    if (!await o.redis.set(lock, claim, { nx: true, px: 15000 })) {
      await new Promise(resolve => setTimeout(resolve, 100)); continue;
    }
    try {
      await fresh();
      // A concurrent winner may have filled the cache between our GET and lock acquisition.
      const latest = await read();
      if (latest.error === 'invalid_grant' || latest.error === 'invalid_client') throw unavailable(latest.error);
      if (usable(latest) && latest.token && (latest.refreshAt ?? latest.expiresAt - 180000) > now()) { await fresh(); return latest.token; }
      if (latest.retryAt > now()) {
        if (usable(latest)) { await fresh(); return latest.token!; }
        throw unavailable('temporarily unavailable');
      }
      const started = now();
      let next: CachedToken;
      let response: Response | undefined;
      let body: Record<string, unknown> = {};
      try {
        response = await (o.fetch ?? fetch)(endpoint, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
          headers: { 'content-type': 'application/x-www-form-urlencoded',
            authorization: `Basic ${Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64')}` },
          body: new URLSearchParams({ grant_type: 'client_credentials', installation_id: o.installationId }),
        });
        const reader = response.body?.getReader();
        let text = '';
        if (reader) { try { for (;;) { const part = await reader.read(); if (part.done) break;
          text += Buffer.from(part.value).toString('utf8'); if (text.length > 16384) throw unavailable('response invalid');
        } } finally { await reader.cancel(); } }
        body = JSON.parse(text);
        if (!body || typeof body !== 'object') throw unavailable('response invalid');
      } catch { response = undefined; }
      if (response?.ok) {
        if (typeof body.access_token !== 'string' || !body.access_token || body.access_token.length > 8192
          || /[\u0000-\u0020\u007f]/u.test(body.access_token) || body.token_type !== 'Bearer'
          || typeof body.expires_in !== 'number' || !Number.isInteger(body.expires_in) || body.expires_in <= 5
          || body.expires_in > 3600 || body.installation_id !== o.installationId
          || (body.team_id ?? null) !== o.teamId) throw unavailable('response identity or expiry invalid');
        next = { token: body.access_token, expiresAt: started + body.expires_in * 1000, refreshAt: started + body.expires_in * 1000 - Math.min(180000, body.expires_in * 500), retryAt: 0, failures: 0 };
      } else {
        const error = body.error as { code?: unknown } | undefined;
        const code = typeof error?.code === 'string' ? error.code : 'unavailable';
        const transient = !response || response.status === 429 || response.status >= 500;
        const failures = Math.min(latest.failures + 1, 6);
        const retrySeconds = Number(response?.headers.get('retry-after'));
        const delay = Math.min(300000, Math.max(1000 * 2 ** failures,
          Number.isFinite(retrySeconds) ? retrySeconds * 1000 : 0));
        next = { ...(transient && usable(latest) ? { token: latest.token } : {}),
          expiresAt: transient ? latest.expiresAt : 0, failures,
          retryAt: now() + (transient ? delay : 60000),
          error: code === 'invalid_grant' || code === 'invalid_client' ? code : 'unavailable' };
      }
      const ttl = next.error === 'invalid_grant' || next.error === 'invalid_client' ? 0 : Math.max(60000, next.expiresAt - now(), next.retryAt - now());
      if (Number(await o.redis.eval(publish, [o.installationKey, lock, key],
        [o.installationRecord, claim, o.vault.seal(JSON.stringify(next)), ttl])) !== 1) throw unavailable('connection changed');
      await fresh();
      if (!usable(next)) throw unavailable(next.error === 'invalid_grant' || next.error === 'invalid_client' ? next.error : 'unavailable');
      return next.token!;
    } finally { await o.redis.eval(unlock, [lock], [claim]); }
  }
  throw unavailable('refresh busy');
}
