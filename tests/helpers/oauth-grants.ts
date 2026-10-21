import type { Redis } from '@upstash/redis';
import { RedisOAuthGrantStore, GRANT_TRANSITION_SCRIPT, oauthGrantKey, type GrantIdentity, type OAuthGrant } from '../../src/transport/oauth-grant-store.js';

/** Atomic-response Redis model, not a Lua interpreter or live Redis evidence. */
export class GrantRedisFixture {
  values = new Map<string, string>();
  unavailable = false;
  ambiguousWrite = false;
  beforeEval?: () => void;
  async get(key: string) {
    if (this.unavailable) throw new Error('Redis unavailable');
    return this.values.get(key) ?? null;
  }
  async eval(script: string, keys: string[], args: (string | number)[]) {
    if (this.unavailable) throw new Error('Redis unavailable');
    this.beforeEval?.();
    const current = this.values.get(keys[0]);
    if ((current ?? '') !== args[0]) return null;
    if (script !== GRANT_TRANSITION_SCRIPT) {
      // Model the event-record CAS against the same grant authority atomically.
      if (!script.includes("redis.call('GET', KEYS[2])")) throw new Error('Missing atomic grant read');
      if (args[3] !== '') {
        let grant;
        try { grant = JSON.parse(this.values.get(keys[1]) ?? 'null'); } catch { return 0; }
        if (!grant || grant.status !== 'active' || grant.generation !== args[3] || grant.expiresAt <= Math.max(Number(args[2]), Date.now()) || Number(args[4]) <= Math.max(Number(args[2]), Date.now())) return 0;
      }
      this.values.set(keys[0], String(args[1])); return 1;
    }
    if (JSON.parse(String(args[1])).expiresAt <= Date.now()) throw new Error('Grant expired before write');
    const counter = this.values.get(keys[1]);
    if (current && (!counter || Number(counter) !== Number(JSON.parse(current).generation.split(':')[0]))) throw new Error('Grant counter missing or reset');
    const n = Number(counter ?? 0) + 1;
    this.values.set(keys[1], String(n));
    const record = JSON.parse(String(args[1])); record.generation = `${n}:${args[2]}`;
    const result = JSON.stringify(record); this.values.set(keys[0], result);
    if (this.ambiguousWrite) throw new Error('Write acknowledgment lost');
    return result;
  }
  store() { return new RedisOAuthGrantStore(this as unknown as Redis); }
  seed(identity: GrantIdentity, generation: string, expiresAt: number) {
    const record: OAuthGrant = { schemaVersion: 1, identity, generation, status: 'active', scopes: ['conductor.read'], expiresAt, updatedAt: Date.now(), reason: 'owner-consent' };
    this.values.set(oauthGrantKey(identity), JSON.stringify(record));
    this.values.set(`${oauthGrantKey(identity)}:generation`, generation.split(':')[0]);
  }
}
