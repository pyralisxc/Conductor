import { randomUUID } from 'node:crypto';
import { ConductorToolError, normalizeToolError } from './errors.js';
import { assertCommitCheckpoint, type CommitCheckpoint, type CommitMutationProgress } from './commit-checkpoint.js';
import {
  TOOL_RUNTIME_CONTRACT_VERSION,
  type ExecutionIdentifiers,
  type ExecutionReceipt,
  type ExecutionTarget,
  type MutationOperationName,
  type ToolDiagnostic,
} from './types.js';

export interface IdempotencyRecord {
  key: string;
  fingerprint: string;
  operationId: string;
  startedAt: string;
  state: 'in-progress' | 'completed';
  receipt?: ExecutionReceipt<unknown>;
  scope?: string;
  operation?: MutationOperationName;
  target?: ExecutionTarget;
  updatedAt?: string;
  expiresAt?: string;
  revision?: number;
  checkpoint?: CommitCheckpoint;
}

export type IdempotencyClaim =
  | { status: 'claimed' }
  | { status: 'conflict'; record: IdempotencyRecord }
  | { status: 'in-progress'; record: IdempotencyRecord }
  | { status: 'replay'; record: IdempotencyRecord };

export interface IdempotencyStore {
  claim(record: IdempotencyRecord): Promise<IdempotencyClaim>;
  get?(key: string): Promise<IdempotencyRecord | null>;
  checkpoint?(key: string, fingerprint: string, operationId: string, value: CommitCheckpoint, updatedAt: string): Promise<IdempotencyRecord>;
  complete(
    key: string,
    fingerprint: string,
    receipt: ExecutionReceipt<unknown>,
  ): Promise<ExecutionReceipt<unknown> | void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async get(key: string): Promise<IdempotencyRecord | null> {
    return structuredClone(this.records.get(key) ?? null);
  }

  async checkpoint(key: string, fingerprint: string, operationId: string, value: CommitCheckpoint, updatedAt: string): Promise<IdempotencyRecord> {
    const existing = this.records.get(key);
    if (!existing || existing.fingerprint !== fingerprint || existing.operationId !== operationId || existing.state === 'completed') {
      throw new ConductorToolError({ code: 'CONFLICT', message: 'Commit checkpoint did not match the active claim', source: 'idempotency' });
    }
    assertCommitCheckpoint(value, existing.checkpoint);
    const record = { ...existing, checkpoint: structuredClone(value), updatedAt, revision: (existing.revision ?? 0) + 1 };
    this.records.set(key, record);
    return structuredClone(record);
  }

  async claim(record: IdempotencyRecord): Promise<IdempotencyClaim> {
    const existing = this.records.get(record.key);
    if (!existing) {
      this.records.set(record.key, structuredClone(record));
      return { status: 'claimed' };
    }

    if (existing.fingerprint !== record.fingerprint) {
      return { status: 'conflict', record: structuredClone(existing) };
    }

    if (existing.state === 'in-progress') {
      return { status: 'in-progress', record: structuredClone(existing) };
    }

    return { status: 'replay', record: structuredClone(existing) };
  }

  async complete(
    key: string,
    fingerprint: string,
    receipt: ExecutionReceipt<unknown>,
  ): Promise<ExecutionReceipt<unknown>> {
    const existing = this.records.get(key);
    if (!existing || existing.fingerprint !== fingerprint || existing.operationId !== receipt.operationId) {
      throw new ConductorToolError({
        code: 'CONFLICT',
        message: 'Idempotency completion did not match the active claim',
        source: 'idempotency',
      });
    }

    if (existing.state === 'completed' && existing.receipt) return structuredClone(existing.receipt);

    this.records.set(key, {
      ...existing,
      state: 'completed',
      receipt: structuredClone(receipt),
      updatedAt: receipt.finishedAt,
      revision: (existing.revision ?? 0) + 1,
    });
    return structuredClone(receipt);
  }
}

export interface MutationResult<Result> {
  result: Result;
  diagnostics?: ToolDiagnostic[];
  identifiers?: ExecutionIdentifiers;
}

export interface IdempotentMutationInput {
  key: string;
  fingerprint: string;
  operation: MutationOperationName;
  target: ExecutionTarget;
  storageKey?: string;
  scope?: string;
}

export interface MutationRecovery<Result> {
  reconcile(record: IdempotencyRecord): Promise<MutationResult<Result> | null>;
}

export interface MutationStatus {
  state: 'not-retained' | 'incomplete' | 'completed';
  outcome: 'unknown' | 'succeeded' | 'failed';
  operationId?: string;
  operation?: MutationOperationName;
  target?: ExecutionTarget;
  phase?: CommitCheckpoint['phase'] | 'claimed';
  startedAt?: string;
  updatedAt?: string;
  expiresAt?: string;
  receipt?: ExecutionReceipt<unknown>;
}

