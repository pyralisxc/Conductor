import type {
  CapabilityAvailability,
  NormalizedToolError,
  PreflightCheck,
  OperationPreflightCheck,
  ProjectReference,
  RuntimeOperationName,
  CreateBranchInput,
  CreateCommitInput,
  CreatePullRequestInput,
  CommentPullRequestInput,
  GetPullRequestStatusInput,
  PullRequestStatus,
  UpdatePullRequestLabelsInput,
  MergeIntegrationPullRequestInput,
  ReconcilePreviewPullRequestInput,
  PromotePullRequestInput,
  PullRequestMergeMethod,
  ToolDiagnostic,
  GetWorkItemStatusInput,
  GetWorkItemCandidatesInput,
  ListWorkItemsInput,
  WorkItemRecord,
  WorkItemList,
  WorkItemStatus,
  MutableWorkItemStatus,
  WorkItemKind,
  MutableWorkItemKind,
  WorkItemOrigin,
  MutableWorkItemOrigin,
  WorkItemClassificationSource,
  CreateWorkItemInput,
  UpdateWorkItemStatusInput,
  UpdateWorkItemClassificationInput,
} from '../runtime/types.js';
import { normalizeToolError } from '../runtime/errors.js';
import type { OperationPreflightProvider, SourceControlMutationProvider, ProjectPreflightProvider, PullRequestReadProvider, WorkItemCandidateReadProvider, WorkItemMutationProvider } from './runtime.js';
import {
  StaticGitHubCredentialProvider,
  type GitHubCredential,
  type GitHubCredentialProvider,
} from './github-auth.js';

interface GitHubRepositoryResponse {
  full_name: string;
  default_branch?: string;
  permissions?: {
    pull?: boolean;
    push?: boolean;
    admin?: boolean;
    maintain?: boolean;
    triage?: boolean;
  };
}

interface GitHubPullRequestResponse {
  number: number;
  html_url: string;
  state: string;
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  labels?: Array<{ name?: string | null }>;
}

interface GitHubIssueResponse {
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  state: string;
  labels?: Array<string | { name?: string | null }>;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

interface GitHubIssueTimelineEvent {
  event: string;
  source?: {
    issue?: {
      number: number;
      repository_url?: string;
      pull_request?: unknown;
    };
  };
}

interface GitHubCheckRunsResponse {
  check_runs: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    details_url?: string | null;
    app?: { slug?: string | null; name?: string | null } | null;
  }>;
}

interface GitHubWorkflowRunsResponse {
  workflow_runs: Array<{
    id: number;
    name?: string | null;
    status: string;
    conclusion: string | null;
    html_url?: string | null;
  }>;
}

interface GitHubLabelResponse {
  name: string;
}

interface GitHubMergeResponse {
  sha?: string | null;
  merged: boolean;
  message: string;
}

export interface GitHubRepositoryBinding {
  id: string;
  repository: string;
  write?: boolean;
}

