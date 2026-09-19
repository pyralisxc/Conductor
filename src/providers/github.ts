import type {
  CapabilityAvailability,
  NormalizedToolError,
  PreflightCheck,
  ProjectReference,
  ToolDiagnostic,
} from '../runtime/types.js';
import { normalizeToolError } from '../runtime/errors.js';
import type { ProjectPreflightProvider } from './runtime.js';

interface GitHubRepositoryResponse {
  full_name: string;
  permissions?: {
    pull?: boolean;
    push?: boolean;
    admin?: boolean;
    maintain?: boolean;
    triage?: boolean;
  };
}

export interface GitHubProjectConfiguration {
  id: string;
  repository: string;
}

export interface GitHubRuntimeProviderOptions {
  token?: string;
  projects: GitHubProjectConfiguration[];
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class GitHubRuntimeProvider implements ProjectPreflightProvider {
  readonly id = 'github';
  private readonly token?: string;
  private readonly projects: ReadonlyMap<string, GitHubProjectConfiguration>;
  private readonly apiBaseUrl: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: GitHubRuntimeProviderOptions) {
    this.token = options.token;
    this.projects = new Map(options.projects.map((project) => [project.id, project]));
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async getCapabilities(): Promise<CapabilityAvailability[]> {
    if (!this.token) {
      return [
        unavailableCapability('github.read', 'read', 'AUTH_REQUIRED'),
        unavailableCapability('github.write', 'write', 'AUTH_REQUIRED'),
        unavailableCapability('repository.read', 'read', 'AUTH_REQUIRED'),
        unavailableCapability('repository.write', 'write', 'AUTH_REQUIRED'),
      ];
    }

    const response = await this.fetch(`${this.apiBaseUrl}/rate_limit`, {
      headers: this.headers(),
    });
    if (!response.ok) throw await githubResponseError(response);

    const projectSpecific: ToolDiagnostic = {
      level: 'info',
      source: this.id,
      message: 'Repository write permission is verified per project during preflight.',
    };

    return [
      availableCapability('github.read', 'read'),
      unverifiedCapability('github.write', 'write', projectSpecific),
      availableCapability('repository.read', 'read'),
      unverifiedCapability('repository.write', 'write', projectSpecific),
      availableCapability('pull-request.read', 'read'),
      unverifiedCapability('pull-request.write', 'write', projectSpecific),
      availableCapability('ci.read', 'read'),
    ];
  }

  async preflightProject(project: ProjectReference): Promise<PreflightCheck[]> {
    const configured = this.projects.get(project.id);
    if (!configured) {
      return githubChecks('blocked', normalizeToolError({
        code: 'NOT_FOUND',
        message: `Project ${project.id} is not in the Conductor allowlist`,
      }, 'NOT_FOUND', this.id));
    }
    if (project.repository && project.repository !== configured.repository) {
      return githubChecks('blocked', normalizeToolError({
        code: 'CONFLICT',
        message: `Repository ${project.repository} does not match the configured project repository`,
      }, 'CONFLICT', this.id));
    }
    if (!this.token) {
      return githubChecks('blocked', normalizeToolError({
        code: 'AUTH_REQUIRED',
        message: 'GitHub authentication is not configured',
      }, 'AUTH_REQUIRED', this.id));
    }

    try {
      const response = await this.fetch(
        `${this.apiBaseUrl}/repos/${encodeRepository(configured.repository)}`,
        { headers: this.headers() },
      );
      if (!response.ok) throw await githubResponseError(response);
      const repository = await response.json() as GitHubRepositoryResponse;
      const canRead = repository.permissions?.pull ?? true;
      const canWrite = Boolean(
        repository.permissions?.push ||
        repository.permissions?.admin ||
        repository.permissions?.maintain,
      );

      const readError = canRead ? undefined : normalizeToolError({
        code: 'PERMISSION_DENIED',
        message: `GitHub token cannot read ${configured.repository}`,
      }, 'PERMISSION_DENIED', this.id);
      const writeError = canWrite ? undefined : normalizeToolError({
        code: 'PERMISSION_DENIED',
        message: `GitHub token cannot write ${configured.repository}`,
      }, 'PERMISSION_DENIED', this.id);

      return [
        check('repository.access', canRead, configured.repository, readError),
        check('github.read', canRead, configured.repository, readError),
        check('github.write', canWrite, configured.repository, writeError),
      ];
    } catch (error) {
      const normalized = normalizeToolError(error, 'TOOL_UNAVAILABLE', this.id);
      return githubChecks('blocked', normalized);
    }
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'User-Agent': 'Conductor-Tool-Runtime',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }
}

function encodeRepository(repository: string): string {
  return repository.split('/').map(encodeURIComponent).join('/');
}

function availableCapability(
  capability: CapabilityAvailability['capability'],
  access: CapabilityAvailability['access'],
): CapabilityAvailability {
  return {
    capability,
    available: true,
    provider: 'github',
    access,
    auth: 'ready',
    health: 'ready',
    diagnostics: [],
  };
}

function unavailableCapability(
  capability: CapabilityAvailability['capability'],
  access: CapabilityAvailability['access'],
  code: NormalizedToolError['code'],
): CapabilityAvailability {
  return {
    capability,
    available: false,
    provider: 'github',
    access,
    auth: code === 'AUTH_REQUIRED' ? 'required' : 'denied',
    health: 'unavailable',
    diagnostics: [{
      level: 'error',
      source: 'github',
      code,
      message: 'GitHub authentication is not configured',
    }],
  };
}

function unverifiedCapability(
  capability: CapabilityAvailability['capability'],
  access: CapabilityAvailability['access'],
  diagnostic: ToolDiagnostic,
): CapabilityAvailability {
  return {
    capability,
    available: false,
    provider: 'github',
    access,
    auth: 'ready',
    health: 'degraded',
    diagnostics: [diagnostic],
  };
}

function check(
  id: PreflightCheck['check'],
  ready: boolean,
  repository: string,
  error?: NormalizedToolError,
): PreflightCheck {
  return {
    check: id,
    status: ready ? 'ready' : 'blocked',
    provider: 'github',
    summary: ready
      ? `${id} is available for ${repository}`
      : error?.message ?? `${id} is unavailable for ${repository}`,
    error,
    diagnostics: error?.diagnostics ?? [],
  };
}

function githubChecks(
  status: PreflightCheck['status'],
  error: NormalizedToolError,
): PreflightCheck[] {
  return (['repository.access', 'github.read', 'github.write'] as const).map((id) => ({
    check: id,
    status,
    provider: 'github',
    summary: error.message,
    error,
    diagnostics: error.diagnostics,
  }));
}

async function githubResponseError(response: Response): Promise<unknown> {
  const requestId = response.headers.get('x-github-request-id');
  const body = await response.json().catch(() => undefined) as { message?: string } | undefined;
  return {
    status: response.status,
    message: body?.message ?? `GitHub request failed with status ${response.status}`,
    diagnostics: requestId ? [{
      level: 'error',
      source: 'github',
      message: 'GitHub request failed',
      details: { requestId },
    }] : undefined,
  };
}
