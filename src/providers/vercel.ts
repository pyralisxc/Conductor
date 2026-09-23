import { normalizeToolError } from '../runtime/errors.js';
import type {
  CapabilityAvailability,
  DeploymentLogEntry,
  DeploymentLogs,
  DeploymentProjectStatus,
  DeploymentRecord,
  GetDeploymentLogsInput,
  GetDeploymentStatusInput,
  OperationPreflightCheck,
  ProjectReference,
  RuntimeOperationName,
} from '../runtime/types.js';
import type { DeploymentReadProvider, OperationPreflightProvider } from './runtime.js';

interface VercelProjectBinding {
  id: string;
  project: string;
  teamId?: string;
}

interface VercelDeploymentProviderOptions {
  token?: string;
  bindings: VercelProjectBinding[];
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

type JsonRecord = Record<string, unknown>;

export class VercelDeploymentProvider implements DeploymentReadProvider, OperationPreflightProvider {
  readonly id = 'vercel';
  private readonly token?: string;
  private readonly bindings: ReadonlyMap<string, VercelProjectBinding>;
  private readonly apiBaseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => Date;

  constructor(options: VercelDeploymentProviderOptions) {
    this.token = options.token?.trim() || undefined;
    this.bindings = new Map(options.bindings.map(binding => [binding.id, { ...binding }]));
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.vercel.com').replace(/\/$/u, '');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getCapabilities(): Promise<CapabilityAvailability[]> {
    const configured = this.bindings.size > 0;
    const authenticated = Boolean(this.token);
    return [
      capability('deployment.read', configured, authenticated),
      capability('deployment.logs.read', configured, authenticated),
    ];
  }

  async preflightOperation(
    project: ProjectReference,
    operation: RuntimeOperationName,
  ): Promise<OperationPreflightCheck[] | undefined> {
    if (operation !== 'deployment.status' && operation !== 'deployment.logs') return undefined;
    const binding = this.bindings.get(project.id);
    if (!binding) {
      const error = normalizeToolError({
        code: 'NOT_FOUND',
        source: 'vercel',
        message: `No Vercel deployment binding is configured for ${project.id}`,
      }, 'NOT_FOUND', 'vercel');
      return [{ provider: 'vercel', status: 'blocked', summary: error.message, error, diagnostics: error.diagnostics }];
    }
    if (!this.token) {
      const error = normalizeToolError({
        code: 'AUTH_REQUIRED',
        source: 'vercel',
        message: 'Vercel deployment access requires CONDUCTOR_VERCEL_TOKEN (or VERCEL_TOKEN)',
      }, 'AUTH_REQUIRED', 'vercel');
      return [{ provider: 'vercel', status: 'blocked', summary: error.message, error, diagnostics: error.diagnostics }];
    }
    try {
      const resolved = await this.getProject(binding);
      return [{
        provider: 'vercel',
        status: 'ready',
        summary: `Vercel project ${resolved.name} (${resolved.id}) is readable for ${operation}`,
        diagnostics: [{ level: 'info', source: 'vercel', message: 'Vercel project binding and read credential were verified without mutating provider state.' }],
      }];
    } catch (error) {
      const normalized = normalizeToolError(error, 'TOOL_UNAVAILABLE', 'vercel');
      return [{
        provider: 'vercel',
        status: normalized.code === 'TRANSIENT' ? 'degraded' : 'blocked',
        summary: normalized.message,
        error: normalized,
        diagnostics: normalized.diagnostics,
      }];
    }
  }