export interface GitHubRuntimeProviderOptions {
  token?: string;
  credentials?: GitHubCredentialProvider;
  bindings?: GitHubRepositoryBinding[];
  allowedOwners?: string[];
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class GitHubRuntimeProvider implements ProjectPreflightProvider, OperationPreflightProvider, SourceControlMutationProvider, PullRequestReadProvider, WorkItemCandidateReadProvider, WorkItemMutationProvider {
  readonly id = 'github';
  private readonly credentials?: GitHubCredentialProvider;
  private readonly bindings: ReadonlyMap<string, GitHubRepositoryBinding>;
  private readonly allowedOwners: ReadonlyMap<string, string>;
  private readonly apiBaseUrl: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: GitHubRuntimeProviderOptions) {
    if (options.token && options.credentials) {
      throw new Error('Configure either a GitHub token or GitHub App credentials, not both');
    }
    this.credentials = options.credentials ?? (options.token
      ? new StaticGitHubCredentialProvider(options.token)
      : undefined);
    this.bindings = new Map((options.bindings ?? []).map((binding) => [binding.id, binding]));
    this.allowedOwners = new Map((options.allowedOwners ?? []).map((owner) => [owner.toLowerCase(), owner]));
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async getCapabilities(): Promise<CapabilityAvailability[]> {
    if (!this.credentials) {
      return [
        unavailableCapability('github.read', 'read', 'AUTH_REQUIRED'),
        unavailableCapability('github.write', 'write', 'AUTH_REQUIRED'),
        unavailableCapability('repository.read', 'read', 'AUTH_REQUIRED'),
        unavailableCapability('repository.write', 'write', 'AUTH_REQUIRED'),
        unavailableCapability('work-item.read', 'read', 'AUTH_REQUIRED'),
        unavailableCapability('work-item.write', 'write', 'AUTH_REQUIRED'),
      ];
    }

    const identity = await this.credentials.getIdentity();
    if (identity.kind === 'static-token') {
      const credential = await this.credentials.getCredential('runtime/identity');
      const response = await this.fetch(`${this.apiBaseUrl}/rate_limit`, {
        headers: this.headers(credential.token),
      });
      if (!response.ok) throw await githubResponseError(response);
    }

    const projectSpecific: ToolDiagnostic = {
      level: 'info',
      source: this.id,
      message: identity.kind === 'app'
        ? `GitHub App ${identity.appSlug ?? identity.appId ?? 'identity'} permissions are verified per repository and operation during preflight.`
        : 'Static-token write reach is repository-scoped but cannot prove operation-specific token permissions; migrate to the Conductor GitHub App.',
    };

    return [
      availableCapability('github.read', 'read'),
      unverifiedCapability('github.write', 'write', projectSpecific),
      availableCapability('repository.read', 'read'),
      unverifiedCapability('repository.write', 'write', projectSpecific),
      availableCapability('pull-request.read', 'read'),
      unverifiedCapability('pull-request.write', 'write', projectSpecific),
      availableCapability('work-item.read', 'read'),
      unverifiedCapability('work-item.write', 'write', projectSpecific),
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
    if (!this.credentials) {
      return githubChecks('blocked', normalizeToolError({
        code: 'AUTH_REQUIRED',
        message: 'GitHub authentication is not configured',
      }, 'AUTH_REQUIRED', this.id));
    }

    try {
      const credential = await this.credentials.getCredential(configured.repository);
      const response = await this.fetch(
        `${this.apiBaseUrl}/repos/${encodeRepository(configured.repository)}`,
        { headers: this.headers(credential.token) },
      );
      if (!response.ok) throw await githubResponseError(response);
      const repository = await response.json() as GitHubRepositoryResponse;
      const appInstallation = credential.kind === 'app-installation';
      const canRead = appInstallation ? true : (repository.permissions?.pull ?? true);
      const repositoryRoleAllowsWrite = configured.write !== false && (
        appInstallation ||
        Boolean(
          repository.permissions?.push ||
          repository.permissions?.admin ||
          repository.permissions?.maintain,
        )
      );

      const readError = canRead ? undefined : normalizeToolError({
        code: 'PERMISSION_DENIED',
        message: `GitHub token cannot read ${configured.repository}`,
      }, 'PERMISSION_DENIED', this.id);
      const permissionEvidence = permissionDiagnostics(credential, configured.repository);
      const missingPermissions = credential.kind === 'app-installation'
        ? missingDevelopPermissions(credential)
        : [];
      const canWrite = repositoryRoleAllowsWrite && missingPermissions.length === 0;
      const writeError = canWrite ? undefined : normalizeToolError({
        code: 'PERMISSION_DENIED',
        message: missingPermissions.length > 0
          ? `GitHub App installation lacks required develop permissions for ${configured.repository}: ${missingPermissions.join(', ')}`
          : `GitHub credential cannot write ${configured.repository}`,
      }, 'PERMISSION_DENIED', this.id);

      const writeCheck = credential.kind === 'static-token' && canWrite
        ? {
          check: 'github.write' as const,
          status: 'degraded' as const,
          provider: 'github',
          summary: `Repository role allows writes to ${configured.repository}, but the static token cannot prove operation-specific permissions`,
          diagnostics: permissionEvidence,
        }
        : check('github.write', canWrite, configured.repository, writeError, [
          ...permissionEvidence,
          ...(writeError?.diagnostics ?? []),
        ]);

      return [
        check('repository.access', canRead, configured.repository, readError, [
          ...permissionEvidence,
          ...(readError?.diagnostics ?? []),
        ]),
        check('github.read', canRead, configured.repository, readError, [
          ...permissionEvidence,
          ...(readError?.diagnostics ?? []),
        ]),
        writeCheck,
      ];
    } catch (error) {
      const normalized = normalizeToolError(error, 'TOOL_UNAVAILABLE', this.id);
      return githubChecks('blocked', normalized);
    }
  }

  async preflightOperation(
    project: ProjectReference,
    operation: RuntimeOperationName,
  ): Promise<OperationPreflightCheck[] | undefined> {
    const requirements = githubOperationRequirements(operation);
    if (!requirements) return undefined;
    const resolution = this.resolveProject(project);
    if ('error' in resolution) {
      const error = normalizeToolError({
        code: resolution.code,
        message: resolution.error,
      }, resolution.code, this.id);
      return [operationCheck('blocked', error.message, error, error.diagnostics)];
    }
    if (!this.credentials) {
      const error = normalizeToolError({
        code: 'AUTH_REQUIRED',
        message: 'GitHub authentication is not configured',
      }, 'AUTH_REQUIRED', this.id);
      return [operationCheck('blocked', error.message, error, error.diagnostics)];
    }
    const configured = resolution.project;
    if (requirements.access === 'write' && configured.write === false) {
      const error = normalizeToolError({
        code: 'PERMISSION_DENIED',
        message: `Writes are disabled for ${configured.repository}`,
      }, 'PERMISSION_DENIED', this.id);
      return [operationCheck('blocked', error.message, error, error.diagnostics)];
    }
    try {
      const credential = await this.credentials.getCredential(configured.repository);
      const evidence = permissionDiagnostics(credential, configured.repository);
      if (credential.kind === 'app-installation') {
        const missing = missingPermissions(credential, requirements.permissions);
        if (missing.length > 0) {
          const error = normalizeToolError({
            code: 'PERMISSION_DENIED',
            message: `GitHub App installation lacks required permissions for ${configured.repository}: ${missing.join(', ')}`,
          }, 'PERMISSION_DENIED', this.id);
          return [operationCheck('blocked', error.message, error, [...evidence, ...error.diagnostics])];
        }
        return [operationCheck(
          'ready',
          `GitHub App can execute ${operation} for ${configured.repository}`,
          undefined,
          evidence,
        )];
      }

      const response = await this.fetch(
        `${this.apiBaseUrl}/repos/${encodeRepository(configured.repository)}`,
        { headers: this.headers(credential.token) },
      );
      if (!response.ok) throw await githubResponseError(response);
      const repository = await response.json() as GitHubRepositoryResponse;
      const canRead = repository.permissions?.pull ?? true;
      if (!canRead) {
        const error = normalizeToolError({
          code: 'PERMISSION_DENIED',
          message: `GitHub token cannot read ${configured.repository}`,
        }, 'PERMISSION_DENIED', this.id);
        return [operationCheck('blocked', error.message, error, [...evidence, ...error.diagnostics])];
      }
      if (requirements.access === 'write') {
        const canWrite = Boolean(
          repository.permissions?.push
          || repository.permissions?.admin
          || repository.permissions?.maintain,
        );
        if (!canWrite) {
          const error = normalizeToolError({
            code: 'PERMISSION_DENIED',
            message: `GitHub token repository role cannot execute ${operation} for ${configured.repository}`,
          }, 'PERMISSION_DENIED', this.id);
          return [operationCheck('blocked', error.message, error, [...evidence, ...error.diagnostics])];
        }
      }
      return [operationCheck(
        'degraded',
        `Repository role permits ${operation} for ${configured.repository}, but a static token cannot prove operation-specific permissions`,
        undefined,
        evidence,
      )];
    } catch (error) {
      const normalized = normalizeToolError(error, 'TOOL_UNAVAILABLE', this.id);
      return [operationCheck(
        normalized.code === 'TRANSIENT' ? 'degraded' : 'blocked',
        normalized.message,
        normalized,
        normalized.diagnostics,
      )];
    }
  }

  async getPullRequestStatus(input: GetPullRequestStatusInput): Promise<PullRequestStatus> {
    const { repository, credential } = await this.readableRepository(input.project, GITHUB_READ_OPERATION_PERMISSIONS['pull-request.status']);
    assertPullRequestNumber(input.pullRequestNumber);
    const pull = await this.request<GitHubPullRequestResponse>(
      repository,
      `/pulls/${input.pullRequestNumber}`,
      {},
      credential,
    );
    const [checkRuns, workflowRuns] = await Promise.all([
      this.request<GitHubCheckRunsResponse>(
        repository,
        `/commits/${encodeURIComponent(pull.head.sha)}/check-runs?per_page=100`,
        {},
        credential,
      ),
      this.request<GitHubWorkflowRunsResponse>(
        repository,
        `/actions/runs?head_sha=${encodeURIComponent(pull.head.sha)}&per_page=100`,
        {},
        credential,
      ),
    ]);
    const items = checkRuns.check_runs.map((check) => ({
      id: check.id,
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      detailsUrl: check.details_url ?? null,
      app: check.app?.slug ?? check.app?.name ?? null,
    }));
    const pending = items.filter((check) => check.status !== 'completed').length;
    const successful = items.filter((check) => check.conclusion === 'success').length;
    const neutral = items.filter((check) => check.conclusion === 'neutral').length;
    const skipped = items.filter((check) => check.conclusion === 'skipped').length;
    const failed = items.filter((check) =>
      check.status === 'completed'
      && check.conclusion !== null
      && !['success', 'neutral', 'skipped'].includes(check.conclusion)
    ).length;
    return {
      repository,
      pullRequestNumber: pull.number,
      url: pull.html_url,
      state: pull.state,
      draft: pull.draft ?? false,
      merged: pull.merged ?? false,
      mergeable: pull.mergeable ?? null,
      mergeableState: pull.mergeable_state ?? null,
      head: pull.head,
      base: pull.base,
      labels: (pull.labels ?? []).flatMap((label) => label.name ? [label.name] : []),
      checks: {
        total: items.length,
        pending,
        successful,
        failed,
        neutral,
        skipped,
        items,
      },
      workflowRuns: workflowRuns.workflow_runs.map((run) => ({
        id: run.id,
        name: run.name ?? `workflow-${run.id}`,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url ?? null,
      })),
    };
  }

  async createBranch(input: CreateBranchInput): Promise<{ repository: string; branch: string; commitSha: string }> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['git.branch.create']);
    assertWorkBranch(input.branch);
    assertSha(input.fromSha, 'fromSha');
    const created = await this.request<{ object: { sha: string } }>(repository, '/git/refs', {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: input.fromSha }),
    }, credential);
    return { repository, branch: input.branch, commitSha: created.object.sha };
  }

  async createCommit(input: CreateCommitInput): Promise<{ repository: string; branch: string; commitSha: string }> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['git.commit.create']);
    assertWorkBranch(input.branch);
    assertSha(input.expectedHeadSha, 'expectedHeadSha');
    if (!input.message.trim()) throw { code: 'CONFLICT', message: 'Commit message must not be empty' };
    if (input.files.length < 1 || input.files.length > 100) {
      throw { code: 'CONFLICT', message: 'A commit must contain between 1 and 100 files' };
    }
    const totalBytes = input.files.reduce((size, file) => size + (file.content === null ? 0 : Buffer.byteLength(file.content, 'utf8')), 0);
    if (totalBytes > 5 * 1024 * 1024) {
      throw { code: 'PERMISSION_DENIED', message: 'Commit content exceeds the 5 MiB mutation limit' };
    }
    const ref = await this.request<{ object: { sha: string } }>(repository, `/git/ref/heads/${encodePath(input.branch)}`, {}, credential);
    if (ref.object.sha !== input.expectedHeadSha) {
      throw { status: 409, message: `Branch head changed from expected ${input.expectedHeadSha} to ${ref.object.sha}` };
    }
    const parent = await this.request<{ tree: { sha: string } }>(repository, `/git/commits/${encodeURIComponent(input.expectedHeadSha)}`, {}, credential);
    const paths = new Set<string>();
    const validatedFiles = input.files.map((file) => {
      const path = validRepositoryPath(file.path);
      if (file.content !== null && Buffer.byteLength(file.content, 'utf8') > 1024 * 1024) {
        throw { code: 'PERMISSION_DENIED', message: `Commit file exceeds the 1 MiB limit: ${path}` };
      }
      if (paths.has(path)) throw { code: 'CONFLICT', message: `Duplicate commit path: ${path}` };
      paths.add(path);
      return { ...file, path };
    });
    const tree = await Promise.all(validatedFiles.map(async (file) => {
      if (file.content === null) return { path: file.path, mode: '100644', type: 'blob', sha: null };
      const blob = await this.request<{ sha: string }>(repository, '/git/blobs', {
        method: 'POST',
        body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
      }, credential);
      return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
    }));
    const createdTree = await this.request<{ sha: string }>(repository, '/git/trees', {
      method: 'POST',
      body: JSON.stringify({ base_tree: parent.tree.sha, tree }),
    }, credential);
    const commit = await this.request<{ sha: string }>(repository, '/git/commits', {
      method: 'POST',
      body: JSON.stringify({ message: input.message, tree: createdTree.sha, parents: [input.expectedHeadSha] }),
    }, credential);
    await this.request(repository, `/git/refs/heads/${encodePath(input.branch)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: false }),
    }, credential);
    return { repository, branch: input.branch, commitSha: commit.sha };
  }


  async getWorkItemStatus(input: GetWorkItemStatusInput): Promise<WorkItemRecord> {
    const { repository, credential } = await this.readableRepository(input.project, GITHUB_READ_OPERATION_PERMISSIONS['work-item.status']);
    assertIssueNumber(input.issueNumber);
    const issue = await this.request<GitHubIssueResponse>(repository, `/issues/${input.issueNumber}`, {}, credential);
    assertIssueIsWorkItem(issue);
    return workItemFromIssue(repository, issue);
  }

  async listWorkItems(input: ListWorkItemsInput): Promise<WorkItemList> {
    const { repository, credential } = await this.readableRepository(input.project, GITHUB_READ_OPERATION_PERMISSIONS['work-item.list']);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const statuses = input.statuses?.length ? new Set(input.statuses) : undefined;
    const kinds = input.kinds?.length ? new Set(input.kinds) : undefined;
    const origins = input.origins?.length ? new Set(input.origins) : undefined;
    const issues = await this.request<GitHubIssueResponse[]>(
      repository,
      '/issues?state=all&per_page=100&sort=updated&direction=desc',
      {},
      credential,
    );
    const filtered = issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => workItemFromIssue(repository, issue))
      .filter((item) => !statuses || statuses.has(item.status))
      .filter((item) => !kinds || kinds.has(item.kind))
      .filter((item) => !origins || origins.has(item.origin));
    return {
      repository,
      items: filtered.slice(0, limit),
      truncated: filtered.length > limit,
    };
  }

  async listWorkItemPullRequests(input: GetWorkItemCandidatesInput): Promise<PullRequestStatus[]> {
    const { repository, credential } = await this.readableRepository(input.project, GITHUB_READ_OPERATION_PERMISSIONS['development.status']);
    assertIssueNumber(input.issueNumber);
    const timeline = await this.request<GitHubIssueTimelineEvent[]>(
      repository,
      `/issues/${input.issueNumber}/timeline?per_page=100`,
      { headers: { Accept: 'application/vnd.github+json' } },
      credential,
    );
    const repositoryUrl = `${this.apiBaseUrl}/repos/${encodeRepository(repository)}`.toLowerCase();
    const pullRequestNumbers = [...new Set(timeline.flatMap((event) => {
      if (event.event !== 'cross-referenced') return [];
      const referenced = event.source?.issue;
      if (!referenced?.pull_request || referenced.repository_url?.toLowerCase() !== repositoryUrl) return [];
      return [referenced.number];
    }))].slice(0, 10);

    return await Promise.all(pullRequestNumbers.map(async (pullRequestNumber) =>
      await this.getPullRequestStatus({ project: input.project, pullRequestNumber })
    ));
  }

  async createWorkItem(input: CreateWorkItemInput): Promise<WorkItemRecord> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['work-item.create']);
    const title = input.title.trim();
    if (!title) throw { code: 'CONFLICT', message: 'Work-item title must not be empty' };
    if (title.length > 256) throw { code: 'CONFLICT', message: 'Work-item title must be 256 characters or fewer' };
    const status = input.status ?? 'backlog';
    const kind = input.kind ?? 'unknown';
    const origin = input.origin ?? 'unknown';
    const labels = normalizedLabels(input.labels);
    if (labels.some(isWorkItemReservedLabel)) {
      throw { code: 'CONFLICT', message: 'Work-item labels may not set reserved status:*, kind:*, or origin:* labels directly' };
    }
    await this.ensureWorkItemStatusLabel(repository, credential, status);
    if (kind !== 'unknown') await this.ensureWorkItemKindLabel(repository, credential, kind);
    if (origin !== 'unknown') await this.ensureWorkItemOriginLabel(repository, credential, origin);
    const created = await this.request<GitHubIssueResponse>(repository, '/issues', {
      method: 'POST',
      body: JSON.stringify({
        title,
        body: input.body ?? '',
        labels: [
          ...labels,
          workItemStatusLabel(status),
          ...(kind === 'unknown' ? [] : [workItemKindLabel(kind)]),
          ...(origin === 'unknown' ? [] : [workItemOriginLabel(origin)]),
        ],
      }),
    }, credential);
    return workItemFromIssue(repository, created);
  }

  async updateWorkItemStatus(input: UpdateWorkItemStatusInput): Promise<WorkItemRecord> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['work-item.update-status']);
    assertIssueNumber(input.issueNumber);
    const current = await this.request<GitHubIssueResponse>(repository, `/issues/${input.issueNumber}`, {}, credential);
    assertIssueIsWorkItem(current);
    await this.ensureWorkItemStatusLabel(repository, credential, input.status);
    const labels = issueLabelNames(current).filter((label) => !isWorkItemStatusLabel(label));
    const nextLabels = [...labels, workItemStatusLabel(input.status)].sort((a, b) => a.localeCompare(b));
    const updated = await this.request<GitHubIssueResponse>(repository, `/issues/${input.issueNumber}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: input.status === 'done' ? 'closed' : 'open' }),
    }, credential);
    const updatedLabels = await this.request<GitHubLabelResponse[]>(repository, `/issues/${input.issueNumber}/labels`, {
      method: 'PUT',
      body: JSON.stringify({ labels: nextLabels }),
    }, credential);
    return workItemFromIssue(repository, {
      ...updated,
      labels: updatedLabels,
    });
  }

  async updateWorkItemClassification(input: UpdateWorkItemClassificationInput): Promise<WorkItemRecord> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['work-item.classification.update']);
    assertIssueNumber(input.issueNumber);
    if (input.kind === undefined && input.origin === undefined) {
      throw { code: 'CONFLICT', message: 'At least one of kind or origin must be provided' };
    }
    const current = await this.request<GitHubIssueResponse>(repository, `/issues/${input.issueNumber}`, {}, credential);
    assertIssueIsWorkItem(current);
    let labels = issueLabelNames(current);

    if (input.kind !== undefined) {
      labels = labels.filter((label) => !isWorkItemKindLabel(label));
      if (input.kind !== 'unknown') {
        await this.ensureWorkItemKindLabel(repository, credential, input.kind);
        labels.push(workItemKindLabel(input.kind));
      }
    }
    if (input.origin !== undefined) {
      labels = labels.filter((label) => !isWorkItemOriginLabel(label));
      if (input.origin !== 'unknown') {
        await this.ensureWorkItemOriginLabel(repository, credential, input.origin);
        labels.push(workItemOriginLabel(input.origin));
      }
    }

    const updatedLabels = await this.request<GitHubLabelResponse[]>(
      repository,
      `/issues/${input.issueNumber}/labels`,
      {
        method: 'PUT',
        body: JSON.stringify({ labels: normalizedLabels(labels).sort((a, b) => a.localeCompare(b)) }),
      },
      credential,
    );
    return workItemFromIssue(repository, { ...current, labels: updatedLabels });
  }

  private async ensureWorkItemStatusLabel(
    repository: string,
    credential: GitHubCredential,
    status: MutableWorkItemStatus,
  ): Promise<void> {
    await this.ensureWorkItemLabel(
      repository,
      credential,
      workItemStatusLabel(status),
      workItemStatusColor(status),
      `Conductor work status: ${status}`,
    );
  }

  private async ensureWorkItemKindLabel(
    repository: string,
    credential: GitHubCredential,
    kind: MutableWorkItemKind,
  ): Promise<void> {
    await this.ensureWorkItemLabel(
      repository,
      credential,
      workItemKindLabel(kind),
      workItemKindColor(kind),
      `Conductor work kind: ${kind}`,
    );
  }

  private async ensureWorkItemOriginLabel(
    repository: string,
    credential: GitHubCredential,
    origin: MutableWorkItemOrigin,
  ): Promise<void> {
    await this.ensureWorkItemLabel(
      repository,
      credential,
      workItemOriginLabel(origin),
      workItemOriginColor(origin),
      `Conductor work origin: ${origin}`,
    );
  }

  private async ensureWorkItemLabel(
    repository: string,
    credential: GitHubCredential,
    name: string,
    color: string,
    description: string,
  ): Promise<void> {
    const response = await this.fetch(
      `${this.apiBaseUrl}/repos/${encodeRepository(repository)}/labels/${encodeURIComponent(name)}`,
      { headers: this.headers(credential.token) },
    );
    if (response.ok) return;
    if (response.status !== 404) throw await githubResponseError(response);
    const created = await this.fetch(`${this.apiBaseUrl}/repos/${encodeRepository(repository)}/labels`, {
      method: 'POST',
      headers: this.headers(credential.token),
      body: JSON.stringify({ name, color, description }),
    });
    if (!created.ok && created.status !== 422) throw await githubResponseError(created);
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<{ repository: string; pullRequestNumber: number; url: string }> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['pull-request.create']);
    assertWorkBranch(input.head);
    const base = input.base.trim();
    if (!base || base.startsWith('refs/')) throw { code: 'CONFLICT', message: 'Pull-request base must be a branch name' };
    if (base === input.head) throw { code: 'CONFLICT', message: 'Pull-request head and base must differ' };
    const created = await this.request<{ number: number; html_url: string }>(repository, '/pulls', {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        head: input.head,
        base,
        body: input.body ?? '',
        draft: input.draft ?? false,
      }),
    }, credential);
    return { repository, pullRequestNumber: created.number, url: created.html_url };
  }

  async commentPullRequest(input: CommentPullRequestInput): Promise<{ repository: string; pullRequestNumber: number; commentId: string; url: string }> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['pull-request.comment.create']);
    if (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1) {
      throw { code: 'CONFLICT', message: 'pullRequestNumber must be a positive integer' };
    }
    const created = await this.request<{ id: number; html_url: string }>(repository, `/issues/${input.pullRequestNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: input.body }),
    }, credential);
    return {
      repository,
      pullRequestNumber: input.pullRequestNumber,
      commentId: String(created.id),
      url: created.html_url,
    };
  }

  async updatePullRequestLabels(input: UpdatePullRequestLabelsInput): Promise<{ repository: string; pullRequestNumber: number; labels: string[] }> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['pull-request.labels.update']);
    assertPullRequestNumber(input.pullRequestNumber);
    const add = normalizedLabels(input.add);
    const remove = new Set(normalizedLabels(input.remove).map((label) => label.toLowerCase()));
    if (!add.length && !remove.size) throw { code: 'CONFLICT', message: 'At least one label must be added or removed' };
    const current = await this.request<GitHubLabelResponse[]>(
      repository,
      `/issues/${input.pullRequestNumber}/labels?per_page=100`,
      {},
      credential,
    );
    const next = new Map(current.map((label) => [label.name.toLowerCase(), label.name]));
    for (const label of remove) next.delete(label);
    for (const label of add) next.set(label.toLowerCase(), label);
    const updated = await this.request<GitHubLabelResponse[]>(
      repository,
      `/issues/${input.pullRequestNumber}/labels`,
      {
        method: 'PUT',
        body: JSON.stringify({ labels: [...next.values()].sort((a, b) => a.localeCompare(b)) }),
      },
      credential,
    );
    return {
      repository,
      pullRequestNumber: input.pullRequestNumber,
      labels: updated.map((label) => label.name).sort((a, b) => a.localeCompare(b)),
    };
  }

  async mergeIntegrationPullRequest(input: MergeIntegrationPullRequestInput): Promise<{ repository: string; pullRequestNumber: number; merged: boolean; mergeCommitSha: string; message: string }> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['pull-request.merge.integration']);
    const pull = await this.mergeCandidate(repository, credential, input.pullRequestNumber, input.expectedHeadSha, input.expectedBaseSha);
    const repositoryInfo = await this.request<GitHubRepositoryResponse>(repository, '', {}, credential);
    const protectedBases = new Set(
      ['main', 'master', repositoryInfo.default_branch]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase()),
    );
    if (protectedBases.has(pull.base.ref.toLowerCase())) {
      throw { code: 'PERMISSION_DENIED', message: `Integration merge cannot target accepted/default branch ${pull.base.ref}` };
    }
    assertIntegrationSourceBranch(pull.head.ref);
    return await this.mergePullRequest(repository, credential, pull, input.mergeMethod ?? 'squash');
  }

  async reconcilePreviewPullRequest(input: ReconcilePreviewPullRequestInput): Promise<{ repository: string; pullRequestNumber: number; merged: boolean; mergeCommitSha: string; message: string }> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['pull-request.merge.reconcile-preview']);
    const pull = await this.mergeCandidate(repository, credential, input.pullRequestNumber, input.expectedHeadSha, input.expectedBaseSha);
    const repositoryInfo = await this.request<GitHubRepositoryResponse>(repository, '', {}, credential);
    if (!repositoryInfo.default_branch || pull.head.ref.toLowerCase() !== repositoryInfo.default_branch.toLowerCase()) {
      throw {
        code: 'PERMISSION_DENIED',
        message: `Preview reconciliation source must be repository default branch ${repositoryInfo.default_branch ?? '(unknown)'}`,
      };
    }
    assertPreviewReconciliationTarget(pull.base.ref);
    return await this.mergePullRequest(repository, credential, pull, 'merge');
  }

  async promotePullRequest(input: PromotePullRequestInput): Promise<{ repository: string; pullRequestNumber: number; merged: boolean; mergeCommitSha: string; message: string; approvalReference: string }> {
    const approvalReference = input.approvalReference.trim();
    if (!approvalReference) throw { code: 'PERMISSION_DENIED', message: 'Promotion requires a non-empty owner approval reference' };
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['pull-request.merge.promote']);
    const pull = await this.mergeCandidate(repository, credential, input.pullRequestNumber, input.expectedHeadSha, input.expectedBaseSha);
    assertPromotionSourceBranch(pull.head.ref);
    const repositoryInfo = await this.request<GitHubRepositoryResponse>(repository, '', {}, credential);
    if (!repositoryInfo.default_branch || pull.base.ref.toLowerCase() !== repositoryInfo.default_branch.toLowerCase()) {
      throw { code: 'PERMISSION_DENIED', message: `Promotion may only target repository default branch ${repositoryInfo.default_branch ?? '(unknown)'}` };
    }
    const merged = await this.mergePullRequest(repository, credential, pull, input.mergeMethod ?? 'squash');
    return { ...merged, approvalReference };
  }

  private async mergeCandidate(
    repository: string,
    credential: GitHubCredential,
    pullRequestNumber: number,
    expectedHeadSha: string,
    expectedBaseSha: string,
  ): Promise<GitHubPullRequestResponse> {
    assertPullRequestNumber(pullRequestNumber);
    assertSha(expectedHeadSha, 'expectedHeadSha');
    assertSha(expectedBaseSha, 'expectedBaseSha');
    const pull = await this.request<GitHubPullRequestResponse>(repository, `/pulls/${pullRequestNumber}`, {}, credential);
    if (pull.state !== 'open' || pull.merged) throw { code: 'CONFLICT', message: `Pull request #${pullRequestNumber} is not open and mergeable as a candidate` };
    if (pull.draft) throw { code: 'CONFLICT', message: `Pull request #${pullRequestNumber} is still a draft` };
    if (pull.head.sha !== expectedHeadSha) {
      throw { code: 'CONFLICT', message: `Pull-request head changed from expected ${expectedHeadSha} to ${pull.head.sha}` };
    }
    if (pull.base.sha !== expectedBaseSha) {
      throw { code: 'CONFLICT', message: `Pull-request base changed from expected ${expectedBaseSha} to ${pull.base.sha}` };
    }
    return pull;
  }

  private async mergePullRequest(
    repository: string,
    credential: GitHubCredential,
    pull: GitHubPullRequestResponse,
    mergeMethod: PullRequestMergeMethod,
  ): Promise<{ repository: string; pullRequestNumber: number; merged: boolean; mergeCommitSha: string; message: string }> {
    const response = await this.request<GitHubMergeResponse>(
      repository,
      `/pulls/${pull.number}/merge`,
      {
        method: 'PUT',
        body: JSON.stringify({ sha: pull.head.sha, merge_method: mergeMethod }),
      },
      credential,
    );
    if (!response.merged || !response.sha) {
      throw { code: 'CONFLICT', message: response.message || `GitHub did not merge pull request #${pull.number}` };
    }
    return {
      repository,
      pullRequestNumber: pull.number,
      merged: true,
      mergeCommitSha: response.sha,
      message: response.message,
    };
  }

  resolveProject(project: ProjectReference): { project: GitHubRepositoryBinding } | {
    error: string;
    code: 'NOT_FOUND' | 'CONFLICT';
  } {
    const explicit = this.bindings.get(project.id);
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

  private headers(token: string): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Conductor-Tool-Runtime',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private async readableRepository(
    project: ProjectReference,
    requiredPermissions: Record<string, 'read' | 'write'>,
  ): Promise<{ repository: string; credential: GitHubCredential }> {
    if (!this.credentials) throw { code: 'AUTH_REQUIRED', message: 'GitHub authentication is not configured' };
    const resolution = this.resolveProject(project);
    if ('error' in resolution) throw { code: resolution.code, message: resolution.error };
    const repository = resolution.project.repository;
    const credential = await this.credentials.getCredential(repository);
    if (credential.kind === 'app-installation') {
      const missing = missingPermissions(credential, requiredPermissions);
      if (missing.length > 0) {
        throw {
          code: 'PERMISSION_DENIED',
          message: `GitHub App installation lacks required permissions for ${repository}: ${missing.join(', ')}`,
        };
      }
    }
    return { repository, credential };
  }

  private async writableRepository(
    project: ProjectReference,
    requiredPermissions: Record<string, 'write'>,
  ): Promise<{ repository: string; credential: GitHubCredential }> {
    if (!this.credentials) throw { code: 'AUTH_REQUIRED', message: 'GitHub authentication is not configured' };
    const resolution = this.resolveProject(project);
    if ('error' in resolution) throw { code: resolution.code, message: resolution.error };
    if (resolution.project.write === false) {
      throw { code: 'PERMISSION_DENIED', message: `Writes are disabled for ${resolution.project.repository}` };
    }
    const repository = resolution.project.repository;
    const credential = await this.credentials.getCredential(repository);
    if (credential.kind === 'app-installation') {
      const missing = missingPermissions(credential, requiredPermissions);
      if (missing.length > 0) {
        throw {
          code: 'PERMISSION_DENIED',
          message: `GitHub App installation lacks required permissions for ${repository}: ${missing.join(', ')}`,
        };
      }
    }
    return { repository, credential };
  }

  private async request<Result>(
    repository: string,
    path: string,
    init: RequestInit = {},
    credential?: GitHubCredential,
  ): Promise<Result> {
    const authorized = credential ?? await this.credentials?.getCredential(repository);
    if (!authorized) throw { code: 'AUTH_REQUIRED', message: 'GitHub authentication is not configured' };
    const response = await this.fetch(`${this.apiBaseUrl}/repos/${encodeRepository(repository)}${path}`, {
      ...init,
      headers: { ...this.headers(authorized.token), ...(init.headers ?? {}) },
    });
    if (!response.ok) throw await githubResponseError(response);
    return await response.json() as Result;
  }
}


