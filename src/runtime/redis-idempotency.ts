import { Redis } from '@upstash/redis';
import { ConductorToolError } from './errors.js';
import type { ExecutionReceipt } from './types.js';
import type { IdempotencyClaim, IdempotencyRecord, IdempotencyStore } from './idempotency.js';

export interface RedisIdempotencyStoreOptions {
  url: string;
  token: string;
  ttlSeconds?: number;
  prefix?: string;
}

export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;
  private readonly prefix: string;

  constructor(options: RedisIdempotencyStoreOptions) {
    this.redis = new Redis({ url: options.url, token: options.token, enableTelemetry: false });
    this.ttlSeconds = options.ttlSeconds ?? 7 * 24 * 60 * 60;
    this.prefix = options.prefix ?? 'conductor:idempotency:';
  }

  async claim(record: IdempotencyRecord): Promise<IdempotencyClaim> {
    const key = this.key(record.key);
    const claimed = await this.redis.set(key, record, { nx: true, ex: this.ttlSeconds });
    if (claimed === 'OK') return { status: 'claimed' };
    const existing = await this.redis.get<IdempotencyRecord>(key);
    if (!existing) return await this.claim(record);
    if (existing.fingerprint !== record.fingerprint) return { status: 'conflict', record: existing };
    return existing.state === 'completed'
      ? { status: 'replay', record: existing }
      : { status: 'in-progress', record: existing };
  }

  async complete(
    key: string,
    fingerprint: string,
    receipt: ExecutionReceipt<unknown>,
  ): Promise<void> {
    const record: IdempotencyRecord = {
      key,
      fingerprint,
      operationId: receipt.operationId,
      startedAt: receipt.startedAt,
      state: 'completed',
      receipt,
    };
    const script = `
      local current = redis.call('GET', KEYS[1])
      if not current then return 0 end
      local decoded = cjson.decode(current)
      if decoded.fingerprint ~= ARGV[1] then return -1 end
      redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
      return 1
    `;
    const result = await this.redis.eval(
      script,
      [this.key(key)],
      [fingerprint, JSON.stringify(record), String(this.ttlSeconds)],
    ) as number;
    if (result !== 1) {
      throw new ConductorToolError({
        code: 'CONFLICT',
        message: 'Durable idempotency completion did not match the active claim',
        source: 'idempotency',
      });
    }
  }

  private key(value: string): string {
    return `${this.prefix}${value}`;
  }
}
