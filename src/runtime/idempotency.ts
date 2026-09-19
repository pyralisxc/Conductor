import { randomUUID } from 'node:crypto';
import { ConductorToolError, normalizeToolError } from './errors.js';
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
}

export type IdempotencyClaim =
  | { status: 'claimed' }
  | { status: 'conflict'; record: IdempotencyRecord }
  | { status: 'in-progress'; record: IdempotencyRecord }
  | { status: 'replay'; record: IdempotencyRecord };

export interface IdempotencyStore {
  claim(record: IdempotencyRecord): Promise<IdempotencyClaim>;
  complete(
    key: string,
    fingerprint: string,
    receipt: ExecutionReceipt<unknown>,
  ): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async claim(record: IdempotencyRecord): Promise<IdempotencyClaim> {
    const existing = this.records.get(record.key);
    if (!existing) {
      this.records.set(record.key, record);
      return { status: 'claimed' };
    }

    if (existing.fingerprint !== record.fingerprint) {
      return { status: 'conflict', record: existing };
    }

    if (existing.state === 'in-progress') {
      return { status: 'in-progress', record: existing };
    }

    return { status: 'replay', record: existing };
  }

  async complete(
    key: string,
    fingerprint: string,
    receipt: ExecutionReceipt<unknown>,
  ): Promise<void> {
    const existing = this.records.get(key);
    if (!existing || existing.fingerprint !== fingerprint) {
      throw new ConductorToolError({
        code: 'CONFLICT',
        message: 'Idempotency completion did not match the active claim',
        source: 'idempotency',
      });
    }

    this.records.set(key, {
      ...existing,
      state: 'completed',
      receipt,
    });
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

  async execute<Result>(
    input: IdempotentMutationInput,
    mutate: () => Promise<MutationResult<Result>>,
  ): Promise<ExecutionReceipt<Result>> {
    const operationId = this.createOperationId();
    const startedAt = this.now().toISOString();
    const claim = await this.store.claim({
      key: input.key,
      fingerprint: input.fingerprint,
      operationId,
      startedAt,
      state: 'in-progress',
    });

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
      return this.failureReceipt(
        input,
        claim.record.operationId,
        claim.record.startedAt,
        new ConductorToolError({
          code: 'TRANSIENT',
          message: 'Mutation with this idempotency key is still in progress',
          retryable: true,
          source: 'idempotency',
        }),
        true,
      );
    }

    let receipt: ExecutionReceipt<Result>;
    try {
      const mutation = await mutate();
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
      receipt = this.failureReceipt(
        input,
        operationId,
        startedAt,
        error,
        false,
      );
    }

    await this.store.complete(
      input.key,
      input.fingerprint,
      receipt as ExecutionReceipt<unknown>,
    );
    return receipt;
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