type GitHubReadOperation =
  | 'development.status'
  | 'pull-request.status'
  | 'work-item.status'
  | 'work-item.list';

type GitHubWriteOperation =
  | 'git.branch.create'
  | 'git.commit.create'
  | 'pull-request.create'
  | 'pull-request.comment.create'
  | 'pull-request.labels.update'
  | 'pull-request.merge.integration'
  | 'pull-request.merge.reconcile-preview'
  | 'pull-request.merge.promote'
  | 'work-item.create'
  | 'work-item.update-status'
  | 'work-item.classification.update';

const GITHUB_READ_OPERATION_PERMISSIONS: Readonly<Record<
  GitHubReadOperation,
  Readonly<Record<string, 'read' | 'write'>>
>> = {
  'development.status': {
    issues: 'read',
    pull_requests: 'read',
    checks: 'read',
    actions: 'read',
  },
  'pull-request.status': {
    pull_requests: 'read',
    checks: 'read',
    actions: 'read',
  },
  'work-item.status': { issues: 'read' },
  'work-item.list': { issues: 'read' },
};

const GITHUB_WRITE_OPERATION_PERMISSIONS: Readonly<Record<
  GitHubWriteOperation,
  Readonly<Record<string, 'write'>>
>> = {
  'git.branch.create': { contents: 'write' },
  'git.commit.create': { contents: 'write' },
  'pull-request.create': { pull_requests: 'write' },
  'pull-request.comment.create': { issues: 'write' },
  'pull-request.labels.update': { issues: 'write' },
  'pull-request.merge.integration': { contents: 'write' },
  'pull-request.merge.reconcile-preview': { contents: 'write' },
  'pull-request.merge.promote': { contents: 'write' },
  'work-item.create': { issues: 'write' },
  'work-item.update-status': { issues: 'write' },
  'work-item.classification.update': { issues: 'write' },
};

