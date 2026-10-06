import type {
  CapabilityAvailability, OperationPreflightCheck, ProjectReference, RuntimeOperationName,
  WorkerRuntimeRunProjection, WorkerRuntimeStatusProjection,
} from '../runtime/types.js';
import type { WorkerRuntimeAction, WorkerRuntimeControlProvider } from './runtime.js';

type FetchLike = typeof fetch;

export interface OhMySymphonyProviderOptions {
  endpoint: string; token: string; repository: string; fetchImpl?: FetchLike; timeoutMs?: number; now?: () => Date;
}

export class OhMySymphonyProvider implements WorkerRuntimeControlProvider {
  readonly id = 'oh-my-symphony';
  readonly repository: string;
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: OhMySymphonyProviderOptions) {
    const endpoint = options.endpoint.trim().replace(/\/+$/u, '');
    const token = options.token.trim();
    const repository = options.repository.trim();
    let parsed: URL;
    try { parsed = new URL(endpoint); } catch { throw new Error('CONDUCTOR_SYMPHONY_URL must be an absolute HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('CONDUCTOR_SYMPHONY_URL must use http or https');
    if (!token) throw new Error('CONDUCTOR_SYMPHONY_API_TOKEN is required');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('CONDUCTOR_SYMPHONY_REPOSITORY must be owner/repository');
    this.endpoint = endpoint; this.token = token; this.repository = repository;
    this.fetchImpl = options.fetchImpl ?? fetch; this.timeoutMs = options.timeoutMs ?? 10000; this.now = options.now ?? (() => new Date());
  }

  async getCapabilities(): Promise<CapabilityAvailability[]> {
    return [
      { capability: 'worker-runtime.read', available: true, provider: this.id, access: 'read', auth: 'ready', health: 'ready', diagnostics: [] },
      { capability: 'worker-runtime.control', available: true, provider: this.id, access: 'execute', auth: 'ready', health: 'ready', diagnostics: [] },
    ];
  }

  async preflightOperation(project: ProjectReference, operation: RuntimeOperationName): Promise<OperationPreflightCheck[] | undefined> {
    if (!operation.startsWith('worker-runtime.')) return undefined;
    const repository = project.repository ?? project.id;
    const matches = repository.toLowerCase() === this.repository.toLowerCase();
    return [{ provider: this.id, status: matches ? 'ready' : 'blocked',
      summary: matches ? 'oh-my-symphony is bound to ' + this.repository : 'oh-my-symphony is bound to ' + this.repository + ', not ' + repository,
      diagnostics: matches ? [] : [{ level: 'warning', code: 'PERMISSION_DENIED', source: this.id, message: 'Worker-runtime control is restricted to the exact configured repository binding.' }],
      ...(matches ? {} : { error: { code: 'PERMISSION_DENIED' as const, message: 'Worker-runtime project does not match the configured Symphony repository', retryable: false, source: this.id, diagnostics: [] } }),
    }];
  }

  async getRuntimeStatus(): Promise<WorkerRuntimeStatusProjection> {
    const payload = await this.request('/api/v1/state', 'GET');
    const dispatch = record(payload.dispatch); const counts = record(payload.counts);
    const rawRunning = Array.isArray(payload.running) ? payload.running : [];
    return { provider: 'oh-my-symphony', repository: this.repository, dispatchEnabled: dispatch.enabled === true,
      counts: { running: nonnegativeInt(counts.running), retrying: nonnegativeInt(counts.retrying) },
      running: rawRunning.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)).map(normalizeRun),
      observedAt: this.now().toISOString() };
  }

  async setDispatchEnabled(enabled: boolean) {
    const payload = await this.request(enabled ? '/api/v1/dispatch/enable' : '/api/v1/dispatch/disable', 'POST');
    return { provider: 'oh-my-symphony' as const, repository: this.repository, dispatchEnabled: record(payload).enabled === true, observedAt: this.now().toISOString() };
  }

  async controlWorker(identifier: string, action: WorkerRuntimeAction) {
    if (!/^GH-[1-9]\d*$/u.test(identifier)) throw { code: 'PERMISSION_DENIED', message: 'Canary worker controls require an exact GH-<issueNumber> identifier' };
    const payload = await this.request('/api/v1/' + encodeURIComponent(identifier) + '/' + action, 'POST');
    return { provider: 'oh-my-symphony' as const, repository: this.repository, identifier, action, accepted: true,
      paused: typeof payload.paused === 'boolean' ? payload.paused : null,
      recoveryPreserved: typeof payload.recovery_preserved === 'boolean' ? payload.recovery_preserved : null, observedAt: this.now().toISOString() };
  }

  private async request(path: string, method: 'GET' | 'POST'): Promise<Record<string, unknown>> {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint + path, { method, headers: { accept: 'application/json', authorization: 'Bearer ' + this.token, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, signal: controller.signal });
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? 'AUTH_REQUIRED' : response.status === 404 ? 'NOT_FOUND' : response.status === 409 ? 'CONFLICT' : response.status >= 500 ? 'TRANSIENT' : 'COMMAND_FAILED';
        throw { code, message: 'oh-my-symphony request failed: ' + method + ' ' + path + ' -> ' + response.status, source: this.id };
      }
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw { code: 'COMMAND_FAILED', message: 'oh-my-symphony returned a non-object JSON response', source: this.id };
      return payload as Record<string, unknown>;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw { code: 'TRANSIENT', message: 'oh-my-symphony request timed out', source: this.id };
      throw error;
    } finally { clearTimeout(timeout); }
  }
}

function normalizeRun(entry: Record<string, unknown>): WorkerRuntimeRunProjection {
  const run = record(entry.run); const worker = record(entry.worker); const session = record(entry.session); const workspace = record(entry.workspace);
  return { issueId: stringOrNull(entry.issue_id), issueIdentifier: stringOrNull(entry.issue_identifier), state: stringOrNull(entry.state), paused: entry.paused === true,
    runId: stringOrNull(run.id), continuedFromRunId: stringOrNull(run.continued_from_run_id), processId: positiveIntOrNull(worker.process_id), processGroupId: positiveIntOrNull(worker.process_group_id),
    sessionId: stringOrNull(session.session_id), threadId: stringOrNull(session.thread_id), turnId: stringOrNull(session.turn_id), recoveryResumed: session.recovery_resumed === true,
    workspacePath: stringOrNull(workspace.path), branch: stringOrNull(workspace.branch) };
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringOrNull(value: unknown): string | null { return typeof value === 'string' && value.length > 0 ? value : null; }
function positiveIntOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null; }
function nonnegativeInt(value: unknown): number { return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0; }