export interface IdempotentMutationExecutorOptions {
  store: IdempotencyStore;
  now?: () => Date;
  createOperationId?: () => string;
}

export class IdempotentMutationExecutor {
  private readonly store: IdempotencyStore;
  private readonly now: () => Date;
  private readonly createOperationId: () => string;

  constructor(options: IdempotentMutationExecutorOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.createOperationId =
      options.createOperationId ?? (() => randomUUID());
  }

  get supportsRecovery(): boolean { return Boolean(this.store.get && this.store.checkpoint); }

  async execute<Result>(
    input: IdempotentMutationInput,
    mutate: (progress?: CommitMutationProgress) => Promise<MutationResult<Result>>,
    recovery?: MutationRecovery<Result>,
  ): Promise<ExecutionReceipt<Result>> {
    const storageKey = input.storageKey ?? input.key;
    if (recovery && (!this.store.get || !this.store.checkpoint || !input.scope)) {
      throw new ConductorToolError({ code: 'TOOL_UNAVAILABLE', message: 'Scoped commit recovery requires readable durable checkpoints', source: 'idempotency' });
    }
    const operationId = this.createOperationId();
    const startedAt = this.now().toISOString();
    const claim = await this.store.claim({
      key: storageKey,
      fingerprint: input.fingerprint,
      operationId,
      startedAt,
      state: 'in-progress',
      scope: input.scope,
      operation: input.operation,
      target: input.target,
      updatedAt: startedAt,
      revision: 0,
    });

    if (claim.status !== 'claimed' && input.scope && !this.matchesScopedRecord(input, claim.record)) {
      return this.failureReceipt(input, operationId, startedAt, new ConductorToolError({ code: 'CONFLICT', message: 'Idempotency claim is not attributable to this scoped operation', source: 'idempotency' }), false);
    }

    if (claim.status === 'replay') {
      const receipt = claim.record.receipt;
      if (!receipt) {
        return this.failureReceipt(
          input,
          claim.record.operationId,
          claim.record.startedAt,
          new ConductorToolError({
            code: 'TRANSIENT',
            message: 'Completed idempotency record has no receipt',
            retryable: true,
            source: 'idempotency',
          }),
          true,
        );
      }

      return {
        ...receipt,
        idempotency: {
          key: input.key,
          fingerprint: input.fingerprint,
          replayed: true,
        },
      } as ExecutionReceipt<Result>;
    }

    if (claim.status === 'conflict') {
      return this.failureReceipt(
        input,
        operationId,
        startedAt,
        new ConductorToolError({
          code: 'CONFLICT',
          message: 'Idempotency key was already used for a different mutation',
          source: 'idempotency',
          diagnostics: [
            {
              level: 'error',
              code: 'CONFLICT',
              source: 'idempotency',
              message: 'Use a new idempotency key for a different mutation payload',
            },
          ],
        }),
        false,
      );
    }

    if (claim.status === 'in-progress') {
      if (recovery) return await this.reconcile(input, claim.record, recovery);
      return this.failureReceipt(
        input,
        claim.record.operationId,
        claim.record.startedAt,
        new ConductorToolError({
          code: 'TRANSIENT',
          message: 'Mutation has no completed receipt; process liveness and outcome are unknown',
          retryable: true,
          source: 'idempotency',
        }),
        true,
      );
    }

    let receipt: ExecutionReceipt<Result>;
    try {
      const mutation = await mutate(recovery ? {
        checkpoint: async (value) => {
          await this.store.checkpoint!(storageKey, input.fingerprint, operationId, value, this.now().toISOString());
        },
      } : undefined);
      receipt = {
        contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
        operationId,
        operation: input.operation,
        target: input.target,
        status: 'succeeded',
        startedAt,
        finishedAt: this.now().toISOString(),
        result: mutation.result,
        diagnostics: mutation.diagnostics ?? [],
        identifiers: mutation.identifiers,
        idempotency: {
          key: input.key,
          fingerprint: input.fingerprint,
          replayed: false,
        },
      };
    } catch (error) {
      if (recovery) {
        // A lost ref response is not proof of failure. Only provider readback
        // may turn a known candidate into a successful terminal receipt.
        try {
          const current = await this.store.get!(storageKey);
          if (!current || current.operationId !== operationId) return this.unknownReceipt(input, operationId, startedAt);
          if (current.state === 'completed' || current.checkpoint?.phase === 'ref-update-requested' || current.checkpoint?.phase === 'ref-confirmed') {
            return await this.reconcile(input, current, recovery);
          }
        } catch {
          return this.unknownReceipt(input, operationId, startedAt);
        }
      }
      receipt = this.failureReceipt(
        input,
        operationId,
        startedAt,
        error,
        false,
      );
    }

    try {
      const winner = await this.store.complete(storageKey, input.fingerprint, receipt as ExecutionReceipt<unknown>);
      return (winner ?? receipt) as ExecutionReceipt<Result>;
    } catch (error) {
      if (recovery) return this.unknownReceipt(input, operationId, startedAt);
      throw error;
    }
  }

