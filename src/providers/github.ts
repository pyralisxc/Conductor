import type {
  CapabilityAvailability,
  NormalizedToolError,
  PreflightCheck,
  OperationPreflightCheck,
  ProjectReference,
  RuntimeOperationName,
  CreateBranchInput,
  BootstrapIntegrationBranchInput,
  DeleteBranchInput,
  CreateCommitInput,
  CreateWorkflowCommitInput,
  WorkflowCommitResult,
  WorkflowReviewFinding,
  CreatePullRequestInput,
  CommentPullRequestInput,
  GetPullRequestStatusInput,
  PullRequestStatus,
  OpenPromotionCandidate,
  PromotionCandidateSeal,
  GetSourceArtifactInput,
  SourceArtifactRead,
  DiscoverSourceInput,
  SourceDiscoveryResult,
  GetCiRunEvidenceInput,
  CiRunEvidence,
  CiJobEvidence,
  PullRequestOrchestration,
  PullRequestOrchestrationState,
  UpdatePullRequestLabelsInput,
  ClosePullRequestInput,
  ReadyPullRequestForReviewInput,
  RerunPullRequestVerificationInput,
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
  WorkItemSeverity,
  MutableWorkItemSeverity,
  WorkItemPriority,
  MutableWorkItemPriority,
  WorkItemTriageSource,
  CreateWorkItemInput,
  CommentWorkItemInput,
  UpdateWorkItemStatusInput,
  UpdateWorkItemClassificationInput,
  UpdateWorkItemTriageInput,
  RepositoryAcquisitionPreflightInput,
  RepositoryAcquisitionPreflight,
  AcquireRepositoryInput,
  RepositoryAcquisitionResult,
  RepositoryBootstrapTopology,
  RepositoryProviderAudit,
  GetRepositoryAuditInput,
} from '../runtime/types.js';
import { ConductorToolError, normalizeToolError } from '../runtime/errors.js';
import type { OperationPreflightProvider, RepositoryAcquisitionProvider, RepositoryAuditReadProvider, SourceControlMutationProvider, ProjectPreflightProvider, PullRequestReadProvider, SourceArtifactReadProvider, CiReadProvider, WorkItemCandidateReadProvider, WorkItemMutationProvider } from './runtime.js';
import {
  StaticGitHubCredentialProvider,
  type GitHubCredential,
  type GitHubCredentialProvider,
} from './github-auth.js';
import { ProviderUsageTracker } from './usage.js';

interface GitHubRepositoryResponse {
  full_name: string;
  html_url?: string;
  private?: boolean;
  size?: number;
  pushed_at?: string | null;
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
  node_id?: string;
  state: string;
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  merge_commit_sha?: string | null;
  merged_at?: string | null;
  body?: string | null;
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
    run_attempt?: number | null;
    created_at?: string | null;
  }>;
}

interface GitHubWorkflowRunResponse {
  id: number;
  name?: string | null;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  head_sha: string;
  event?: string | null;
  run_attempt?: number | null;
  created_at?: string | null;
}

interface GitHubWorkflowJobsResponse {
  total_count: number;
  jobs: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    html_url?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    steps?: Array<{
      number: number;
      name: string;
      status: string;
      conclusion: string | null;
      started_at?: string | null;
      completed_at?: string | null;
    }>;
  }>;
}

interface GitHubContentResponse {
  type: string;
  path?: string;
  sha?: string;
  size?: number;
  encoding?: string | null;
  content?: string | null;
}

interface GitHubLabelResponse {
  name: string;
}

interface GitHubMergeResponse {
  sha?: string | null;
  merged: boolean;
  message: string;
}

interface GitHubCommitLookupResponse {
  sha: string;
  html_url?: string;
  commit: { message?: string; tree: { sha: string } };
}

interface GitHubTreeResponse {
  sha: string;
  truncated?: boolean;
  tree: Array<{
    path: string;
    mode: string;
    type: 'blob' | 'tree' | 'commit';
    sha: string;
    size?: number;
  }>;
}

interface GitHubBlobResponse {
  sha: string;
  size?: number;
  encoding?: string | null;
  content?: string | null;
}

interface GitHubGitObjectResponse { sha: string }
interface GitHubContentCreateResponse { commit: { sha: string } }

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

interface GitHubRateLimitSnapshot {
  limit: number | null;
  remaining: number | null;
  used: number | null;
  resetAt: string | null;
  resource: string | null;
  retryAfterSeconds: number | null;
  observedAt: string;
}

const RELEASE_SEAL_PREFIX = '<!-- conductor-release-seal:';
const RELEASE_SEAL_SUFFIX = ' -->';

function parsePromotionSeal(body: string | null | undefined): PromotionCandidateSeal | null {
  if (!body) return null;
  const start = body.indexOf(RELEASE_SEAL_PREFIX);
  if (start < 0) return null;
  const end = body.indexOf(RELEASE_SEAL_SUFFIX, start + RELEASE_SEAL_PREFIX.length);
  if (end < 0) return null;
  const raw = body.slice(start + RELEASE_SEAL_PREFIX.length, end);
  try {
    const value = JSON.parse(raw) as { v?: unknown; head?: unknown; base?: unknown; workItems?: unknown };
    if (value.v !== 1
      || typeof value.head !== 'string'
      || !/^[0-9a-f]{40}$/iu.test(value.head)
      || typeof value.base !== 'string'
      || !/^[0-9a-f]{40}$/iu.test(value.base)
      || !Array.isArray(value.workItems)
      || value.workItems.length < 1
      || value.workItems.length > 20
      || value.workItems.some((number) => !Number.isSafeInteger(number) || number < 1)) {
      return null;
    }
    const workItemNumbers = [...new Set(value.workItems as number[])].sort((a, b) => a - b);
    if (workItemNumbers.length !== value.workItems.length) return null;
    return {
      version: 1,
      expectedHeadSha: value.head.toLowerCase(),
      expectedBaseSha: value.base.toLowerCase(),
      workItemNumbers,
    };
  } catch {
    return null;
  }
}

