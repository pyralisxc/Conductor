import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IdempotentMutationExecutor,
  InMemoryIdempotencyStore,
  type IdempotencyRecord,
  type IdempotencyStore,
} from '../src/runtime/idempotency.js';
import type { CommitCheckpoint } from '../src/runtime/commit-checkpoint.js';
import { RedisIdempotencyStore, type RedisIdempotencyStoreOptions } from '../src/runtime/redis-idempotency.js';
import {
  TOOL_RUNTIME_CONTRACT_VERSION,
  type ExecutionReceipt,
} from '../src/runtime/types.js';

const startedAt = '2026-01-01T00:00:00.000Z';
const finishedAt = '2026-01-01T00:00:01.000Z';
const key = 'commit:conductor:recovery';
const fingerprint = 'sha256:commit-payload';
const target = { kind: 'repository' as const, id: 'pyralisxc/Conductor', ref: 'work/304-recovery' };
const mutationInput = { key, fingerprint, operation: 'git.commit.create' as const, target };
const scopedInput = { ...mutationInput, storageKey: `scope-digest:${key}`, scope: 'server-derived-scope-digest' };

function checkpoint(phase: CommitCheckpoint['phase'] = 'commit-created'): CommitCheckpoint {
  return {
    kind: 'git-commit', phase, repository: target.id, branch: target.ref,
    expectedHeadSha: 'a'.repeat(40),
    ...(phase !== 'validated' ? { parentTreeSha: 'b'.repeat(40), treeSha: 'd'.repeat(40) } : {}),
    ...(['commit-created', 'ref-update-requested', 'ref-confirmed'].includes(phase) ? { candidateCommitSha: 'c'.repeat(40) } : {}),
  };
}

function claimRecord(operationId = 'op-original'): IdempotencyRecord {
  return { key, fingerprint, operationId, startedAt, state: 'in-progress' };
}

function succeeded(operationId = 'op-original'): Extract<ExecutionReceipt<{ commitSha: string }>, { status: 'succeeded' }> {
  return {
    contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
    operationId,
    operation: mutationInput.operation,
    target,
    status: 'succeeded',
    startedAt,
    finishedAt,
    result: { commitSha: 'c'.repeat(40) },
    diagnostics: [],
    idempotency: { key, fingerprint, replayed: false },
  };
}

function failed(operationId = 'op-original'): ExecutionReceipt<never> {
  return {
    contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
    operationId,
    operation: mutationInput.operation,
    target,
    status: 'failed',
    startedAt,
    finishedAt,
    error: { code: 'TRANSIENT', message: 'Late provider response', retryable: true, diagnostics: [] },
    diagnostics: [],
    idempotency: { key, fingerprint, replayed: false },
  };
}

/**
 * Models atomic Redis responses for adapter/protocol tests. It is deliberately
 * not a Lua interpreter or evidence of behavior against a live Redis server.
 */
class FakeRedis {
  readonly records = new Map<string, IdempotencyRecord>();
  readonly evaluations: Array<{ script: string; keys: string[]; args: string[] }> = [];
  readonly sets: Array<{ key: string; ex: number }> = [];
  beforeEval?: () => void;

  async get(key: string): Promise<IdempotencyRecord | null> {
    return structuredClone(this.records.get(key) ?? null);
  }

  async set(key: string, value: IdempotencyRecord, options: { nx: boolean; ex: number }): Promise<'OK' | null> {
    this.sets.push({ key, ex: options.ex });
    if (options.nx && this.records.has(key)) return null;
    this.records.set(key, structuredClone(value));
    return 'OK';
  }

  async eval(script: string, keys: string[], args: string[]): Promise<number | string> {
    this.evaluations.push({ script, keys, args });
    const beforeEval = this.beforeEval;
    this.beforeEval = undefined;
    beforeEval?.();
    const current = this.records.get(keys[0]);
    if (!current) return 0;
    if (current.fingerprint !== args[0] || current.operationId !== args[1]) return -1;
    const nextRecord = JSON.parse(args[3]) as IdempotencyRecord;
    if (nextRecord.state === 'completed' && current.state === 'completed') return JSON.stringify(current);
    if (current.state === 'completed' || (current.revision ?? 0) !== Number(args[2])) return -1;
    this.records.set(keys[0], nextRecord);
    return nextRecord.state === 'completed' ? args[3] : 1;
  }
}