  async getDeploymentStatus(input: GetDeploymentStatusInput): Promise<DeploymentProjectStatus> {
    const binding = this.binding(input.project);
    this.requireToken();
    const limit = clamp(input.limit ?? 10, 1, 50);
    const project = await this.getProject(binding);
    const projectId = stringField(project, 'id') ?? binding.project;
    const [deploymentPayload, domainPayload] = await Promise.all([
      this.getJson('/v13/deployments', {
        ...scopeQuery(binding),
        projectId,
        limit: String(limit),
      }),
      this.getJson(`/v9/projects/${encodeURIComponent(projectId)}/domains`, scopeQuery(binding)),
    ]);

    const recent = arrayField(deploymentPayload, 'deployments')
      .map(normalizeDeployment)
      .filter((item): item is DeploymentRecord => Boolean(item));

    const targets = recordField(project, 'targets');
    const productionTarget = targets ? recordField(targets, 'production') : null;
    const productionId = productionTarget ? (stringField(productionTarget, 'id') ?? stringField(productionTarget, 'uid')) : null;
    let production = productionId ? recent.find(item => item.id === productionId) ?? null : null;
    if (productionId && !production) {
      const detail = await this.getJson(`/v13/deployments/${encodeURIComponent(productionId)}`, scopeQuery(binding));
      production = normalizeDeployment(detail);
    }
    if (!production) {
      production = recent.find(item => item.target === 'production' && item.state === 'READY') ?? null;
    }
    const latestProductionAttempt = recent.find(item => item.target === 'production') ?? null;

    const link = recordField(project, 'link');
    const domains = arrayField(domainPayload, 'domains')
      .map(item => {
        const value = record(item);
        const name = value ? stringField(value, 'name') : null;
        if (!name) return null;
        const verified = value?.verified;
        return { name, verified: typeof verified === 'boolean' ? verified : null };
      })
      .filter((item): item is { name: string; verified: boolean | null } => Boolean(item));

    return {
      provider: 'vercel',
      project: {
        id: projectId,
        name: stringField(project, 'name') ?? binding.project,
        productionBranch: link ? stringField(link, 'productionBranch') : null,
        teamId: binding.teamId ?? null,
      },
      production,
      latestProductionAttempt,
      recent,
      domains,
      observedAt: this.now().toISOString(),
    };
  }

  async getDeploymentLogs(input: GetDeploymentLogsInput): Promise<DeploymentLogs> {
    const binding = this.binding(input.project);
    this.requireToken();
    const limit = clamp(input.limit ?? 100, 1, 200);
    const project = await this.getProject(binding);
    const projectId = stringField(project, 'id') ?? binding.project;
    const deployment = await this.getJson(
      `/v13/deployments/${encodeURIComponent(input.deploymentId)}`,
      scopeQuery(binding),
    );
    const deploymentProjectId = stringField(deployment, 'projectId')
      ?? (recordField(deployment, 'project') ? stringField(recordField(deployment, 'project')!, 'id') : null);
    if (deploymentProjectId && deploymentProjectId !== projectId) {
      throw {
        code: 'PERMISSION_DENIED',
        source: 'vercel',
        message: `Deployment ${input.deploymentId} does not belong to configured Vercel project ${projectId}`,
      };
    }

    const response = await this.request(
      `/v3/deployments/${encodeURIComponent(input.deploymentId)}/events`,
      { ...scopeQuery(binding), direction: 'forward', follow: '0' },
    );
    const body = await response.text();
    const events = parseEventStream(body);
    const entries = events.slice(0, limit).map(normalizeLogEntry).filter((item): item is DeploymentLogEntry => Boolean(item));

    return {
      provider: 'vercel',
      projectId,
      deploymentId: input.deploymentId,
      entries,
      truncated: events.length > limit,
      source: 'deployment-events',
      observedAt: this.now().toISOString(),
      note: 'Vercel deployment-event output is bounded and redacted. Provider event availability varies by deployment lifecycle and must not be treated as a complete runtime log archive.',
    };
  }

  private binding(project: ProjectReference): VercelProjectBinding {
    const binding = this.bindings.get(project.id);
    if (!binding) throw { code: 'NOT_FOUND', source: 'vercel', message: `No Vercel deployment binding is configured for ${project.id}` };
    return binding;
  }

  private requireToken(): asserts this is this & { token: string } {
    if (!this.token) throw { code: 'AUTH_REQUIRED', source: 'vercel', message: 'Vercel deployment access requires CONDUCTOR_VERCEL_TOKEN (or VERCEL_TOKEN)' };
  }

  private async getProject(binding: VercelProjectBinding): Promise<JsonRecord> {
    return await this.getJson(
      `/v9/projects/${encodeURIComponent(binding.project)}`,
      scopeQuery(binding),
    );
  }

  private async getJson(path: string, query: Record<string, string>): Promise<JsonRecord> {
    const response = await this.request(path, query);
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      throw { code: 'COMMAND_FAILED', source: 'vercel', message: `Vercel returned a non-JSON response for ${path}` };
    }
    return body as JsonRecord;
  }

