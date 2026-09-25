import { createHash, randomUUID } from 'node:crypto';
import {
  supportsProjectPreflight,
  supportsOperationPreflight,
  type ToolRuntimeProvider,
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
  type CapabilityAvailability,
  type CapabilityReport,
  type ExecutionReceipt,
  type PreflightCheck,
  type PreflightCheckId,
  type PreflightIntent,
  type ProjectPreflight,
  type ProjectReference,
  type ProviderHealth,
  type ToolDefinition,
  type ToolDiagnostic,
  type ToolOperationName,
  type GetOperationPreflightInput,
  type OperationPreflight,
  type OperationPreflightCheck,
  type GetDevelopmentStatusInput,
  type DevelopmentStatusProjection,
  type DevelopmentStatusWorkCounts,
  type CreateBranchInput,
  type DeleteBranchInput,
  type CreateCommitInput,
  type CreatePullRequestInput,
  type CommentPullRequestInput,
  type GetPullRequestStatusInput,
  type PullRequestStatus,
  type GetSourceArtifactInput,
  type SourceArtifactRead,
  type GetCiRunEvidenceInput,
  type CiRunEvidence,
  type UpdatePullRequestLabelsInput,
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
  type GetDeploymentStatusInput,
  type GetDeploymentLogsInput,
  type DeploymentProjectStatus,
  type DeploymentLogs,
  type VercelProjectInput, type VercelDeploymentInput, type VercelGitDeploymentInput, type VercelEnvInput, type VercelEnvEditInput, type VercelEnvRemoveInput, type VercelRuntimeLogsInput,
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
];

const MUTATION_DEFINITIONS: readonly ToolDefinition[] = [
  { name: 'git.branch.create', description: 'Create a work/* branch from an exact Git SHA.', mutates: true },
  { name: 'git.branch.delete', description: 'Delete one exact integrated development branch after proving its head is already contained in Preview or Main.', mutates: true },
  { name: 'git.commit.create', description: 'Create files in one commit and advance an existing work/* branch from an expected head SHA.', mutates: true },
  { name: 'pull-request.create', description: 'Open a work/* pull request against an explicit target branch.', mutates: true },
  { name: 'pull-request.comment.create', description: 'Add a comment to a pull request.', mutates: true },
  { name: 'pull-request.labels.update', description: 'Add/remove pull-request labels while preserving unrelated labels.', mutates: true },
  { name: 'pull-request.merge.integration', description: 'Merge an exact PR candidate into a non-accepted integration branch.', mutates: true },
  { name: 'pull-request.merge.reconcile-preview', description: 'Reconcile the exact accepted default-branch ancestry back into Preview with a merge commit.', mutates: true },
  { name: 'pull-request.merge.promote', description: 'Promote an exact explicitly approved PR candidate into the repository default branch.', mutates: true },
];

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

  get sourceControlMutationsEnabled(): boolean {
    return Boolean(this.sourceControlMutationProvider && this.mutationExecutor);
  }

  get operationPreflightEnabled(): boolean {
    return this.providers.some((provider) => supportsOperationPreflight(provider));
  }

  get developmentStatusReadEnabled(): boolean {
    return Boolean(this.workItemCandidateProvider);
  }

  get pullRequestReadEnabled(): boolean {
    return Boolean(this.pullRequestProvider);
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
          if (supportingProviders === 0 && !CORE_PREFLIGHT_OPERATIONS.has(input.operation)) {
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
        const projected = await Promise.all(active.slice(0, limit).map(async (workItem) => ({
          workItem,
          candidates: await provider.listWorkItemPullRequests({
            project: resolvedProject,
            issueNumber: workItem.issueNumber,
          }),
        })));

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
  async deploymentEnvironmentList(input: VercelProjectInput) { return this.vercelRead('deployment.env.list', input, (provider, project) => provider.listEnvironment({ project })); }

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

  async createBranch(input: CreateBranchInput) {
    return await this.executeMutation(input, 'git.branch.create', async (provider) => {
      const result = await provider.createBranch(input);
      return { result, identifiers: { branch: result.branch, commitSha: result.commitSha } };
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
      ...(this.developmentStatusReadEnabled ? [DEVELOPMENT_STATUS_READ_DEFINITION] : []),
      ...(this.pullRequestReadEnabled ? [PULL_REQUEST_READ_DEFINITION] : []),
      ...(this.sourceArtifactReadEnabled ? [EXECUTION_EVIDENCE_READ_DEFINITIONS[0]!] : []),
      ...(this.ciReadEnabled ? [EXECUTION_EVIDENCE_READ_DEFINITIONS[1]!] : []),
      ...(this.deploymentReadEnabled ? [...DEPLOYMENT_READ_DEFINITIONS, ...VERCEL_AUDIT_DEFINITIONS] : []),
      ...(this.vercelMutationEnabled ? VERCEL_MUTATION_DEFINITIONS : []),
      ...(this.workItemReadEnabled ? WORK_ITEM_READ_DEFINITIONS : []),
      ...(this.sourceControlMutationsEnabled ? MUTATION_DEFINITIONS : []),
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