function redisStore(redis = new FakeRedis()): RedisIdempotencyStore {
  return new RedisIdempotencyStore({
    url: 'https://unused.invalid', token: 'unused-test-token', prefix: 'test:recovery:', ttlSeconds: 60,
    redis: redis as unknown as NonNullable<RedisIdempotencyStoreOptions['redis']>,
  });
}

type RecoveryStore = IdempotencyStore & Required<Pick<IdempotencyStore, 'get' | 'checkpoint'>>;
const stores: Array<{ name: string; create: () => RecoveryStore }> = [
  { name: 'in-memory', create: () => new InMemoryIdempotencyStore() },
  { name: 'Redis adapter with atomic-response fake', create: () => redisStore() },
];

for (const { name, create } of stores) {
  test(`${name}: persists only candidate metadata and advances checkpoints monotonically`, async () => {
    const store = create();
    assert.equal(await store.get(key), null);
    const record = { ...claimRecord(), scope: scopedInput.scope, operation: mutationInput.operation, target, revision: 0 };
    assert.equal((await store.claim(record)).status, 'claimed');
    const phases: CommitCheckpoint['phase'][] = ['validated', 'tree-created', 'commit-created', 'ref-update-requested', 'ref-confirmed'];
    for (const [index, phase] of phases.entries()) {
      const result = await store.checkpoint(key, fingerprint, record.operationId, checkpoint(phase), finishedAt);
      assert.equal(result.revision, index + 1);
      assert.equal(result.scope, scopedInput.scope);
      assert.equal(result.operation, mutationInput.operation);
      assert.deepEqual(result.target, target);
      assert.equal(result.updatedAt, finishedAt);
      assert.deepEqual(result.checkpoint, checkpoint(phase));
    }
    const winner = succeeded();
    assert.deepEqual(await store.complete(key, fingerprint, winner), winner);
    const completed = await store.get(key);
    assert.equal(completed?.state, 'completed');
    assert.equal(completed?.revision, phases.length + 1);
    assert.deepEqual(completed?.checkpoint, checkpoint('ref-confirmed'));
    assert.deepEqual(completed?.receipt, winner);
    await assert.rejects(store.checkpoint(key, fingerprint, record.operationId, checkpoint('ref-confirmed'), finishedAt), { code: 'CONFLICT' });
    assert.deepEqual(await store.get(key), completed);
  });

  test(`${name}: rejects source, credentials, malformed identities and checkpoint regression`, async () => {
    const invalid: Array<Record<string, unknown>> = [
      { ...checkpoint(), content: 'private source must not be persisted' },
      { ...checkpoint(), message: 'private commit message must not be persisted' },
      { ...checkpoint(), token: 'private credential must not be persisted' },
      { ...checkpoint(), candidateCommitSha: 'not-a-full-sha' },
      { ...checkpoint(), candidateCommitSha: 'e'.repeat(40) },
      { ...checkpoint(), repository: 'another/repository' },
      { ...checkpoint(), branch: 'work/another-branch' },
      { ...checkpoint(), expectedHeadSha: 'e'.repeat(40) },
      { ...checkpoint(), treeSha: 'e'.repeat(40) },
      { ...checkpoint('tree-created') },
      { ...checkpoint('validated'), phase: 'ref-update-requested' },
    ];
    for (const value of invalid) {
      const store = create();
      await store.claim(claimRecord());
      await store.checkpoint(key, fingerprint, 'op-original', checkpoint(), finishedAt);
      const before = await store.get(key);
      await assert.rejects(
        store.checkpoint(key, fingerprint, 'op-original', value as unknown as CommitCheckpoint, finishedAt),
        { code: 'CONFLICT' },
      );
      assert.deepEqual(await store.get(key), before);
    }
  });

  test(`${name}: fingerprint and operation identity fence checkpoint and completion writes`, async () => {
    const store = create();
    await store.claim(claimRecord());
    const before = await store.get(key);
    for (const [differentFingerprint, operationId] of [['sha256:other-payload', 'op-original'], [fingerprint, 'op-expired']]) {
      await assert.rejects(store.checkpoint(key, differentFingerprint, operationId, checkpoint(), finishedAt), { code: 'CONFLICT' });
      await assert.rejects(store.complete(key, differentFingerprint, succeeded(operationId)), { code: 'CONFLICT' });
      assert.deepEqual(await store.get(key), before);
    }
    await assert.rejects(store.checkpoint('missing-key', fingerprint, 'op-original', checkpoint(), finishedAt), { code: 'CONFLICT' });
    await assert.rejects(store.complete('missing-key', fingerprint, succeeded()), { code: 'CONFLICT' });
  });

  test(`${name}: checkpoint repository and branch identities have bounded lengths`, async () => {
    for (const value of [
      { ...checkpoint(), repository: `o/${'r'.repeat(255)}` },
      { ...checkpoint(), branch: `work/${'b'.repeat(251)}` },
    ]) {
      const store = create();
      await store.claim(claimRecord());
      await assert.rejects(store.checkpoint(key, fingerprint, 'op-original', value, finishedAt), { code: 'CONFLICT' });
      assert.equal((await store.get(key))?.checkpoint, undefined);
    }
    const store = create();
    await store.claim(claimRecord());
    const maximumLength = { ...checkpoint(), repository: `o/${'r'.repeat(254)}`, branch: `work/${'b'.repeat(250)}` };
    assert.deepEqual((await store.checkpoint(key, fingerprint, 'op-original', maximumLength, finishedAt)).checkpoint, maximumLength);
  });

  for (const first of [succeeded(), failed()]) {
    test(`${name}: the first ${first.status} receipt cannot be replaced by a late opposite outcome`, async () => {
      const store = create();
      await store.claim(claimRecord());
      await store.complete(key, fingerprint, first);
      const completed = await store.get(key);
      const late = first.status === 'succeeded' ? failed() : succeeded();
      assert.deepEqual(await store.complete(key, fingerprint, late), first);
      assert.deepEqual(await store.get(key), completed);
      const replay = await store.claim(claimRecord('op-retry'));
      assert.equal(replay.status, 'replay');
      if (replay.status === 'replay') assert.deepEqual(replay.record.receipt, first);
    });
  }
}