function githubOperationRequirements(operation: RuntimeOperationName): {
  access: 'read' | 'write';
  permissions: Readonly<Record<string, 'read' | 'write'>>;
} | undefined {
  if (operation in GITHUB_READ_OPERATION_PERMISSIONS) {
    return {
      access: 'read',
      permissions: GITHUB_READ_OPERATION_PERMISSIONS[operation as GitHubReadOperation],
    };
  }
  if (operation in GITHUB_WRITE_OPERATION_PERMISSIONS) {
    return {
      access: 'write',
      permissions: GITHUB_WRITE_OPERATION_PERMISSIONS[operation as GitHubWriteOperation],
    };
  }
  return undefined;
}

function operationCheck(
  status: OperationPreflightCheck['status'],
  summary: string,
  error?: NormalizedToolError,
  diagnostics: ToolDiagnostic[] = error?.diagnostics ?? [],
): OperationPreflightCheck {
  return {
    provider: 'github',
    status,
    summary,
    error,
    diagnostics,
  };
}

const WORK_ITEM_STATUS_PREFIX = 'status:';
const WORK_ITEM_KIND_PREFIX = 'kind:';
const WORK_ITEM_ORIGIN_PREFIX = 'origin:';

const WORK_ITEM_STATUSES: readonly MutableWorkItemStatus[] = [
  'backlog', 'ready', 'in-progress', 'blocked', 'review', 'done',
];
const WORK_ITEM_KINDS: readonly MutableWorkItemKind[] = [
  'bug', 'feature', 'investigation', 'improvement', 'maintenance', 'operations',
];
const WORK_ITEM_ORIGINS: readonly MutableWorkItemOrigin[] = [
  'human', 'agent-audit', 'di-finding', 'ci', 'runtime', 'dependency', 'user-feedback',
];

