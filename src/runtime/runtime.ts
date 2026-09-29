import { createHash, randomUUID } from 'node:crypto';
import {
  supportsProjectPreflight,
  supportsOperationPreflight,
  type ToolRuntimeProvider,
  type RepositoryAcquisitionProvider,
  type RepositoryBootstrapReadProvider,
  type RepositoryAuditReadProvider,
  type RepositorySemanticAuditProvider,
  type SourceControlMutationProvider,
  type ProjectReferenceResolver,
  type PullRequestReadProvider,
  type SourceArtifactReadProvider,
  type CiReadProvider,
  type WorkItemCandidateReadProvider,
  type WorkItemMutationProvider,
  type DeploymentReadProvider,
  type VercelOperationsProvider,
} from '../providers/runtime.js';
import { normalizeToolError } from './errors.js';
import {
  TOOL_RUNTIME_CONTRACT_VERSION,
  TOOL_CATALOG_VERSION,
  type CapabilityAvailability,
  type CapabilityReport,
  type ExecutionReceipt,
  type PreflightCheck,
  type PreflightCheckId,
  type PreflightIntent,
  type ProjectPreflight,
  type ProjectReference,
  type ProviderHealth,
  type ProviderUsageDelta,
  type ProviderUsageSnapshot,
  type ToolDefinition,
  type ToolDiagnostic,
  type ToolOperationName,
  type GetOperationPreflightInput,
  type OperationPreflight,
  type RepositoryAcquisitionPreflightInput,
  type RepositoryAcquisitionPreflight,
  type AcquireRepositoryInput,
  type RepositoryAcquisitionResult,
  type OperationPreflightCheck,
  type GetWorkBootstrapInput,
  type WorkBootstrapProjection,
  type GetRepositoryAuditInput,
  type RepositoryAuditProjection,
  type GetEvidenceBundleInput,
  type EvidenceBundleProjection,
  type EvidenceBundleItemInput,
  type EvidenceBundleItemResult,
  type RepositoryAuditFinding,
  type GetDevelopmentStatusInput,
  type DevelopmentStatusProjection,
  type DevelopmentStatusWorkCounts,
  type DevelopmentStatusWorkItem,
  type AdvanceLifecycleInput,
  type ResumeLifecycleInput,
  type LifecycleAdvanceProjection,
  type LifecycleGateSpec,
  type LifecycleTransitionRecord,
  type CreateBranchInput,
  type BootstrapIntegrationBranchInput,
  type DeleteBranchInput,
  type CreateCommitInput,
  type CreateWorkflowCommitInput,
  type CreatePullRequestInput,
  type CommentPullRequestInput,
  type GetPullRequestStatusInput,
  type PullRequestStatus,
  type GetSourceArtifactInput,
  type SourceArtifactRead,
  type DiscoverSourceInput,
  type SourceDiscoveryResult,
  type GetCiRunEvidenceInput,
  type CiRunEvidence,
  type UpdatePullRequestLabelsInput,
  type ClosePullRequestInput,
  type ReadyPullRequestForReviewInput,
  type RerunPullRequestVerificationInput,
  type MergeIntegrationPullRequestInput,
  type ReconcilePreviewPullRequestInput,
  type PromotePullRequestInput,
  type GetWorkItemStatusInput,
  type ListWorkItemsInput,
  type WorkItemRecord,
  type WorkItemList,
  type CreateWorkItemInput,
  type CommentWorkItemInput,
  type UpdateWorkItemStatusInput,
  type UpdateWorkItemClassificationInput,
  type UpdateWorkItemTriageInput,
  type GetDeploymentStatusInput,
  type GetDeploymentLogsInput,
  type DeploymentProjectStatus,
  type DeploymentLogs,
  type VercelProjectInput, type VercelReadProjectInput, type VercelDeploymentInput, type VercelGitDeploymentInput, type VercelEnvInput, type VercelEnvEditInput, type VercelEnvRemoveInput, type VercelRuntimeLogsInput, type VercelVcrRepositoryInput, type VercelVcrCreateInput,
} from './types.js';
import { IdempotentMutationExecutor } from './idempotency.js';

const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'capabilities',
    description: 'Report the operations and development capabilities currently available.',
    mutates: false,
  },
  {
    name: 'preflight_project',
    description: 'Verify repository-development access, execution surfaces, tests, and intelligence for an execution referent.',
    mutates: false,
  },
];

const OPERATION_PREFLIGHT_DEFINITION: ToolDefinition = {
  name: 'preflight_operation',
  description: 'Verify whether one exact exposed Conductor operation can execute against a supplied execution referent.',
  mutates: false,
};

const REPOSITORY_ACQUISITION_PREFLIGHT_DEFINITION: ToolDefinition = {
  name: 'repository.acquire.preflight',
  description: 'Resolve one exact public GitHub upstream/ref and verify a bounded authorized empty destination without changing work scope.',
  mutates: false,
};

const REPOSITORY_ACQUISITION_MUTATION_DEFINITION: ToolDefinition = {
  name: 'repository.acquire',
  description: 'Import one exact public GitHub snapshot into an already-authorized empty destination without granting code-work authority.',
  mutates: true,
};


const WORK_BOOTSTRAP_READ_DEFINITION: ToolDefinition = {
  name: 'work.bootstrap',
  description: 'Return one compact client-bound development bootstrap snapshot with catalog freshness, repository topology, work/preflight state, DI posture, and deployment posture.',
  mutates: false,
};


const EVIDENCE_BUNDLE_READ_DEFINITION: ToolDefinition = {
  name: 'evidence.bundle',
  description: 'Run a bounded read-only evidence matrix with explicit per-item identity, failure isolation, and a small concurrency ceiling.',
  mutates: false,
};

const REPOSITORY_AUDIT_READ_DEFINITION: ToolDefinition = {
  name: 'repository.audit',
  description: 'Return one bounded read-only provider-facts audit for repository topology, active PR/check state, durable-work hygiene, provider posture, deployment state, and optional separate Development Intelligence semantic findings.',
  mutates: false,
};

const DEVELOPMENT_STATUS_READ_DEFINITION: ToolDefinition = {
  name: 'development.status',
  description: 'Reconstruct compact inspect-time development readiness, active work, and native PR candidate evidence.',
  mutates: false,
};

const PULL_REQUEST_READ_DEFINITION: ToolDefinition = {
  name: 'pull-request.status',
  description: 'Read one pull request with exact head/base identity plus observed check and workflow state.',
  mutates: false,
};

const SOURCE_DISCOVERY_READ_DEFINITION: ToolDefinition = {
  name: 'source.discover',
  description: 'Read a bounded exact-SHA repository manifest or literal source matches without semantic inference or mutation authority.',
  mutates: false,
};

const EXECUTION_EVIDENCE_READ_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'source.artifact.read',
    description: 'Read one complete bounded UTF-8 source artifact at an exact immutable Git SHA and path; no search or semantic inference.',
    mutates: false,
  },
  {
    name: 'ci.run.read',
    description: 'Read exact workflow-run jobs, steps, and bounded redacted failure-log tails for one exact pull-request head.',
    mutates: false,
  },
];

const DEPLOYMENT_READ_DEFINITIONS: readonly ToolDefinition[] = [
  { name: 'deployment.status', description: 'Read Vercel deployment/production state for one configured execution referent.', mutates: false },
  { name: 'deployment.logs', description: 'Read bounded/redacted deployment event logs for one exact Vercel deployment.', mutates: false },
];

const VERCEL_AUDIT_DEFINITIONS: readonly ToolDefinition[] = [
  { name: 'deployment.audit', description: 'Read bounded project, environment, deployment, and supported account posture.', mutates: false },
  { name: 'deployment.runtime-logs', description: 'Read bounded redacted runtime logs for one exact deployment.', mutates: false },
  { name: 'deployment.env.list', description: 'List project variable metadata without secret values.', mutates: false },
  { name: 'deployment.vcr.get', description: 'Read one exact Vercel Container Registry repository in the bound project.', mutates: false },
];
const VERCEL_MUTATION_DEFINITIONS: readonly ToolDefinition[] = [
  { name: 'deployment.redeploy', description: 'Redeploy one exact bound deployment.', mutates: true },
  { name: 'deployment.git.create', description: 'Create a deployment from exact linked Git source.', mutates: true },
  { name: 'deployment.promote', description: 'Promote one exact READY deployment to production.', mutates: true },
  { name: 'deployment.rollback', description: 'Rollback to one exact prior READY deployment.', mutates: true },
  { name: 'deployment.delete', description: 'Delete one exact terminal deployment while protecting current production.', mutates: true },
  { name: 'deployment.env.upsert', description: 'Upsert one project environment variable.', mutates: true },
  { name: 'deployment.env.update', description: 'Update one exact project environment variable.', mutates: true },
  { name: 'deployment.env.remove', description: 'Remove one exact project environment variable.', mutates: true },
  { name: 'deployment.vcr.create', description: 'Create one exact Vercel Container Registry repository in the bound project.', mutates: true },
];

const WORK_ITEM_READ_DEFINITIONS: readonly ToolDefinition[] = [
  { name: 'work-item.status', description: 'Read one normalized durable work item.', mutates: false },
  { name: 'work-item.list', description: 'List normalized durable work items for one project, optionally filtered by status.', mutates: false },
];

const WORK_ITEM_MUTATION_DEFINITIONS: readonly ToolDefinition[] = [
  { name: 'work-item.create', description: 'Create one durable work item in the owning project.', mutates: true },
  { name: 'work-item.comment.create', description: 'Add evidence or a consolidation link to one existing issue.', mutates: true },
  { name: 'work-item.update-status', description: 'Move one durable work item to an explicit normalized status.', mutates: true },
  { name: 'work-item.classification.update', description: 'Update normalized work kind and/or origin without changing lifecycle status.', mutates: true },
  { name: 'work-item.triage.update', description: 'Update normalized severity, priority, and production release-gate triage without changing lifecycle status.', mutates: true },
];

const PULL_REQUEST_LIFECYCLE_MUTATION_DEFINITIONS: readonly ToolDefinition[] = [
  { name: 'pull-request.close', description: 'Close one exact unmerged pull request without accepting its code.', mutates: true },
  { name: 'pull-request.ready-for-review', description: 'Mark one exact open draft pull request ready for review without bypassing verification.', mutates: true },
  { name: 'pull-request.verify.rerun', description: 'Rerun one exact verify workflow run after proving it belongs to the expected pull-request head.', mutates: true },
];


const LIFECYCLE_MUTATION_DEFINITIONS: readonly ToolDefinition[] = [
  { name: 'lifecycle.advance', description: 'Advance one canonical work item through deterministic already-authorized lifecycle mechanics until an external, failure, ambiguity, completion, or human Main gate.', mutates: true },
  { name: 'lifecycle.resume', description: 'Resume one exact signed human continuation gate and perform only the bound Main promotion after fresh explicit owner approval.', mutates: true },
];