test('a late mutation caller returns the already completed winning receipt', async () => {
  const store = new InMemoryIdempotencyStore();
  let started!: () => void;
  const mutationStarted = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const canFinish = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const executor = new IdempotentMutationExecutor({
    store,
    createOperationId: () => 'op-original',
    now: () => new Date(startedAt),
  });

  const lateCaller = executor.execute(mutationInput, async () => {
    calls += 1;
    started();
    await canFinish;
    throw new Error('Transport timed out after recovery completed');
  });
  await mutationStarted;
  const winner = succeeded();
  await store.complete(key, fingerprint, winner);
  release();

  const result = await lateCaller;
  assert.equal(calls, 1);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.operationId, winner.operationId);
  assert.equal(result.finishedAt, winner.finishedAt);
  assert.deepEqual(result.result, winner.result);
  assert.deepEqual((await store.get(key))?.receipt, winner);
});

test('Redis checkpoint compare-and-set rejects a checkpoint that raced a newer phase', async () => {
  const redis = new FakeRedis();
  const store = redisStore(redis);
  await store.claim(claimRecord());
  await store.checkpoint(key, fingerprint, 'op-original', checkpoint(), startedAt);
  const redisKey = `test:recovery:${key}`;
  redis.beforeEval = () => {
    const current = redis.records.get(redisKey)!;
    redis.records.set(redisKey, { ...current, checkpoint: checkpoint('ref-confirmed'), revision: 2, updatedAt: finishedAt });
  };
  await assert.rejects(
    store.checkpoint(key, fingerprint, 'op-original', checkpoint('ref-update-requested'), finishedAt),
    { code: 'CONFLICT' },
  );
  assert.equal((await store.get(key))?.checkpoint?.phase, 'ref-confirmed');
  assert.equal((await store.get(key))?.revision, 2);
  const call = redis.evaluations.at(-1)!;
  assert.deepEqual(call.keys, [redisKey]);
  assert.deepEqual(call.args.slice(0, 3), [fingerprint, 'op-original', '1']);
  assert.equal(call.args.at(-1), '60');
  assert.equal(redis.sets.length, 1, 'only claim may use a non-scripted SET');
});