function workItemStatusLabel(status: MutableWorkItemStatus): string {
  return `${WORK_ITEM_STATUS_PREFIX}${status}`;
}

function workItemKindLabel(kind: MutableWorkItemKind): string {
  return `${WORK_ITEM_KIND_PREFIX}${kind}`;
}

function workItemOriginLabel(origin: MutableWorkItemOrigin): string {
  return `${WORK_ITEM_ORIGIN_PREFIX}${origin}`;
}

function workItemStatusColor(status: MutableWorkItemStatus): string {
  const colors: Record<MutableWorkItemStatus, string> = {
    backlog: 'D0D7DE',
    ready: '1F883D',
    'in-progress': '0969DA',
    blocked: 'CF222E',
    review: '8250DF',
    done: '6E7781',
  };
  return colors[status];
}

function workItemKindColor(kind: MutableWorkItemKind): string {
  const colors: Record<MutableWorkItemKind, string> = {
    bug: 'CF222E',
    feature: '8250DF',
    investigation: '0969DA',
    improvement: '1F883D',
    maintenance: 'BF8700',
    operations: '0E8A16',
  };
  return colors[kind];
}

function workItemOriginColor(_origin: MutableWorkItemOrigin): string {
  return 'D4C5F9';
}

function isWorkItemStatusLabel(label: string): boolean {
  return label.toLowerCase().startsWith(WORK_ITEM_STATUS_PREFIX);
}