  private async request(path: string, query: Record<string, string>): Promise<Response> {
    this.requireToken();
    const url = new URL(`${this.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) if (value) url.searchParams.set(key, value);
    const response = await this.fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json, application/stream+json, text/plain;q=0.8',
        'User-Agent': 'Conductor-Tool-Runtime',
      },
    });
    if (response.ok) return response;
    const text = await response.text().catch(() => '');
    let message = `Vercel request failed with status ${response.status}`;
    try {
      const parsed = JSON.parse(text) as JsonRecord;
      const error = recordField(parsed, 'error');
      message = (error && stringField(error, 'message')) ?? stringField(parsed, 'message') ?? message;
    } catch {}
    throw { status: response.status, source: 'vercel', message };
  }
}

function capability(
  capabilityName: 'deployment.read' | 'deployment.logs.read',
  configured: boolean,
  authenticated: boolean,
): CapabilityAvailability {
  const available = configured && authenticated;
  return {
    capability: capabilityName,
    available,
    provider: 'vercel',
    access: 'read',
    auth: authenticated ? 'ready' : 'required',
    health: available ? 'ready' : 'unavailable',
    diagnostics: available ? [] : [{
      level: 'info',
      source: 'vercel',
      code: authenticated ? 'NOT_FOUND' : 'AUTH_REQUIRED',
      message: authenticated ? 'No Vercel project bindings are configured.' : 'Vercel read credential is not configured.',
    }],
  };
}

function scopeQuery(binding: VercelProjectBinding): Record<string, string> {
  return binding.teamId ? { teamId: binding.teamId } : {};
}

function normalizeDeployment(value: unknown): DeploymentRecord | null {
  const item = record(value);
  if (!item) return null;
  const id = stringField(item, 'uid') ?? stringField(item, 'id');
  if (!id) return null;
  const meta = recordField(item, 'meta');
  const gitSource = recordField(item, 'gitSource');
  const aliases = [
    ...stringArray(item.alias),
    ...stringArray(item.aliases),
  ];
  const urlValue = stringField(item, 'url');
  return {
    id,
    url: urlValue ? (/^https?:\/\//u.test(urlValue) ? urlValue : `https://${urlValue}`) : null,
    state: stringField(item, 'readyState') ?? stringField(item, 'state'),
    target: stringField(item, 'target'),
    createdAt: timestamp(item.createdAt ?? item.created),
    readyAt: timestamp(item.readyAt),
    sourceRevision: (meta && (
      stringField(meta, 'githubCommitSha')
      ?? stringField(meta, 'gitlabCommitSha')
      ?? stringField(meta, 'bitbucketCommitSha')
    )) ?? (gitSource ? stringField(gitSource, 'sha') : null),
    sourceRef: (meta && (
      stringField(meta, 'githubCommitRef')
      ?? stringField(meta, 'gitlabCommitRef')
      ?? stringField(meta, 'bitbucketCommitRef')
    )) ?? (gitSource ? stringField(gitSource, 'ref') : null),
    sourceRepository: (meta && (
      stringField(meta, 'githubCommitRepo')
      ?? stringField(meta, 'githubRepo')
      ?? stringField(meta, 'gitlabProjectName')
    )) ?? null,
    aliases: [...new Set(aliases)].sort(),
    errorCode: stringField(item, 'errorCode'),
    errorMessage: stringField(item, 'errorMessage'),
  };
}

function normalizeLogEntry(value: unknown): DeploymentLogEntry | null {
  const item = record(value);
  if (!item) return null;
  const payload = recordField(item, 'payload');
  const text = stringField(item, 'text')
    ?? stringField(item, 'message')
    ?? (payload ? (stringField(payload, 'text') ?? stringField(payload, 'message')) : null);
  if (!text) return null;
  return {
    createdAt: timestamp(item.createdAt ?? item.created ?? item.timestamp),
    type: stringField(item, 'type'),
    level: stringField(item, 'level') ?? (payload ? stringField(payload, 'level') : null),
    text: redact(text).slice(0, 4_000),
  };
}

function parseEventStream(body: string): unknown[] {
  if (!body.trim()) return [];
  try {
    const parsed = JSON.parse(body) as unknown;
    if (Array.isArray(parsed)) return parsed;
    const value = record(parsed);
    if (value) {
      const events = value.events;
      if (Array.isArray(events)) return events;
      return [parsed];
    }
  } catch {}
  return body.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try { return [JSON.parse(line) as unknown]; }
      catch { return [{ text: line }]; }
    });
}

function redact(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/giu, '$1[redacted]')
    .replace(/((?:token|secret|password|private[_-]?key|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]')
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/gu, '://[redacted]@');
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}
function recordField(value: JsonRecord, key: string): JsonRecord | null {
  return record(value[key]);
}
function stringField(value: JsonRecord, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' && field.trim() ? field.trim() : null;
}
function arrayField(value: JsonRecord, key: string): unknown[] {
  return Array.isArray(value[key]) ? value[key] as unknown[] : [];
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
}
function timestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value > 10_000_000_000 ? value : value * 1_000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}