test('Redis TTL replacement fences both a stale checkpoint CAS and a late completion', async () => {
  const redis = new FakeRedis();
  const store = redisStore(redis);
  await store.claim(claimRecord());
  const redisKey = `test:recovery:${key}`;
  redis.beforeEval = () => {
    redis.records.delete(redisKey); // Expire after checkpoint read, before atomic write.
    redis.records.set(redisKey, { ...claimRecord('op-replacement'), revision: 0 });
  };
  await assert.rejects(store.checkpoint(key, fingerprint, 'op-original', checkpoint(), finishedAt), { code: 'CONFLICT' });
  const replacement = await store.get(key);
  assert.equal(replacement?.operationId, 'op-replacement');
  await assert.rejects(store.complete(key, fingerprint, succeeded()), { code: 'CONFLICT' });
  assert.deepEqual(await store.get(key), replacement);
  const winner = succeeded('op-replacement');
  assert.deepEqual(await store.complete(key, fingerprint, winner), winner);
  assert.equal((await store.get(key))?.receipt?.operationId, 'op-replacement');
});

test('Redis completion compare-and-set preserves a checkpoint written after its initial read', async () => {
  const redis = new FakeRedis();
  const store = redisStore(redis);
  await store.claim(claimRecord());
  const redisKey = `test:recovery:${key}`;
  redis.beforeEval = () => {
    redis.records.set(redisKey, { ...redis.records.get(redisKey)!, revision: 1, checkpoint: checkpoint('ref-confirmed') });
  };
  await assert.rejects(store.complete(key, fingerprint, succeeded()), { code: 'CONFLICT' });
  assert.equal((await store.get(key))?.state, 'in-progress');
  assert.equal((await store.get(key))?.checkpoint?.phase, 'ref-confirmed');
  assert.deepEqual(await store.complete(key, fingerprint, succeeded()), succeeded());
  assert.equal((await store.get(key))?.checkpoint?.phase, 'ref-confirmed');
});

test('Redis completion preserves empty receipt arrays through persistence and winning replay', async () => {
  const redis = new FakeRedis();
  const store = redisStore(redis);
  await store.claim(claimRecord());
  const receipt = { ...succeeded(), result: { commitSha: 'c'.repeat(40), files: [], nested: { warnings: [] } }, diagnostics: [] };
  assert.deepEqual(await store.complete(key, fingerprint, receipt), receipt);
  assert.deepEqual((await store.get(key))?.receipt, receipt);
  const written = JSON.parse(redis.evaluations.at(-1)!.args[3]) as IdempotencyRecord;
  assert.ok(Array.isArray(written.receipt?.diagnostics));
  assert.deepEqual(written.receipt, receipt);
  assert.deepEqual(await store.complete(key, fingerprint, failed()), receipt);
  assert.deepEqual((await store.get(key))?.receipt, receipt);
});

for (const phase of ['validated', 'commit-created'] as const) {
  test(`a tracked failure at ${phase}, before any ref request, retains a terminal known failure`, async () => {
    const store = new InMemoryIdempotencyStore();
    const executor = new IdempotentMutationExecutor({ store, createOperationId: () => 'op-original', now: () => new Date(startedAt) });
    let reconciliations = 0;
    const result = await executor.execute(scopedInput, async (progress) => {
      assert.ok(progress);
      await progress.checkpoint(checkpoint(phase));
      throw new Error('Known failure before publishing candidate');
    }, { reconcile: async () => { reconciliations += 1; return null; } });
    assert.equal(result.status, 'failed');
    assert.equal(reconciliations, 0);
    assert.equal((await store.get(scopedInput.storageKey))?.state, 'completed');
    assert.equal((await store.get(scopedInput.storageKey))?.receipt?.status, 'failed');
    assert.equal(await store.get(key), null, 'caller key is not the internal scoped storage key');
  });
}