function isWorkItemKindLabel(label: string): boolean {
  return label.toLowerCase().startsWith(WORK_ITEM_KIND_PREFIX);
}

function isWorkItemOriginLabel(label: string): boolean {
  return label.toLowerCase().startsWith(WORK_ITEM_ORIGIN_PREFIX);
}

function isWorkItemReservedLabel(label: string): boolean {
  return isWorkItemStatusLabel(label) || isWorkItemKindLabel(label) || isWorkItemOriginLabel(label);
}

function issueLabelNames(issue: GitHubIssueResponse): string[] {
  return normalizedLabels((issue.labels ?? []).flatMap((label) => {
    if (typeof label === 'string') return [label];
    return label.name ? [label.name] : [];
  }));
}

function deriveWorkItemStatus(issue: GitHubIssueResponse): {
  status: WorkItemStatus;
  source: import('../runtime/types.js').WorkItemStatusSource;
} {
  const statuses = issueLabelNames(issue)
    .filter(isWorkItemStatusLabel)
    .map((label) => label.slice(WORK_ITEM_STATUS_PREFIX.length).toLowerCase())
    .filter((value): value is MutableWorkItemStatus => WORK_ITEM_STATUSES.includes(value as MutableWorkItemStatus));

  if (issue.state === 'closed') {
    if (statuses.length === 0) return { status: 'done', source: 'issue-state' };
    if (statuses.length === 1 && statuses[0] === 'done') return { status: 'done', source: 'label' };
    return { status: 'unknown', source: 'conflict' };
  }

  if (statuses.length === 0) return { status: 'backlog', source: 'default' };
  if (statuses.length === 1 && statuses[0] !== 'done') return { status: statuses[0], source: 'label' };
  return { status: 'unknown', source: 'conflict' };
}

