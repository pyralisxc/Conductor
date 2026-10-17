import { Redis } from '@upstash/redis';
import { ConductorToolError } from './errors.js';
import type { ExecutionReceipt } from './types.js';
import type { IdempotencyClaim, IdempotencyRecord, IdempotencyStore } from './idempotency.js';
import { assertCommitCheckpoint, type CommitCheckpoint } from './commit-checkpoint.js';

export interface RedisIdempotencyStoreOptions {
  url: string;
  token: string;
  ttlSeconds?: number;
  prefix?: string;
  redis?: Pick<Redis, 'get' | 'set' | 'eval'>;
}

export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly redis: Pick<Redis, 'get' | 'set' | 'eval'>;
  private readonly ttlSeconds: number;
  private readonly prefix: string;

  constructor(options: RedisIdempotencyStoreOptions) {
    this.redis = options.redis ?? new Redis({ url: options.url, token: options.token, enableTelemetry: false });
    this.ttlSeconds = options.ttlSeconds ?? 7 * 24 * 60 * 60;
    this.prefix = options.prefix ?? 'conductor:idempotency:';
  }

  async claim(record: IdempotencyRecord): Promise<IdempotencyClaim> {
    const key = this.key(record.key);
    const claimed = await this.redis.set(key, { ...record, expiresAt: this.expiry() }, { nx: true, ex: this.ttlSeconds });
    if (claimed === 'OK') return { status: 'claimed' };
    const existing = await this.redis.get<IdempotencyRecord>(key);
    if (!existing) return await this.claim(record);
    if (existing.fingerprint !== record.fingerprint) return { status: 'conflict', record: existing };
    return existing.state === 'completed'
      ? { status: 'replay', record: existing }
      : { status: 'in-progress', record: existing };
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    return await this.redis.get<IdempotencyRecord>(this.key(key));
  }

  async checkpoint(key: string, fingerprint: string, operationId: string, value: CommitCheckpoint, updatedAt: string): Promise<IdempotencyRecord> {
    const current = await this.get(key);
    if (!current || current.fingerprint !== fingerprint || current.operationId !== operationId || current.state === 'completed') throw this.conflict();
    assertCommitCheckpoint(value, current.checkpoint);
    const record: IdempotencyRecord = { ...current, checkpoint: value, updatedAt, expiresAt: this.expiry(), revision: (current.revision ?? 0) + 1 };
    const script = `
      local current = redis.call('GET', KEYS[1])
      if not current then return 0 end
      local decoded = cjson.decode(current)
      if decoded.fingerprint ~= ARGV[1] or decoded.operationId ~= ARGV[2] then return -1 end
      if decoded.state == 'completed' or (decoded.revision or 0) ~= tonumber(ARGV[3]) then return -1 end
      redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[5])
      return 1
    `;
    const result = await this.redis.eval(script, [this.key(key)], [fingerprint, operationId, String(current.revision ?? 0), JSON.stringify(record), String(this.ttlSeconds)]);
    if (result !== 1) throw this.conflict();
    return record;
  }

  async complete(
    key: string,
    fingerprint: string,
    receipt: ExecutionReceipt<unknown>,
  ): Promise<ExecutionReceipt<unknown>> {
    const current = await this.get(key);
    if (!current || current.fingerprint !== fingerprint || current.operationId !== receipt.operationId) throw this.conflict();
    const record: IdempotencyRecord = { ...current, state: 'completed', receipt, updatedAt: receipt.finishedAt, expiresAt: this.expiry(), revision: (current.revision ?? 0) + 1 };
    const script = `
      local current = redis.call('GET', KEYS[1])
      if not current then return 0 end
      local decoded = cjson.decode(current)
      if decoded.fingerprint ~= ARGV[1] or decoded.operationId ~= ARGV[2] then return -1 end
      if decoded.state == 'completed' then return current end
      if (decoded.revision or 0) ~= tonumber(ARGV[3]) then return -1 end
      redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[5])
      return ARGV[4]
    `;
    const result = await this.redis.eval(
      script,
      [this.key(key)],
      [fingerprint, receipt.operationId, String(current.revision ?? 0), JSON.stringify(record), String(this.ttlSeconds)],
    );
    if (typeof result === 'number' || result === null) throw this.conflict();
    const completed = (typeof result === 'string' ? JSON.parse(result) : result) as IdempotencyRecord;
    if (!completed.receipt || completed.operationId !== receipt.operationId) throw this.conflict();
    return completed.receipt;
  }

  private key(value: string): string {
    return `${this.prefix}${value}`;
  }

  private expiry(): string {
    return new Date(Date.now() + this.ttlSeconds * 1000).toISOString();
  }

  private conflict(): ConductorToolError {
    return new ConductorToolError({ code: 'CONFLICT', message: 'Durable idempotency update did not match the active operation', source: 'idempotency' });
  }
}