const MUTATION_DEFINITIONS: readonly ToolDefinition[] = [
  { name: 'git.branch.create', description: 'Create a work/* branch from an exact Git SHA.', mutates: true },
  { name: 'git.integration.bootstrap', description: 'Create one approved Preview integration branch from the exact current repository default-branch SHA.', mutates: true },
  { name: 'git.branch.delete', description: 'Delete one exact integrated development branch after proving its head is already contained in Preview or Main.', mutates: true },
  { name: 'git.commit.create', description: 'Create files in one commit and advance an existing work/* branch from an expected head SHA.', mutates: true },
  { name: 'pull-request.create', description: 'Open a work/* pull request or the bounded Preview-to-default promotion proposal lane.', mutates: true },
  { name: 'pull-request.comment.create', description: 'Add a comment to a pull request.', mutates: true },
  { name: 'pull-request.labels.update', description: 'Add/remove pull-request labels while preserving unrelated labels.', mutates: true },
  { name: 'pull-request.merge.integration', description: 'Merge an exact PR candidate into a non-accepted integration branch.', mutates: true },
  { name: 'pull-request.merge.reconcile-preview', description: 'Reconcile the exact accepted default-branch ancestry back into Preview with a merge commit.', mutates: true },
  { name: 'pull-request.merge.promote', description: 'Promote an exact explicitly approved PR candidate into the repository default branch.', mutates: true },
];

const WORKFLOW_MUTATION_DEFINITION: ToolDefinition = {
  name: 'git.workflow.commit',
  description: 'Create or edit one GitHub Actions workflow on an exact work/* branch after proving workflows:write and returning explicit security-review findings.',
  mutates: true,
};

const CORE_PREFLIGHT_OPERATIONS = new Set<import('./types.js').RuntimeOperationName>([
  'capabilities',
  'preflight_project',
  'preflight_operation',
]);

const REQUIRED_PREFLIGHT_CHECKS: Record<PreflightIntent, readonly PreflightCheckId[]> = {
  inspect: ['repository.access', 'github.read', 'development-intelligence.read'],
  develop: ['repository.access', 'github.read', 'github.write', 'development-intelligence.read'],
  execute: [
    'repository.access', 'github.read', 'github.write', 'workspace.access',
    'shell.execute', 'tests.run', 'development-intelligence.read',
  ],
};

export interface ConductorToolRuntimeOptions {
  providers?: ToolRuntimeProvider[];
  now?: () => Date;
  createOperationId?: () => string;
  repositoryAcquisitionProvider?: RepositoryAcquisitionProvider;
  repositoryBootstrapProvider?: RepositoryBootstrapReadProvider;
  repositoryAuditProvider?: RepositoryAuditReadProvider;
  intelligenceAuditProvider?: RepositorySemanticAuditProvider;
  sourceControlMutationProvider?: SourceControlMutationProvider;
  mutationExecutor?: IdempotentMutationExecutor;
  projectResolver?: ProjectReferenceResolver;
  pullRequestProvider?: PullRequestReadProvider;
  sourceArtifactProvider?: SourceArtifactReadProvider;
  ciReadProvider?: CiReadProvider;
  workItemProvider?: WorkItemMutationProvider;
  workItemCandidateProvider?: WorkItemCandidateReadProvider;
  deploymentProvider?: VercelOperationsProvider;
}

export class ConductorToolRuntime {
  resolveProjectReference(project: ProjectReference): ProjectReference {
    return this.projectResolver?.resolveProjectReference(project) ?? project;
  }
  private readonly providers: ToolRuntimeProvider[];
  private readonly now: () => Date;
  private readonly createOperationId: () => string;
  private readonly repositoryAcquisitionProvider?: RepositoryAcquisitionProvider;
  private readonly repositoryBootstrapProvider?: RepositoryBootstrapReadProvider;
  private readonly repositoryAuditProvider?: RepositoryAuditReadProvider;
  private readonly intelligenceAuditProvider?: RepositorySemanticAuditProvider;
  private readonly sourceControlMutationProvider?: SourceControlMutationProvider;
  private readonly mutationExecutor?: IdempotentMutationExecutor;
  private readonly projectResolver?: ProjectReferenceResolver;
  private readonly pullRequestProvider?: PullRequestReadProvider;
  private readonly sourceArtifactProvider?: SourceArtifactReadProvider;
  private readonly ciReadProvider?: CiReadProvider;
  private readonly workItemProvider?: WorkItemMutationProvider;
  private readonly workItemCandidateProvider?: WorkItemCandidateReadProvider;
  private readonly deploymentProvider?: VercelOperationsProvider;

  constructor(options: ConductorToolRuntimeOptions = {}) {
    this.providers = options.providers ?? [];
    this.now = options.now ?? (() => new Date());
    this.createOperationId =
      options.createOperationId ?? (() => randomUUID());
    this.repositoryAcquisitionProvider = options.repositoryAcquisitionProvider;
    this.repositoryBootstrapProvider = options.repositoryBootstrapProvider;
    this.repositoryAuditProvider = options.repositoryAuditProvider;
    this.intelligenceAuditProvider = options.intelligenceAuditProvider;
    this.sourceControlMutationProvider = options.sourceControlMutationProvider;
    this.mutationExecutor = options.mutationExecutor;
    this.projectResolver = options.projectResolver;
    this.pullRequestProvider = options.pullRequestProvider;
    this.sourceArtifactProvider = options.sourceArtifactProvider;
    this.ciReadProvider = options.ciReadProvider;
    this.workItemProvider = options.workItemProvider;
    this.workItemCandidateProvider = options.workItemCandidateProvider;
    this.deploymentProvider = options.deploymentProvider;
  }

  private captureProviderUsage(): Map<string, ProviderUsageSnapshot> {
    const snapshots = new Map<string, ProviderUsageSnapshot>();
    for (const provider of this.providers) {
      const snapshot = provider.getUsageSnapshot?.();
      if (snapshot) snapshots.set(provider.id, snapshot);
    }
    return snapshots;
  }

  private providerUsageDelta(before: Map<string, ProviderUsageSnapshot>): ProviderUsageDelta[] {
    const deltas: ProviderUsageDelta[] = [];
    for (const provider of this.providers) {
      const current = provider.getUsageSnapshot?.();
      if (!current) continue;
      const prior = before.get(provider.id);
      deltas.push({
        provider: provider.id,
        calls: Math.max(0, current.calls - (prior?.calls ?? 0)),
        duplicateReads: Math.max(0, current.duplicateReads - (prior?.duplicateReads ?? 0)),
        requestBodyBytes: Math.max(0, current.requestBodyBytes - (prior?.requestBodyBytes ?? 0)),
        reportedResponseBytes: Math.max(0, current.reportedResponseBytes - (prior?.reportedResponseBytes ?? 0)),
        responsesWithUnknownBytes: Math.max(0, current.responsesWithUnknownBytes - (prior?.responsesWithUnknownBytes ?? 0)),
      });
    }
    return deltas.sort((left, right) => left.provider.localeCompare(right.provider));
  }

  get repositoryAcquisitionReadEnabled(): boolean {
    return Boolean(this.repositoryAcquisitionProvider);
  }

  get repositoryAcquisitionMutationEnabled(): boolean {
    return Boolean(this.repositoryAcquisitionProvider && this.mutationExecutor);
  }

  get sourceControlMutationsEnabled(): boolean {
    return Boolean(this.sourceControlMutationProvider && this.mutationExecutor);
  }

  get workflowCommitEnabled(): boolean {
    return Boolean(this.sourceControlMutationProvider?.createWorkflowCommit && this.mutationExecutor);
  }

  get pullRequestLifecycleMutationsEnabled(): boolean {
    const provider = this.sourceControlMutationProvider;
    return Boolean(
      provider
      && this.mutationExecutor
      && provider.closePullRequest
      && provider.readyPullRequestForReview
      && provider.rerunPullRequestVerification
    );
  }

  get operationPreflightEnabled(): boolean {
    return this.providers.some((provider) => supportsOperationPreflight(provider));
  }

  get repositoryAuditReadEnabled(): boolean {
    return Boolean(this.repositoryAuditProvider && this.workItemCandidateProvider);
  }

  get lifecycleAdvanceEnabled(): boolean {
    return Boolean(
      this.sourceControlMutationsEnabled
      && this.workItemCandidateProvider
      && this.pullRequestProvider
      && this.repositoryBootstrapProvider
      && this.deploymentProvider
    );
  }

  get lifecycleResumeEnabled(): boolean {
    return Boolean(this.sourceControlMutationsEnabled && this.pullRequestProvider);
  }

  get developmentStatusReadEnabled(): boolean {
    return Boolean(this.workItemCandidateProvider);
  }

  get workBootstrapReadEnabled(): boolean {
    return Boolean(this.workItemCandidateProvider);
  }

  get pullRequestReadEnabled(): boolean {
    return Boolean(this.pullRequestProvider);
  }

  get sourceDiscoveryReadEnabled(): boolean {
    return Boolean(this.sourceArtifactProvider?.discoverSource);
  }

  get sourceArtifactReadEnabled(): boolean {
    return Boolean(this.sourceArtifactProvider);
  }

  get ciReadEnabled(): boolean {
    return Boolean(this.ciReadProvider);
  }

  get deploymentReadEnabled(): boolean {
    return Boolean(this.deploymentProvider);
  }

  get vercelMutationEnabled(): boolean { return Boolean(this.deploymentProvider && this.mutationExecutor); }

  get workItemReadEnabled(): boolean {
    return Boolean(this.workItemProvider);
  }

  get workItemMutationsEnabled(): boolean {
    return Boolean(this.workItemProvider && this.mutationExecutor);
  }

  async capabilities(): Promise<ExecutionReceipt<CapabilityReport>> {
    return this.executeRead(
      'capabilities',
      { kind: 'runtime', id: 'conductor' },
      async () => {
        const capabilities: CapabilityAvailability[] = [];
        const providers: ProviderHealth[] = [];
        const diagnostics: ToolDiagnostic[] = [];

        for (const provider of this.providers) {
          try {
            const reported = await provider.getCapabilities();
            capabilities.push(...reported);
            const health = reported.some((capability) => capability.health === 'ready')
              ? reported.some((capability) => capability.health !== 'ready')
                ? 'degraded'
                : 'ready'
              : reported.some((capability) => capability.health === 'degraded')
                ? 'degraded'
                : 'unavailable';
            providers.push({ provider: provider.id, health });
          } catch (error) {
            const normalized = normalizeToolError(
              error,
              'TOOL_UNAVAILABLE',
              provider.id,
            );
            providers.push({
              provider: provider.id,
              health:
                normalized.code === 'TRANSIENT' ? 'degraded' : 'unavailable',
              error: normalized,
            });
            diagnostics.push(...normalized.diagnostics);
          }
        }

        capabilities.sort((left, right) =>
          left.capability.localeCompare(right.capability),
        );
        providers.sort((left, right) =>
          left.provider.localeCompare(right.provider),
        );

        return {
          result: {
            contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
            catalogVersion: TOOL_CATALOG_VERSION,
            catalogDigest: this.catalogDigest(),
            operations: this.operationDefinitions(),
            capabilities,
            providers,
          },
          diagnostics,
        };
      },
    );
  }

