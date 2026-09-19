import type {
  CapabilityAvailability,
  NormalizedToolError,
  PreflightCheck,
  ProjectReference,
  CreateBranchInput,
  CreateCommitInput,
  CreatePullRequestInput,
  CommentPullRequestInput,
  ToolDiagnostic,
} from '../runtime/types.js';
import { normalizeToolError } from '../runtime/errors.js';
import type { ProjectMutationProvider, ProjectPreflightProvider } from './runtime.js';

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
  write?: boolean;
}

export interface GitHubRuntimeProviderOptions {
  token?: string;
  projects?: GitHubProjectConfiguration[];
  allowedOwners?: string[];
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class GitHubRuntimeProvider implements ProjectPreflightProvider, ProjectMutationProvider {
  readonly id = 'github';
  private readonly token?: string;
  private readonly projects: ReadonlyMap<string, GitHubProjectConfiguration>;
  private readonly allowedOwners: ReadonlyMap<string, string>;
  private readonly apiBaseUrl: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: GitHubRuntimeProviderOptions) {
    this.token = options.token;
    this.projects = new Map((options.projects ?? []).map((project) => [project.id, project]));
    this.allowedOwners = new Map((options.allowedOwners ?? []).map((owner) => [owner.toLowerCase(), owner]));
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

  resolveProjectReference(project: ProjectReference): ProjectReference {
    const resolution = this.resolveProject(project);
    if ('error' in resolution) return project;
    return { ...project, repository: resolution.project.repository };
  }

  async preflightProject(project: ProjectReference): Promise<PreflightCheck[]> {
    const resolution = this.resolveProject(project);
    if ('error' in resolution) {
      return githubChecks('blocked', normalizeToolError({
        code: resolution.code,
        message: resolution.error,
      }, resolution.code, this.id));
    }
    const configured = resolution.project;
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
      const canWrite = configured.write !== false && Boolean(
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

  async createBranch(input: CreateBranchInput): Promise<{ repository: string; branch: string; commitSha: string }> {
    const repository = this.writableRepository(input.project);
    assertWorkBranch(input.branch);
    assertSha(input.fromSha, 'fromSha');
    const created = await this.request<{ object: { sha: string } }>(repository, '/git/refs', {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: input.fromSha }),
    });
    return { repository, branch: input.branch, commitSha: created.object.sha };
  }

  async createCommit(input: CreateCommitInput): Promise<{ repository: string; branch: string; commitSha: string }> {
    const repository = this.writableRepository(input.project);
    assertWorkBranch(input.branch);
    assertSha(input.expectedHeadSha, 'expectedHeadSha');
    if (!input.message.trim()) throw { code: 'CONFLICT', message: 'Commit message must not be empty' };
    if (input.files.length < 1 || input.files.length > 100) {
      throw { code: 'CONFLICT', message: 'A commit must contain between 1 and 100 files' };
    }
    const totalBytes = input.files.reduce((size, file) => size + Buffer.byteLength(file.content, 'utf8'), 0);
    if (totalBytes > 5 * 1024 * 1024) {
      throw { code: 'PERMISSION_DENIED', message: 'Commit content exceeds the 5 MiB mutation limit' };
    }
    const ref = await this.request<{ object: { sha: string } }>(repository, `/git/ref/heads/${encodePath(input.branch)}`);
    if (ref.object.sha !== input.expectedHeadSha) {
      throw { status: 409, message: `Branch head changed from expected ${input.expectedHeadSha} to ${ref.object.sha}` };
    }
    const parent = await this.request<{ tree: { sha: string } }>(repository, `/git/commits/${encodeURIComponent(input.expectedHeadSha)}`);
    const paths = new Set<string>();
    const validatedFiles = input.files.map((file) => {
      const path = validRepositoryPath(file.path);
      if (Buffer.byteLength(file.content, 'utf8') > 1024 * 1024) {
        throw { code: 'PERMISSION_DENIED', message: `Commit file exceeds the 1 MiB limit: ${path}` };
      }
      if (paths.has(path)) throw { code: 'CONFLICT', message: `Duplicate commit path: ${path}` };
      paths.add(path);
      return { ...file, path };
    });
    const tree = await Promise.all(validatedFiles.map(async (file) => {
      const blob = await this.request<{ sha: string }>(repository, '/git/blobs', {
        method: 'POST',
        body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
      });
      return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
    }));
    const createdTree = await this.request<{ sha: string }>(repository, '/git/trees', {
      method: 'POST',
      body: JSON.stringify({ base_tree: parent.tree.sha, tree }),
    });
    const commit = await this.request<{ sha: string }>(repository, '/git/commits', {
      method: 'POST',
      body: JSON.stringify({ message: input.message, tree: createdTree.sha, parents: [input.expectedHeadSha] }),
    });
    await this.request(repository, `/git/refs/heads/${encodePath(input.branch)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
    return { repository, branch: input.branch, commitSha: commit.sha };
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<{ repository: string; pullRequestNumber: number; url: string }> {
    const repository = this.writableRepository(input.project);
    assertWorkBranch(input.head);
    if (input.base !== 'preview') throw { code: 'PERMISSION_DENIED', message: 'Conductor may only open work pull requests targeting preview' };
    const created = await this.request<{ number: number; html_url: string }>(repository, '/pulls', {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body ?? '',
        draft: input.draft ?? false,
      }),
    });
    return { repository, pullRequestNumber: created.number, url: created.html_url };
  }

  async commentPullRequest(input: CommentPullRequestInput): Promise<{ repository: string; pullRequestNumber: number; commentId: string; url: string }> {
    const repository = this.writableRepository(input.project);
    if (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1) {
      throw { code: 'CONFLICT', message: 'pullRequestNumber must be a positive integer' };
    }
    const created = await this.request<{ id: number; html_url: string }>(repository, `/issues/${input.pullRequestNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: input.body }),
    });
    return {
      repository,
      pullRequestNumber: input.pullRequestNumber,
      commentId: String(created.id),
      url: created.html_url,
    };
  }

  resolveProject(project: ProjectReference): { project: GitHubProjectConfiguration } | {
    error: string;
    code: 'NOT_FOUND' | 'CONFLICT';
  } {
    const explicit = this.projects.get(project.id);
    if (explicit) {
      if (project.repository && !sameRepository(project.repository, explicit.repository)) {
        return {
          code: 'CONFLICT',
          error: `Repository ${project.repository} does not match the configured project repository`,
        };
      }
      return { project: explicit };
    }

    const requested = project.repository
      ?? (project.id.includes('/') ? project.id : this.singleOwnerRepository(project.id));
    if (!requested) {
      return {
        code: 'NOT_FOUND',
        error: `Project ${project.id} is not an explicit project and cannot be resolved to an authorized owner`,
      };
    }
    const parsed = parseRepository(requested);
    if (!parsed) {
      return { code: 'NOT_FOUND', error: `Repository ${requested} is not a valid owner/repository identity` };
    }
    const authorizedOwner = this.allowedOwners.get(parsed.owner.toLowerCase());
    if (!authorizedOwner) {
      return { code: 'NOT_FOUND', error: `GitHub owner ${parsed.owner} is not authorized` };
    }
    return {
      project: {
        id: project.id,
        repository: `${authorizedOwner}/${parsed.repository}`,
      },
    };
  }

  private singleOwnerRepository(projectId: string): string | undefined {
    if (this.allowedOwners.size !== 1 || !validRepositoryName(projectId)) return undefined;
    return `${[...this.allowedOwners.values()][0]}/${projectId}`;
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'User-Agent': 'Conductor-Tool-Runtime',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private writableRepository(project: ProjectReference): string {
    if (!this.token) throw { code: 'AUTH_REQUIRED', message: 'GitHub authentication is not configured' };
    const resolution = this.resolveProject(project);
    if ('error' in resolution) throw { code: resolution.code, message: resolution.error };
    if (resolution.project.write === false) {
      throw { code: 'PERMISSION_DENIED', message: `Writes are disabled for ${resolution.project.repository}` };
    }
    return resolution.project.repository;
  }

  private async request<Result>(
    repository: string,
    path: string,
    init: RequestInit = {},
  ): Promise<Result> {
    const response = await this.fetch(`${this.apiBaseUrl}/repos/${encodeRepository(repository)}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers ?? {}) },
    });
    if (!response.ok) throw await githubResponseError(response);
    return await response.json() as Result;
  }
}

function assertWorkBranch(branch: string): void {
  if (!/^work\/[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..') || branch.endsWith('/')) {
    throw { code: 'PERMISSION_DENIED', message: 'Conductor mutations are limited to valid work/* branches' };
  }
}

function assertSha(value: string, field: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw { code: 'CONFLICT', message: `${field} must be a full 40-character Git SHA` };
}

function validRepositoryPath(value: string): string {
  if (!value || value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.split('/').includes('..')) {
    throw { code: 'PERMISSION_DENIED', message: `Unsafe repository path: ${value}` };
  }
  return value;
}

function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function validRepositoryName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
}

function parseRepository(value: string): { owner: string; repository: string } | undefined {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)$/.exec(value);
  if (!match?.[1] || !match[2] || !validRepositoryName(match[2])) return undefined;
  return { owner: match[1], repository: match[2] };
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
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