test('a lost ref response stays unknown until read-only evidence confirms the retained candidate', async () => {
  const store = new InMemoryIdempotencyStore();
  let operationIds = 0;
  const executor = new IdempotentMutationExecutor({ store, createOperationId: () => `op-${++operationIds}`, now: () => new Date(startedAt) });
  let mutations = 0;
  let confirmed = false;
  let reconciliations = 0;
  const recovery = {
    reconcile: async (record: IdempotencyRecord) => {
      reconciliations += 1;
      assert.equal(record.checkpoint?.candidateCommitSha, 'c'.repeat(40));
      return confirmed ? { result: { commitSha: record.checkpoint!.candidateCommitSha } } : null;
    },
  };
  const unknown = await executor.execute(scopedInput, async (progress) => {
    mutations += 1;
    assert.ok(progress);
    await progress.checkpoint(checkpoint('ref-update-requested'));
    throw new Error('PATCH may have succeeded, response was lost');
  }, recovery);
  assert.equal(unknown.status, 'failed');
  if (unknown.status === 'failed') assert.equal(unknown.error.code, 'TRANSIENT');
  const incomplete = await store.get(scopedInput.storageKey);
  assert.equal(incomplete?.state, 'in-progress');
  assert.equal(incomplete?.receipt, undefined);
  assert.equal(incomplete?.scope, scopedInput.scope);

  const retry = await executor.execute(scopedInput, async () => {
    mutations += 1;
    throw new Error('Incomplete claims must never resume writes');
  }, recovery);
  assert.equal(retry.status, 'failed');
  assert.equal(mutations, 1);
  assert.equal((await store.get(scopedInput.storageKey))?.state, 'in-progress');
  const unknownStatus = await executor.status(scopedInput, recovery);
  assert.equal(unknownStatus.state, 'incomplete');
  assert.equal(unknownStatus.outcome, 'unknown');

  confirmed = true;
  const status = await executor.status(scopedInput, recovery);
  assert.equal(status.state, 'completed');
  assert.equal(status.outcome, 'succeeded');
  assert.equal(status.operationId, 'op-1');
  assert.equal(status.receipt?.idempotency?.key, key);
  assert.equal(status.receipt?.idempotency?.replayed, true);
  assert.equal(mutations, 1);
  const completed = await store.get(scopedInput.storageKey);
  const readbacks = reconciliations;
  await executor.status(scopedInput, recovery);
  assert.equal(reconciliations, readbacks, 'completed status does not query providers again');
  assert.deepEqual(await store.get(scopedInput.storageKey), completed);
});

test('a late tracked caller returns recovery success instead of its own later failure', async () => {
  const store = new InMemoryIdempotencyStore();
  const executor = new IdempotentMutationExecutor({ store, createOperationId: () => 'op-original', now: () => new Date(startedAt) });
  let started!: () => void;
  const mutationStarted = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const canFinish = new Promise<void>((resolve) => { release = resolve; });
  let confirmed = false;
  const recovery = { reconcile: async () => confirmed ? { result: { commitSha: 'c'.repeat(40) } } : null };
  const late = executor.execute(scopedInput, async (progress) => {
    assert.ok(progress);
    await progress.checkpoint(checkpoint('ref-update-requested'));
    started();
    await canFinish;
    throw new Error('Late original network failure');
  }, recovery);
  await mutationStarted;
  confirmed = true;
  const recovered = await executor.status(scopedInput, recovery);
  assert.equal(recovered.outcome, 'succeeded');
  release();
  const result = await late;
  assert.deepEqual(result, recovered.receipt);
  assert.equal((await store.get(scopedInput.storageKey))?.receipt?.status, 'succeeded');
});