  async preflightOperation(input: GetOperationPreflightInput): Promise<ExecutionReceipt<OperationPreflight>> {
    const resolvedProject = this.projectResolver?.resolveProjectReference(input.project) ?? input.project;
    return await this.executeRead(
      'preflight_operation',
      { kind: 'project', id: resolvedProject.id, ref: resolvedProject.ref },
      async () => {
        const exposed = this.operationDefinitions().some((definition) => definition.name === input.operation);
        const checks: OperationPreflightCheck[] = [{
          provider: 'conductor',
          status: exposed ? 'ready' : 'blocked',
          summary: exposed
            ? `Operation ${input.operation} is exposed by this runtime`
            : `Operation ${input.operation} is not exposed by this runtime`,
          diagnostics: [],
          ...(exposed ? {} : {
            error: normalizeToolError({
              code: 'TOOL_UNAVAILABLE',
              message: `Operation ${input.operation} is not exposed by this runtime`,
            }, 'TOOL_UNAVAILABLE', 'conductor'),
          }),
        }];
        if (exposed) {
          let supportingProviders = 0;
          for (const provider of this.providers) {
            if (!supportsOperationPreflight(provider)) continue;
            try {
              const providerChecks = await provider.preflightOperation(resolvedProject, input.operation);
              if (providerChecks === undefined) continue;
              supportingProviders += 1;
              checks.push(...providerChecks);
            } catch (error) {
              supportingProviders += 1;
              const normalized = normalizeToolError(error, 'TOOL_UNAVAILABLE', provider.id);
              checks.push({
                provider: provider.id,
                status: normalized.code === 'TRANSIENT' ? 'degraded' : 'blocked',
                summary: normalized.message,
                error: normalized,
                diagnostics: normalized.diagnostics,
              });
            }
          }
          if (supportingProviders === 0 && input.operation === 'repository.acquire') {
            const summary = 'Repository acquisition requires repository.acquire.preflight with exact upstream, ref, and destination inputs; generic preflight_operation cannot evaluate those acquisition-specific facts.';
            checks.push({
              provider: 'conductor',
              status: 'blocked',
              summary,
              diagnostics: [{
                level: 'info',
                source: 'conductor',
                message: 'Use repository.acquire.preflight as the authoritative readiness check before repository.acquire.',
              }],
            });
          } else if (supportingProviders === 0 && !CORE_PREFLIGHT_OPERATIONS.has(input.operation)) {
            const error = normalizeToolError({
              code: 'TOOL_UNAVAILABLE',
              message: `No configured provider can preflight operation ${input.operation}`,
            }, 'TOOL_UNAVAILABLE', 'conductor');
            checks.push({
              provider: 'conductor',
              status: 'blocked',
              summary: error.message,
              error,
              diagnostics: error.diagnostics,
            });
          }
        }
        const status = checks.some((check) => check.status === 'blocked' || check.status === 'unavailable')
          ? 'blocked'
          : checks.some((check) => check.status === 'degraded')
            ? 'degraded'
            : 'ready';
        return {
          result: {
            contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
            project: resolvedProject,
            operation: input.operation,
            exposed,
            status,
            checks,
          },
        };
      },
    );
  }


