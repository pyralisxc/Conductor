import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  IncomingMessage,
  ServerResponse
} from 'node:http';

import type { ConductorToolRuntime } from '../runtime/runtime.js';
import type {
  ExecutionReceipt,
  SourceArtifactRead
} from '../runtime/types.js';
import {
  normalizeRepository,
  type WorkScopeAuthorizer
} from './work-scope.js';
import {
  ascBridgeRequestAuthorized,
  ascBridgeSecretFromEnvironment
} from './asc-provider-bridge.js';

export type AscDelegationEffectClass =
  | 'read'
  | 'propose'
  | 'mutate';

export interface AscDelegationResource {
  readonly kind: string;
  readonly value: string;
}

export interface AscDelegationReceipt {
  readonly accountDomainId: string;
  readonly delegationId: string;
  readonly bindingId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly projectId: string;
  readonly workspaceId?: string;
  readonly capabilityId: string;
  readonly effectClass: AscDelegationEffectClass;
  readonly environment?: string;
  readonly resource?: AscDelegationResource;
  readonly audience: string;
  readonly approvalReference?: string;
  readonly consumedAt: string;
}

export interface ConsumeAscDelegationInput {
  readonly handle: string;
  readonly accountDomainId: string;
  readonly projectId: string;
  readonly capabilityId: string;
  readonly effectClass: AscDelegationEffectClass;
  readonly workspaceId?: string;
  readonly environment?: string;
}

export interface AscDelegationVerifier {
  consume(
    input: ConsumeAscDelegationInput
  ): Promise<AscDelegationReceipt>;
}

export interface HttpAscDelegationVerifierOptions {
  readonly baseUrl: string;
  readonly secret: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class AscAuthorityRejectedError extends Error {
  readonly code = 'asc_authority_rejected';

  constructor(message = 'ASC delegation was rejected.') {
    super(message);
    this.name = 'AscAuthorityRejectedError';
  }
}

function secureBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(
      'CONDUCTOR_ASC_CONTROL_URL must be an absolute URL',
    );
  }
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1';
  if (
    url.protocol !== 'https:' &&
    !(loopback && url.protocol === 'http:')
  ) {
    throw new Error(
      'CONDUCTOR_ASC_CONTROL_URL must use HTTPS outside localhost',
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'CONDUCTOR_ASC_CONTROL_URL must not contain credentials, query, or fragment',
    );
  }
  return url.origin;
}

function validSecret(value: string): string {
  const secret = value.trim();
  if (
    secret.length < 32 ||
    secret.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(secret)
  ) {
    throw new Error(
      'CONDUCTOR_ASC_BRIDGE_SECRET must contain 32-4096 printable characters',
    );
  }
  return secret;
}

function record(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function stringField(
  value: unknown,
  label: string
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AscAuthorityRejectedError(
      label + ' is missing from ASC receipt.',
    );
  }
  return value.trim();
}

function parseReceipt(value: unknown): AscDelegationReceipt {
  if (!record(value)) {
    throw new AscAuthorityRejectedError();
  }
  const effectClass =
    stringField(value.effectClass, 'effectClass');
  if (
    effectClass !== 'read' &&
    effectClass !== 'propose' &&
    effectClass !== 'mutate'
  ) {
    throw new AscAuthorityRejectedError(
      'ASC receipt effect class is invalid.',
    );
  }
  if (
    typeof value.connectionGeneration !== 'number' ||
    !Number.isSafeInteger(value.connectionGeneration) ||
    value.connectionGeneration < 1
  ) {
    throw new AscAuthorityRejectedError(
      'ASC receipt Connection generation is invalid.',
    );
  }
  const consumedAt = stringField(
    value.consumedAt,
    'consumedAt',
  );
  if (!Number.isFinite(Date.parse(consumedAt))) {
    throw new AscAuthorityRejectedError(
      'ASC receipt consumption time is invalid.',
    );
  }

  let resource: AscDelegationResource | undefined;
  if (value.resource !== undefined) {
    if (!record(value.resource)) {
      throw new AscAuthorityRejectedError(
        'ASC receipt resource is invalid.',
      );
    }
    resource = Object.freeze({
      kind: stringField(
        value.resource.kind,
        'resource.kind',
      ),
      value: stringField(
        value.resource.value,
        'resource.value',
      ),
    });
  }

  const workspaceId =
    typeof value.workspaceId === 'string' &&
    value.workspaceId.trim()
      ? value.workspaceId.trim()
      : undefined;
  const environment =
    typeof value.environment === 'string' &&
    value.environment.trim()
      ? value.environment.trim()
      : undefined;
  const approvalReference =
    typeof value.approvalReference === 'string' &&
    value.approvalReference.trim()
      ? value.approvalReference.trim()
      : undefined;

  return Object.freeze({
    accountDomainId: stringField(
      value.accountDomainId,
      'accountDomainId',
    ),
    delegationId: stringField(
      value.delegationId,
      'delegationId',
    ),
    bindingId: stringField(
      value.bindingId,
      'bindingId',
    ),
    connectionId: stringField(
      value.connectionId,
      'connectionId',
    ),
    connectionGeneration: value.connectionGeneration,
    projectId: stringField(
      value.projectId,
      'projectId',
    ),
    ...(workspaceId ? { workspaceId } : {}),
    capabilityId: stringField(
      value.capabilityId,
      'capabilityId',
    ),
    effectClass,
    ...(environment ? { environment } : {}),
    ...(resource ? { resource } : {}),
    audience: stringField(
      value.audience,
      'audience',
    ),
    ...(approvalReference
      ? { approvalReference }
      : {}),
    consumedAt,
  });
}