test('a completion-store outage does not lose the confirmed candidate or rerun the mutation', async () => {
  class TemporarilyUnavailableCompletionStore extends InMemoryIdempotencyStore {
    unavailable = true;

    override async complete(key: string, fingerprint: string, receipt: ExecutionReceipt<unknown>): Promise<ExecutionReceipt<unknown>> {
      if (this.unavailable) throw new Error('Completion persistence is temporarily unavailable');
      return super.complete(key, fingerprint, receipt);
    }
  }
  const store = new TemporarilyUnavailableCompletionStore();
  const executor = new IdempotentMutationExecutor({ store, createOperationId: () => 'op-original', now: () => new Date(startedAt) });
  let mutations = 0;
  let readbacks = 0;
  const recovery = {
    reconcile: async (record: IdempotencyRecord) => {
      readbacks += 1;
      assert.equal(record.checkpoint?.candidateCommitSha, 'c'.repeat(40));
      return { result: { commitSha: 'c'.repeat(40) } };
    },
  };
  const result = await executor.execute(scopedInput, async (progress) => {
    mutations += 1;
    assert.ok(progress);
    await progress.checkpoint(checkpoint('ref-confirmed'));
    return { result: { commitSha: 'c'.repeat(40) } };
  }, recovery);
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.equal(result.error.code, 'TRANSIENT');
  assert.equal((await store.get(scopedInput.storageKey))?.state, 'in-progress');
  assert.equal((await store.get(scopedInput.storageKey))?.checkpoint?.phase, 'ref-confirmed');
  store.unavailable = false;
  const recovered = await executor.status(scopedInput, recovery);
  assert.equal(recovered.outcome, 'succeeded');
  assert.equal(recovered.operationId, 'op-original');
  assert.equal(mutations, 1);
  assert.equal(readbacks, 1);
});

test('claim age never authorizes resuming an incomplete mutation', async () => {
  const store = new InMemoryIdempotencyStore();
  await store.claim({
    ...claimRecord(), key: scopedInput.storageKey, startedAt: '2000-01-01T00:00:00.000Z',
    scope: scopedInput.scope, operation: mutationInput.operation, target,
  });
  await store.checkpoint(scopedInput.storageKey, fingerprint, 'op-original', checkpoint('ref-update-requested'), startedAt);
  const executor = new IdempotentMutationExecutor({ store, now: () => new Date('2099-01-01T00:00:00.000Z') });
  let mutations = 0;
  const result = await executor.execute(scopedInput, async () => {
    mutations += 1;
    return { result: { commitSha: 'e'.repeat(40) } };
  }, { reconcile: async () => null });
  assert.equal(result.status, 'failed');
  assert.equal(result.operationId, 'op-original');
  assert.equal(mutations, 0);
  assert.equal((await store.get(scopedInput.storageKey))?.state, 'in-progress');
});

test('status hides mismatched scopes, operations, targets and unattributable legacy records', async () => {
  const store = new InMemoryIdempotencyStore();
  await store.claim({ ...claimRecord(), key: scopedInput.storageKey, scope: scopedInput.scope, operation: mutationInput.operation, target });
  const executor = new IdempotentMutationExecutor({ store });
  let readbacks = 0;
  const recovery = { reconcile: async () => { readbacks += 1; return null; } };
  for (const input of [
    { ...scopedInput, scope: 'another-scope' },
    { ...scopedInput, operation: 'git.workflow.commit' as const },
    { ...scopedInput, target: { ...target, id: 'another/repository' } },
  ]) {
    assert.deepEqual(await executor.status(input, recovery), { state: 'not-retained', outcome: 'unknown' });
  }
  await store.claim({ ...claimRecord(), key: 'legacy-global-key' });
  assert.deepEqual(await executor.status({ ...scopedInput, storageKey: 'legacy-global-key' }, recovery), { state: 'not-retained', outcome: 'unknown' });
  assert.equal(readbacks, 0);
});

