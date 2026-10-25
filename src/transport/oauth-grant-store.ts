import { createHash, randomUUID } from 'node:crypto';
import { Redis } from '@upstash/redis';
import * as z from 'zod/v4';

export interface GrantIdentity { issuer: string; subject: string; clientId: string }
const identitySchema = z.object({ issuer: z.string().min(1).max(2048), subject: z.string().min(1).max(200), clientId: z.string().min(1).max(4096) }).strict();
export const grantGenerationSchema = z.string().regex(/^[1-9][0-9]*:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const recordSchema = z.object({
  schemaVersion: z.literal(1), identity: identitySchema, status: z.enum(['active', 'revoked']),
  generation: grantGenerationSchema, scopes: z.array(z.enum(['conductor.read', 'conductor.write', 'offline_access'])).min(1).max(3),
  expiresAt: z.number().int().positive(), updatedAt: z.number().int().positive(), reason: z.enum(['owner-consent', 'client-revoked']),
}).strict();
export type OAuthGrant = z.infer<typeof recordSchema>;
export interface OAuthGrantStore {
  read(identity: GrantIdentity): Promise<OAuthGrant | null>;
  consent(identity: GrantIdentity, scopes: string[], expiresAt: number): Promise<OAuthGrant>;
  revoke(identity: GrantIdentity, generation: string): Promise<void>;
}
export function oauthGrantKey(identity: GrantIdentity): string {
  identitySchema.parse(identity);
  return `conductor:oauth:grant:v1:${createHash('sha256').update(JSON.stringify([identity.issuer, identity.subject, identity.clientId])).digest('hex')}`;
}
export function parseOAuthGrant(value: unknown, identity: GrantIdentity): OAuthGrant {
  const grant = recordSchema.parse(value);
  if (oauthGrantKey(grant.identity) !== oauthGrantKey(identity)) throw new Error('OAuth grant identity mismatch');
  if (new Set(grant.scopes).size !== grant.scopes.length) throw new Error('Invalid OAuth grant scopes');
  return grant;
}
export async function requireOAuthGrant(store: OAuthGrantStore, identity: GrantIdentity, generation: unknown, scopes: string[] = ['conductor.read'], now: () => number = Date.now): Promise<OAuthGrant> {
  const checkedGeneration = grantGenerationSchema.parse(generation);
  const raw = await store.read(identity);
  if (!raw) throw new Error('OAuth grant is unavailable');
  const grant = parseOAuthGrant(raw, identity);
  if (grant.status !== 'active' || grant.generation !== checkedGeneration || grant.expiresAt <= now() || scopes.some(scope => !grant.scopes.includes(scope as OAuthGrant['scopes'][number]))) throw new Error('OAuth grant is inactive');
  return grant;
}

// The high-water counter deliberately has NO TTL. A random generation suffix also
// prevents identity reuse after complete storage loss; missing grants never authorize.
// Restoring an old active snapshot is different: operators must invalidate the
// restored grants (and signing authority) before serving traffic after a restore.
export const GRANT_TRANSITION_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if (current or '') ~= ARGV[1] then return false end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local candidate = cjson.decode(ARGV[2])
if candidate.expiresAt <= now then return redis.error_reply('Grant expired before write') end
local counter = redis.call('GET', KEYS[2])
if current and (not counter or tonumber(counter) ~= tonumber(string.match(cjson.decode(current).generation, '^([0-9]+):'))) then return redis.error_reply('Grant counter missing or reset') end
local n = redis.call('INCR', KEYS[2])
if n > 9007199254740990 then return redis.error_reply('Grant generation exhausted') end
redis.call('PERSIST', KEYS[2])
local record = candidate
record.generation = tostring(n) .. ':' .. ARGV[3]
local encoded = cjson.encode(record)
redis.call('SET', KEYS[1], encoded)
return encoded`;
export class RedisOAuthGrantStore implements OAuthGrantStore {
  constructor(private readonly redis: Redis) {}
  private async snapshot(identity: GrantIdentity) {
    const value = await this.redis.get<string>(oauthGrantKey(identity));
    const raw = value === null ? null : typeof value === 'string' ? value : JSON.stringify(value);
    return { raw, grant: raw ? parseOAuthGrant(JSON.parse(raw), identity) : null };
  }
  async read(identity: GrantIdentity) { return (await this.snapshot(identity)).grant; }
  private async transition(identity: GrantIdentity, scopes: string[], expiresAt: number, generation?: string): Promise<OAuthGrant> {
    const current = await this.snapshot(identity);
    const now = Date.now();
    if (generation && (!current.grant || current.grant.status !== 'active' || current.grant.generation !== generation || current.grant.expiresAt <= now)) throw new Error('OAuth grant changed');
    const record = parseOAuthGrant({ schemaVersion: 1, identity,
      status: generation ? 'revoked' : 'active', generation: `1:${randomUUID()}`,
      scopes: [...new Set(scopes)].sort(), expiresAt, updatedAt: now, reason: generation ? 'client-revoked' : 'owner-consent',
    }, identity);
    if (expiresAt <= now) throw new Error('OAuth grant expiry is invalid');
    const key = oauthGrantKey(identity);
    const incarnation = randomUUID();
    const result = await this.redis.eval(GRANT_TRANSITION_SCRIPT, [key, `${key}:generation`], [current.raw ?? '', JSON.stringify(record), incarnation]);
    if (result) {
      const confirmed = parseOAuthGrant(typeof result === 'string' ? JSON.parse(result) : result, identity);
      if (confirmed.status !== record.status || !confirmed.generation.endsWith(`:${incarnation}`)) throw new Error('Grant write not confirmed');
      return confirmed;
    }

    throw new Error('OAuth grant changed; retry consent');
  }
  async consent(identity: GrantIdentity, scopes: string[], expiresAt: number) { return this.transition(identity, scopes, expiresAt); }
  async revoke(identity: GrantIdentity, generation: string) {
    const grant = await requireOAuthGrant(this, identity, generation);
    await this.transition(identity, grant.scopes, grant.expiresAt, generation);
  }
}
export function oauthGrantStore(environment: NodeJS.ProcessEnv = process.env): OAuthGrantStore {
  const url = environment.UPSTASH_REDIS_REST_URL ?? environment.KV_REST_API_URL;
  const token = environment.UPSTASH_REDIS_REST_TOKEN ?? environment.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Shared OAuth grant authority is required');
  return new RedisOAuthGrantStore(new Redis({ url, token, enableTelemetry: false, automaticDeserialization: false }));
}