export class HttpAscDelegationVerifier
  implements AscDelegationVerifier
{
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: HttpAscDelegationVerifierOptions) {
    this.#baseUrl = secureBaseUrl(options.baseUrl);
    this.#secret = validSecret(options.secret);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async consume(
    input: ConsumeAscDelegationInput
  ): Promise<AscDelegationReceipt> {
    const response = await this.#fetch(
      this.#baseUrl +
        '/api/internal/conductor/delegations/consume',
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer ' + this.#secret,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
      },
    );

    if (!response.ok) {
      throw new AscAuthorityRejectedError();
    }

    const payload: unknown = await response.json();
    if (!record(payload) || !('receipt' in payload)) {
      throw new AscAuthorityRejectedError(
        'ASC delegation response is invalid.',
      );
    }
    return parseReceipt(payload.receipt);
  }
}

export interface AscAuthorityReference {
  readonly source: 'asc';
  readonly accountDomainId: string;
  readonly delegationId: string;
  readonly bindingId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly projectId: string;
  readonly capabilityId: string;
  readonly effectClass: AscDelegationEffectClass;
  readonly resource: AscDelegationResource;
  readonly approvalReference?: string;
  readonly consumedAt: string;
}

export interface AscAuthorityExecution<Result> {
  readonly authority: AscAuthorityReference;
  readonly execution: Result;
}

export interface AscSourceArtifactInput {
  readonly delegationHandle: string;
  readonly accountDomainId: string;
  readonly projectId: string;
  readonly sha: string;
  readonly path: string;
  readonly maxBytes?: number;
}

export interface AscPullRequestCommentInput {
  readonly delegationHandle: string;
  readonly accountDomainId: string;
  readonly projectId: string;
  readonly pullRequestNumber: number;
  readonly body: string;
  readonly idempotencyKey: string;
}

export interface AscAuthorityExecutorOptions {
  readonly runtime: ConductorToolRuntime;
  readonly verifier: AscDelegationVerifier;
  readonly workScope?: WorkScopeAuthorizer;
}

const ascServiceClientId = 'asc-control-plane';

export class AscAuthorityExecutor {
  readonly #runtime: ConductorToolRuntime;
  readonly #verifier: AscDelegationVerifier;
  readonly #workScope: WorkScopeAuthorizer | undefined;

  constructor(options: AscAuthorityExecutorOptions) {
    this.#runtime = options.runtime;
    this.#verifier = options.verifier;
    this.#workScope = options.workScope;
  }