  catalogDigest(): string {
    return createHash('sha256')
      .update(JSON.stringify({
        contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
        catalogVersion: TOOL_CATALOG_VERSION,
        operations: this.operationDefinitions()
          .map(({ name, mutates }) => ({ name, mutates }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      }))
      .digest('hex');
  }

  async workBootstrap(input: GetWorkBootstrapInput): Promise<ExecutionReceipt<WorkBootstrapProjection>> {
    const resolvedProject = this.projectResolver?.resolveProjectReference(input.project) ?? input.project;
    return await this.executeRead(
      'work.bootstrap',
      { kind: 'project', id: resolvedProject.id, ref: resolvedProject.ref },
      async () => {
        const startedAt = Date.now();
        const providerUsageBefore = this.captureProviderUsage();
        const development = await this.developmentStatus({ project: resolvedProject, limit: input.limit ?? 10 });
        if (development.status === 'failed') throw development.error;

        const catalogDigest = this.catalogDigest();
        const suppliedDigest = input.clientCatalogDigest?.trim().toLowerCase() || null;
        const freshness = suppliedDigest === null
          ? 'unknown'
          : suppliedDigest === catalogDigest
            ? 'current'
            : 'stale-client-schema';

        let topology = null;
        const diagnostics: ToolDiagnostic[] = [];
        if (this.repositoryBootstrapProvider) {
          try {
            topology = await this.repositoryBootstrapProvider.getRepositoryBootstrap(resolvedProject);
          } catch (error) {
            const normalized = normalizeToolError(error, 'TOOL_UNAVAILABLE', 'github');
            diagnostics.push(...normalized.diagnostics);
          }
        }

        let deployment: WorkBootstrapProjection['deployment'] = null;
        if (this.deploymentProvider) {
          try {
            const status = await this.deploymentProvider.getDeploymentStatus({ project: resolvedProject, limit: 3 });
            deployment = {
              provider: status.provider,
              projectId: status.project.id,
              projectName: status.project.name,
              teamId: status.project.teamId,
              productionBranch: status.project.productionBranch,
              production: status.production,
              observedAt: status.observedAt,
            };
          } catch (error) {
            const normalized = normalizeToolError(error, 'TOOL_UNAVAILABLE', 'vercel');
            diagnostics.push(...normalized.diagnostics);
          }
        }

        const intelligenceCheck = development.result.preflight.checks.find((check) => check.check === 'development-intelligence.read');
        const intelligence = intelligenceCheck
          ? { status: intelligenceCheck.status, summary: intelligenceCheck.summary }
          : { status: 'unavailable' as const, summary: 'Development Intelligence is not configured for this runtime' };

        return {
          result: {
            contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
            catalogVersion: TOOL_CATALOG_VERSION,
            catalogDigest,
            clientCatalog: { suppliedDigest, freshness },
            project: resolvedProject,
            topology,
            preflight: development.result.preflight,
            work: development.result.work,
            intelligence,
            deployment,
            elapsedMs: Math.max(0, Date.now() - startedAt),
            providerUsage: this.providerUsageDelta(providerUsageBefore),
            observedAt: this.now().toISOString(),
          },
          diagnostics: [
            ...diagnostics,
            ...(freshness === 'stale-client-schema' ? [{
              level: 'warning' as const,
              source: 'conductor',
              code: 'TOOL_UNAVAILABLE' as const,
              message: 'The connected client catalog digest differs from the current runtime; refresh/reconnect the client before treating absent tools as unavailable.',
            }] : []),
          ],
        };
      },
    );
  }



  async evidenceBundle(input: GetEvidenceBundleInput): Promise<ExecutionReceipt<EvidenceBundleProjection>> {
    const items = input.items ?? [];
    const concurrency = Math.min(Math.max(Math.trunc(input.concurrency ?? 3), 1), 4);
    return await this.executeRead(
      'evidence.bundle',
      { kind: 'runtime', id: 'conductor' },
      async () => {
        if (items.length < 1 || items.length > 12) {
          throw { code: 'CONFLICT', message: 'Evidence bundle requires between 1 and 12 items' };
        }
        const keys = new Set<string>();
        for (const item of items) {
          const key = item.key.trim();
          if (!/^[A-Za-z0-9._:/-]{1,100}$/u.test(key)) {
            throw { code: 'CONFLICT', message: `Invalid evidence bundle key: ${item.key}` };
          }
          if (keys.has(key)) throw { code: 'CONFLICT', message: `Duplicate evidence bundle key: ${key}` };
          keys.add(key);
        }

        const startedAt = Date.now();
        const providerUsageBefore = this.captureProviderUsage();
        const results = await boundedEvidenceMap(items, concurrency, async (item) =>
          await this.runEvidenceBundleItem(item)
        );
        const succeeded = results.filter((item) => item.status === 'succeeded').length;
        return {
          result: {
            contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
            concurrency,
            itemCount: results.length,
            succeeded,
            failed: results.length - succeeded,
            elapsedMs: Math.max(0, Date.now() - startedAt),
            providerUsage: this.providerUsageDelta(providerUsageBefore),
            items: results,
            note: 'Read-only bundle execution preserves input order, limits concurrency, performs no hidden retries, and keeps per-item failures explicit. Provider usage counts network calls, duplicate identical GET/HEAD reads within 30 seconds, known request-body bytes, Content-Length-reported response bytes, and responses whose byte size is unknown.',
          },
        };
      },
    );
  }

  private async runEvidenceBundleItem(item: EvidenceBundleItemInput): Promise<EvidenceBundleItemResult> {
    const startedAt = Date.now();
    const project = this.resolveProjectReference(item.project);
    try {
      if (item.operation === 'preflight_project') {
        const receipt = await this.preflightProject(project, item.intent ?? 'inspect');
        if (receipt.status === 'failed') return failedEvidenceBundleItem(item, project, receipt.error, startedAt);
        const result = receipt.result;
        return succeededEvidenceBundleItem(item, project, startedAt,
          `Project preflight is ${result.status} for ${project.repository ?? project.id}.`,
          { repository: project.repository },
          {
            intent: result.intent,
            status: result.status,
            checks: result.checks.map((check) => ({
              check: check.check,
              status: check.status,
              provider: check.provider,
              summary: check.summary,
            })),
          },
        );
      }
      if (item.operation === 'deployment.status') {
        const receipt = await this.deploymentStatus({ project, limit: Math.min(Math.max(item.limit ?? 5, 1), 10) });
        if (receipt.status === 'failed') return failedEvidenceBundleItem(item, project, receipt.error, startedAt);
        const result = receipt.result;
        return succeededEvidenceBundleItem(item, project, startedAt,
          `Deployment posture read for ${result.project.name}.`,
          { projectId: result.project.id, deploymentId: result.production?.id },
          {
            project: result.project,
            production: result.production ? compactDeployment(result.production) : null,
            latestProductionAttempt: result.latestProductionAttempt ? compactDeployment(result.latestProductionAttempt) : null,
            recent: result.recent.slice(0, Math.min(Math.max(item.limit ?? 5, 1), 10)).map(compactDeployment),
            observedAt: result.observedAt,
          },
        );
      }
      if (item.operation === 'deployment.runtime-logs') {
        const receipt = await this.deploymentRuntimeLogs({
          project,
          deploymentId: item.deploymentId,
          limit: Math.min(Math.max(item.limit ?? 20, 1), 20),
        });
        if (receipt.status === 'failed') return failedEvidenceBundleItem(item, project, receipt.error, startedAt);
        const result = receipt.result as Record<string, unknown>;
        const entries = Array.isArray(result.entries) ? result.entries.slice(0, 20) : [];
        return succeededEvidenceBundleItem(item, project, startedAt,
          `Runtime evidence read for deployment ${item.deploymentId}.`,
          { deploymentId: item.deploymentId, projectId: typeof result.projectId === 'string' ? result.projectId : undefined },
          {
            entries,
            truncated: result.truncated ?? false,
            source: result.source ?? null,
            observedAt: result.observedAt ?? null,
            coverage: result.coverage ?? null,
            note: result.note ?? null,
          },
        );
      }
      if (item.operation === 'pull-request.status') {
        const receipt = await this.pullRequestStatus({ project, pullRequestNumber: item.pullRequestNumber });
        if (receipt.status === 'failed') return failedEvidenceBundleItem(item, project, receipt.error, startedAt);
        const result = receipt.result;
        return succeededEvidenceBundleItem(item, project, startedAt,
          `PR #${result.pullRequestNumber} is ${result.orchestration.state}.`,
          { repository: result.repository, pullRequestNumber: result.pullRequestNumber, revision: result.head.sha },
          {
            state: result.state,
            draft: result.draft,
            merged: result.merged,
            head: result.head,
            base: result.base,
            checks: {
              total: result.checks.total,
              pending: result.checks.pending,
              successful: result.checks.successful,
              failed: result.checks.failed,
            },
            workflowRuns: result.workflowRuns.slice(0, 10).map((run) => ({
              id: run.id,
              name: run.name,
              status: run.status,
              conclusion: run.conclusion,
              historical: run.historical ?? false,
            })),
            orchestration: result.orchestration,
          },
        );
      }
      const receipt = await this.repositoryAudit({ project, limit: Math.min(Math.max(item.limit ?? 8, 1), 12) });
      if (receipt.status === 'failed') return failedEvidenceBundleItem(item, project, receipt.error, startedAt);
      const result = receipt.result;
      return succeededEvidenceBundleItem(item, project, startedAt,
        `Repository audit returned ${result.findings.length} provider-facts finding(s).`,
        { repository: result.github?.repository },
        {
          topology: result.github?.topology ?? null,
          work: result.work,
          deployment: {
            status: result.deployment.status,
            project: result.deployment.project?.project ?? null,
            production: result.deployment.project?.production ? compactDeployment(result.deployment.project.production) : null,
          },
          intelligence: {
            status: result.intelligence.status,
            summary: result.intelligence.summary,
          },
          findings: result.findings.slice(0, 12),
          observedAt: result.observedAt,
        },
      );
    } catch (error) {
      return failedEvidenceBundleItem(item, project, normalizeToolError(error), startedAt);
    }
  }

  async repositoryAudit(input: GetRepositoryAuditInput): Promise<ExecutionReceipt<RepositoryAuditProjection>> {
    const resolvedProject = this.projectResolver?.resolveProjectReference(input.project) ?? input.project;
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 12), 1), 20);
    return await this.executeRead(
      'repository.audit',
      { kind: 'project', id: resolvedProject.id, ref: resolvedProject.ref },
      async () => {
        const tasks = await Promise.allSettled([
          this.preflightProject(resolvedProject, 'inspect'),
          this.repositoryAuditProvider!.getRepositoryAudit({ project: resolvedProject, limit }),
          this.workItemCandidateProvider!.listWorkItems({ project: resolvedProject, limit: 100 }),
          this.deploymentProvider
            ? this.deploymentProvider.getDeploymentStatus({ project: resolvedProject, limit: Math.min(limit, 10) })
            : Promise.reject({ code: 'TOOL_UNAVAILABLE', message: 'Deployment provider is not configured' }),
          this.deploymentProvider
            ? this.deploymentProvider.getAudit({ project: resolvedProject })
            : Promise.reject({ code: 'TOOL_UNAVAILABLE', message: 'Deployment audit provider is not configured' }),
          this.intelligenceAuditProvider
            ? this.intelligenceAuditProvider.auditRepository(resolvedProject, limit)
            : Promise.reject({ code: 'TOOL_UNAVAILABLE', message: 'Development Intelligence semantic audit is not configured' }),
        ]);

        const [preflightSettled, githubSettled, workSettled, deploymentStatusSettled, deploymentAuditSettled, intelligenceSettled] = tasks;
        if (preflightSettled.status === 'rejected') throw preflightSettled.reason;
        const preflightReceipt = preflightSettled.value;
        if (preflightReceipt.status === 'failed') throw preflightReceipt.error;
        const preflight = preflightReceipt.result;

        const githubAudit = githubSettled.status === 'fulfilled' ? githubSettled.value : null;
        const workList = workSettled.status === 'fulfilled'
          ? workSettled.value
          : { repository: resolvedProject.repository ?? resolvedProject.id, items: [], truncated: false };
        const counts: DevelopmentStatusWorkCounts = {
          backlog: 0, ready: 0, inProgress: 0, blocked: 0, review: 0, done: 0, unknown: 0,
        };
        for (const item of workList.items) {
          if (item.status === 'in-progress') counts.inProgress += 1;
          else counts[item.status] += 1;
        }
        const unknownItems = workList.items.filter((item) =>
          item.status === 'unknown' || item.kind === 'unknown' || item.origin === 'unknown'
        );
        const hygiene = {
          unknownStatus: workList.items.filter((item) => item.status === 'unknown').length,
          unknownKind: workList.items.filter((item) => item.kind === 'unknown').length,
          unknownOrigin: workList.items.filter((item) => item.origin === 'unknown').length,
          sampleIssueNumbers: unknownItems.slice(0, 10).map((item) => item.issueNumber),
        };

        const findings: RepositoryAuditFinding[] = [];
        for (const check of preflight.checks) {
          if (check.status === 'ready') continue;
          findings.push({
            code: `capability.${check.check}`,
            source: check.provider,
            category: 'capability',
            state: check.status === 'blocked' ? 'blocked' : check.status === 'unavailable' ? 'unavailable' : 'attention',
            basis: 'provider-native',
            summary: check.summary,
            evidence: { check: check.check, status: check.status },
          });
        }

        if (githubAudit) {
          if (!githubAudit.topology.integrationBranch) {
            findings.push({
              code: 'topology.integration-branch-missing',
              source: 'github',
              category: 'topology',
              state: 'attention',
              basis: 'provider-native',
              summary: 'No Preview integration branch is present in the repository topology.',
              evidence: { defaultBranch: githubAudit.topology.defaultBranch },
            });
          }
          for (const pull of githubAudit.openPullRequests.items) {
            if (['verification-failed', 'action-required', 'merge-blocked'].includes(pull.orchestration.state)) {
              findings.push({
                code: 'pull-request.actionable',
                source: 'github',
                category: 'pull-request',
                state: 'attention',
                basis: 'conductor-derived',
                summary: `PR #${pull.pullRequestNumber} requires attention: ${pull.orchestration.summary}`,
                evidence: {
                  pullRequestNumber: pull.pullRequestNumber,
                  orchestrationState: pull.orchestration.state,
                  failedChecks: pull.checks.failed,
                },
              });
            }
          }
          const detached = githubAudit.developmentBranches.items.filter((branch) => branch.hasOpenPullRequest === false);
          if (detached.length) {
            findings.push({
              code: 'topology.development-branches-without-open-pr',
              source: 'github',
              category: 'topology',
              state: 'observed',
              basis: 'provider-native',
              summary: `${detached.length} sampled development branch(es) are proven to have no open pull request.`,
              evidence: { count: detached.length, truncated: githubAudit.developmentBranches.truncated },
            });
          }
        } else {
          const normalized = normalizeToolError(
            githubSettled.status === 'rejected' ? githubSettled.reason : {},
            'TOOL_UNAVAILABLE',
            'github',
          );
          findings.push({
            code: 'github.audit-unavailable',
            source: 'github',
            category: 'capability',
            state: 'unavailable',
            basis: 'provider-native',
            summary: normalized.message,
            evidence: {},
          });
        }

        if (hygiene.unknownStatus || hygiene.unknownKind || hygiene.unknownOrigin) {
          findings.push({
            code: 'work-item.classification-hygiene',
            source: 'github',
            category: 'work-item',
            state: 'attention',
            basis: 'conductor-derived',
            summary: 'One or more durable work items have unknown/conflicting normalized lifecycle or classification.',
            evidence: {
              unknownStatus: hygiene.unknownStatus,
              unknownKind: hygiene.unknownKind,
              unknownOrigin: hygiene.unknownOrigin,
            },
          });
        }

        const deploymentProject = deploymentStatusSettled.status === 'fulfilled' ? deploymentStatusSettled.value : null;
        const deploymentAudit = deploymentAuditSettled.status === 'fulfilled' ? deploymentAuditSettled.value : null;
        if (deploymentProject?.production && deploymentProject.production.state !== 'READY') {
          findings.push({
            code: 'deployment.production-not-ready',
            source: 'vercel',
            category: 'deployment',
            state: 'attention',
            basis: 'provider-native',
            summary: `Current production deployment state is ${deploymentProject.production.state ?? 'unknown'}.`,
            evidence: {
              deploymentId: deploymentProject.production.id,
              state: deploymentProject.production.state,
            },
          });
        }

        const intelligenceAudit = intelligenceSettled.status === 'fulfilled' ? intelligenceSettled.value : null;
        let intelligenceStatus: RepositoryAuditProjection['intelligence']['status'] = intelligenceAudit ? 'ready' : 'unavailable';
        let intelligenceSummary = intelligenceAudit
          ? 'Development Intelligence semantic audit is available as a separate evidence plane.'
          : 'Development Intelligence semantic audit is unavailable; provider-facts audit remains valid.';
        if (!intelligenceAudit) {
          const check = preflight.checks.find((item) => item.check === 'development-intelligence.read');
          if (check?.status === 'degraded') intelligenceStatus = 'degraded';
          if (check?.summary) intelligenceSummary = check.summary;
        }

        return {
          result: {
            contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
            project: resolvedProject,
            preflight,
            github: githubAudit,
            work: { counts, hygiene, truncated: workList.truncated },
            deployment: {
              status: deploymentProject || deploymentAudit ? 'ready' : 'unavailable',
              project: deploymentProject,
              audit: deploymentAudit,
              summary: deploymentProject || deploymentAudit
                ? 'Deployment/provider posture was read from the configured Vercel adapter.'
                : 'No deployment/provider audit evidence is available for this project.',
            },
            intelligence: {
              status: intelligenceStatus,
              audit: intelligenceAudit,
              summary: intelligenceSummary,
            },
            findings,
            observedAt: this.now().toISOString(),
          },
          diagnostics: [],
        };
      },
    );
  }

  async developmentStatus(input: GetDevelopmentStatusInput): Promise<ExecutionReceipt<DevelopmentStatusProjection>> {
    const resolvedProject = this.projectResolver?.resolveProjectReference(input.project) ?? input.project;
    return await this.executeRead(
      'development.status',
      { kind: 'project', id: resolvedProject.id, ref: resolvedProject.ref },
      async () => {
        const provider = this.workItemCandidateProvider;
        if (!provider) throw { code: 'TOOL_UNAVAILABLE', message: 'Development status provider is not configured' };

        const preflightReceipt = await this.preflightProject(resolvedProject, 'inspect');
        if (preflightReceipt.status === 'failed') throw preflightReceipt.error;

        const listed = await provider.listWorkItems({ project: resolvedProject, limit: 100 });
        const counts: DevelopmentStatusWorkCounts = {
          backlog: 0, ready: 0, inProgress: 0, blocked: 0, review: 0, done: 0, unknown: 0,
        };
        for (const item of listed.items) {
          if (item.status === 'in-progress') counts.inProgress += 1;
          else counts[item.status] += 1;
        }

        const limit = Math.min(Math.max(input.limit ?? 25, 1), 50);
        const active = listed.items.filter((item) =>
          ['ready', 'in-progress', 'blocked', 'review'].includes(item.status)
        );
        const projected = await boundedEvidenceMap(
          active.slice(0, limit),
          4,
          async (workItem): Promise<DevelopmentStatusWorkItem> => {
            const candidates = await provider.listWorkItemPullRequests({
              project: resolvedProject,
              issueNumber: workItem.issueNumber,
            });
            const artifacts = candidates.map((pullRequest) => ({
              role: lifecycleTransportRole(pullRequest),
              pullRequest,
            }));
            const promotion = artifacts.find((artifact) => artifact.role === 'main-promotion');
            const previewIntegration = artifacts.find((artifact) => artifact.role === 'preview-integration');
            const lifecycleStage = promotion
              ? 'main-promotion' as const
              : previewIntegration?.pullRequest.merged
                ? 'preview-integrated' as const
                : previewIntegration
                  ? 'preview-integration' as const
                  : 'implementation' as const;
            return { workItem, lifecycleStage, candidates, artifacts };
          },
        );

        return {
          result: {
            contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
            project: resolvedProject,
            preflight: preflightReceipt.result,
            work: {
              counts,
              ready: projected.filter((item) => item.workItem.status === 'ready'),
              inProgress: projected.filter((item) => item.workItem.status === 'in-progress'),
              blocked: projected.filter((item) => item.workItem.status === 'blocked'),
              review: projected.filter((item) => item.workItem.status === 'review'),
              truncated: listed.truncated || active.length > limit,
            },
          },
        };
      },
    );
  }

  async pullRequestStatus(input: GetPullRequestStatusInput): Promise<ExecutionReceipt<PullRequestStatus>> {
    const resolvedProject = this.projectResolver?.resolveProjectReference(input.project) ?? input.project;
    return await this.executeRead(
      'pull-request.status',
      { kind: 'project', id: resolvedProject.id, ref: resolvedProject.ref },
      async () => {
        if (!this.pullRequestProvider) throw { code: 'TOOL_UNAVAILABLE', message: 'Pull-request read provider is not configured' };
        return { result: await this.pullRequestProvider.getPullRequestStatus({ ...input, project: resolvedProject }) };
      },
    );
  }


  async sourceDiscover(input: DiscoverSourceInput): Promise<ExecutionReceipt<SourceDiscoveryResult>> {
    const resolvedProject = this.projectResolver?.resolveProjectReference(input.project) ?? input.project;
    return await this.executeRead(
      'source.discover',
      { kind: 'repository', id: resolvedProject.repository ?? resolvedProject.id, ref: input.sha },
      async () => {
        if (!this.sourceArtifactProvider?.discoverSource) {
          throw { code: 'TOOL_UNAVAILABLE', message: 'Source discovery provider is not configured' };
        }
        return { result: await this.sourceArtifactProvider.discoverSource({ ...input, project: resolvedProject }) };
      },
    );
  }

  async sourceArtifactRead(input: GetSourceArtifactInput): Promise<ExecutionReceipt<SourceArtifactRead>> {
    const resolvedProject = this.projectResolver?.resolveProjectReference(input.project) ?? input.project;
    return await this.executeRead(
      'source.artifact.read',
      { kind: 'repository', id: resolvedProject.repository ?? resolvedProject.id, ref: input.sha },
      async () => {
        if (!this.sourceArtifactProvider) throw { code: 'TOOL_UNAVAILABLE', message: 'Source-artifact read provider is not configured' };
        return { result: await this.sourceArtifactProvider.getSourceArtifact({ ...input, project: resolvedProject }) };
      },
    );
  }

  async ciRunRead(input: GetCiRunEvidenceInput): Promise<ExecutionReceipt<CiRunEvidence>> {
    const resolvedProject = this.projectResolver?.resolveProjectReference(input.project) ?? input.project;
    return await this.executeRead(
      'ci.run.read',
      { kind: 'repository', id: resolvedProject.repository ?? resolvedProject.id, ref: input.expectedHeadSha },
      async () => {
        if (!this.ciReadProvider) throw { code: 'TOOL_UNAVAILABLE', message: 'CI read provider is not configured' };
        return {
          result: await this.ciReadProvider.getCiRunEvidence({ ...input, project: resolvedProject }),
          diagnostics: [{ level: 'info', source: 'github', message: 'CI log excerpts are bounded and redacted before leaving the provider adapter.' }],
        };
      },
    );
  }

  async deploymentStatus(input: GetDeploymentStatusInput): Promise<ExecutionReceipt<DeploymentProjectStatus>> {
    const resolvedProject = this.projectResolver?.resolveProjectReference(input.project) ?? input.project;
    return await this.executeRead(
      'deployment.status',
      { kind: 'project', id: resolvedProject.id, ref: resolvedProject.ref },
      async () => {
        if (!this.deploymentProvider) throw { code: 'TOOL_UNAVAILABLE', message: 'Deployment read provider is not configured' };
        return { result: await this.deploymentProvider.getDeploymentStatus({ ...input, project: resolvedProject }) };
      },
    );
  }

  async deploymentLogs(input: GetDeploymentLogsInput): Promise<ExecutionReceipt<DeploymentLogs>> {
    const resolvedProject = this.projectResolver?.resolveProjectReference(input.project) ?? input.project;
    return await this.executeRead(
      'deployment.logs',
      { kind: 'project', id: resolvedProject.id, ref: resolvedProject.ref },
      async () => {
        if (!this.deploymentProvider) throw { code: 'TOOL_UNAVAILABLE', message: 'Deployment read provider is not configured' };
        return {
          result: await this.deploymentProvider.getDeploymentLogs({ ...input, project: resolvedProject }),
          diagnostics: [{ level: 'info', source: 'vercel', message: 'Deployment logs are bounded and redacted before leaving the provider adapter.' }],
        };
      },
    );
  }



  private async vercelRead<Result>(operation: ToolOperationName, input: VercelProjectInput, read: (provider: VercelOperationsProvider, project: ProjectReference) => Promise<Result>): Promise<ExecutionReceipt<Result>> {
    const project = this.resolveProjectReference(input.project);
    return this.executeRead(operation, { kind: 'project', id: project.id, ref: project.ref }, async () => {
      if (!this.deploymentProvider) throw { code: 'TOOL_UNAVAILABLE', message: 'Vercel provider is not configured' };
      return { result: await read(this.deploymentProvider, project) };
    });
  }
  async deploymentAudit(input: VercelProjectInput) { return this.vercelRead('deployment.audit', input, (provider, project) => provider.getAudit({ project })); }
  async deploymentRuntimeLogs(input: VercelRuntimeLogsInput) { return this.vercelRead('deployment.runtime-logs', input, (provider, project) => provider.getRuntimeLogs({ ...input, project })); }
  async deploymentEnvironmentList(input: VercelReadProjectInput) { return this.vercelRead('deployment.env.list', input, (provider, project) => provider.listEnvironment({ ...input, project })); }
  async deploymentVcrGet(input: VercelVcrRepositoryInput) { return this.vercelRead('deployment.vcr.get', input, (provider, project) => provider.getVcrRepository({ ...input, project })); }

  private async vercelMutation<Result>(operation: import('./types.js').MutationOperationName, input: VercelProjectInput & { idempotencyKey: string }, mutate: (provider: VercelOperationsProvider, project: ProjectReference) => Promise<Result>): Promise<ExecutionReceipt<Result>> {
    const project = this.resolveProjectReference(input.project);
    if (!/^[A-Za-z0-9._:/-]{8,200}$/u.test(input.idempotencyKey)) throw new Error('Invalid idempotency key');
    if (!this.mutationExecutor || !this.deploymentProvider) throw { code: 'TOOL_UNAVAILABLE', message: 'Vercel mutations require a provider and durable idempotency' };
    return this.mutationExecutor.execute({
      key: input.idempotencyKey, fingerprint: mutationFingerprint(operation, { ...input, project }), operation,
      target: { kind: 'project', id: project.id, ref: project.ref },
    }, async () => {
      const result = await mutate(this.deploymentProvider!, project);
      return { result, identifiers: typeof (result as Record<string, unknown>).deploymentId === 'string' ? { deploymentId: (result as Record<string, string>).deploymentId } : undefined };
    });
  }
  async vercelRedeploy(input: VercelDeploymentInput) { return this.vercelMutation('deployment.redeploy', input, (provider, project) => provider.redeploy({ ...input, project })); }
  async vercelCreateGitDeployment(input: VercelGitDeploymentInput) { return this.vercelMutation('deployment.git.create', input, (provider, project) => provider.createGitDeployment({ ...input, project })); }
  async vercelPromote(input: VercelDeploymentInput) { return this.vercelMutation('deployment.promote', input, (provider, project) => provider.promote({ ...input, project })); }
  async vercelRollback(input: VercelDeploymentInput) { return this.vercelMutation('deployment.rollback', input, (provider, project) => provider.rollback({ ...input, project })); }
  async vercelDeleteDeployment(input: VercelDeploymentInput) { return this.vercelMutation('deployment.delete', input, (provider, project) => provider.deleteDeployment({ ...input, project })); }
  async vercelEnvUpsert(input: VercelEnvInput) { return this.vercelMutation('deployment.env.upsert', input, (provider, project) => provider.upsertEnvironment({ ...input, project })); }
  async vercelEnvUpdate(input: VercelEnvEditInput) { return this.vercelMutation('deployment.env.update', input, (provider, project) => provider.updateEnvironment({ ...input, project })); }
  async vercelEnvRemove(input: VercelEnvRemoveInput) { return this.vercelMutation('deployment.env.remove', input, (provider, project) => provider.removeEnvironment({ ...input, project })); }
  async vercelVcrCreate(input: VercelVcrCreateInput) { return this.vercelMutation('deployment.vcr.create', input, (provider, project) => provider.createVcrRepository({ ...input, project })); }

  async workItemStatus(input: GetWorkItemStatusInput): Promise<ExecutionReceipt<WorkItemRecord>> {
    const resolvedProject = this.projectResolver?.resolveProjectReference(input.project) ?? input.project;
    return await this.executeRead(
      'work-item.status',
      { kind: 'project', id: resolvedProject.id, ref: resolvedProject.ref },
      async () => {
        if (!this.workItemProvider) throw { code: 'TOOL_UNAVAILABLE', message: 'Work-item provider is not configured' };
        return { result: await this.workItemProvider.getWorkItemStatus({ ...input, project: resolvedProject }) };
      },
    );
  }

  async listWorkItems(input: ListWorkItemsInput): Promise<ExecutionReceipt<WorkItemList>> {
    const resolvedProject = this.projectResolver?.resolveProjectReference(input.project) ?? input.project;
    return await this.executeRead(
      'work-item.list',
      { kind: 'project', id: resolvedProject.id, ref: resolvedProject.ref },
      async () => {
        if (!this.workItemProvider) throw { code: 'TOOL_UNAVAILABLE', message: 'Work-item provider is not configured' };
        return { result: await this.workItemProvider.listWorkItems({ ...input, project: resolvedProject }) };
      },
    );
  }


  async createWorkItem(input: CreateWorkItemInput) {
    return await this.executeWorkItemMutation(input, 'work-item.create', async (provider) => {
      const result = await provider.createWorkItem(input);
      return { result, identifiers: { issueNumber: result.issueNumber } };
    });
  }

  async commentWorkItem(input: CommentWorkItemInput) {
    return await this.executeWorkItemMutation(input, 'work-item.comment.create', async (provider) => {
      const result = await provider.commentWorkItem(input);
      return { result, identifiers: { issueNumber: result.issueNumber, commentId: result.commentId } };
    });
  }

  async updateWorkItemStatus(input: UpdateWorkItemStatusInput) {
    return await this.executeWorkItemMutation(input, 'work-item.update-status', async (provider) => {
      const result = await provider.updateWorkItemStatus(input);
      return { result, identifiers: { issueNumber: result.issueNumber } };
    });
  }

  async updateWorkItemClassification(input: UpdateWorkItemClassificationInput) {
    return await this.executeWorkItemMutation(input, 'work-item.classification.update', async (provider) => {
      const result = await provider.updateWorkItemClassification(input);
      return { result, identifiers: { issueNumber: result.issueNumber } };
    });
  }

  async updateWorkItemTriage(input: UpdateWorkItemTriageInput) {
    return await this.executeWorkItemMutation(input, 'work-item.triage.update', async (provider) => {
      const result = await provider.updateWorkItemTriage(input);
      return { result, identifiers: { issueNumber: result.issueNumber } };
    });
  }

  async repositoryAcquisitionPreflight(input: RepositoryAcquisitionPreflightInput): Promise<ExecutionReceipt<RepositoryAcquisitionPreflight>> {
    return await this.executeRead(
      'repository.acquire.preflight',
      { kind: 'repository', id: `${input.destinationOwner}/${input.destinationRepository}` },
      async () => {
        if (!this.repositoryAcquisitionProvider) throw { code: 'TOOL_UNAVAILABLE', message: 'Repository acquisition is not configured' };
        return { result: await this.repositoryAcquisitionProvider.preflightRepositoryAcquisition(input) };
      },
    );
  }

  async acquireRepository(input: AcquireRepositoryInput): Promise<ExecutionReceipt<RepositoryAcquisitionResult>> {
    if (!this.repositoryAcquisitionProvider || !this.mutationExecutor) {
      const executor = new IdempotentMutationExecutor({
        store: {
          async claim() { throw { code: 'TOOL_UNAVAILABLE', message: 'Repository acquisition is not enabled' }; },
          async complete() {},
        },
        createOperationId: this.createOperationId,
        now: this.now,
      });
      return await executor.execute({
        key: input.idempotencyKey,
        fingerprint: mutationFingerprint('repository.acquire', input),
        operation: 'repository.acquire',
        target: { kind: 'repository', id: `${input.destinationOwner}/${input.destinationRepository}` },
      }, async () => { throw { code: 'TOOL_UNAVAILABLE', message: 'Repository acquisition is not enabled' }; });
    }
    if (!/^[A-Za-z0-9._:/-]{8,200}$/.test(input.idempotencyKey)) {
      throw new Error('idempotencyKey must be 8-200 stable URL-safe characters');
    }
    return await this.mutationExecutor.execute({
      key: input.idempotencyKey,
      fingerprint: mutationFingerprint('repository.acquire', input),
      operation: 'repository.acquire',
      target: { kind: 'repository', id: `${input.destinationOwner}/${input.destinationRepository}` },
    }, async () => {
      const result = await this.repositoryAcquisitionProvider!.acquireRepository(input);
      return { result, identifiers: { commitSha: result.commitSha } };
    });
  }


  async advanceLifecycle(input: AdvanceLifecycleInput): Promise<ExecutionReceipt<LifecycleAdvanceProjection>> {
    const project = this.resolveProjectReference(input.project);
    const maxPolls = Math.min(Math.max(Math.trunc(input.maxPolls ?? 2), 0), 4);
    const pollIntervalMs = Math.min(Math.max(Math.trunc(input.pollIntervalMs ?? 500), 0), 1500);
    return await this.executeCompositeMutation('lifecycle.advance', project, async () => {
      if (!this.lifecycleAdvanceEnabled) throw { code: 'TOOL_UNAVAILABLE', message: 'Lifecycle advance requires GitHub work/PR mutation, topology, and deployment providers' };
      if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) throw { code: 'CONFLICT', message: 'issueNumber must be a positive integer' };
      if (!/^[A-Za-z0-9._:/-]{8,200}$/u.test(input.idempotencyKey)) throw { code: 'CONFLICT', message: 'idempotencyKey must be 8-200 stable URL-safe characters' };

      const transitions: LifecycleTransitionRecord[] = [];
      const work = await this.workItemCandidateProvider!.getWorkItemStatus({ project, issueNumber: input.issueNumber });
      if (work.status === 'done' || work.state === 'closed') return lifecycleProjection(project, input.issueNumber, 'complete', 'Canonical work item is already complete.', transitions);

      const candidates = await this.workItemCandidateProvider!.listWorkItemPullRequests({ project, issueNumber: input.issueNumber });
      const artifacts = candidates.map((pullRequest) => ({ role: lifecycleTransportRole(pullRequest), pullRequest }));
      const openPromotions = artifacts.filter((item) => item.role === 'main-promotion' && item.pullRequest.state === 'open' && !item.pullRequest.merged);
      if (openPromotions.length > 1) throw { code: 'CONFLICT', message: 'Multiple open Preview-to-Main promotion pull requests are linked to the same canonical work item' };

      const pollPull = async (initial: PullRequestStatus): Promise<PullRequestStatus> => {
        let current = initial;
        for (let attempt = 0; attempt < maxPolls && current.orchestration.state === 'external-gate-pending'; attempt++) {
          if (pollIntervalMs > 0) await lifecycleDelay(pollIntervalMs);
          current = await this.pullRequestProvider!.getPullRequestStatus({
            project,
            pullRequestNumber: current.pullRequestNumber,
            previous: { headSha: current.head.sha, orchestrationState: current.orchestration.state },
          });
        }
        return current;
      };

      const stopForPull = (pull: PullRequestStatus, humanPromotion = false): LifecycleAdvanceProjection | null => {
        if (pull.merged || pull.orchestration.state === 'merged') {
          return humanPromotion ? lifecycleProjection(project, input.issueNumber, 'complete', 'Promotion pull request is already merged.', transitions) : null;
        }
        if (humanPromotion && pull.orchestration.state === 'promotion-ready') {
          const gate: LifecycleGateSpec = {
            kind: 'human-approval', allowedNextOperation: 'lifecycle.resume', issueNumber: input.issueNumber,
            summary: `Preview candidate PR #${pull.pullRequestNumber} is technically verified and requires explicit owner approval before Main promotion.`,
            resumeWhen: 'The owner explicitly approves this exact promotion candidate.',
            pullRequestNumber: pull.pullRequestNumber, expectedHeadSha: pull.head.sha, expectedBaseSha: pull.base.sha,
          };
          return lifecycleProjection(project, input.issueNumber, 'human-gate', gate.summary, transitions, null, gate);
        }
        if (pull.orchestration.state === 'external-gate-pending') {
          const gate: LifecycleGateSpec = {
            kind: 'external-wait', allowedNextOperation: 'lifecycle.advance', issueNumber: input.issueNumber,
            summary: pull.orchestration.summary, resumeWhen: pull.orchestration.resumeWhen ?? 'The provider gate changes.',
            pullRequestNumber: pull.pullRequestNumber, expectedHeadSha: pull.head.sha, expectedBaseSha: pull.base.sha,
          };
          return lifecycleProjection(project, input.issueNumber, 'external-wait', gate.summary, transitions, null, gate);
        }
        if (['verification-failed', 'action-required', 'merge-blocked', 'sealed-head-verification-required', 'pre-seal-checkpoint', 'draft'].includes(pull.orchestration.state)) {
          return lifecycleProjection(project, input.issueNumber, 'verification-failed', `PR #${pull.pullRequestNumber} stopped at ${pull.orchestration.state}: ${pull.orchestration.summary}`, transitions);
        }
        return null;
      };

      if (openPromotions.length === 1) {
        const promotion = await pollPull(openPromotions[0]!.pullRequest);
        const stop = stopForPull(promotion, true);
        if (stop) return stop;
      }

      const openIntegrations = artifacts.filter((item) => item.role === 'preview-integration' && item.pullRequest.state === 'open' && !item.pullRequest.merged);
      if (openIntegrations.length > 1) throw { code: 'CONFLICT', message: 'Multiple open work-to-Preview pull requests are linked to the same canonical work item' };

      let integrationMergeSha: string | null = null;
      const mergedIntegrations = artifacts.filter((item) => item.role === 'preview-integration' && item.pullRequest.merged);
      if (openIntegrations.length === 1) {
        const integration = await pollPull(openIntegrations[0]!.pullRequest);
        const stop = stopForPull(integration, false);
        if (stop) return stop;
        if (integration.orchestration.state !== 'integration-ready') return lifecycleProjection(project, input.issueNumber, 'action-required', `Integration PR #${integration.pullRequestNumber} is not in a deterministic integration-ready state.`, transitions);
        const merged = await this.mergeIntegrationPullRequest({
          project, pullRequestNumber: integration.pullRequestNumber, expectedHeadSha: integration.head.sha, expectedBaseSha: integration.base.sha,
          idempotencyKey: lifecycleSubkey(input.idempotencyKey, `integrate:${integration.pullRequestNumber}:${integration.head.sha}`),
        });
        if (merged.status === 'failed') throw merged.error;
        integrationMergeSha = merged.result.mergeCommitSha;
        transitions.push({ operation: 'pull-request.merge.integration', status: merged.idempotency?.replayed ? 'replayed' : 'performed', summary: `Integrated PR #${integration.pullRequestNumber} into ${integration.base.ref}.`, pullRequestNumber: integration.pullRequestNumber, mergeCommitSha: merged.result.mergeCommitSha });
      }

      const topology = await this.repositoryBootstrapProvider!.getRepositoryBootstrap(project);
      if (!topology.integrationBranch || !topology.integrationHead) throw { code: 'CONFLICT', message: 'Repository has no exact Preview integration branch after integration' };
      if (integrationMergeSha && topology.integrationHead !== integrationMergeSha) throw { code: 'CONFLICT', message: `Preview moved from expected integration merge ${integrationMergeSha} to ${topology.integrationHead}; refusing to infer the promotion candidate` };

      const alreadyPromoted = artifacts.find((item) =>
        item.role === 'main-promotion'
        && item.pullRequest.merged
        && item.pullRequest.head.sha === topology.integrationHead
      );
      if (alreadyPromoted) {
        transitions.push({
          operation: 'pull-request.status',
          status: 'observed',
          summary: `Current Preview head ${topology.integrationHead} was already promoted by PR #${alreadyPromoted.pullRequest.pullRequestNumber}.`,
          pullRequestNumber: alreadyPromoted.pullRequest.pullRequestNumber,
          commitSha: topology.integrationHead,
        });
        return lifecycleProjection(
          project,
          input.issueNumber,
          'complete',
          `Current Preview head ${topology.integrationHead} is already represented by merged promotion PR #${alreadyPromoted.pullRequest.pullRequestNumber}; no duplicate promotion is required.`,
          transitions,
        );
      }

      if (openIntegrations.length === 0) {
        if (mergedIntegrations.length === 0) return lifecycleProjection(project, input.issueNumber, 'action-required', 'No linked work-to-Preview pull request exists for this canonical work item.', transitions);
        if (mergedIntegrations.length > 1) throw { code: 'CONFLICT', message: 'Multiple merged integration pull requests are linked to this work item; exact continuation is ambiguous' };
        transitions.push({ operation: 'pull-request.status', status: 'observed', summary: `Integration PR #${mergedIntegrations[0]!.pullRequest.pullRequestNumber} is already merged.`, pullRequestNumber: mergedIntegrations[0]!.pullRequest.pullRequestNumber });
      }

      let previewDeployment: import('./types.js').DeploymentRecord | null = null;
      for (let attempt = 0; attempt <= maxPolls; attempt++) {
        const status = await this.deploymentProvider!.getDeploymentStatus({ project, limit: 20 });
        const matching = status.recent.find((deployment) => deployment.sourceRevision === topology.integrationHead && deployment.sourceRef?.toLowerCase() === topology.integrationBranch!.toLowerCase()) ?? null;
        if (matching?.state === 'READY') { previewDeployment = matching; break; }
        if (matching && lifecycleDeploymentFailed(matching.state)) {
          return lifecycleProjection(project, input.issueNumber, 'verification-failed', `Preview deployment ${matching.id} settled in ${matching.state ?? 'unknown'} state.`, transitions, { branch: topology.integrationBranch, commitSha: topology.integrationHead, deploymentId: matching.id, state: matching.state ?? 'unknown' });
        }
        if (attempt < maxPolls && pollIntervalMs > 0) await lifecycleDelay(pollIntervalMs);
        if (attempt === maxPolls) {
          const gate: LifecycleGateSpec = {
            kind: 'external-wait', allowedNextOperation: 'lifecycle.advance', issueNumber: input.issueNumber,
            summary: `Preview deployment for ${topology.integrationBranch}@${topology.integrationHead} has not reached READY within the bounded wait budget.`,
            resumeWhen: 'A deployment for the exact Preview head appears or changes state.',
            integrationBranch: topology.integrationBranch, integrationHead: topology.integrationHead, ...(matching ? { deploymentId: matching.id } : {}),
          };
          return lifecycleProjection(project, input.issueNumber, 'external-wait', gate.summary, transitions, null, gate);
        }
      }

      transitions.push({ operation: 'deployment.status', status: 'observed', summary: `Preview deployment ${previewDeployment!.id} is READY for exact head ${topology.integrationHead}.`, commitSha: topology.integrationHead, deploymentId: previewDeployment!.id });
      const previewProof = { branch: topology.integrationBranch, commitSha: topology.integrationHead, deploymentId: previewDeployment!.id, state: previewDeployment!.state ?? 'READY' };

      let promotion = openPromotions[0]?.pullRequest ?? null;
      if (!promotion) {
        const created = await this.createPullRequest({
          project, head: topology.integrationBranch, base: topology.defaultBranch,
          title: `Promote ${topology.integrationBranch} for #${input.issueNumber}`,
          body: `Prepared by lifecycle.advance after exact Preview proof for canonical work #${input.issueNumber}.`,
          workItemNumbers: [input.issueNumber],
          idempotencyKey: lifecycleSubkey(input.idempotencyKey, `promotion-pr:${topology.integrationHead}`),
        });
        if (created.status === 'failed') throw created.error;
        transitions.push({ operation: 'pull-request.create', status: created.idempotency?.replayed ? 'replayed' : 'performed', summary: `Prepared Preview-to-Main promotion PR #${created.result.pullRequestNumber}.`, pullRequestNumber: created.result.pullRequestNumber });
        promotion = await this.pullRequestProvider!.getPullRequestStatus({ project, pullRequestNumber: created.result.pullRequestNumber });
      }
      promotion = await pollPull(promotion);
      const promotionStop = stopForPull(promotion, true);
      if (promotionStop) return { ...promotionStop, previewProof };
      return lifecycleProjection(project, input.issueNumber, 'action-required', `Promotion PR #${promotion.pullRequestNumber} reached unsupported orchestration state ${promotion.orchestration.state}.`, transitions, previewProof);
    });
  }

  async resumeLifecycle(input: ResumeLifecycleInput): Promise<ExecutionReceipt<LifecycleAdvanceProjection>> {
    const project = this.resolveProjectReference(input.project);
    return await this.executeCompositeMutation('lifecycle.resume', project, async () => {
      if (!this.lifecycleResumeEnabled) throw { code: 'TOOL_UNAVAILABLE', message: 'Lifecycle resume requires GitHub PR mutation/read providers' };
      if (!input.approvalReference.startsWith('owner-approved:')) throw { code: 'PERMISSION_DENIED', message: 'Lifecycle resume requires a fresh owner-approved: approval reference' };
      const current = await this.pullRequestProvider!.getPullRequestStatus({ project, pullRequestNumber: input.pullRequestNumber });
      if (current.head.sha !== input.expectedHeadSha || current.base.sha !== input.expectedBaseSha) throw { code: 'CONFLICT', message: 'Signed lifecycle gate candidate no longer matches the current pull-request head/base' };
      if (current.orchestration.state !== 'promotion-ready') throw { code: 'CONFLICT', message: `Promotion candidate is no longer promotion-ready; current state is ${current.orchestration.state}` };
      const promoted = await this.promotePullRequest({
        project, pullRequestNumber: input.pullRequestNumber, expectedHeadSha: input.expectedHeadSha, expectedBaseSha: input.expectedBaseSha,
        approvalReference: input.approvalReference,
        overrideBlockerIssueNumbers: input.overrideBlockerIssueNumbers,
        mergeMethod: 'merge',
        idempotencyKey: lifecycleSubkey(input.idempotencyKey, `promote:${input.gateId}:${input.pullRequestNumber}`),
      });
      if (promoted.status === 'failed') throw promoted.error;
      const transitions: LifecycleTransitionRecord[] = [{ operation: 'pull-request.merge.promote', status: promoted.idempotency?.replayed ? 'replayed' : 'performed', summary: `Promoted exact approved PR #${input.pullRequestNumber} to Main.`, pullRequestNumber: input.pullRequestNumber, mergeCommitSha: promoted.result.mergeCommitSha }];
      return lifecycleProjection(project, input.issueNumber, 'complete', `Exact approved promotion completed as ${promoted.result.mergeCommitSha}.`, transitions);
    });
  }

  private async executeCompositeMutation(
    operation: 'lifecycle.advance' | 'lifecycle.resume',
    project: ProjectReference,
    run: () => Promise<LifecycleAdvanceProjection>,
  ): Promise<ExecutionReceipt<LifecycleAdvanceProjection>> {
    const operationId = this.createOperationId();
    const startedAt = this.now().toISOString();
    const startedAtMs = Date.now();
    const providerUsageBefore = this.captureProviderUsage();
    try {
      const result = await run();
      const measured = {
        ...result,
        elapsedMs: Math.max(0, Date.now() - startedAtMs),
        providerUsage: this.providerUsageDelta(providerUsageBefore),
      };
      return { contractVersion: TOOL_RUNTIME_CONTRACT_VERSION, operationId, operation, target: { kind: 'project', id: project.id, ref: project.ref }, status: 'succeeded', startedAt, finishedAt: this.now().toISOString(), result: measured, diagnostics: [{ level: 'info', source: 'conductor', message: 'Composite lifecycle effects retain durable idempotency in each underlying mutation substep; the composite re-reads provider state on retry. Provider usage is measured as the operation-local delta from configured provider counters.' }] };
    } catch (error) {
      const normalized = normalizeToolError(error);
      return { contractVersion: TOOL_RUNTIME_CONTRACT_VERSION, operationId, operation, target: { kind: 'project', id: project.id, ref: project.ref }, status: 'failed', startedAt, finishedAt: this.now().toISOString(), error: normalized, diagnostics: normalized.diagnostics };
    }
  }

  async createBranch(input: CreateBranchInput) {
    return await this.executeMutation(input, 'git.branch.create', async (provider) => {
      const result = await provider.createBranch(input);
      return { result, identifiers: { branch: result.branch, commitSha: result.commitSha } };
    });
  }

  async bootstrapIntegrationBranch(input: BootstrapIntegrationBranchInput) {
    return await this.executeMutation(input, 'git.integration.bootstrap', async (provider) => {
      const result = await provider.bootstrapIntegrationBranch(input);
      return {
        result,
        identifiers: { branch: result.branch, commitSha: result.commitSha },
      };
    });
  }

  async deleteBranch(input: DeleteBranchInput) {
    return await this.executeMutation(input, 'git.branch.delete', async (provider) => {
      const result = await provider.deleteBranch(input);
      return { result, identifiers: { branch: result.branch, commitSha: result.commitSha } };
    });
  }

  async createCommit(input: CreateCommitInput) {
    return await this.executeMutation(input, 'git.commit.create', async (provider) => {
      const result = await provider.createCommit(input);
      return { result, identifiers: { branch: result.branch, commitSha: result.commitSha } };
    });
  }

  async createWorkflowCommit(input: CreateWorkflowCommitInput) {
    return await this.executeMutation(input, 'git.workflow.commit', async (provider) => {
      if (!provider.createWorkflowCommit) throw { code: 'TOOL_UNAVAILABLE', message: 'GitHub Actions workflow authoring is not enabled' };
      const result = await provider.createWorkflowCommit(input);
      return { result, identifiers: { branch: result.branch, commitSha: result.commitSha } };
    });
  }

  async createPullRequest(input: CreatePullRequestInput) {
    return await this.executeMutation(input, 'pull-request.create', async (provider) => {
      const result = await provider.createPullRequest(input);
      return { result, identifiers: { pullRequestNumber: result.pullRequestNumber } };
    });
  }

  async commentPullRequest(input: CommentPullRequestInput) {
    return await this.executeMutation(input, 'pull-request.comment.create', async (provider) => {
      const result = await provider.commentPullRequest(input);
      return {
        result,
        identifiers: { pullRequestNumber: result.pullRequestNumber, commentId: result.commentId },
      };
    });
  }

  async updatePullRequestLabels(input: UpdatePullRequestLabelsInput) {
    return await this.executeMutation(input, 'pull-request.labels.update', async (provider) => {
      const result = await provider.updatePullRequestLabels(input);
      return { result, identifiers: { pullRequestNumber: result.pullRequestNumber } };
    });
  }

  async closePullRequest(input: ClosePullRequestInput) {
    return await this.executeMutation(input, 'pull-request.close', async (provider) => {
      if (!provider.closePullRequest) throw { code: 'TOOL_UNAVAILABLE', message: 'Pull-request close is not enabled' };
      const result = await provider.closePullRequest(input);
      return { result, identifiers: { pullRequestNumber: result.pullRequestNumber } };
    });
  }

  async readyPullRequestForReview(input: ReadyPullRequestForReviewInput) {
    return await this.executeMutation(input, 'pull-request.ready-for-review', async (provider) => {
      if (!provider.readyPullRequestForReview) throw { code: 'TOOL_UNAVAILABLE', message: 'Pull-request ready-for-review is not enabled' };
      const result = await provider.readyPullRequestForReview(input);
      return { result, identifiers: { pullRequestNumber: result.pullRequestNumber } };
    });
  }

  async rerunPullRequestVerification(input: RerunPullRequestVerificationInput) {
    return await this.executeMutation(input, 'pull-request.verify.rerun', async (provider) => {
      if (!provider.rerunPullRequestVerification) throw { code: 'TOOL_UNAVAILABLE', message: 'Pull-request verification rerun is not enabled' };
      const result = await provider.rerunPullRequestVerification(input);
      return { result, identifiers: { pullRequestNumber: result.pullRequestNumber, workflowRunId: String(result.workflowRunId) } };
    });
  }

  async mergeIntegrationPullRequest(input: MergeIntegrationPullRequestInput) {
    return await this.executeMutation(input, 'pull-request.merge.integration', async (provider) => {
      const result = await provider.mergeIntegrationPullRequest(input);
      return { result, identifiers: { pullRequestNumber: result.pullRequestNumber, mergeCommitSha: result.mergeCommitSha } };
    });
  }

  async reconcilePreviewPullRequest(input: ReconcilePreviewPullRequestInput) {
    return await this.executeMutation(input, 'pull-request.merge.reconcile-preview', async (provider) => {
      const result = await provider.reconcilePreviewPullRequest(input);
      return { result, identifiers: { pullRequestNumber: result.pullRequestNumber, mergeCommitSha: result.mergeCommitSha } };
    });
  }

  async promotePullRequest(input: PromotePullRequestInput) {
    return await this.executeMutation(input, 'pull-request.merge.promote', async (provider) => {
      const result = await provider.promotePullRequest(input);
      return { result, identifiers: { pullRequestNumber: result.pullRequestNumber, mergeCommitSha: result.mergeCommitSha } };
    });
  }


  private operationDefinitions(): ToolDefinition[] {
    return [
      ...TOOL_DEFINITIONS,
      ...(this.operationPreflightEnabled ? [OPERATION_PREFLIGHT_DEFINITION] : []),
      ...(this.repositoryAcquisitionReadEnabled ? [REPOSITORY_ACQUISITION_PREFLIGHT_DEFINITION] : []),
      ...(this.repositoryAcquisitionMutationEnabled ? [REPOSITORY_ACQUISITION_MUTATION_DEFINITION] : []),
      ...(this.workBootstrapReadEnabled ? [WORK_BOOTSTRAP_READ_DEFINITION] : []),
      EVIDENCE_BUNDLE_READ_DEFINITION,
      ...(this.repositoryAuditReadEnabled ? [REPOSITORY_AUDIT_READ_DEFINITION] : []),
      ...(this.developmentStatusReadEnabled ? [DEVELOPMENT_STATUS_READ_DEFINITION] : []),
      ...(this.pullRequestReadEnabled ? [PULL_REQUEST_READ_DEFINITION] : []),
      ...(this.sourceDiscoveryReadEnabled ? [SOURCE_DISCOVERY_READ_DEFINITION] : []),
      ...(this.sourceArtifactReadEnabled ? [EXECUTION_EVIDENCE_READ_DEFINITIONS[0]!] : []),
      ...(this.ciReadEnabled ? [EXECUTION_EVIDENCE_READ_DEFINITIONS[1]!] : []),
      ...(this.deploymentReadEnabled ? [...DEPLOYMENT_READ_DEFINITIONS, ...VERCEL_AUDIT_DEFINITIONS] : []),
      ...(this.vercelMutationEnabled ? VERCEL_MUTATION_DEFINITIONS : []),
      ...(this.workItemReadEnabled ? WORK_ITEM_READ_DEFINITIONS : []),
      ...(this.sourceControlMutationsEnabled ? MUTATION_DEFINITIONS : []),
      ...(this.workflowCommitEnabled ? [WORKFLOW_MUTATION_DEFINITION] : []),
      ...(this.lifecycleAdvanceEnabled || this.lifecycleResumeEnabled ? LIFECYCLE_MUTATION_DEFINITIONS.filter((item) => item.name === 'lifecycle.advance' ? this.lifecycleAdvanceEnabled : this.lifecycleResumeEnabled) : []),
      ...(this.pullRequestLifecycleMutationsEnabled ? PULL_REQUEST_LIFECYCLE_MUTATION_DEFINITIONS : []),
      ...(this.workItemMutationsEnabled ? WORK_ITEM_MUTATION_DEFINITIONS : []),
    ];
  }

  private async executeWorkItemMutation<Result>(
    input: { project: ProjectReference; idempotencyKey: string },
    operation: import('./types.js').MutationOperationName,
    mutate: (provider: WorkItemMutationProvider) => Promise<import('./idempotency.js').MutationResult<Result>>,
  ): Promise<ExecutionReceipt<Result>> {
    if (!this.workItemProvider || !this.mutationExecutor) {
      const executor = new IdempotentMutationExecutor({
        store: {
          async claim() { throw { code: 'TOOL_UNAVAILABLE', message: 'Work-item mutation tools are not enabled' }; },
          async complete() {},
        },
        createOperationId: this.createOperationId,
        now: this.now,
      });
      return await executor.execute({
        key: input.idempotencyKey,
        fingerprint: mutationFingerprint(operation, input),
        operation,
        target: { kind: 'repository', id: input.project.repository ?? input.project.id },
      }, async () => { throw { code: 'TOOL_UNAVAILABLE', message: 'Work-item mutation tools are not enabled' }; });
    }
    if (!/^[A-Za-z0-9._:/-]{8,200}$/.test(input.idempotencyKey)) {
      throw new Error('idempotencyKey must be 8-200 stable URL-safe characters');
    }
    return await this.mutationExecutor.execute({
      key: input.idempotencyKey,
      fingerprint: mutationFingerprint(operation, input),
      operation,
      target: { kind: 'repository', id: input.project.repository ?? input.project.id },
    }, async () => await mutate(this.workItemProvider!));
  }

  private async executeMutation<Result>(
    input: { project: ProjectReference; idempotencyKey: string },
    operation: import('./types.js').MutationOperationName,
    mutate: (provider: SourceControlMutationProvider) => Promise<import('./idempotency.js').MutationResult<Result>>,
  ): Promise<ExecutionReceipt<Result>> {
    if (!this.sourceControlMutationProvider || !this.mutationExecutor) {
      const executor = new IdempotentMutationExecutor({
        store: {
          async claim() { throw { code: 'TOOL_UNAVAILABLE', message: 'Mutation tools are not enabled' }; },
          async complete() {},
        },
        createOperationId: this.createOperationId,
        now: this.now,
      });
      return await executor.execute({
        key: input.idempotencyKey,
        fingerprint: mutationFingerprint(operation, input),
        operation,
        target: { kind: 'repository', id: input.project.repository ?? input.project.id },
      }, async () => { throw { code: 'TOOL_UNAVAILABLE', message: 'Mutation tools are not enabled' }; });
    }
    if (!/^[A-Za-z0-9._:/-]{8,200}$/.test(input.idempotencyKey)) {
      throw new Error('idempotencyKey must be 8-200 stable URL-safe characters');
    }
    return await this.mutationExecutor.execute({
      key: input.idempotencyKey,
      fingerprint: mutationFingerprint(operation, input),
      operation,
      target: { kind: 'repository', id: input.project.repository ?? input.project.id },
    }, async () => await mutate(this.sourceControlMutationProvider!));
  }

  async preflightProject(
    project: ProjectReference,
    intent: PreflightIntent = 'develop',
  ): Promise<ExecutionReceipt<ProjectPreflight>> {
    const resolvedProject = this.projectResolver?.resolveProjectReference(project) ?? project;
    return this.executeRead(
      'preflight_project',
      { kind: 'project', id: resolvedProject.id, ref: resolvedProject.ref },
      async () => {
        const checks = new Map<PreflightCheckId, PreflightCheck>();
        const diagnostics: ToolDiagnostic[] = [];

        for (const provider of this.providers) {
          if (!supportsProjectPreflight(provider)) continue;

          try {
            const providerChecks = await provider.preflightProject(resolvedProject);
            for (const check of providerChecks) {
              const existing = checks.get(check.check);
              if (existing) {
                const error = normalizeToolError(
                  {
                    code: 'CONFLICT',
                    message: `Preflight check ${check.check} was reported by both ${existing.provider} and ${provider.id}`,
                  },
                  'CONFLICT',
                  'conductor',
                );
                checks.set(check.check, {
                  check: check.check,
                  status: 'blocked',
                  provider: 'conductor',
                  summary: error.message,
                  error,
                  diagnostics: error.diagnostics,
                });
                diagnostics.push(...error.diagnostics);
                continue;
              }
              checks.set(check.check, check);
            }
          } catch (error) {
            const normalized = normalizeToolError(
              error,
              'TOOL_UNAVAILABLE',
              provider.id,
            );
            diagnostics.push(...normalized.diagnostics);
          }
        }

        const requiredChecks = REQUIRED_PREFLIGHT_CHECKS[intent];
        for (const check of requiredChecks) {
          if (!checks.has(check)) {
            const error = normalizeToolError(
              {
                code: 'TOOL_UNAVAILABLE',
                message: `No provider is configured for ${check}`,
              },
              'TOOL_UNAVAILABLE',
              'conductor',
            );
            checks.set(check, {
              check,
              status: 'unavailable',
              provider: 'conductor',
              summary: error.message,
              error,
              diagnostics: error.diagnostics,
            });
          }
        }

        const orderedChecks = requiredChecks.map(
          (check) => checks.get(check)!,
        );
        const status = orderedChecks.some((check) => check.status === 'blocked')
          ? 'blocked'
          : orderedChecks.some((check) => check.status !== 'ready')
            ? 'degraded'
            : 'ready';

        return {
          result: {
            contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
            project: resolvedProject,
            intent,
            status,
            checks: orderedChecks,
          },
          diagnostics,
        };
      },
    );
  }

  private async executeRead<Result>(
    operation: ToolOperationName,
    target: { kind: 'runtime' | 'project' | 'repository'; id: string; ref?: string },
    read: () => Promise<{
      result: Result;
      diagnostics?: ToolDiagnostic[];
    }>,
  ): Promise<ExecutionReceipt<Result>> {
    const operationId = this.createOperationId();
    const startedAt = this.now().toISOString();

    try {
      const outcome = await read();
      return {
        contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
        operationId,
        operation,
        target,
        status: 'succeeded',
        startedAt,
        finishedAt: this.now().toISOString(),
        result: outcome.result,
        diagnostics: outcome.diagnostics ?? [],
      };
    } catch (error) {
      const normalized = normalizeToolError(error, 'TOOL_UNAVAILABLE');
      return {
        contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
        operationId,
        operation,
        target,
        status: 'failed',
        startedAt,
        finishedAt: this.now().toISOString(),
        error: normalized,
        diagnostics: normalized.diagnostics,
      };
    }
  }
}