test('scoped execution and status reject unattributable same-key claims and corrupt completed receipts', async () => {
  const matching: IdempotencyRecord = {
    ...claimRecord(), key: scopedInput.storageKey, scope: scopedInput.scope, operation: scopedInput.operation, target,
  };
  const mismatches: Array<Partial<IdempotencyRecord>> = [
    { scope: 'another-scope' },
    { scope: undefined },
    { operation: 'git.workflow.commit' },
    { target: { ...target, id: 'another/repository' } },
    { target: { ...target, kind: 'project' } },
    { target: { ...target, ref: 'work/another-ref' } },
  ];
  const corruptReceipts: ExecutionReceipt<unknown>[] = [
    { ...succeeded(), operationId: 'another-operation' },
    { ...succeeded(), operation: 'git.workflow.commit' },
    { ...succeeded(), target: { ...target, id: 'another/repository' } },
    { ...succeeded(), target: { ...target, kind: 'project' } },
    { ...succeeded(), target: { ...target, ref: 'work/another-ref' } },
  ];
  const records: IdempotencyRecord[] = [
    ...mismatches.map((mismatch) => ({ ...matching, ...mismatch })),
    ...mismatches.map((mismatch) => ({ ...matching, ...mismatch, state: 'completed' as const, receipt: succeeded() })),
    ...corruptReceipts.map((receipt) => ({ ...matching, state: 'completed' as const, receipt })),
  ];
  for (const record of records) {
    const store = new InMemoryIdempotencyStore();
    await store.claim(record);
    const executor = new IdempotentMutationExecutor({ store, createOperationId: () => 'op-rejected-caller' });
    let mutations = 0;
    let readbacks = 0;
    const recovery = { reconcile: async () => { readbacks += 1; return null; } };
    const result = await executor.execute(scopedInput, async () => { mutations += 1; return { result: null }; }, recovery);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.error.code, 'CONFLICT');
    assert.equal(result.operationId, 'op-rejected-caller');
    assert.deepEqual(await executor.status(scopedInput, recovery), { state: 'not-retained', outcome: 'unknown' });
    assert.equal(mutations, 0);
    assert.equal(readbacks, 0);
    assert.deepEqual(await store.get(scopedInput.storageKey), record);
  }
});

test('status returns a concurrent failed winner and its authoritative update and expiry after reconciliation', async () => {
  const redis = new FakeRedis();
  const store = redisStore(redis);
  await store.claim({
    ...claimRecord(), key: scopedInput.storageKey, scope: scopedInput.scope, operation: scopedInput.operation, target,
  });
  await store.checkpoint(scopedInput.storageKey, fingerprint, 'op-original', checkpoint('ref-update-requested'), startedAt);
  const redisKey = `test:recovery:${scopedInput.storageKey}`;
  redis.records.set(redisKey, { ...redis.records.get(redisKey)!, expiresAt: '2020-01-01T00:00:00.000Z' });
  const before = await store.get(scopedInput.storageKey);
  const winner = { ...failed(), finishedAt: '2026-01-01T00:02:00.000Z' };
  const executor = new IdempotentMutationExecutor({ store, now: () => new Date(finishedAt) });
  const status = await executor.status(scopedInput, {
    reconcile: async () => {
      await store.complete(scopedInput.storageKey, fingerprint, winner);
      return { result: { commitSha: 'c'.repeat(40) } };
    },
  });
  const retained = await store.get(scopedInput.storageKey);
  assert.equal(status.state, 'completed');
  assert.equal(status.outcome, 'failed');
  assert.deepEqual(status.receipt, winner);
  assert.equal(status.updatedAt, winner.finishedAt);
  assert.equal(status.updatedAt, retained?.updatedAt);
  assert.equal(status.expiresAt, retained?.expiresAt);
  assert.notEqual(status.updatedAt, before?.updatedAt);
  assert.notEqual(status.expiresAt, before?.expiresAt);
});

test('tracked execution requires a scoped readable checkpoint store before invoking mutation', async () => {
  const memory = new InMemoryIdempotencyStore();
  const legacy: IdempotencyStore = { claim: (record) => memory.claim(record), complete: (key, fp, receipt) => memory.complete(key, fp, receipt) };
  let mutations = 0;
  const mutate = async () => { mutations += 1; return { result: null }; };
  const recovery = { reconcile: async () => null };
  await assert.rejects(new IdempotentMutationExecutor({ store: legacy }).execute(scopedInput, mutate, recovery), { code: 'TOOL_UNAVAILABLE' });
  await assert.rejects(new IdempotentMutationExecutor({ store: memory }).execute(mutationInput, mutate, recovery), { code: 'TOOL_UNAVAILABLE' });
  assert.equal(mutations, 0);
  assert.equal(await memory.get(scopedInput.storageKey), null);
});