  async sourceArtifactRead(
    input: AscSourceArtifactInput
  ): Promise<
    AscAuthorityExecution<
      ExecutionReceipt<SourceArtifactRead>
    >
  > {
    if (!this.#runtime.sourceArtifactReadEnabled) {
      throw new Error(
        'Conductor source-artifact read is unavailable.',
      );
    }
    const receipt = await this.#consume(
      input,
      'source.read',
      'read',
    );
    const project = projectFromReceipt(receipt);
    const execution =
      await this.#runtime.sourceArtifactRead({
        project,
        sha: input.sha,
        path: input.path,
        ...(input.maxBytes !== undefined
          ? { maxBytes: input.maxBytes }
          : {}),
      });

    return Object.freeze({
      authority: authorityReference(receipt),
      execution,
    });
  }

  async pullRequestComment(
    input: AscPullRequestCommentInput
  ): Promise<AscAuthorityExecution<Awaited<
    ReturnType<ConductorToolRuntime['commentPullRequest']>
  >>> {
    if (
      !this.#runtime.sourceControlMutationsEnabled ||
      !this.#workScope
    ) {
      throw new Error(
        'Conductor mutation infrastructure is unavailable.',
      );
    }

    const receipt = await this.#consume(
      input,
      'pull_request.write',
      'mutate',
    );
    if (!receipt.approvalReference) {
      throw new AscAuthorityRejectedError(
        'ASC mutation receipt is missing approval provenance.',
      );
    }

    const project = projectFromReceipt(receipt);
    const work = this.#workScope.begin(
      ascServiceClientId,
      project.repository!,
    );
    const auth: AuthInfo = {
      token: 'asc-delegated-authority',
      clientId: ascServiceClientId,
      scopes: ['conductor.read', 'conductor.write'],
    };
    await this.#workScope.assertAllowed(
      auth,
      'develop',
      project,
      work.workContext,
    );

    const execution =
      await this.#runtime.commentPullRequest({
        project,
        pullRequestNumber: input.pullRequestNumber,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
      });

    return Object.freeze({
      authority: authorityReference(receipt),
      execution,
    });
  }

  async #consume(
    input: {
      readonly delegationHandle: string;
      readonly accountDomainId: string;
      readonly projectId: string;
    },
    capabilityId: string,
    effectClass: AscDelegationEffectClass,
  ): Promise<AscDelegationReceipt> {
    const receipt = await this.#verifier.consume({
      handle: input.delegationHandle,
      accountDomainId: input.accountDomainId,
      projectId: input.projectId,
      capabilityId,
      effectClass,
    });

    if (
      receipt.accountDomainId !== input.accountDomainId ||
      receipt.projectId !== input.projectId ||
      receipt.capabilityId !== capabilityId ||
      receipt.effectClass !== effectClass ||
      receipt.audience !== 'conductor'
    ) {
      throw new AscAuthorityRejectedError(
        'ASC delegation receipt does not match the requested Conductor operation.',
      );
    }
    return receipt;
  }
}

function projectFromReceipt(
  receipt: AscDelegationReceipt
) {
  if (
    receipt.resource?.kind !== 'github_repository'
  ) {
    throw new AscAuthorityRejectedError(
      'ASC delegation is not bound to an exact GitHub repository.',
    );
  }
  const repository = normalizeRepository(
    receipt.resource.value,
  );
  return Object.freeze({
    id: repository,
    repository,
  });
}

function authorityReference(
  receipt: AscDelegationReceipt
): AscAuthorityReference {
  const resource = receipt.resource;
  if (!resource) {
    throw new AscAuthorityRejectedError(
      'ASC delegation resource is missing.',
    );
  }
  return Object.freeze({
    source: 'asc' as const,
    accountDomainId: receipt.accountDomainId,
    delegationId: receipt.delegationId,
    bindingId: receipt.bindingId,
    connectionId: receipt.connectionId,
    connectionGeneration: receipt.connectionGeneration,
    projectId: receipt.projectId,
    capabilityId: receipt.capabilityId,
    effectClass: receipt.effectClass,
    resource,
    ...(receipt.approvalReference
      ? {
          approvalReference:
            receipt.approvalReference,
        }
      : {}),
    consumedAt: receipt.consumedAt,
  });
}

function json(
  res: ServerResponse,
  status: number,
  value: unknown,
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

async function readJson(
  req: IncomingMessage,
): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > 256 * 1024) {
      throw new Error('Request body is too large.');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    throw new Error('Request body is required.');
  }
  return JSON.parse(
    Buffer.concat(chunks).toString('utf8'),
  ) as unknown;
}

function requiredString(
  value: unknown,
  label: string,
  max = 2048,
): string {
  if (typeof value !== 'string') {
    throw new Error(label + ' is required.');
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > max ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(label + ' is invalid.');
  }
  return normalized;
}

function baseInput(value: Record<string, unknown>) {
  const delegationHandle = requiredString(
    value.delegationHandle,
    'Delegation handle',
    128,
  );
  if (
    !/^ascd_[A-Za-z0-9_-]{43}$/u.test(
      delegationHandle,
    )
  ) {
    throw new Error('Delegation handle is invalid.');
  }
  return {
    delegationHandle,
    accountDomainId: requiredString(
      value.accountDomainId,
      'AccountDomain',
      256,
    ),
    projectId: requiredString(
      value.projectId,
      'Project',
      256,
    ),
  };
}