function mutationFingerprint(operation: string, input: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({ operation, input })).digest('hex')}`;
}


function lifecycleTransportRole(pullRequest: PullRequestStatus): 'preview-integration' | 'main-promotion' | 'other' {
  if (['preview', 'vercel-preview'].includes(pullRequest.head.ref.toLowerCase())) return 'main-promotion';
  if (['preview', 'vercel-preview'].includes(pullRequest.base.ref.toLowerCase())) return 'preview-integration';
  return 'other';
}
function lifecycleSubkey(base: string, suffix: string): string {
  return `lifecycle:${createHash('sha256').update(`${base}:${suffix}`).digest('hex').slice(0, 48)}`;
}
function lifecycleDeploymentFailed(state: string | null): boolean {
  return ['ERROR', 'FAILED', 'CANCELED', 'CANCELLED'].includes((state ?? '').toUpperCase());
}
async function lifecycleDelay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
function lifecycleProjection(
  project: ProjectReference,
  issueNumber: number,
  stage: LifecycleAdvanceProjection['stage'],
  summary: string,
  transitions: LifecycleTransitionRecord[],
  previewProof: LifecycleAdvanceProjection['previewProof'] = null,
  gate: LifecycleGateSpec | null = null,
): LifecycleAdvanceProjection {
  return { contractVersion: TOOL_RUNTIME_CONTRACT_VERSION, project, issueNumber, stage, summary, transitions, elapsedMs: 0, providerUsage: [], previewProof, gate };
}


async function boundedEvidenceMap<T, R>(
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

function succeededEvidenceBundleItem(
  item: EvidenceBundleItemInput,
  project: ProjectReference,
  startedAt: number,
  summary: string,
  identifiers: EvidenceBundleItemResult['identifiers'],
  evidence: Record<string, unknown>,
): EvidenceBundleItemResult {
  return {
    key: item.key,
    operation: item.operation,
    project,
    status: 'succeeded',
    elapsedMs: Math.max(0, Date.now() - startedAt),
    summary,
    identifiers,
    evidence,
  };
}

function failedEvidenceBundleItem(
  item: EvidenceBundleItemInput,
  project: ProjectReference,
  error: import('./types.js').NormalizedToolError,
  startedAt: number,
): EvidenceBundleItemResult {
  return {
    key: item.key,
    operation: item.operation,
    project,
    status: 'failed',
    elapsedMs: Math.max(0, Date.now() - startedAt),
    summary: error.message,
    identifiers: {},
    error,
  };
}

function compactDeployment(deployment: import('./types.js').DeploymentRecord): Record<string, unknown> {
  return {
    id: deployment.id,
    state: deployment.state,
    target: deployment.target,
    sourceRevision: deployment.sourceRevision,
    sourceRef: deployment.sourceRef,
    sourceRepository: deployment.sourceRepository,
    createdAt: deployment.createdAt,
    errorCode: deployment.errorCode,
  };
}