  async status<Result>(input: IdempotentMutationInput, recovery: MutationRecovery<Result>): Promise<MutationStatus> {
    if (!this.store.get || !input.scope) throw new ConductorToolError({ code: 'TOOL_UNAVAILABLE', message: 'Scoped operation status is not enabled', source: 'idempotency' });
    let record = await this.store.get(input.storageKey ?? input.key);
    // Legacy/global claims are not attributable. Never reveal them by key.
    if (!record || !this.matchesScopedRecord(input, record)) {
      return { state: 'not-retained', outcome: 'unknown' };
    }
    let receipt = record.receipt;
    if (record.state !== 'completed' && record.checkpoint?.candidateCommitSha) {
      const operationId = record.operationId;
      await this.reconcile({ ...input, fingerprint: record.fingerprint }, record, recovery);
      record = await this.store.get(input.storageKey ?? input.key);
      if (!record || record.operationId !== operationId || !this.matchesScopedRecord(input, record)) return { state: 'not-retained', outcome: 'unknown' };
      receipt = record.state === 'completed' ? record.receipt : undefined;
    }
    if (record.checkpoint) assertCommitCheckpoint(record.checkpoint);
    return {
      state: receipt ? 'completed' : 'incomplete',
      outcome: receipt?.status ?? 'unknown',
      operationId: record.operationId,
      operation: record.operation,
      target: record.target,
      phase: record.checkpoint?.phase ?? 'claimed',
      startedAt: record.startedAt,
      updatedAt: record.updatedAt ?? record.startedAt,
      expiresAt: record.expiresAt,
      ...(receipt ? { receipt } : {}),
    };
  }

  private matchesScopedRecord(input: IdempotentMutationInput, record: IdempotencyRecord): boolean {
    const sameTarget = (target: ExecutionTarget | undefined) => target?.kind === input.target.kind && target.id === input.target.id && target.ref === input.target.ref;
    return record.scope === input.scope && record.operation === input.operation && sameTarget(record.target)
      && (!record.receipt || (record.receipt.operationId === record.operationId && record.receipt.operation === input.operation && sameTarget(record.receipt.target)));
  }

  private unknownReceipt<Result>(input: IdempotentMutationInput, operationId: string, startedAt: string): ExecutionReceipt<Result> {
    return this.failureReceipt(input, operationId, startedAt, new ConductorToolError({
      code: 'TRANSIENT', message: 'Mutation outcome is incomplete or unknown; no execution was resumed. Check operation.status using the same idempotency key.',
      retryable: true, source: 'idempotency', diagnostics: [{ level: 'warning', source: 'idempotency', message: 'Retry/status only reconcile provider evidence; record age does not establish process liveness.', details: { outcome: 'unknown', executionResumed: false } }],
    }), true);
  }

  private async reconcile<Result>(input: IdempotentMutationInput, record: IdempotencyRecord, recovery: MutationRecovery<Result>): Promise<ExecutionReceipt<Result>> {
    if (record.state === 'completed' && record.receipt) return {
      ...record.receipt, idempotency: { key: input.key, fingerprint: record.fingerprint, replayed: true },
    } as ExecutionReceipt<Result>;
    try {
      const mutation = await recovery.reconcile(record);
      if (!mutation) return this.unknownReceipt(input, record.operationId, record.startedAt);
      const receipt: ExecutionReceipt<Result> = {
        contractVersion: TOOL_RUNTIME_CONTRACT_VERSION, operationId: record.operationId, operation: input.operation, target: input.target,
        status: 'succeeded', startedAt: record.startedAt, finishedAt: this.now().toISOString(), result: mutation.result,
        identifiers: mutation.identifiers, diagnostics: mutation.diagnostics ?? [],
        idempotency: { key: input.key, fingerprint: record.fingerprint, replayed: true },
      };
      const winner = await this.store.complete(input.storageKey ?? input.key, record.fingerprint, receipt);
      return (winner ?? receipt) as ExecutionReceipt<Result>;
    } catch {
      return this.unknownReceipt(input, record.operationId, record.startedAt);
    }
  }

  private failureReceipt<Result>(
    input: IdempotentMutationInput,
    operationId: string,
    startedAt: string,
    error: unknown,
    replayed: boolean,
  ): ExecutionReceipt<Result> {
    const normalized = normalizeToolError(error, 'TOOL_UNAVAILABLE');
    return {
      contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
      operationId,
      operation: input.operation,
      target: input.target,
      status: 'failed',
      startedAt,
      finishedAt: this.now().toISOString(),
      error: normalized,
      diagnostics: normalized.diagnostics,
      idempotency: {
        key: input.key,
        fingerprint: input.fingerprint,
        replayed,
      },
    };
  }
}