function deriveClassification<T extends string>(
  labels: string[],
  prefix: string,
  allowed: readonly T[],
): { value: T | 'unknown'; source: WorkItemClassificationSource } {
  const matching = labels.filter((label) => label.toLowerCase().startsWith(prefix));
  if (matching.length === 0) return { value: 'unknown', source: 'default' };
  if (matching.length !== 1) return { value: 'unknown', source: 'conflict' };
  const value = matching[0]!.slice(prefix.length).toLowerCase();
  return allowed.includes(value as T)
    ? { value: value as T, source: 'label' }
    : { value: 'unknown', source: 'conflict' };
}

function workItemFromIssue(repository: string, issue: GitHubIssueResponse): WorkItemRecord {
  const labels = issueLabelNames(issue).sort((a, b) => a.localeCompare(b));
  const derived = deriveWorkItemStatus(issue);
  const kind = deriveClassification(labels, WORK_ITEM_KIND_PREFIX, WORK_ITEM_KINDS);
  const origin = deriveClassification(labels, WORK_ITEM_ORIGIN_PREFIX, WORK_ITEM_ORIGINS);
  return {
    repository,
    issueNumber: issue.number,
    url: issue.html_url,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state === 'closed' ? 'closed' : 'open',
    status: derived.status,
    statusSource: derived.source,
    kind: kind.value as WorkItemKind,
    kindSource: kind.source,
    origin: origin.value as WorkItemOrigin,
    originSource: origin.source,
    labels,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  };
}