function readInput(value: unknown): AscSourceArtifactInput {
  if (!record(value)) throw new Error('Invalid request.');
  const allowed = new Set([
    'delegationHandle',
    'accountDomainId',
    'projectId',
    'sha',
    'path',
    'maxBytes',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Unsupported request field.');
  }
  const base = baseInput(value);
  const sha = requiredString(value.sha, 'SHA', 40);
  if (!/^[0-9a-f]{40}$/iu.test(sha)) {
    throw new Error('SHA is invalid.');
  }
  const maxBytes = value.maxBytes;
  if (
    maxBytes !== undefined &&
    (
      typeof maxBytes !== 'number' ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 1024 * 1024
    )
  ) {
    throw new Error('maxBytes is invalid.');
  }
  return Object.freeze({
    ...base,
    sha,
    path: requiredString(value.path, 'Path', 1024),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  });
}

function commentInput(
  value: unknown,
): AscPullRequestCommentInput {
  if (!record(value)) throw new Error('Invalid request.');
  const allowed = new Set([
    'delegationHandle',
    'accountDomainId',
    'projectId',
    'pullRequestNumber',
    'body',
    'idempotencyKey',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Unsupported request field.');
  }
  const base = baseInput(value);
  const pullRequestNumber = value.pullRequestNumber;
  if (
    typeof pullRequestNumber !== 'number' ||
    !Number.isSafeInteger(pullRequestNumber) ||
    pullRequestNumber < 1
  ) {
    throw new Error('Pull request number is invalid.');
  }
  return Object.freeze({
    ...base,
    pullRequestNumber,
    body: requiredString(
      value.body,
      'Comment body',
      100000,
    ),
    idempotencyKey: requiredString(
      value.idempotencyKey,
      'Idempotency key',
      200,
    ),
  });
}

function isAscAuthorityPath(pathname: string): boolean {
  return (
    pathname ===
      '/internal/asc/authority/source-artifact-read' ||
    pathname ===
      '/internal/asc/authority/pull-request-comment'
  );
}

export interface AscAuthorityBridgeHandlerOptions {
  readonly runtime: ConductorToolRuntime;
  readonly workScope?: WorkScopeAuthorizer;
  readonly enabled?: boolean;
  readonly secret?: string;
  readonly verifier?: AscDelegationVerifier;
}

function verifierFromEnvironment(
  secret: string,
): AscDelegationVerifier {
  const baseUrl =
    process.env.CONDUCTOR_ASC_CONTROL_URL?.trim();
  if (!baseUrl) {
    throw new Error(
      'CONDUCTOR_ASC_CONTROL_URL is required for ASC delegated authority.',
    );
  }
  return new HttpAscDelegationVerifier({
    baseUrl,
    secret,
  });
}

export async function handleAscAuthorityBridgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
  options: AscAuthorityBridgeHandlerOptions,
): Promise<boolean> {
  if (!isAscAuthorityPath(requestUrl.pathname)) {
    return false;
  }

  const enabled =
    options.enabled ??
    process.env.CONDUCTOR_ENABLE_ASC_AUTHORITY_CANARY === '1';
  if (!enabled) {
    json(res, 503, {
      error: 'asc_authority_canary_disabled',
    });
    return true;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, {
      allow: 'POST',
      'cache-control': 'no-store',
    });
    res.end();
    return true;
  }

  let secret: string;
  try {
    secret =
      options.secret ??
      ascBridgeSecretFromEnvironment();
  } catch {
    json(res, 503, {
      error: 'asc_authority_bridge_unavailable',
    });
    return true;
  }

  if (!ascBridgeRequestAuthorized(req, secret)) {
    json(res, 401, { error: 'unauthorized' });
    return true;
  }

  let executor: AscAuthorityExecutor;
  try {
    executor = new AscAuthorityExecutor({
      runtime: options.runtime,
      workScope: options.workScope,
      verifier:
        options.verifier ??
        verifierFromEnvironment(secret),
    });
  } catch {
    json(res, 503, {
      error: 'asc_authority_bridge_unavailable',
    });
    return true;
  }

  try {
    const body = await readJson(req);
    const result =
      requestUrl.pathname.endsWith(
        '/source-artifact-read',
      )
        ? await executor.sourceArtifactRead(
            readInput(body),
          )
        : await executor.pullRequestComment(
            commentInput(body),
          );
    json(res, 200, result);
  } catch (error) {
    if (error instanceof AscAuthorityRejectedError) {
      json(res, 403, {
        error: 'asc_authority_rejected',
      });
      return true;
    }
    json(res, 400, {
      error: 'asc_authority_request_failed',
    });
  }
  return true;
}