export class GitHubRuntimeProvider implements ProjectPreflightProvider, OperationPreflightProvider, RepositoryAcquisitionProvider, RepositoryAuditReadProvider, SourceControlMutationProvider, PullRequestReadProvider, SourceArtifactReadProvider, CiReadProvider, WorkItemCandidateReadProvider, WorkItemMutationProvider {
  readonly id = 'github';
  private readonly credentials?: GitHubCredentialProvider;
  private readonly bindings: ReadonlyMap<string, GitHubRepositoryBinding>;
  private readonly allowedOwners: ReadonlyMap<string, string>;
  private readonly apiBaseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly usage: ProviderUsageTracker;
  private rateLimit: GitHubRateLimitSnapshot | null = null;

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
    const rawFetch = options.fetch ?? globalThis.fetch;
    this.usage = new ProviderUsageTracker(this.id);
    this.fetch = async (input, init) => {
      const guard = this.rateLimitGuard();
      if (guard) throw guard;
      const response = await this.usage.fetch(rawFetch, input, init);
      this.observeRateLimit(response);
      return response;
    };
  }

  getUsageSnapshot() {
    return this.usage.snapshot();
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
    const resolution = this.resolveBinding(project);
    if ('error' in resolution) return project;
    return { ...project, repository: resolution.binding.repository };
  }

  async preflightProject(project: ProjectReference): Promise<PreflightCheck[]> {
    const resolution = this.resolveBinding(project);
    if ('error' in resolution) {
      return githubChecks('blocked', normalizeToolError({
        code: resolution.code,
        message: resolution.error,
      }, resolution.code, this.id));
    }
    const configured = resolution.binding;
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
      const permissionEvidence = [
        ...permissionDiagnostics(credential, configured.repository),
        ...this.rateLimitDiagnostics(),
      ];
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
    const resolution = this.resolveBinding(project);
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
    const configured = resolution.binding;
    if (requirements.access === 'write' && configured.write === false) {
      const error = normalizeToolError({
        code: 'PERMISSION_DENIED',
        message: `Writes are disabled for ${configured.repository}`,
      }, 'PERMISSION_DENIED', this.id);
      return [operationCheck('blocked', error.message, error, error.diagnostics)];
    }
    try {
      const credential = await this.credentials.getCredential(configured.repository);
      const evidence = [
        ...permissionDiagnostics(credential, configured.repository),
        ...this.rateLimitDiagnostics(),
      ];
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

  async findOpenPromotionPullRequest(project: ProjectReference): Promise<OpenPromotionCandidate | null> {
    const { repository, credential } = await this.readableRepository(
      project,
      GITHUB_READ_OPERATION_PERMISSIONS['pull-request.status'],
    );
    const metadata = await this.request<GitHubRepositoryResponse>(repository, '', {}, credential);
    const defaultBranch = metadata.default_branch?.trim();
    if (!defaultBranch) throw { code: 'NOT_FOUND', message: 'Repository default branch is unavailable' };

    const owner = repository.split('/')[0]!;
    const candidates = (
      await Promise.all(['preview', 'vercel-preview'].map((head) =>
        this.request<GitHubPullRequestResponse[]>(
          repository,
          `/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(defaultBranch)}&per_page=2`,
          {},
          credential,
        )
      ))
    ).flat().filter((pull) =>
      ['preview', 'vercel-preview'].includes(pull.head.ref.toLowerCase())
      && pull.base.ref === defaultBranch
    );
    if (candidates.length > 1) {
      throw { code: 'CONFLICT', message: 'Multiple open Preview-to-Main promotion pull requests exist; release identity is ambiguous' };
    }
    const raw = candidates[0];
    if (!raw) return null;

    const pullRequest = await this.getPullRequestStatus({
      project,
      pullRequestNumber: raw.number,
    });
    const seal = parsePromotionSeal(raw.body);
    const sealState = !seal
      ? 'unsealed'
      : seal.expectedHeadSha === pullRequest.head.sha.toLowerCase()
        && seal.expectedBaseSha === pullRequest.base.sha.toLowerCase()
        ? 'current'
        : 'stale';
    return { pullRequest, seal, sealState };
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
    const labels = (pull.labels ?? []).flatMap((label) => label.name ? [label.name] : []);
    if (pull.merged) {
      const checks: PullRequestStatus['checks']['items'] = [];
      const workflowRuns: PullRequestStatus['workflowRuns'] = [];
      return {
        repository,
        pullRequestNumber: pull.number,
        url: pull.html_url,
        state: pull.state,
        draft: pull.draft ?? false,
        merged: true,
        mergeable: pull.mergeable ?? null,
        mergeableState: pull.mergeable_state ?? null,
        head: { ref: pull.head.ref, sha: pull.head.sha },
        base: { ref: pull.base.ref, sha: pull.base.sha },
        labels,
        checks: {
          total: 0,
          pending: 0,
          successful: 0,
          failed: 0,
          neutral: 0,
          skipped: 0,
          items: checks,
        },
        workflowRuns,
        orchestration: derivePullRequestOrchestration({
          pull,
          labels,
          checks,
          workflowRuns,
          previous: input.previous,
        }),
      };
    }
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
    const items = markHistoricalChecks(checkRuns.check_runs.map((check) => ({
      id: check.id,
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      detailsUrl: check.details_url ?? null,
      app: check.app?.slug ?? check.app?.name ?? null,
    })));
    const activeItems = items.filter((check) => !check.historical);
    const pending = activeItems.filter((check) => check.status !== 'completed').length;
    const successful = activeItems.filter((check) => check.conclusion === 'success').length;
    const neutral = activeItems.filter((check) => check.conclusion === 'neutral').length;
    const skipped = activeItems.filter((check) => check.conclusion === 'skipped').length;
    const failed = activeItems.filter((check) =>
      check.status === 'completed'
      && check.conclusion !== null
      && !['success', 'neutral', 'skipped'].includes(check.conclusion)
    ).length;
    const observedWorkflowRuns = markHistoricalWorkflowRuns(workflowRuns.workflow_runs.map((run) => ({
      id: run.id,
      name: run.name ?? `workflow-${run.id}`,
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url ?? null,
      runAttempt: run.run_attempt ?? null,
      createdAt: run.created_at ?? null,
    })));
    const orchestration = derivePullRequestOrchestration({
      pull,
      labels,
      checks: items,
      workflowRuns: observedWorkflowRuns,
      previous: input.previous,
    });
    return {
      repository,
      pullRequestNumber: pull.number,
      url: pull.html_url,
      state: pull.state,
      draft: pull.draft ?? false,
      merged: pull.merged ?? false,
      mergeable: pull.mergeable ?? null,
      mergeableState: pull.mergeable_state ?? null,
      head: { ref: pull.head.ref, sha: pull.head.sha },
      base: { ref: pull.base.ref, sha: pull.base.sha },
      labels,
      checks: {
        total: items.length,
        pending,
        successful,
        failed,
        neutral,
        skipped,
        items,
      },
      workflowRuns: observedWorkflowRuns,
      orchestration,
    };
  }


  async discoverSource(input: DiscoverSourceInput): Promise<SourceDiscoveryResult> {
    const { repository, credential } = await this.readableRepository(input.project, GITHUB_READ_OPERATION_PERMISSIONS['source.discover']);
    assertSha(input.sha, 'sha');

    const query = input.query === undefined ? null : input.query.trim();
    if (query !== null && (query.length < 1 || query.length > 256)) {
      throw { code: 'CONFLICT', message: 'Source discovery query must be 1-256 characters when provided' };
    }
    const pathPrefix = input.pathPrefix?.trim()
      ? validRepositoryPath(input.pathPrefix.trim().replace(/\/+$/u, ''))
      : null;
    const caseSensitive = input.caseSensitive ?? false;
    const maxFiles = boundedInteger(input.maxFiles ?? 80, 1, 120);
    const maxBytes = boundedInteger(input.maxBytes ?? 2 * 1024 * 1024, 1024, 5 * 1024 * 1024);
    const maxFileBytes = boundedInteger(input.maxFileBytes ?? 128 * 1024, 1024, 512 * 1024);
    const maxMatches = boundedInteger(input.maxMatches ?? 20, 1, 50);

    const commit = await this.request<{ sha: string; tree: { sha: string } }>(
      repository,
      `/git/commits/${encodeURIComponent(input.sha)}`,
      {},
      credential,
    );
    if (!commit?.tree?.sha) throw { code: 'COMMAND_FAILED', message: 'GitHub did not return the exact commit tree for source discovery' };
    const tree = await this.request<GitHubTreeResponse>(
      repository,
      `/git/trees/${encodeURIComponent(commit.tree.sha)}?recursive=1`,
      {},
      credential,
    );

    const allBlobs = tree.tree
      .filter((entry) =>
        entry.type === 'blob'
        && (!pathPrefix || entry.path === pathPrefix || entry.path.startsWith(`${pathPrefix}/`))
      )
      .sort((left, right) => left.path.localeCompare(right.path));
    const totalFiles = tree.tree.filter((entry) => entry.type === 'blob').length;
    const limits = { maxFiles, maxBytes, maxFileBytes, maxMatches };
    const truncationReasons = new Set<string>();
    if (tree.truncated) truncationReasons.add('provider-tree-truncated');

    if (query === null) {
      const files = allBlobs.slice(0, maxFiles).map((entry) => ({
        path: entry.path,
        blobSha: entry.sha,
        size: typeof entry.size === 'number' ? entry.size : null,
      }));
      if (allBlobs.length > files.length) truncationReasons.add('file-result-limit');
      return {
        provider: 'github',
        repository,
        revisionSha: input.sha,
        treeSha: commit.tree.sha,
        mode: 'manifest',
        query: null,
        pathPrefix,
        totalFiles,
        candidateFiles: allBlobs.length,
        files,
        matches: [],
        scannedFiles: 0,
        scannedBytes: 0,
        skipped: { tooLarge: 0, binaryOrInvalidText: 0, unsupported: 0 },
        truncated: truncationReasons.size > 0,
        truncationReasons: [...truncationReasons],
        limits,
        observedAt: new Date().toISOString(),
        note: 'Manifest mode returns bounded exact-tree file metadata only; it does not rank, infer, or interpret source meaning.',
      };
    }

    const textCandidates = allBlobs.filter((entry) => sourceDiscoveryTextCandidate(entry.path));
    const skipped = {
      tooLarge: 0,
      binaryOrInvalidText: 0,
      unsupported: allBlobs.length - textCandidates.length,
    };
    const selected: typeof textCandidates = [];
    let plannedBytes = 0;
    for (const entry of textCandidates) {
      if (selected.length >= maxFiles) {
        truncationReasons.add('scan-file-limit');
        break;
      }
      const size = typeof entry.size === 'number' ? entry.size : null;
      if (size === null) {
        skipped.unsupported += 1;
        continue;
      }
      if (size > maxFileBytes) {
        skipped.tooLarge += 1;
        continue;
      }
      if (plannedBytes + size > maxBytes) {
        truncationReasons.add('scan-byte-limit');
        continue;
      }
      selected.push(entry);
      plannedBytes += size;
    }

    const matches: SourceDiscoveryResult['matches'] = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let stopForMatches = false;

    for (let offset = 0; offset < selected.length && !stopForMatches; offset += 4) {
      const batch = selected.slice(offset, offset + 4);
      const payloads = await Promise.all(batch.map(async (entry) => ({
        entry,
        payload: await this.request<GitHubBlobResponse>(
          repository,
          `/git/blobs/${encodeURIComponent(entry.sha)}`,
          {},
          credential,
        ),
      })));

      for (const { entry, payload } of payloads) {
        if (payload.encoding !== 'base64' || typeof payload.content !== 'string') {
          skipped.unsupported += 1;
          continue;
        }
        const bytes = Buffer.from(payload.content.replace(/\s/gu, ''), 'base64');
        if (bytes.byteLength > maxFileBytes) {
          skipped.tooLarge += 1;
          continue;
        }
        scannedFiles += 1;
        scannedBytes += bytes.byteLength;
        if (bytes.includes(0)) {
          skipped.binaryOrInvalidText += 1;
          continue;
        }
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          skipped.binaryOrInvalidText += 1;
          continue;
        }

        const needle = caseSensitive ? query : query.toLocaleLowerCase();
        const lines = content.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index] ?? '';
          const haystack = caseSensitive ? line : line.toLocaleLowerCase();
          if (!haystack.includes(needle)) continue;
          matches.push({
            path: entry.path,
            blobSha: entry.sha,
            size: typeof entry.size === 'number' ? entry.size : bytes.byteLength,
            line: index + 1,
            snippet: sourceDiscoverySnippet(line),
          });
          if (matches.length >= maxMatches) {
            truncationReasons.add('match-limit');
            stopForMatches = true;
            break;
          }
        }
        if (stopForMatches) break;
      }
    }

    return {
      provider: 'github',
      repository,
      revisionSha: input.sha,
      treeSha: commit.tree.sha,
      mode: 'literal',
      query,
      pathPrefix,
      totalFiles,
      candidateFiles: allBlobs.length,
      files: [],
      matches,
      scannedFiles,
      scannedBytes,
      skipped,
      truncated: truncationReasons.size > 0,
      truncationReasons: [...truncationReasons],
      limits,
      observedAt: new Date().toISOString(),
      note: 'Literal discovery is exact-SHA provider evidence only. Match order is repository-path order, not semantic relevance, and matches never authorize mutation by themselves.',
    };
  }

  async getSourceArtifact(input: GetSourceArtifactInput): Promise<SourceArtifactRead> {
    const { repository, credential } = await this.readableRepository(input.project, GITHUB_READ_OPERATION_PERMISSIONS['source.artifact.read']);
    assertSha(input.sha, 'sha');
    const path = validRepositoryPath(input.path);
    const maxBytes = boundedInteger(input.maxBytes ?? 256 * 1024, 1, 1024 * 1024);
    const payload = await this.request<GitHubContentResponse | GitHubContentResponse[]>(
      repository,
      `/contents/${encodePath(path)}?ref=${encodeURIComponent(input.sha)}`,
      {},
      credential,
    );
    if (Array.isArray(payload)) {
      return {
        provider: 'github', repository, revisionSha: input.sha, path, blobSha: null, size: null,
        status: 'unsupported', content: null, encoding: null,
        reason: 'Exact source artifact read supports files only; the requested path resolved to a directory.',
        observedAt: new Date().toISOString(),
      };
    }

    const size = typeof payload.size === 'number' ? payload.size : null;
    const blobSha = typeof payload.sha === 'string' ? payload.sha : null;
    if (payload.type !== 'file') {
      return {
        provider: 'github', repository, revisionSha: input.sha, path, blobSha, size,
        status: 'unsupported', content: null, encoding: null,
        reason: `GitHub path type ${payload.type || '(unknown)'} is not a regular file.`,
        observedAt: new Date().toISOString(),
      };
    }
    if (size !== null && size > maxBytes) {
      return {
        provider: 'github', repository, revisionSha: input.sha, path, blobSha, size,
        status: 'too-large', content: null, encoding: null,
        reason: `Source artifact is ${size} bytes; configured read limit is ${maxBytes} bytes.`,
        observedAt: new Date().toISOString(),
      };
    }
    if (payload.encoding !== 'base64' || typeof payload.content !== 'string') {
      return {
        provider: 'github', repository, revisionSha: input.sha, path, blobSha, size,
        status: 'unsupported', content: null, encoding: null,
        reason: 'GitHub did not return complete base64 file content for this bounded read.',
        observedAt: new Date().toISOString(),
      };
    }

    const bytes = Buffer.from(payload.content.replace(/\s/gu, ''), 'base64');
    if (bytes.byteLength > maxBytes) {
      return {
        provider: 'github', repository, revisionSha: input.sha, path, blobSha, size: size ?? bytes.byteLength,
        status: 'too-large', content: null, encoding: null,
        reason: `Source artifact exceeds the configured ${maxBytes}-byte read limit.`,
        observedAt: new Date().toISOString(),
      };
    }
    if (bytes.includes(0)) {
      return {
        provider: 'github', repository, revisionSha: input.sha, path, blobSha, size: size ?? bytes.byteLength,
        status: 'binary', content: null, encoding: null,
        reason: 'Source artifact contains NUL bytes and is treated as binary.',
        observedAt: new Date().toISOString(),
      };
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return {
        provider: 'github', repository, revisionSha: input.sha, path, blobSha, size: size ?? bytes.byteLength,
        status: 'binary', content: null, encoding: null,
        reason: 'Source artifact is not valid UTF-8 text.',
        observedAt: new Date().toISOString(),
      };
    }
    return {
      provider: 'github', repository, revisionSha: input.sha, path, blobSha, size: size ?? bytes.byteLength,
      status: 'available', content, encoding: 'utf-8', reason: null, observedAt: new Date().toISOString(),
    };
  }

  async getCiRunEvidence(input: GetCiRunEvidenceInput): Promise<CiRunEvidence> {
    const { repository, credential } = await this.readableRepository(input.project, GITHUB_READ_OPERATION_PERMISSIONS['ci.run.read']);
    assertPullRequestNumber(input.pullRequestNumber);
    assertSha(input.expectedHeadSha, 'expectedHeadSha');
    if (!Number.isSafeInteger(input.workflowRunId) || input.workflowRunId <= 0) {
      throw { code: 'CONFLICT', message: 'workflowRunId must be a positive integer' };
    }
    if (input.jobId !== undefined && (!Number.isSafeInteger(input.jobId) || input.jobId <= 0)) {
      throw { code: 'CONFLICT', message: 'jobId must be a positive integer when provided' };
    }
    const logTailBytes = boundedInteger(input.logTailBytes ?? 12_000, 1024, 50_000);

    const pull = await this.request<GitHubPullRequestResponse>(
      repository,
      `/pulls/${input.pullRequestNumber}`,
      {},
      credential,
    );
    if (pull.head.sha !== input.expectedHeadSha) {
      throw { code: 'CONFLICT', message: `Pull-request head changed from expected ${input.expectedHeadSha} to ${pull.head.sha}` };
    }
    const run = await this.request<GitHubWorkflowRunResponse>(
      repository,
      `/actions/runs/${input.workflowRunId}`,
      {},
      credential,
    );
    if (run.head_sha !== input.expectedHeadSha) {
      throw { code: 'CONFLICT', message: `Workflow run ${input.workflowRunId} belongs to ${run.head_sha}, not expected head ${input.expectedHeadSha}` };
    }
    const jobsPayload = await this.request<GitHubWorkflowJobsResponse>(
      repository,
      `/actions/runs/${input.workflowRunId}/jobs?per_page=100`,
      {},
      credential,
    );
    if (input.jobId !== undefined && !jobsPayload.jobs.some(job => job.id === input.jobId)) {
      throw { code: 'NOT_FOUND', message: `Job ${input.jobId} is not part of workflow run ${input.workflowRunId}` };
    }

    const failedJobIds = jobsPayload.jobs
      .filter(job => isFailureConclusion(job.conclusion))
      .slice(0, 3)
      .map(job => job.id);
    const requestedLogIds = new Set<number>(input.jobId !== undefined ? [input.jobId] : failedJobIds);

    const jobs: CiJobEvidence[] = [];
    for (const job of jobsPayload.jobs) {
      const steps = (job.steps ?? []).map(step => ({
        number: step.number,
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        startedAt: step.started_at ?? null,
        completedAt: step.completed_at ?? null,
      }));
      let log: CiJobEvidence['log'] = {
        status: 'not-requested', text: null, truncated: false, totalBytes: null, reason: null,
      };
      if (requestedLogIds.has(job.id)) {
        const response = await this.fetch(
          `${this.apiBaseUrl}/repos/${encodeRepository(repository)}/actions/jobs/${job.id}/logs`,
          { headers: this.headers(credential.token) },
        );
        if (!response.ok) {
          log = {
            status: 'unavailable', text: null, truncated: false, totalBytes: null,
            reason: `GitHub job logs are unavailable with status ${response.status}; logs may have expired or access may be restricted.`,
          };
        } else {
          const tail = await readTailBytes(response, logTailBytes);
          log = {
            status: 'available',
            text: redactGithubLog(tail.text),
            truncated: tail.truncated,
            totalBytes: tail.totalBytes,
            reason: null,
          };
        }
      }
      jobs.push({
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        url: job.html_url ?? null,
        startedAt: job.started_at ?? null,
        completedAt: job.completed_at ?? null,
        steps,
        log,
      });
    }

    return {
      provider: 'github',
      repository,
      pullRequestNumber: pull.number,
      headSha: input.expectedHeadSha,
      workflowRun: {
        id: run.id,
        name: run.name ?? `workflow-${run.id}`,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url ?? null,
        event: run.event ?? null,
        headSha: run.head_sha,
      },
      jobs,
      jobsTruncated: jobsPayload.total_count > jobsPayload.jobs.length,
      observedAt: new Date().toISOString(),
    };
  }


  async preflightRepositoryAcquisition(input: RepositoryAcquisitionPreflightInput): Promise<RepositoryAcquisitionPreflight> {
    return await this.inspectRepositoryAcquisition(input);
  }

  async acquireRepository(input: AcquireRepositoryInput): Promise<RepositoryAcquisitionResult> {
    assertSha(input.expectedUpstreamSha, 'expectedUpstreamSha');
    const approvalReference = input.approvalReference.trim();
    if (!approvalReference || approvalReference.length > 500) {
      throw { code: 'PERMISSION_DENIED', message: 'Repository acquisition requires an explicit owner approval reference' };
    }

    const preflight = await this.inspectRepositoryAcquisition(input);
    if (preflight.status !== 'ready' || !preflight.upstream.sha || !preflight.upstream.treeSha) {
      throw { code: 'PERMISSION_DENIED', message: preflight.reason ?? 'Repository acquisition preflight is blocked' };
    }
    if (preflight.upstream.sha.toLowerCase() !== input.expectedUpstreamSha.toLowerCase()) {
      throw { code: 'CONFLICT', message: `Upstream ref moved: expected ${input.expectedUpstreamSha}, observed ${preflight.upstream.sha}` };
    }

    const destination = preflight.destination.repository;
    const tree = await this.publicRepositoryRequest<GitHubTreeResponse>(
      preflight.upstream.repository,
      `/git/trees/${preflight.upstream.treeSha}?recursive=1`,
    );
    const blobs = acquisitionBlobs(tree);
    enforceAcquisitionBounds(tree, blobs);
    const requiredPermissions: Record<string, 'write'> = acquisitionRequiresWorkflowWrite(blobs)
      ? { contents: 'write', workflows: 'write' }
      : { contents: 'write' };
    const { credential } = await this.writableRepository(
      { id: destination, repository: destination },
      requiredPermissions,
    );

    const branch = preflight.destination.branch;
    let bootstrapCommitSha = preflight.destination.bootstrapCommitSha ?? null;
    if (preflight.destination.recoverableBootstrap) {
      if (!bootstrapCommitSha) {
        throw { code: 'CONFLICT', message: 'Recoverable bootstrap preflight did not provide an exact bootstrap commit' };
      }
      const current = await this.request<{ object: { sha: string } }>(
        destination,
        `/git/ref/heads/${encodeURIComponent(branch)}`,
        {},
        credential,
      );
      if (current.object.sha.toLowerCase() !== bootstrapCommitSha.toLowerCase()) {
        throw { code: 'CONFLICT', message: 'Destination bootstrap changed after acquisition preflight' };
      }
    } else {
      const bootstrap = await this.request<GitHubContentCreateResponse>(
        destination,
        `/contents/${REPOSITORY_ACQUIRE_BOOTSTRAP_PATH}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            message: REPOSITORY_ACQUIRE_BOOTSTRAP_MESSAGE,
            content: Buffer.from(REPOSITORY_ACQUIRE_BOOTSTRAP_CONTENT).toString('base64'),
            branch,
          }),
        },
        credential,
      );
      bootstrapCommitSha = bootstrap.commit.sha;
    }

    for (let offset = 0; offset < blobs.length; offset += REPOSITORY_ACQUIRE_BLOB_CONCURRENCY) {
      const batch = blobs.slice(offset, offset + REPOSITORY_ACQUIRE_BLOB_CONCURRENCY);
      await Promise.all(batch.map(async (entry) => {
        const rawUrl = rawGithubUrl(preflight.upstream.repository, preflight.upstream.sha!, entry.path);
        const response = await this.fetch(rawUrl, { headers: { 'User-Agent': 'Conductor-Tool-Runtime' } });
        if (!response.ok) throw await githubResponseError(response);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length !== entry.size) {
          throw { code: 'CONFLICT', message: `Upstream blob size changed for ${entry.path}` };
        }
        const created = await this.request<GitHubGitObjectResponse>(
          destination,
          '/git/blobs',
          {
            method: 'POST',
            body: JSON.stringify({ content: bytes.toString('base64'), encoding: 'base64' }),
          },
          credential,
        );
        if (created.sha.toLowerCase() !== entry.sha.toLowerCase()) {
          throw { code: 'CONFLICT', message: `GitHub blob verification failed for ${entry.path}` };
        }
      }));
    }

    const createdTree = await this.request<GitHubGitObjectResponse>(
      destination,
      '/git/trees',
      {
        method: 'POST',
        body: JSON.stringify({
          tree: blobs.map((entry) => ({
            path: entry.path,
            mode: entry.mode,
            type: 'blob',
            sha: entry.sha,
          })),
        }),
      },
      credential,
    );
    if (createdTree.sha.toLowerCase() !== preflight.upstream.treeSha.toLowerCase()) {
      throw { code: 'CONFLICT', message: 'Destination tree does not exactly match the resolved upstream snapshot' };
    }

    const acquiredAt = new Date().toISOString();
    const message = [
      'Import exact upstream snapshot',
      '',
      `Upstream-Repository: ${preflight.upstream.repository}`,
      `Upstream-URL: ${preflight.upstream.url}`,
      `Upstream-Ref: ${input.upstreamRef}`,
      `Upstream-SHA: ${preflight.upstream.sha}`,
      `Acquired-At: ${acquiredAt}`,
    ].join('\n');
    const commit = await this.request<GitHubGitObjectResponse>(
      destination,
      '/git/commits',
      {
        method: 'POST',
        body: JSON.stringify({
          message,
          tree: createdTree.sha,
          parents: [bootstrapCommitSha],
        }),
      },
      credential,
    );
    await this.request<GitHubGitObjectResponse>(
      destination,
      `/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha, force: false }),
      },
      credential,
    );
    const verified = await this.request<{ object: { sha: string } }>(
      destination,
      `/git/ref/heads/${encodeURIComponent(branch)}`,
      {},
      credential,
    );
    if (verified.object.sha.toLowerCase() !== commit.sha.toLowerCase()) {
      throw { code: 'CONFLICT', message: 'Destination branch read-back did not match the imported commit' };
    }

    return {
      provider: 'github',
      destinationRepository: destination,
      url: `https://github.com/${destination}`,
      branch,
      commitSha: commit.sha,
      treeSha: createdTree.sha,
      importedFiles: blobs.length,
      totalBytes: blobs.reduce((sum, entry) => sum + entry.size, 0),
      provenance: {
        upstreamRepository: preflight.upstream.repository,
        upstreamUrl: preflight.upstream.url,
        upstreamRef: input.upstreamRef,
        upstreamSha: preflight.upstream.sha,
        acquiredAt,
      },
      approvalReference,
      codeWorkGranted: false,
      cleanup: 'owner-provider-cleanup',
    };
  }

  private async inspectRepositoryAcquisition(input: RepositoryAcquisitionPreflightInput): Promise<RepositoryAcquisitionPreflight> {
    const upstream = exactRepositoryIdentity(input.upstreamRepository, 'upstreamRepository');
    const destinationOwner = exactGitHubOwner(input.destinationOwner);
    const authorizedOwner = this.allowedOwners.get(destinationOwner.toLowerCase());
    const destinationName = exactRepositoryName(input.destinationRepository);
    const destination = `${authorizedOwner ?? destinationOwner}/${destinationName}`;
    const branch = acquisitionBranch(input.destinationBranch ?? 'main');
    const blocked = (
      reason: string,
      upstreamFacts: RepositoryAcquisitionPreflight['upstream'] = {
        repository: upstream, url: `https://github.com/${upstream}`, ref: input.upstreamRef,
        sha: null, treeSha: null, fileCount: null, totalBytes: null,
      },
      destinationFacts: Partial<RepositoryAcquisitionPreflight['destination']> = {},
    ): RepositoryAcquisitionPreflight => ({
      provider: 'github',
      status: 'blocked',
      method: 'snapshot-existing-destination',
      upstream: upstreamFacts,
      destination: {
        repository: destination,
        branch,
        exists: false,
        empty: null,
        authorized: false,
        ...destinationFacts,
      },
      limits: acquisitionLimits(),
      reason,
      codeWorkGranted: false,
      observedAt: new Date().toISOString(),
    });

    if (!authorizedOwner) return blocked(`Destination owner ${destinationOwner} is not in Conductor's authorized GitHub owner set`);
    if (!input.upstreamRef.trim() || input.upstreamRef.length > 255 || /[\u0000-\u001f]/u.test(input.upstreamRef)) {
      return blocked('upstreamRef must be a non-empty Git ref or SHA of 255 characters or fewer');
    }

    let sourceRepository: GitHubRepositoryResponse;
    let sourceCommit: GitHubCommitLookupResponse;
    let sourceTree: GitHubTreeResponse;
    try {
      sourceRepository = await this.publicRepositoryRequest<GitHubRepositoryResponse>(upstream, '');
      if (sourceRepository.private === true) return blocked('Repository acquisition v0 accepts public upstream repositories only');
      sourceCommit = await this.publicRepositoryRequest<GitHubCommitLookupResponse>(
        upstream,
        `/commits/${encodeURIComponent(input.upstreamRef)}`,
      );
      sourceTree = await this.publicRepositoryRequest<GitHubTreeResponse>(
        upstream,
        `/git/trees/${sourceCommit.commit.tree.sha}?recursive=1`,
      );
    } catch (error) {
      const normalized = normalizeToolError(error, 'NOT_FOUND', this.id);
      return blocked(`Unable to resolve public upstream: ${normalized.message}`);
    }

    const blobEntries = acquisitionBlobs(sourceTree);
    const upstreamFacts: RepositoryAcquisitionPreflight['upstream'] = {
      repository: upstream,
      url: sourceRepository.html_url ?? `https://github.com/${upstream}`,
      ref: input.upstreamRef,
      sha: sourceCommit.sha,
      treeSha: sourceCommit.commit.tree.sha,
      fileCount: blobEntries.length,
      totalBytes: blobEntries.reduce((sum, entry) => sum + entry.size, 0),
    };
    try {
      enforceAcquisitionBounds(sourceTree, blobEntries);
    } catch (error) {
      return blocked(error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error), upstreamFacts);
    }

    const requiresWorkflowWrite = acquisitionRequiresWorkflowWrite(blobEntries);
    const acquisitionPermissions: Record<string, 'write'> = requiresWorkflowWrite
      ? { contents: 'write', workflows: 'write' }
      : { contents: 'write' };

    let credential: GitHubCredential;
    let repository: GitHubRepositoryResponse;
    try {
      const writable = await this.writableRepository(
        { id: destination, repository: destination },
        acquisitionPermissions,
      );
      credential = writable.credential;
      repository = await this.request<GitHubRepositoryResponse>(destination, '', {}, credential);
    } catch (error) {
      const normalized = normalizeToolError(error, 'PERMISSION_DENIED', this.id);
      return blocked(
        `Destination must already exist and authorize Conductor before acquisition: ${normalized.message}`,
        upstreamFacts,
        { repository: destination, exists: false, empty: null, authorized: false },
      );
    }

    const resolvedBranch = acquisitionBranch(input.destinationBranch ?? repository.default_branch ?? branch);
    if (requiresWorkflowWrite && credential.kind !== 'app-installation') {
      return blocked(
        'Static-token repository acquisition cannot safely import .github/workflows files because workflow scope cannot be proven',
        upstreamFacts,
        { repository: destination, branch: resolvedBranch, exists: true, empty: null, authorized: false },
      );
    }

    let destinationState: RepositoryAcquisitionDestinationState;
    try {
      destinationState = await this.repositoryAcquisitionDestinationState(destination, resolvedBranch, credential);
    } catch (error) {
      const normalized = normalizeToolError(error, 'TOOL_UNAVAILABLE', this.id);
      return blocked(
        `Unable to verify destination Git history before acquisition: ${normalized.message}`,
        upstreamFacts,
        { repository: destination, branch: resolvedBranch, exists: true, empty: null, authorized: true },
      );
    }
    if (destinationState.kind === 'history') {
      return blocked(
        'Destination repository is not empty; acquisition refuses to overwrite existing repository history',
        upstreamFacts,
        { repository: destination, branch: resolvedBranch, exists: true, empty: false, authorized: true },
      );
    }

    return {
      provider: 'github',
      status: 'ready',
      method: 'snapshot-existing-destination',
      upstream: upstreamFacts,
      destination: {
        repository: destination,
        branch: resolvedBranch,
        exists: true,
        empty: destinationState.kind === 'empty',
        authorized: true,
        recoverableBootstrap: destinationState.kind === 'bootstrap',
        bootstrapCommitSha: destinationState.kind === 'bootstrap' ? destinationState.commitSha : null,
      },
      limits: acquisitionLimits(),
      reason: null,
      codeWorkGranted: false,
      observedAt: new Date().toISOString(),
    };
  }

  private async publicRepositoryRequest<Result>(repository: string, path: string): Promise<Result> {
    const response = await this.fetch(`${this.apiBaseUrl}/repos/${encodeRepository(repository)}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Conductor-Tool-Runtime',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) throw await githubResponseError(response);
    return await response.json() as Result;
  }



  async getRepositoryAudit(input: GetRepositoryAuditInput): Promise<RepositoryProviderAudit> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 8), 1), 20);
    const detailedPullLimit = Math.min(limit, 6);
    const { repository, credential } = await this.readableRepository(
      input.project,
      GITHUB_READ_OPERATION_PERMISSIONS['repository.audit'],
    );
    const metadata = await this.request<GitHubRepositoryResponse>(repository, '', {}, credential);
    const defaultBranch = metadata.default_branch?.trim();
    if (!defaultBranch) throw { code: 'NOT_FOUND', message: 'Repository default branch is unavailable' };

    const readHead = async (branch: string): Promise<string | null> => {
      try {
        const ref = await this.request<{ object: { sha: string } }>(
          repository,
          `/git/ref/heads/${encodePath(branch)}`,
          {},
          credential,
        );
        return ref.object.sha;
      } catch (error) {
        if ((error as { status?: number }).status === 404 || (error as { code?: string }).code === 'NOT_FOUND') return null;
        throw error;
      }
    };

    const [defaultHead, previewHead, vercelPreviewHead, branches, pulls] = await Promise.all([
      readHead(defaultBranch),
      readHead('preview'),
      readHead('vercel-preview'),
      this.request<Array<{ name: string; protected?: boolean; commit: { sha: string } }>>(
        repository,
        `/branches?per_page=${limit + 1}`,
        {},
        credential,
      ),
      this.request<GitHubPullRequestResponse[]>(
        repository,
        '/pulls?state=open&sort=updated&direction=desc&per_page=100',
        {},
        credential,
      ),
    ]);
    if (!defaultHead) throw { code: 'NOT_FOUND', message: `Repository default branch ${defaultBranch} has no readable head` };

    const integrationBranch = previewHead ? 'preview' : vercelPreviewHead ? 'vercel-preview' : null;
    const integrationHead = previewHead ?? vercelPreviewHead;
    const selectedPulls = pulls.slice(0, detailedPullLimit);
    const pullStatuses = await Promise.all(selectedPulls.map((pull) =>
      this.getPullRequestStatus({ project: input.project, pullRequestNumber: pull.number })
    ));
    const openHeads = new Set(pulls.map((pull) => pull.head.ref));
    const openPullIndexComplete = pulls.length < 100;
    const developmentBranches = branches
      .filter((branch) => /^(?:work|repair|audit|release)\//u.test(branch.name))
      .slice(0, limit)
      .map((branch) => ({
        name: branch.name,
        sha: branch.commit.sha,
        protected: branch.protected === true,
        hasOpenPullRequest: openHeads.has(branch.name) ? true : openPullIndexComplete ? false : null,
      }));

    return {
      provider: 'github',
      repository,
      topology: {
        provider: 'github',
        repository,
        defaultBranch,
        defaultHead,
        integrationBranch,
        integrationHead,
        observedAt: new Date().toISOString(),
      },
      developmentBranches: {
        items: developmentBranches,
        truncated: branches.length > limit,
      },
      openPullRequests: {
        items: pullStatuses,
        truncated: pulls.length > detailedPullLimit,
      },
      observedAt: new Date().toISOString(),
    };
  }

  async getRepositoryBootstrap(project: ProjectReference): Promise<RepositoryBootstrapTopology> {
    const { repository, credential } = await this.readableRepository(project, { contents: 'read' });
    const metadata = await this.request<GitHubRepositoryResponse>(repository, '', {}, credential);
    const defaultBranch = metadata.default_branch?.trim();
    if (!defaultBranch) throw { code: 'NOT_FOUND', message: 'Repository default branch is unavailable' };

    const readHead = async (branch: string): Promise<string | null> => {
      try {
        const ref = await this.request<{ object: { sha: string } }>(
          repository,
          `/git/ref/heads/${encodePath(branch)}`,
          {},
          credential,
        );
        return ref.object.sha;
      } catch (error) {
        if ((error as { status?: number }).status === 404 || (error as { code?: string }).code === 'NOT_FOUND') return null;
        throw error;
      }
    };

    const [defaultHead, previewHead, vercelPreviewHead] = await Promise.all([
      readHead(defaultBranch),
      readHead('preview'),
      readHead('vercel-preview'),
    ]);
    if (!defaultHead) throw { code: 'NOT_FOUND', message: `Repository default branch ${defaultBranch} has no readable head` };

    const integrationBranch = previewHead ? 'preview' : vercelPreviewHead ? 'vercel-preview' : null;
    return {
      provider: 'github',
      repository,
      defaultBranch,
      defaultHead,
      integrationBranch,
      integrationHead: previewHead ?? vercelPreviewHead,
      observedAt: new Date().toISOString(),
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


  async bootstrapIntegrationBranch(input: BootstrapIntegrationBranchInput): Promise<{
    repository: string;
    branch: 'preview' | 'vercel-preview';
    commitSha: string;
    defaultBranch: string;
    created: boolean;
    approvalReference: string;
  }> {
    const approvalReference = input.approvalReference.trim();
    if (!approvalReference.startsWith('owner-approved:')) {
      throw { code: 'PERMISSION_DENIED', message: 'Integration branch bootstrap requires an owner-approved: approval reference' };
    }
    assertIntegrationBootstrapBranch(input.branch);
    assertSha(input.fromSha, 'fromSha');

    const { repository, credential } = await this.writableRepository(
      input.project,
      GITHUB_WRITE_OPERATION_PERMISSIONS['git.integration.bootstrap'],
    );
    const metadata = await this.request<GitHubRepositoryResponse>(repository, '', {}, credential);
    const defaultBranch = metadata.default_branch?.trim();
    if (!defaultBranch) throw { code: 'NOT_FOUND', message: 'Repository default branch is unavailable' };
    if (defaultBranch.toLowerCase() === input.branch.toLowerCase()) {
      throw { code: 'PERMISSION_DENIED', message: `Integration bootstrap cannot target repository default branch ${defaultBranch}` };
    }

    const defaultRef = await this.request<{ object: { sha: string } }>(
      repository,
      `/git/ref/heads/${encodePath(defaultBranch)}`,
      {},
      credential,
    );
    if (defaultRef.object.sha !== input.fromSha) {
      throw {
        code: 'CONFLICT',
        message: `Integration bootstrap base ${input.fromSha} is stale; repository default branch ${defaultBranch} is at ${defaultRef.object.sha}`,
      };
    }

    const readHead = async (branch: string): Promise<string | null> => {
      try {
        const ref = await this.request<{ object: { sha: string } }>(
          repository,
          `/git/ref/heads/${encodePath(branch)}`,
          {},
          credential,
        );
        return ref.object.sha;
      } catch (error) {
        if ((error as { status?: number }).status === 404 || (error as { code?: string }).code === 'NOT_FOUND') return null;
        throw error;
      }
    };

    const sibling = input.branch === 'preview' ? 'vercel-preview' : 'preview';
    const [existing, siblingHead] = await Promise.all([readHead(input.branch), readHead(sibling)]);
    if (siblingHead !== null) {
      throw {
        code: 'CONFLICT',
        message: `Repository already has integration branch ${sibling} at ${siblingHead}; refusing to create a competing integration branch`,
      };
    }
    if (existing !== null) {
      if (existing !== input.fromSha) {
        throw {
          code: 'CONFLICT',
          message: `Integration branch ${input.branch} already exists at ${existing}, not requested base ${input.fromSha}`,
        };
      }
      return {
        repository,
        branch: input.branch,
        commitSha: existing,
        defaultBranch,
        created: false,
        approvalReference,
      };
    }

    const created = await this.request<{ object: { sha: string } }>(repository, '/git/refs', {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: input.fromSha }),
    }, credential);
    return {
      repository,
      branch: input.branch,
      commitSha: created.object.sha,
      defaultBranch,
      created: true,
      approvalReference,
    };
  }

  async deleteBranch(input: DeleteBranchInput): Promise<{ repository: string; branch: string; commitSha: string; deleted: true; containedIn: string }> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['git.branch.delete']);
    assertCleanupBranch(input.branch);
    assertSha(input.expectedHeadSha, 'expectedHeadSha');

    const repositoryInfo = await this.request<GitHubRepositoryResponse>(repository, '', {}, credential);
    const protectedBranches = new Set(
      ['main', 'master', 'preview', 'vercel-preview', repositoryInfo.default_branch]
        .filter((value): value is string => typeof value === 'string')
        .map(value => value.toLowerCase()),
    );
    if (protectedBranches.has(input.branch.toLowerCase())) {
      throw { code: 'PERMISSION_DENIED', message: `Branch cleanup cannot delete protected branch ${input.branch}` };
    }

    const owner = repository.split('/')[0]!;
    const openPullRequests = await this.request<GitHubPullRequestResponse[]>(
      repository,
      `/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.branch}`)}&per_page=1`,
      {},
      credential,
    );
    if (openPullRequests.length > 0) {
      throw { code: 'CONFLICT', message: `Branch ${input.branch} is still the head of an open pull request` };
    }

    const integrationBases = [...new Set(
      ['preview', 'vercel-preview', repositoryInfo.default_branch]
        .filter((value): value is string => typeof value === 'string' && value.toLowerCase() !== input.branch.toLowerCase()),
    )];
    let containedIn: string | undefined;
    for (const base of integrationBases) {
      const response = await this.fetch(
        `${this.apiBaseUrl}/repos/${encodeRepository(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(input.expectedHeadSha)}`,
        { headers: this.headers(credential.token) },
      );
      if (response.status === 404) continue;
      if (!response.ok) throw await githubResponseError(response);
      const comparison = await response.json() as { status?: string };
      if (comparison.status === 'behind' || comparison.status === 'identical') {
        containedIn = base;
        break;
      }
    }
    if (!containedIn) {
      const mergedCandidates = await this.request<GitHubPullRequestResponse[]>(
        repository,
        `/pulls?state=closed&head=${encodeURIComponent(`${owner}:${input.branch}`)}&per_page=20`,
        {},
        credential,
      );
      for (const candidate of mergedCandidates) {
        if (candidate.head.sha !== input.expectedHeadSha || !integrationBases.includes(candidate.base.ref)) continue;
        const pull = await this.request<GitHubPullRequestResponse>(
          repository,
          `/pulls/${candidate.number}`,
          {},
          credential,
        );
        const mergeCommitSha = pull.merge_commit_sha;
        if (pull.merged !== true || !mergeCommitSha || !/^[0-9a-f]{40}$/iu.test(mergeCommitSha)) continue;
        const base = pull.base.ref;
        if (!integrationBases.includes(base)) continue;
        const response = await this.fetch(
          `${this.apiBaseUrl}/repos/${encodeRepository(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(mergeCommitSha)}`,
          { headers: this.headers(credential.token) },
        );
        if (response.status === 404) continue;
        if (!response.ok) throw await githubResponseError(response);
        const comparison = await response.json() as { status?: string };
        if (comparison.status === 'behind' || comparison.status === 'identical') {
          containedIn = `${base} via merged PR #${pull.number}`;
          break;
        }
      }
    }
    if (!containedIn) {
      throw { code: 'CONFLICT', message: `Branch ${input.branch} head ${input.expectedHeadSha} is not proven contained in Preview/default by ancestry or an exact merged-PR result` };
    }

    const ref = await this.request<{ object: { sha: string } }>(
      repository,
      `/git/ref/heads/${encodePath(input.branch)}`,
      {},
      credential,
    );
    if (ref.object.sha !== input.expectedHeadSha) {
      throw { code: 'CONFLICT', message: `Branch head changed from expected ${input.expectedHeadSha} to ${ref.object.sha}` };
    }

    const response = await this.fetch(
      `${this.apiBaseUrl}/repos/${encodeRepository(repository)}/git/refs/heads/${encodePath(input.branch)}`,
      { method: 'DELETE', headers: this.headers(credential.token) },
    );
    if (!response.ok) throw await githubResponseError(response);
    return { repository, branch: input.branch, commitSha: input.expectedHeadSha, deleted: true, containedIn };
  }

  async createCommit(input: CreateCommitInput): Promise<{ repository: string; branch: string; commitSha: string }> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['git.commit.create']);
    if (input.files.some((file) => /^\.github\/workflows\//iu.test(file.path))) {
      throw { code: 'PERMISSION_DENIED', message: 'GitHub Actions workflow files must use the dedicated git.workflow.commit lane' };
    }
    return await this.createCommitUsingCredential(repository, credential, input);
  }

  async createWorkflowCommit(input: CreateWorkflowCommitInput): Promise<WorkflowCommitResult> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['git.workflow.commit']);
    if (credential.kind !== 'app-installation') {
      throw { code: 'PERMISSION_DENIED', message: 'Workflow authoring requires provable GitHub App workflows:write permission' };
    }
    assertWorkBranch(input.branch);
    assertSha(input.expectedHeadSha, 'expectedHeadSha');
    const path = workflowRepositoryPath(input.path);
    if (!input.content.trim()) throw { code: 'CONFLICT', message: 'Workflow content must not be empty' };
    if (Buffer.byteLength(input.content, 'utf8') > 1024 * 1024) {
      throw { code: 'PERMISSION_DENIED', message: 'Workflow file exceeds the 1 MiB mutation limit' };
    }
    const findings = workflowReviewFindings(input.content);
    const committed = await this.createCommitUsingCredential(repository, credential, {
      project: input.project,
      branch: input.branch,
      expectedHeadSha: input.expectedHeadSha,
      message: input.message,
      files: [{ path, content: input.content }],
      idempotencyKey: input.idempotencyKey,
    });
    return {
      ...committed,
      path,
      findings,
      permissionSummary: {
        required: ['contents:write', 'workflows:write'],
        declaredPermissions: /^\s*permissions\s*:/imu.test(input.content),
        findingCount: findings.length,
      },
    };
  }

  private async createCommitUsingCredential(
    repository: string,
    credential: GitHubCredential,
    input: CreateCommitInput,
  ): Promise<{ repository: string; branch: string; commitSha: string }> {
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

    return await boundedGitHubMap(pullRequestNumbers, 2, async (pullRequestNumber) =>
      await this.getPullRequestStatus({ project: input.project, pullRequestNumber })
    );
  }

  async createWorkItem(input: CreateWorkItemInput): Promise<WorkItemRecord> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['work-item.create']);
    const title = input.title.trim();
    if (!title) throw { code: 'CONFLICT', message: 'Work-item title must not be empty' };
    if (title.length > 256) throw { code: 'CONFLICT', message: 'Work-item title must be 256 characters or fewer' };
    const status = input.status ?? 'backlog';
    const kind = input.kind ?? 'unknown';
    const origin = input.origin ?? 'unknown';
    const severity = input.severity ?? 'unknown';
    const priority = input.priority ?? 'unknown';
    const productionBlocking = input.productionBlocking ?? false;
    const labels = normalizedLabels(input.labels);
    if (labels.some(isWorkItemReservedLabel)) {
      throw { code: 'CONFLICT', message: 'Work-item labels may not set reserved normalized status/classification/triage labels directly' };
    }
    await this.ensureWorkItemStatusLabel(repository, credential, status);
    if (kind !== 'unknown') await this.ensureWorkItemKindLabel(repository, credential, kind);
    if (origin !== 'unknown') await this.ensureWorkItemOriginLabel(repository, credential, origin);
    if (severity !== 'unknown') await this.ensureWorkItemSeverityLabel(repository, credential, severity);
    if (priority !== 'unknown') await this.ensureWorkItemPriorityLabel(repository, credential, priority);
    if (productionBlocking) await this.ensureProductionBlockingLabel(repository, credential);
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
          ...(severity === 'unknown' ? [] : [workItemSeverityLabel(severity)]),
          ...(priority === 'unknown' ? [] : [workItemPriorityLabel(priority)]),
          ...(productionBlocking ? [WORK_ITEM_PRODUCTION_BLOCKING_LABEL] : []),
        ],
      }),
    }, credential);
    return workItemFromIssue(repository, created);
  }

  async commentWorkItem(input: CommentWorkItemInput): Promise<{ repository: string; issueNumber: number; commentId: string; url: string }> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['work-item.comment.create']);
    assertIssueNumber(input.issueNumber);
    const body = input.body.trim();
    if (!body || body.length > 100000) throw { code: 'CONFLICT', message: 'Issue comment must contain 1-100000 characters' };
    const current = await this.request<GitHubIssueResponse>(repository, `/issues/${input.issueNumber}`, {}, credential);
    assertIssueIsWorkItem(current);
    const created = await this.request<{ id: number; html_url: string }>(repository, `/issues/${input.issueNumber}/comments`, {
      method: 'POST', body: JSON.stringify({ body }),
    }, credential);
    return { repository, issueNumber: input.issueNumber, commentId: String(created.id), url: created.html_url };
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

  async updateWorkItemTriage(input: UpdateWorkItemTriageInput): Promise<WorkItemRecord> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['work-item.triage.update']);
    assertIssueNumber(input.issueNumber);
    if (input.severity === undefined && input.priority === undefined && input.productionBlocking === undefined) {
      throw { code: 'CONFLICT', message: 'At least one of severity, priority, or productionBlocking must be provided' };
    }
    const current = await this.request<GitHubIssueResponse>(repository, `/issues/${input.issueNumber}`, {}, credential);
    assertIssueIsWorkItem(current);
    let labels = issueLabelNames(current);
    if (input.severity !== undefined) {
      labels = labels.filter((label) => !isWorkItemSeverityLabel(label));
      if (input.severity !== 'unknown') {
        await this.ensureWorkItemSeverityLabel(repository, credential, input.severity);
        labels.push(workItemSeverityLabel(input.severity));
      }
    }
    if (input.priority !== undefined) {
      labels = labels.filter((label) => !isWorkItemPriorityLabel(label));
      if (input.priority !== 'unknown') {
        await this.ensureWorkItemPriorityLabel(repository, credential, input.priority);
        labels.push(workItemPriorityLabel(input.priority));
      }
    }
    if (input.productionBlocking !== undefined) {
      labels = labels.filter((label) => !isProductionBlockingLabel(label));
      if (input.productionBlocking) {
        await this.ensureProductionBlockingLabel(repository, credential);
        labels.push(WORK_ITEM_PRODUCTION_BLOCKING_LABEL);
      }
    }
    const updatedLabels = await this.request<GitHubLabelResponse[]>(repository, `/issues/${input.issueNumber}/labels`, {
      method: 'PUT',
      body: JSON.stringify({ labels: normalizedLabels(labels).sort((a, b) => a.localeCompare(b)) }),
    }, credential);
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

  private async ensureWorkItemSeverityLabel(repository: string, credential: GitHubCredential, severity: MutableWorkItemSeverity): Promise<void> {
    await this.ensureWorkItemLabel(repository, credential, workItemSeverityLabel(severity), workItemSeverityColor(severity), `Conductor work severity: ${severity}`);
  }

  private async ensureWorkItemPriorityLabel(repository: string, credential: GitHubCredential, priority: MutableWorkItemPriority): Promise<void> {
    await this.ensureWorkItemLabel(repository, credential, workItemPriorityLabel(priority), workItemPriorityColor(priority), `Conductor work priority: ${priority}`);
  }

  private async ensureProductionBlockingLabel(repository: string, credential: GitHubCredential): Promise<void> {
    await this.ensureWorkItemLabel(repository, credential, WORK_ITEM_PRODUCTION_BLOCKING_LABEL, 'CF222E', 'Open work item blocks production promotion unless explicitly overridden');
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
    const base = input.base.trim();
    if (!base || base.startsWith('refs/')) throw { code: 'CONFLICT', message: 'Pull-request base must be a branch name' };
    if (base === input.head) throw { code: 'CONFLICT', message: 'Pull-request head and base must differ' };

    const metadata = await this.request<GitHubRepositoryResponse>(repository, '', {}, credential);
    const defaultBranch = metadata.default_branch?.trim();
    if (!defaultBranch) throw { code: 'NOT_FOUND', message: 'Repository default branch is unavailable' };
    const promotionProposal = ['preview', 'vercel-preview'].includes(input.head.toLowerCase());
    if (promotionProposal) {
      assertPromotionSourceBranch(input.head);
      if (base !== defaultBranch) {
        throw { code: 'PERMISSION_DENIED', message: 'Preview promotion pull requests must target the repository default branch' };
      }
    } else {
      assertWorkBranch(input.head);
      if (!['preview', 'vercel-preview'].includes(base.toLowerCase())) {
        throw { code: 'PERMISSION_DENIED', message: 'Ordinary work/* pull requests must integrate through preview or vercel-preview before default-branch promotion' };
      }
    }

    const workItemNumbers = [...new Set(input.workItemNumbers ?? [])];
    if (workItemNumbers.some((number) => !Number.isSafeInteger(number) || number < 1)) {
      throw { code: 'CONFLICT', message: 'workItemNumbers must contain only positive issue numbers' };
    }
    const canonicalWork = workItemNumbers.length
      ? `Canonical Conductor work: ${workItemNumbers.map((number) => `#${number}`).join(', ')}`
      : '';
    const body = [input.body?.trim(), canonicalWork].filter(Boolean).join('\n\n');

    const created = await this.request<{ number: number; html_url: string }>(repository, '/pulls', {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        head: input.head,
        base,
        body,
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


  async closePullRequest(input: ClosePullRequestInput): Promise<{ repository: string; pullRequestNumber: number; url: string; state: string; draft: boolean; merged: boolean; headSha: string }> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['pull-request.close']);
    assertPullRequestNumber(input.pullRequestNumber);
    assertSha(input.expectedHeadSha, 'expectedHeadSha');
    let pull = await this.request<GitHubPullRequestResponse>(repository, `/pulls/${input.pullRequestNumber}`, {}, credential);
    if (pull.head.sha !== input.expectedHeadSha) {
      throw { code: 'CONFLICT', message: `Pull-request head changed from expected ${input.expectedHeadSha} to ${pull.head.sha}` };
    }
    if (pull.merged) throw { code: 'CONFLICT', message: `Pull request #${input.pullRequestNumber} is already merged and cannot be closed as obsolete` };
    if (pull.state !== 'closed') {
      await this.request<GitHubPullRequestResponse>(repository, `/pulls/${input.pullRequestNumber}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed' }),
      }, credential);
      pull = await this.request<GitHubPullRequestResponse>(repository, `/pulls/${input.pullRequestNumber}`, {}, credential);
    }
    if (pull.state !== 'closed') throw { code: 'COMMAND_FAILED', message: `GitHub did not close pull request #${input.pullRequestNumber}` };
    return { repository, pullRequestNumber: pull.number, url: pull.html_url, state: pull.state, draft: pull.draft ?? false, merged: pull.merged ?? false, headSha: pull.head.sha };
  }

  async readyPullRequestForReview(input: ReadyPullRequestForReviewInput): Promise<{ repository: string; pullRequestNumber: number; url: string; state: string; draft: boolean; merged: boolean; headSha: string }> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['pull-request.ready-for-review']);
    assertPullRequestNumber(input.pullRequestNumber);
    assertSha(input.expectedHeadSha, 'expectedHeadSha');
    let pull = await this.request<GitHubPullRequestResponse>(repository, `/pulls/${input.pullRequestNumber}`, {}, credential);
    if (pull.head.sha !== input.expectedHeadSha) {
      throw { code: 'CONFLICT', message: `Pull-request head changed from expected ${input.expectedHeadSha} to ${pull.head.sha}` };
    }
    if (pull.merged || pull.state !== 'open') throw { code: 'CONFLICT', message: `Pull request #${input.pullRequestNumber} is not an open review candidate` };
    if (pull.draft) {
      if (!pull.node_id) throw { code: 'NOT_FOUND', message: `GitHub node identity is unavailable for pull request #${input.pullRequestNumber}` };
      const response = await this.fetch(`${this.apiBaseUrl}/graphql`, {
        method: 'POST',
        headers: this.headers(credential.token),
        body: JSON.stringify({
          query: 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}',
          variables: { id: pull.node_id },
        }),
      });
      if (!response.ok) throw await githubResponseError(response);
      const body = await response.json().catch(() => null) as { errors?: Array<{ message?: string }> } | null;
      if (body?.errors?.length) throw { code: 'COMMAND_FAILED', message: body.errors.map((error) => error.message ?? 'GitHub GraphQL error').join('; ') };
      pull = await this.request<GitHubPullRequestResponse>(repository, `/pulls/${input.pullRequestNumber}`, {}, credential);
    }
    if (pull.draft) throw { code: 'COMMAND_FAILED', message: `GitHub did not mark pull request #${input.pullRequestNumber} ready for review` };
    return { repository, pullRequestNumber: pull.number, url: pull.html_url, state: pull.state, draft: false, merged: pull.merged ?? false, headSha: pull.head.sha };
  }

  async rerunPullRequestVerification(input: RerunPullRequestVerificationInput): Promise<{ repository: string; pullRequestNumber: number; workflowRunId: number; url: string | null; headSha: string; requested: true }> {
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['pull-request.verify.rerun']);
    assertPullRequestNumber(input.pullRequestNumber);
    assertSha(input.expectedHeadSha, 'expectedHeadSha');
    if (!Number.isSafeInteger(input.workflowRunId) || input.workflowRunId < 1) throw { code: 'CONFLICT', message: 'workflowRunId must be a positive integer' };
    const pull = await this.request<GitHubPullRequestResponse>(repository, `/pulls/${input.pullRequestNumber}`, {}, credential);
    if (pull.state !== 'open' || pull.merged) throw { code: 'CONFLICT', message: `Pull request #${input.pullRequestNumber} is not open` };
    if (pull.head.sha !== input.expectedHeadSha) {
      throw { code: 'CONFLICT', message: `Pull-request head changed from expected ${input.expectedHeadSha} to ${pull.head.sha}` };
    }
    const run = await this.request<GitHubWorkflowRunResponse>(repository, `/actions/runs/${input.workflowRunId}`, {}, credential);
    if (run.head_sha !== input.expectedHeadSha) throw { code: 'CONFLICT', message: `Workflow run #${input.workflowRunId} belongs to head ${run.head_sha}, not expected ${input.expectedHeadSha}` };
    if (normalizedCheckName(run.name ?? '') !== 'verify') throw { code: 'PERMISSION_DENIED', message: `Workflow run #${input.workflowRunId} is not the verify workflow` };
    const response = await this.fetch(
      `${this.apiBaseUrl}/repos/${encodeRepository(repository)}/actions/runs/${input.workflowRunId}/rerun`,
      { method: 'POST', headers: this.headers(credential.token) },
    );
    if (!response.ok) throw await githubResponseError(response);
    return { repository, pullRequestNumber: pull.number, workflowRunId: run.id, url: run.html_url ?? null, headSha: input.expectedHeadSha, requested: true };
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

  async promotePullRequest(input: PromotePullRequestInput): Promise<{ repository: string; pullRequestNumber: number; merged: boolean; mergeCommitSha: string; message: string; approvalReference: string; overriddenBlockerIssueNumbers: number[] }> {
    const approvalReference = input.approvalReference.trim();
    if (!approvalReference) throw { code: 'PERMISSION_DENIED', message: 'Promotion requires a non-empty owner approval reference' };
    const { repository, credential } = await this.writableRepository(input.project, GITHUB_WRITE_OPERATION_PERMISSIONS['pull-request.merge.promote']);
    const pull = await this.mergeCandidate(repository, credential, input.pullRequestNumber, input.expectedHeadSha, input.expectedBaseSha);
    assertPromotionSourceBranch(pull.head.ref);
    const repositoryInfo = await this.request<GitHubRepositoryResponse>(repository, '', {}, credential);
    if (!repositoryInfo.default_branch || pull.base.ref.toLowerCase() !== repositoryInfo.default_branch.toLowerCase()) {
      throw { code: 'PERMISSION_DENIED', message: `Promotion may only target repository default branch ${repositoryInfo.default_branch ?? '(unknown)'}` };
    }
    if (input.mergeMethod && input.mergeMethod !== 'merge') {
      throw { code: 'PERMISSION_DENIED', message: 'Main promotion requires a merge commit to preserve Preview ancestry' };
    }
    const blockers = await this.openProductionBlockerIssueNumbers(repository, credential);
    const overrides = [...new Set(input.overrideBlockerIssueNumbers ?? [])].sort((a, b) => a - b);
    if (overrides.some((issueNumber) => !Number.isSafeInteger(issueNumber) || issueNumber < 1)) {
      throw { code: 'CONFLICT', message: 'Production blocker override issue numbers must be positive safe integers' };
    }
    const unrelatedOverrides = overrides.filter((issueNumber) => !blockers.includes(issueNumber));
    if (unrelatedOverrides.length > 0) {
      throw { code: 'PERMISSION_DENIED', message: `Production blocker override names non-blocking issue(s): ${unrelatedOverrides.map((value) => `#${value}`).join(', ')}` };
    }
    const unoverridden = blockers.filter((issueNumber) => !overrides.includes(issueNumber));
    if (unoverridden.length > 0) {
      throw { code: 'PERMISSION_DENIED', message: `Production promotion is blocked by open production-blocking issue(s): ${unoverridden.map((value) => `#${value}`).join(', ')}. Explicitly name every blocker to override.` };
    }
    const merged = await this.mergePullRequest(repository, credential, pull, 'merge');
    return { ...merged, approvalReference, overriddenBlockerIssueNumbers: blockers };
  }

  private async openProductionBlockerIssueNumbers(repository: string, credential: GitHubCredential): Promise<number[]> {
    const issues = await this.request<GitHubIssueResponse[]>(repository, '/issues?state=open&labels=production-blocking&per_page=100', {}, credential);
    if (issues.length >= 100) {
      throw { code: 'CONFLICT', message: 'Production blocker enumeration reached its 100-item safety bound; promotion fails closed until the release scope is reduced' };
    }
    return issues.filter((issue) => !issue.pull_request).map((issue) => issue.number).sort((a, b) => a - b);
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

  private resolveBinding(project: ProjectReference): { binding: GitHubRepositoryBinding } | {
    error: string;
    code: 'NOT_FOUND' | 'CONFLICT';
  } {
    const explicit = this.bindings.get(project.id);
    if (explicit) {
      if (project.repository && !sameRepository(project.repository, explicit.repository)) {
        return {
          code: 'CONFLICT',
          error: `Repository ${project.repository} does not match the configured repository binding`,
        };
      }
      return { binding: explicit };
    }

    const requested = project.repository
      ?? (project.id.includes('/') ? project.id : this.singleOwnerRepository(project.id));
    if (!requested) {
      return {
        code: 'NOT_FOUND',
        error: `Project ${project.id} is not an explicit runtime binding and cannot be resolved to an authorized owner`,
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
      binding: {
        id: project.id,
        repository: `${authorizedOwner}/${parsed.repository}`,
      },
    };
  }

  private singleOwnerRepository(projectId: string): string | undefined {
    if (this.allowedOwners.size !== 1 || !validRepositoryName(projectId)) return undefined;
    return `${[...this.allowedOwners.values()][0]}/${projectId}`;
  }

  private observeRateLimit(response: Response): void {
    const observed = githubRateLimitHeaders(response.headers);
    if (!observed) return;
    this.rateLimit = {
      ...observed,
      observedAt: new Date().toISOString(),
    };
  }

  private rateLimitGuard(): ConductorToolError | null {
    const snapshot = this.rateLimit;
    if (!snapshot || snapshot.remaining !== 0 || !snapshot.resetAt) return null;
    const resetAtMs = Date.parse(snapshot.resetAt);
    if (!Number.isFinite(resetAtMs) || resetAtMs <= Date.now()) return null;
    return new ConductorToolError({
      code: 'TRANSIENT',
      message: `GitHub API rate limit is exhausted until ${snapshot.resetAt}`,
      retryable: true,
      source: this.id,
      diagnostics: [{
        level: 'warning',
        code: 'TRANSIENT',
        source: this.id,
        message: 'GitHub API request suppressed until the observed rate-limit reset',
        details: {
          limit: snapshot.limit,
          remaining: snapshot.remaining,
          used: snapshot.used,
          resetAt: snapshot.resetAt,
          resource: snapshot.resource,
          providerCallsObserved: this.usage.snapshot().calls,
        },
      }],
    });
  }

  private rateLimitDiagnostics(): ToolDiagnostic[] {
    const snapshot = this.rateLimit;
    if (!snapshot) return [];
    const ratio = snapshot.limit && snapshot.remaining !== null
      ? snapshot.remaining / snapshot.limit
      : null;
    const low = snapshot.remaining === 0 || (ratio !== null && ratio <= 0.1);
    const budget = snapshot.limit !== null && snapshot.remaining !== null
      ? `${snapshot.remaining}/${snapshot.limit} remaining`
      : 'rate-limit headers observed';
    return [{
      level: low ? 'warning' : 'info',
      source: this.id,
      message: `GitHub API budget: ${budget}${snapshot.resetAt ? `; resets ${snapshot.resetAt}` : ''}`,
      details: {
        limit: snapshot.limit,
        remaining: snapshot.remaining,
        used: snapshot.used,
        resetAt: snapshot.resetAt,
        resource: snapshot.resource,
        retryAfterSeconds: snapshot.retryAfterSeconds,
        observedAt: snapshot.observedAt,
        providerCallsObserved: this.usage.snapshot().calls,
      },
    }];
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
    const resolution = this.resolveBinding(project);
    if ('error' in resolution) throw { code: resolution.code, message: resolution.error };
    const repository = resolution.binding.repository;
    const credential = await this.credentialWithPermissions(repository, requiredPermissions);
    return { repository, credential };
  }

  private async writableRepository(
    project: ProjectReference,
    requiredPermissions: Record<string, 'read' | 'write'>,
  ): Promise<{ repository: string; credential: GitHubCredential }> {
    if (!this.credentials) throw { code: 'AUTH_REQUIRED', message: 'GitHub authentication is not configured' };
    const resolution = this.resolveBinding(project);
    if ('error' in resolution) throw { code: resolution.code, message: resolution.error };
    if (resolution.binding.write === false) {
      throw { code: 'PERMISSION_DENIED', message: `Writes are disabled for ${resolution.binding.repository}` };
    }
    const repository = resolution.binding.repository;
    const credential = await this.credentialWithPermissions(repository, requiredPermissions);
    return { repository, credential };
  }

  private async credentialWithPermissions(
    repository: string,
    requiredPermissions: Readonly<Record<string, 'read' | 'write'>>,
  ): Promise<GitHubCredential> {
    if (!this.credentials) throw { code: 'AUTH_REQUIRED', message: 'GitHub authentication is not configured' };
    let credential = await this.credentials.getCredential(repository);
    if (credential.kind !== 'app-installation') return credential;

    let missing = missingPermissions(credential, requiredPermissions);
    if (missing.length === 0) return credential;

    credential = await this.credentials.getCredential(repository, { forceRefresh: true });
    missing = missingPermissions(credential, requiredPermissions);
    if (missing.length > 0) {
      throw {
        code: 'PERMISSION_DENIED',
        message: `GitHub App installation lacks required permissions for ${repository}: ${missing.join(', ')}`,
      };
    }
    return credential;
  }

  private async repositoryAcquisitionDestinationState(
    repository: string,
    branch: string,
    credential: GitHubCredential,
  ): Promise<RepositoryAcquisitionDestinationState> {
    const response = await this.fetch(
      `${this.apiBaseUrl}/repos/${encodeRepository(repository)}/commits?sha=${encodeURIComponent(branch)}&per_page=2`,
      { headers: this.headers(credential.token) },
    );
    if (response.status === 409) {
      const conflict = await response.clone().json().catch(() => undefined) as { message?: string } | undefined;
      if (/git repository is empty/i.test(conflict?.message ?? '')) return { kind: 'empty' };
    }
    if (!response.ok) throw await githubResponseError(response);
    const commits = await response.json().catch(() => null) as GitHubCommitLookupResponse[] | null;
    if (!Array.isArray(commits)) {
      throw { code: 'COMMAND_FAILED', message: `GitHub returned invalid commit history for ${repository}` };
    }
    if (commits.length === 0) return { kind: 'empty' };
    if (commits.length !== 1) return { kind: 'history' };
    const commit = commits[0];
    if (!commit?.sha || commit.commit?.message !== REPOSITORY_ACQUIRE_BOOTSTRAP_MESSAGE) {
      return { kind: 'history' };
    }

    const [root, bootstrap, branches, tags] = await Promise.all([
      this.request<GitHubContentResponse[]>(repository, `/contents?ref=${encodeURIComponent(branch)}`, {}, credential),
      this.request<GitHubContentResponse>(
        repository,
        `/contents/${REPOSITORY_ACQUIRE_BOOTSTRAP_PATH}?ref=${encodeURIComponent(branch)}`,
        {},
        credential,
      ),
      this.request<Array<{ name: string }>>(repository, '/branches?per_page=2', {}, credential),
      this.request<Array<{ name: string }>>(repository, '/tags?per_page=1', {}, credential),
    ]);
    if (
      root.length !== 1
      || root[0]?.type !== 'file'
      || root[0]?.path !== REPOSITORY_ACQUIRE_BOOTSTRAP_PATH
      || branches.length !== 1
      || branches[0]?.name !== branch
      || tags.length !== 0
      || bootstrap.type !== 'file'
      || bootstrap.path !== REPOSITORY_ACQUIRE_BOOTSTRAP_PATH
      || bootstrap.encoding !== 'base64'
      || !bootstrap.content
    ) {
      return { kind: 'history' };
    }
    const bootstrapContent = Buffer.from(bootstrap.content.replace(/\s+/gu, ''), 'base64').toString('utf8');
    if (bootstrapContent !== REPOSITORY_ACQUIRE_BOOTSTRAP_CONTENT) return { kind: 'history' };
    return { kind: 'bootstrap', commitSha: commit.sha };
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



const REPOSITORY_ACQUIRE_BOOTSTRAP_PATH = '.conductor-bootstrap';
const REPOSITORY_ACQUIRE_BOOTSTRAP_MESSAGE = 'Initialize repository for Conductor snapshot acquisition';
const REPOSITORY_ACQUIRE_BOOTSTRAP_CONTENT = 'temporary bootstrap; removed by snapshot import\n';

type RepositoryAcquisitionDestinationState =
  | { kind: 'empty' }
  | { kind: 'bootstrap'; commitSha: string }
  | { kind: 'history' };

const REPOSITORY_ACQUIRE_MAX_FILES = 1500;
const REPOSITORY_ACQUIRE_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const REPOSITORY_ACQUIRE_MAX_SINGLE_BLOB_BYTES = 5 * 1024 * 1024;
const REPOSITORY_ACQUIRE_BLOB_CONCURRENCY = 8;

type AcquisitionBlob = { path: string; mode: string; sha: string; size: number };

function acquisitionLimits() {
  return {
    maxFiles: REPOSITORY_ACQUIRE_MAX_FILES,
    maxTotalBytes: REPOSITORY_ACQUIRE_MAX_TOTAL_BYTES,
    maxSingleBlobBytes: REPOSITORY_ACQUIRE_MAX_SINGLE_BLOB_BYTES,
  };
}

function exactRepositoryIdentity(value: string, field: string): string {
  const parts = value.trim().split('/');
  if (parts.length !== 2) throw { code: 'CONFLICT', message: `${field} must be an exact owner/repository identity` };
  return `${exactGitHubOwner(parts[0]!)}/${exactRepositoryName(parts[1]!)}`;
}

function exactGitHubOwner(value: string): string {
  const owner = value.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(owner)) {
    throw { code: 'CONFLICT', message: 'destinationOwner must be a valid exact GitHub owner' };
  }
  return owner;
}

function exactRepositoryName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/u.test(name) || name === '.' || name === '..') {
    throw { code: 'CONFLICT', message: 'destinationRepository must be a valid exact GitHub repository name' };
  }
  return name;
}

function acquisitionBranch(value: string): string {
  const branch = value.trim();
  if (!safeMergeBranch(branch) || branch.length > 255) {
    throw { code: 'CONFLICT', message: 'destinationBranch must be a valid exact Git branch name' };
  }
  return branch;
}

function acquisitionBlobs(tree: GitHubTreeResponse): AcquisitionBlob[] {
  if (tree.truncated) throw { code: 'CONFLICT', message: 'Upstream tree response is truncated; acquisition refuses incomplete snapshots' };
  if (tree.tree.some((entry) => entry.type === 'commit')) {
    throw { code: 'CONFLICT', message: 'Upstream contains Git submodules; acquisition v0 refuses snapshots it cannot reproduce exactly' };
  }
  return tree.tree
    .filter((entry) => entry.type === 'blob')
    .map((entry) => {
      if (!Number.isSafeInteger(entry.size) || (entry.size ?? -1) < 0) {
        throw { code: 'CONFLICT', message: `Upstream blob size is unavailable for ${entry.path}` };
      }
      return { path: entry.path, mode: entry.mode, sha: entry.sha, size: entry.size! };
    });
}

function acquisitionRequiresWorkflowWrite(blobs: AcquisitionBlob[]): boolean {
  return blobs.some((entry) => /^\.github\/workflows\//u.test(entry.path));
}

function enforceAcquisitionBounds(tree: GitHubTreeResponse, blobs: AcquisitionBlob[]): void {
  if (tree.truncated) throw { code: 'CONFLICT', message: 'Upstream tree response is truncated; acquisition refuses incomplete snapshots' };
  if (blobs.length > REPOSITORY_ACQUIRE_MAX_FILES) {
    throw { code: 'CONFLICT', message: `Upstream snapshot has ${blobs.length} files; limit is ${REPOSITORY_ACQUIRE_MAX_FILES}` };
  }
  const oversized = blobs.find((entry) => entry.size > REPOSITORY_ACQUIRE_MAX_SINGLE_BLOB_BYTES);
  if (oversized) {
    throw { code: 'CONFLICT', message: `Upstream blob ${oversized.path} exceeds the ${REPOSITORY_ACQUIRE_MAX_SINGLE_BLOB_BYTES}-byte per-file limit` };
  }
  const total = blobs.reduce((sum, entry) => sum + entry.size, 0);
  if (total > REPOSITORY_ACQUIRE_MAX_TOTAL_BYTES) {
    throw { code: 'CONFLICT', message: `Upstream snapshot is ${total} bytes; limit is ${REPOSITORY_ACQUIRE_MAX_TOTAL_BYTES}` };
  }
}

const SOURCE_DISCOVERY_TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.gql', '.graphql', '.h', '.hpp',
  '.html', '.ini', '.java', '.js', '.jsx', '.json', '.kt', '.kts', '.md', '.mdx',
  '.mjs', '.cjs', '.php', '.proto', '.py', '.rb', '.rs', '.scss', '.sh', '.sql',
  '.svelte', '.swift', '.toml', '.ts', '.tsx', '.txt', '.vue', '.yaml', '.yml', '.zsh',
]);
const SOURCE_DISCOVERY_TEXT_BASENAMES = new Set(['Dockerfile', 'Makefile', 'Procfile', 'Gemfile', 'Rakefile']);

function sourceDiscoveryTextCandidate(path: string): boolean {
  const basename = path.split('/').at(-1) ?? path;
  if (SOURCE_DISCOVERY_TEXT_BASENAMES.has(basename)) return true;
  const dot = basename.lastIndexOf('.');
  return dot >= 0 && SOURCE_DISCOVERY_TEXT_EXTENSIONS.has(basename.slice(dot).toLowerCase());
}

function sourceDiscoverySnippet(line: string): string {
  const compact = line.replace(/\t/gu, '  ').trimEnd();
  return compact.length <= 320 ? compact : `${compact.slice(0, 317)}...`;
}

function rawGithubUrl(repository: string, sha: string, path: string): string {
  return `https://raw.githubusercontent.com/${repository.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(sha)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

type GitHubReadOperation =
  | 'development.status'
  | 'repository.audit'
  | 'pull-request.status'
  | 'source.discover'
  | 'source.artifact.read'
  | 'ci.run.read'
  | 'work-item.status'
  | 'work-item.list';

type GitHubWriteOperation =
  | 'lifecycle.advance'
  | 'lifecycle.resume'
  | 'git.branch.create'
  | 'git.integration.bootstrap'
  | 'git.branch.delete'
  | 'git.commit.create'
  | 'git.workflow.commit'
  | 'pull-request.create'
  | 'pull-request.comment.create'
  | 'pull-request.labels.update'
  | 'pull-request.close'
  | 'pull-request.ready-for-review'
  | 'pull-request.verify.rerun'
  | 'pull-request.merge.integration'
  | 'pull-request.merge.reconcile-preview'
  | 'pull-request.merge.promote'
  | 'work-item.create'
  | 'work-item.comment.create'
  | 'work-item.update-status'
  | 'work-item.classification.update'
  | 'work-item.triage.update';

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
  'repository.audit': {
    contents: 'read',
    pull_requests: 'read',
    checks: 'read',
    actions: 'read',
  },
  'pull-request.status': {
    pull_requests: 'read',
    checks: 'read',
    actions: 'read',
  },
  'source.discover': { contents: 'read' },
  'source.artifact.read': { contents: 'read' },
  'ci.run.read': {
    pull_requests: 'read',
    actions: 'read',
  },
  'work-item.status': { issues: 'read' },
  'work-item.list': { issues: 'read' },
};

const GITHUB_WRITE_OPERATION_PERMISSIONS: Readonly<Record<
  GitHubWriteOperation,
  Readonly<Record<string, 'read' | 'write'>>
>> = {
  'lifecycle.advance': { contents: 'write', pull_requests: 'write', checks: 'read', actions: 'read' },
  'lifecycle.resume': { contents: 'write', pull_requests: 'read' },
  'git.branch.create': { contents: 'write' },
  'git.integration.bootstrap': { contents: 'write' },
  'git.branch.delete': { contents: 'write' },
  'git.commit.create': { contents: 'write' },
  'git.workflow.commit': { contents: 'write', workflows: 'write' },
  'pull-request.create': { pull_requests: 'write' },
  'pull-request.comment.create': { issues: 'write' },
  'pull-request.labels.update': { issues: 'write' },
  'pull-request.close': { pull_requests: 'write' },
  'pull-request.ready-for-review': { pull_requests: 'write' },
  'pull-request.verify.rerun': { actions: 'write' },
  'pull-request.merge.integration': { contents: 'write' },
  'pull-request.merge.reconcile-preview': { contents: 'write' },
  'pull-request.merge.promote': { contents: 'write', issues: 'read' },
  'work-item.create': { issues: 'write' },
  'work-item.comment.create': { issues: 'write' },
  'work-item.update-status': { issues: 'write' },
  'work-item.classification.update': { issues: 'write' },
  'work-item.triage.update': { issues: 'write' },
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

function derivePullRequestOrchestration(input: {
  pull: GitHubPullRequestResponse;
  labels: string[];
  checks: PullRequestStatus['checks']['items'];
  workflowRuns: PullRequestStatus['workflowRuns'];
  previous?: GetPullRequestStatusInput['previous'];
}): PullRequestOrchestration {
  const sealRequested = input.labels.some((label) => label.toLowerCase() === 'seal-b');
  const activeChecks = input.checks.filter((check) => !check.historical);
  const activeWorkflowRuns = input.workflowRuns.filter((run) => !run.historical);
  const namedChecks = (name: string) =>
    activeChecks.filter((check) => normalizedCheckName(check.name) === name);

  const verifyChecks = namedChecks('verify');
  const actionSmokeChecks = namedChecks('action-smoke');
  const selfSealChecks = namedChecks('self-seal');

  const sourceVerifySucceeded = verifyChecks.some((check) => check.conclusion === 'success');
  const sourceVerifyFailed = verifyChecks.some((check) => isFailureConclusion(check.conclusion));
  const actionSmokeFailed = actionSmokeChecks.some((check) => isFailureConclusion(check.conclusion));
  const selfSealPending = selfSealChecks.some((check) => check.status !== 'completed');
  const selfSealSucceeded = selfSealChecks.some((check) => check.conclusion === 'success');
  const selfSealActive = selfSealPending || selfSealSucceeded;

  const expectedPreSealCheckpoint =
    sealRequested
    && sourceVerifySucceeded
    && actionSmokeFailed
    && selfSealActive;

  const pendingSignals = uniqueStrings([
    ...activeChecks
      .filter((check) => check.status !== 'completed')
      .map((check) => `check:${check.name}`),
    ...activeWorkflowRuns
      .filter((run) => run.status !== 'completed')
      .map((run) => `workflow:${run.name}`),
  ]);

  const actionRequiredSignals = uniqueStrings([
    ...activeChecks
      .filter((check) => check.conclusion === 'action_required')
      .map((check) => `check:${check.name}`),
    ...activeWorkflowRuns
      .filter((run) => run.conclusion === 'action_required')
      .map((run) => `workflow:${run.name}`),
  ]);

  const granularFailures = input.checks
    .filter((check) => isFailureConclusion(check.conclusion))
    .filter((check) =>
      !(expectedPreSealCheckpoint && normalizedCheckName(check.name) === 'action-smoke')
    )
    .map((check) => `check:${check.name}`);

  const aggregateWorkflowFailures = input.workflowRuns
    .filter((run) => isFailureConclusion(run.conclusion))
    .filter((run) =>
      !(expectedPreSealCheckpoint && normalizedCheckName(run.name) === 'verify')
    )
    .map((run) => `workflow:${run.name}`);

  const failedSignals = uniqueStrings([
    ...granularFailures,
    ...aggregateWorkflowFailures,
  ]);

  const previousHeadSha = input.previous?.headSha ?? null;
  const previousState = input.previous?.orchestrationState ?? null;
  const headChanged = previousHeadSha === null
    ? null
    : previousHeadSha !== input.pull.head.sha;

  let state: PullRequestOrchestrationState;
  let action: PullRequestOrchestration['action'];
  let shouldAct: boolean;
  let summary: string;
  let resumeWhen: string | null = null;

  if (input.pull.merged) {
    state = 'merged';
    action = 'none';
    shouldAct = false;
    summary = 'Pull request is already merged; no further orchestration action is required.';
  } else if (input.pull.draft) {
    state = 'draft';
    action = 'none';
    shouldAct = false;
    summary = 'Pull request is still a draft; promotion/integration orchestration is not active.';
  } else if (sourceVerifyFailed || failedSignals.length > 0) {
    state = 'verification-failed';
    action = 'inspect-failure';
    shouldAct = true;
    summary = 'One or more source/check gates failed on the exact PR head; inspect the failure before proceeding.';
  } else if (sealRequested && headChanged === true && actionRequiredSignals.length > 0) {
    state = 'sealed-head-verification-required';
    action = 'rerun-exact-head';
    shouldAct = true;
    summary = 'The seal changed the candidate head and GitHub reports action_required; rerun verification from the exact sealed head before promotion.';
  } else if (expectedPreSealCheckpoint) {
    state = 'pre-seal-checkpoint';
    action = 'wait';
    shouldAct = false;
    summary = 'Expected pre-seal checkpoint mismatch: source verify passed while action-smoke failed and self-seal is active.';
    resumeWhen = 'Self-seal completes or the pull-request head SHA changes.';
  } else if (pendingSignals.length > 0) {
    state = 'external-gate-pending';
    action = 'wait';
    shouldAct = false;
    summary = 'External gate pending for the exact PR head; no agent action is required until provider state changes.';
    resumeWhen = 'A check/workflow settles or the pull-request head SHA changes.';
  } else if (
    sealRequested
    && headChanged === true
    && activeChecks.length === 0
    && activeWorkflowRuns.length === 0
  ) {
    state = 'sealed-head-verification-required';
    action = 'rerun-exact-head';
    shouldAct = true;
    summary = 'The seal changed the candidate head and no exact-head verification is currently observed; run verification on the sealed head.';
  } else if (actionRequiredSignals.length > 0) {
    state = 'action-required';
    action = 'resume-external-gate';
    shouldAct = true;
    summary = 'GitHub reports action_required for the exact PR head; caller intervention is required before the external gate can continue.';
  } else if (input.pull.mergeable === false) {
    state = 'merge-blocked';
    action = 'inspect-failure';
    shouldAct = true;
    summary = 'Checks are settled but GitHub reports the pull request as not mergeable; inspect the merge blocker.';
  } else if (
    verifyChecks.length === 0
    && !activeWorkflowRuns.some((run) => normalizedCheckName(run.name) === 'verify')
  ) {
    state = 'external-gate-pending';
    action = 'wait';
    shouldAct = false;
    summary = 'No recognized verification result is observed yet for the exact PR head; unrelated provider checks do not prove the development gate.';
    resumeWhen = 'The verify check/workflow appears or the pull-request head SHA changes.';
  } else if (['preview', 'vercel-preview'].includes(input.pull.head.ref.toLowerCase())) {
    state = 'promotion-ready';
    action = 'promotion-gate';
    shouldAct = true;
    summary = 'Verified Preview candidate is technically ready for the caller-owned Main promotion/authorization gate.';
  } else {
    state = 'integration-ready';
    action = 'integration-merge';
    shouldAct = true;
    summary = 'Exact-head verification is settled for work-to-Preview integration. Ready to integrate into Preview; this is not Preview deployment/proof and does not authorize Main promotion.';
  }

  const stateChanged = input.previous?.orchestrationState === undefined
    ? null
    : input.previous.orchestrationState !== state;
  const meaningful = input.previous === undefined
    ? null
    : headChanged === true || stateChanged === true;

  return {
    state,
    action,
    shouldAct,
    summary,
    resumeWhen,
    transition: {
      observed: input.previous !== undefined,
      previousHeadSha,
      previousState,
      headChanged,
      stateChanged,
      meaningful,
    },
    seal: {
      requested: sealRequested,
      expectedPreSealCheckpoint,
      exactHeadVerificationRequired:
        sealRequested
        && headChanged === true
        && state !== 'promotion-ready'
        && state !== 'integration-ready'
        && state !== 'merged',
    },
    signals: {
      pending: pendingSignals,
      actionRequired: actionRequiredSignals,
      failed: failedSignals,
    },
  };
}


function markHistoricalChecks(checks: PullRequestStatus['checks']['items']): PullRequestStatus['checks']['items'] {
  const latest = new Map<string, number>();
  for (const check of checks) {
    const key = normalizedCheckName(check.name);
    latest.set(key, Math.max(latest.get(key) ?? Number.MIN_SAFE_INTEGER, check.id));
  }
  return checks.map((check) => ({ ...check, historical: latest.get(normalizedCheckName(check.name)) !== check.id }));
}

function markHistoricalWorkflowRuns(runs: PullRequestStatus['workflowRuns']): PullRequestStatus['workflowRuns'] {
  const latest = new Map<string, PullRequestStatus['workflowRuns'][number]>();
  for (const run of runs) {
    const key = normalizedCheckName(run.name);
    const current = latest.get(key);
    if (!current || workflowRunIsNewer(run, current)) latest.set(key, run);
  }
  return runs.map((run) => ({ ...run, historical: latest.get(normalizedCheckName(run.name))?.id !== run.id }));
}

function workflowRunIsNewer(
  candidate: PullRequestStatus['workflowRuns'][number],
  current: PullRequestStatus['workflowRuns'][number],
): boolean {
  const candidateTime = candidate.createdAt ? Date.parse(candidate.createdAt) : Number.NaN;
  const currentTime = current.createdAt ? Date.parse(current.createdAt) : Number.NaN;
  if (Number.isFinite(candidateTime) && Number.isFinite(currentTime) && candidateTime !== currentTime) {
    return candidateTime > currentTime;
  }
  if ((candidate.runAttempt ?? 0) !== (current.runAttempt ?? 0)) {
    return (candidate.runAttempt ?? 0) > (current.runAttempt ?? 0);
  }
  return candidate.id > current.id;
}

function normalizedCheckName(name: string): string {
  return name
    .toLowerCase()
    .split('/')
    .at(-1)!
    .trim();
}

function isFailureConclusion(conclusion: string | null): boolean {
  return conclusion !== null
    && !['success', 'neutral', 'skipped', 'action_required'].includes(conclusion);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

const WORK_ITEM_STATUS_PREFIX = 'status:';
const WORK_ITEM_KIND_PREFIX = 'kind:';
const WORK_ITEM_ORIGIN_PREFIX = 'origin:';
const WORK_ITEM_SEVERITY_PREFIX = 'severity:';
const WORK_ITEM_PRIORITY_PREFIX = 'priority:';
const WORK_ITEM_PRODUCTION_BLOCKING_LABEL = 'production-blocking';

const WORK_ITEM_STATUSES: readonly MutableWorkItemStatus[] = [
  'backlog', 'ready', 'in-progress', 'blocked', 'review', 'done',
];
const WORK_ITEM_KINDS: readonly MutableWorkItemKind[] = [
  'bug', 'feature', 'investigation', 'improvement', 'maintenance', 'operations', 'audit',
];
const WORK_ITEM_ORIGINS: readonly MutableWorkItemOrigin[] = [
  'human', 'agent-audit', 'di-finding', 'ci', 'runtime', 'dependency', 'user-feedback',
];
const WORK_ITEM_SEVERITIES: readonly MutableWorkItemSeverity[] = ['critical', 'high', 'medium', 'low'];
const WORK_ITEM_PRIORITIES: readonly MutableWorkItemPriority[] = ['p0', 'p1', 'p2', 'p3'];

function workItemStatusLabel(status: MutableWorkItemStatus): string {
  return `${WORK_ITEM_STATUS_PREFIX}${status}`;
}

function workItemKindLabel(kind: MutableWorkItemKind): string {
  return `${WORK_ITEM_KIND_PREFIX}${kind}`;
}

function workItemOriginLabel(origin: MutableWorkItemOrigin): string {
  return `${WORK_ITEM_ORIGIN_PREFIX}${origin}`;
}

function workItemSeverityLabel(severity: MutableWorkItemSeverity): string {
  return `${WORK_ITEM_SEVERITY_PREFIX}${severity}`;
}

function workItemPriorityLabel(priority: MutableWorkItemPriority): string {
  return `${WORK_ITEM_PRIORITY_PREFIX}${priority}`;
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
    audit: '5319E7',
  };
  return colors[kind];
}

function workItemOriginColor(_origin: MutableWorkItemOrigin): string {
  return 'D4C5F9';
}

function workItemSeverityColor(severity: MutableWorkItemSeverity): string {
  return ({ critical: 'CF222E', high: 'FB8F44', medium: 'BF8700', low: '0969DA' } as const)[severity];
}

function workItemPriorityColor(priority: MutableWorkItemPriority): string {
  return ({ p0: 'CF222E', p1: 'FB8F44', p2: 'BF8700', p3: '0969DA' } as const)[priority];
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

function isWorkItemSeverityLabel(label: string): boolean {
  return label.toLowerCase().startsWith(WORK_ITEM_SEVERITY_PREFIX);
}

function isWorkItemPriorityLabel(label: string): boolean {
  return label.toLowerCase().startsWith(WORK_ITEM_PRIORITY_PREFIX);
}

function isProductionBlockingLabel(label: string): boolean {
  return label.toLowerCase() === WORK_ITEM_PRODUCTION_BLOCKING_LABEL;
}

function isWorkItemReservedLabel(label: string): boolean {
  return isWorkItemStatusLabel(label) || isWorkItemKindLabel(label) || isWorkItemOriginLabel(label)
    || isWorkItemSeverityLabel(label) || isWorkItemPriorityLabel(label) || isProductionBlockingLabel(label);
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
  const severity = deriveClassification(labels, WORK_ITEM_SEVERITY_PREFIX, WORK_ITEM_SEVERITIES);
  const priority = deriveClassification(labels, WORK_ITEM_PRIORITY_PREFIX, WORK_ITEM_PRIORITIES);
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
    severity: severity.value as WorkItemSeverity,
    severitySource: severity.source as WorkItemTriageSource,
    priority: priority.value as WorkItemPriority,
    prioritySource: priority.source as WorkItemTriageSource,
    productionBlocking: labels.some(isProductionBlockingLabel),
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

function assertIntegrationBootstrapBranch(branch: string): asserts branch is 'preview' | 'vercel-preview' {
  if (branch !== 'preview' && branch !== 'vercel-preview') {
    throw { code: 'PERMISSION_DENIED', message: 'Integration bootstrap branch must be exactly preview or vercel-preview' };
  }
}

function assertPreviewReconciliationTarget(branch: string): void {
  if (!safeMergeBranch(branch) || !['preview', 'vercel-preview'].includes(branch.toLowerCase())) {
    throw { code: 'PERMISSION_DENIED', message: 'Preview reconciliation targets must be preview or vercel-preview' };
  }
}

function assertPromotionSourceBranch(branch: string): void {
  if (!safeMergeBranch(branch) || !['preview', 'vercel-preview'].includes(branch.toLowerCase())) {
    throw { code: 'PERMISSION_DENIED', message: 'Promotion sources must be preview or vercel-preview' };
  }
}

function workflowRepositoryPath(value: string): string {
  const path = validRepositoryPath(value);
  if (!/^\.github\/workflows\/[^/]+\.(?:ya?ml)$/iu.test(path)) {
    throw { code: 'PERMISSION_DENIED', message: 'Workflow authoring is limited to .github/workflows/*.yml or *.yaml' };
  }
  return path;
}

function workflowReviewFindings(content: string): WorkflowReviewFinding[] {
  const findings: WorkflowReviewFinding[] = [];
  const lines = content.split(/\r?\n/u);
  const add = (code: string, severity: WorkflowReviewFinding['severity'], summary: string, line?: number) => {
    if (findings.length >= 50) return;
    findings.push({ code, severity, summary, ...(line ? { line } : {}) });
  };
  lines.forEach((line, index) => {
    const n = index + 1;
    if (/\bpull_request_target\b/u.test(line)) add('pull-request-target', 'high', 'pull_request_target executes with elevated base-repository context and requires explicit review.', n);
    if (/^\s*permissions\s*:\s*write-all\s*$/iu.test(line) || /^\s*[A-Za-z0-9_-]+\s*:\s*write\s*(?:#.*)?$/iu.test(line)) {
      add('write-permission', 'high', 'Workflow declares a write permission; verify the minimum required scope.', n);
    } else if (/^\s*permissions\s*:/iu.test(line)) {
      add('permissions-block', 'info', 'Workflow declares an explicit permissions block; review requested scopes.', n);
    }
    if (/\bid-token\s*:\s*write\b/iu.test(line)) add('oidc-write', 'warning', 'Workflow requests OIDC id-token: write.', n);
    if (/runs-on\s*:\s*(?:\[[^\]]*\bself-hosted\b|self-hosted\b)/iu.test(line)) add('self-hosted-runner', 'high', 'Workflow targets a self-hosted runner.', n);
    if (/^\s*environment\s*:/iu.test(line)) add('environment-access', /prod(?:uction)?/iu.test(line) ? 'high' : 'warning', 'Workflow declares environment access; verify deployment/environment protections.', n);
    if (/\$\{\{\s*secrets\./u.test(line)) add('secret-reference', 'warning', 'Workflow references a GitHub secret. Conductor does not read or resolve the secret value.', n);
    if (/(?:curl|wget)\b.*\|\s*(?:bash|sh)\b/iu.test(line)) add('download-execute', 'high', 'Workflow downloads content and pipes it directly to a shell.', n);
    const uses = line.match(/^\s*-?\s*uses\s*:\s*([^\s#]+)\s*/iu);
    if (uses) {
      const ref = uses[1]!;
      if (!ref.startsWith('./') && !ref.startsWith('actions/') && !ref.startsWith('github/')) {
        const at = ref.lastIndexOf('@');
        const pinned = at > 0 && /^[0-9a-f]{40}$/iu.test(ref.slice(at + 1));
        add('external-action', pinned ? 'info' : 'warning', pinned
          ? `Third-party action is pinned to a full commit SHA: ${ref}`
          : `Third-party action is not pinned to a full commit SHA: ${ref}`, n);
      }
    }
  });
  return findings;
}

function assertWorkBranch(branch: string): void {
  if (!/^work\/[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..') || branch.endsWith('/')) {
    throw { code: 'PERMISSION_DENIED', message: 'Conductor mutations are limited to valid work/* branches' };
  }
}

function assertCleanupBranch(branch: string): void {
  if (!/^(?:work|repair|audit)\/[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..') || branch.endsWith('/')) {
    throw { code: 'PERMISSION_DENIED', message: 'Branch cleanup is limited to valid work/*, repair/*, or audit/* branches' };
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

async function boundedGitHubMap<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

async function readTailBytes(response: Response, maxBytes: number): Promise<{ text: string; totalBytes: number; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    const bytes = Buffer.from(text, 'utf8');
    return {
      text: bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString('utf8'),
      totalBytes: bytes.length,
      truncated: bytes.length > maxBytes,
    };
  }
  const reader = response.body.getReader();
  let tail = Buffer.alloc(0);
  let totalBytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = Buffer.from(next.value);
    totalBytes += chunk.length;
    tail = Buffer.concat([tail, chunk]);
    if (tail.length > maxBytes) tail = tail.subarray(tail.length - maxBytes);
  }
  return { text: tail.toString('utf8'), totalBytes, truncated: totalBytes > maxBytes };
}

function redactGithubLog(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/giu, '$1[redacted]')
    .replace(/((?:token|secret|password|private[_-]?key|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/gu, '[redacted]')
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/gu, '://[redacted]@');
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

interface GitHubRateLimitHeaders {
  limit: number | null;
  remaining: number | null;
  used: number | null;
  resetAt: string | null;
  resource: string | null;
  retryAfterSeconds: number | null;
}

function integerHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null || value.trim() === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function githubRateLimitHeaders(headers: Headers): GitHubRateLimitHeaders | null {
  const limit = integerHeader(headers, 'x-ratelimit-limit');
  const remaining = integerHeader(headers, 'x-ratelimit-remaining');
  const used = integerHeader(headers, 'x-ratelimit-used');
  const resetSeconds = integerHeader(headers, 'x-ratelimit-reset');
  const resource = headers.get('x-ratelimit-resource');
  const retryAfterSeconds = integerHeader(headers, 'retry-after');
  if (
    limit === null
    && remaining === null
    && used === null
    && resetSeconds === null
    && resource === null
    && retryAfterSeconds === null
  ) return null;
  return {
    limit,
    remaining,
    used,
    resetAt: resetSeconds === null ? null : new Date(resetSeconds * 1000).toISOString(),
    resource,
    retryAfterSeconds,
  };
}

async function githubResponseError(response: Response): Promise<ConductorToolError> {
  const requestId = response.headers.get('x-github-request-id');
  const acceptedPermissions = response.headers.get('x-accepted-github-permissions');
  const rateLimit = githubRateLimitHeaders(response.headers);
  const body = await response.json().catch(() => undefined) as { message?: string } | undefined;
  const message = body?.message ?? `GitHub request failed with status ${response.status}`;
  const rateLimited = response.status === 429
    || rateLimit?.remaining === 0
    || /rate limit/iu.test(message);
  const normalized = normalizeToolError(
    rateLimited ? { code: 'TRANSIENT', message } : { status: response.status, message },
    'TOOL_UNAVAILABLE',
    'github',
  );
  const code = rateLimited ? 'TRANSIENT' : normalized.code;
  const details: Record<string, string | number | boolean | null> = {
    httpStatus: response.status,
  };
  if (requestId) details.requestId = requestId;
  if (acceptedPermissions) details.acceptedPermissions = acceptedPermissions;
  if (rateLimit) {
    details.limit = rateLimit.limit;
    details.remaining = rateLimit.remaining;
    details.used = rateLimit.used;
    details.resetAt = rateLimit.resetAt;
    details.resource = rateLimit.resource;
    details.retryAfterSeconds = rateLimit.retryAfterSeconds;
  }
  return new ConductorToolError({
    code,
    message,
    retryable: rateLimited || normalized.retryable,
    source: 'github',
    diagnostics: [{
      level: rateLimited ? 'warning' : 'error',
      code,
      source: 'github',
      message: rateLimited ? 'GitHub API rate limit exhausted' : 'GitHub request failed',
      details,
    }],
  });
}