function assertIssueIsWorkItem(issue: GitHubIssueResponse): void {
  if (issue.pull_request) throw { code: 'CONFLICT', message: `GitHub issue #${issue.number} is a pull request, not a work item` };
}

function assertIssueNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw { code: 'CONFLICT', message: 'issueNumber must be a positive integer' };
}

function assertPullRequestNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw { code: 'CONFLICT', message: 'pullRequestNumber must be a positive integer' };
}

function normalizedLabels(values?: string[]): string[] {
  const labels = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (labels.some((label) => label.length > 100)) throw { code: 'CONFLICT', message: 'Labels must be 100 characters or fewer' };
  return [...new Map(labels.map((label) => [label.toLowerCase(), label])).values()];
}

function safeMergeBranch(branch: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(branch) && !branch.includes('..') && !branch.startsWith('/') && !branch.endsWith('/');
}

function assertIntegrationSourceBranch(branch: string): void {
  if (!safeMergeBranch(branch) || !/^(?:work|repair|audit)\//.test(branch)) {
    throw { code: 'PERMISSION_DENIED', message: 'Integration merge sources must be work/*, repair/*, or audit/* branches' };
  }
}

function assertPreviewReconciliationTarget(branch: string): void {
  if (!safeMergeBranch(branch) || !['preview', 'vercel-preview'].includes(branch.toLowerCase())) {
    throw { code: 'PERMISSION_DENIED', message: 'Preview reconciliation targets must be preview or vercel-preview' };
  }
}

function assertPromotionSourceBranch(branch: string): void {
  if (!safeMergeBranch(branch) || !(
    branch === 'preview'
    || branch === 'vercel-preview'
    || /^(?:release|work)\//.test(branch)
  )) {
    throw { code: 'PERMISSION_DENIED', message: 'Promotion sources must be preview, vercel-preview, release/*, or explicitly approved work/* branches' };
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
  diagnostics: ToolDiagnostic[] = error?.diagnostics ?? [],
): PreflightCheck {
  return {
    check: id,
    status: ready ? 'ready' : 'blocked',
    provider: 'github',
    summary: ready
      ? `${id} is available for ${repository}`
      : error?.message ?? `${id} is unavailable for ${repository}`,
    error,
    diagnostics,
  };
}

const DEVELOP_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
} as const;

function missingDevelopPermissions(credential: GitHubCredential): string[] {
  return missingPermissions(credential, DEVELOP_PERMISSIONS);
}

function missingPermissions(
  credential: GitHubCredential,
  required: Readonly<Record<string, 'read' | 'write'>>,
): string[] {
  return Object.entries(required).flatMap(([permission, level]) => {
    const actual = credential.permissions?.[permission];
    const sufficient = actual === 'admin' || actual === 'write' || (level === 'read' && actual === 'read');
    return sufficient ? [] : [`${permission}:${level}`];
  });
}

function permissionDiagnostics(
  credential: GitHubCredential,
  repository: string,
): ToolDiagnostic[] {
  const details: Record<string, string | number | boolean | null> = {
    identityKind: credential.kind,
    repository,
    repositoryCovered: true,
  };
  if (credential.identity.appId) details.appId = credential.identity.appId;
  if (credential.identity.appSlug) details.appSlug = credential.identity.appSlug;
  if (credential.identity.installationId) details.installationId = credential.identity.installationId;
  if (credential.identity.account) details.account = credential.identity.account;
  if (credential.repositorySelection) details.repositorySelection = credential.repositorySelection;
  for (const permission of ['contents', 'pull_requests', 'issues', 'checks', 'actions', 'commit_statuses', 'deployments']) {
    if (credential.permissions?.[permission]) details[`permission.${permission}`] = credential.permissions[permission];
  }
  return [{
    level: credential.kind === 'app-installation' ? 'info' : 'warning',
    source: 'github',
    message: credential.kind === 'app-installation'
      ? 'Repository-scoped GitHub App installation permission evidence'
      : 'Legacy static-token repository-role evidence; operation permissions are not independently verifiable',
    details,
  }];
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
