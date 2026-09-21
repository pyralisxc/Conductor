import { createHash, randomUUID } from 'node:crypto';
import {
  supportsProjectPreflight,
  type ToolRuntimeProvider,
  type ProjectMutationProvider,
  type ProjectReferenceResolver,
  type PullRequestReadProvider,
  type WorkItemMutationProvider,
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
  type CreateBranchInput,
  type CreateCommitInput,
  type CreatePullRequestInput,
  type CommentPullRequestInput,
  type GetPullRequestStatusInput,
  type PullRequestStatus,
  type UpdatePullRequestLabelsInput,
  type MergeIntegrationPullRequestInput,
  type PromotePullRequestInput,
  type GetWorkItemStatusInput,
  type ListWorkItemsInput,
  type WorkItemRecord,
  type WorkItemList,
  type CreateWorkItemInput,
  type UpdateWorkItemStatusInput,
  type UpdateWorkItemClassificationInput,
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
    description: 'Verify development access, execution surfaces, tests, and intelligence for a project.',
    mutates: false,
  },
];

const PULL_REQUEST_READ_DEFINITION: ToolDefinition = {
  name: 'pull-request.status',
  description: 'Read one pull request with exact head/base identity plus observed check and workflow state.',
  mutates: false,
};

const WORK_ITEM_READ_DEFINITIONS: readonly ToolDefinition[] = [
  { name: 'work-item.status', description: 'Read one normalized durable work item.', mutates: false },
  { name: 'work-item.list', description: 'List normalized durable work items for one project, optionally filtered by status.', mutates: false },
];

const WORK_ITEM_MUTATION_DEFINITIONS: readonly ToolDefinition[] = [
  { name: 'work-item.create', description: 'Create one durable work item in the owning project.', mutates: true },
  { name: 'work-item.update-status', description: 'Move one durable work item to an explicit normalized status.', mutates: true },
  { name: 'work-item.classification.update', description: 'Update normalized work kind and/or origin without changing lifecycle status.', mutates: true },
];

const MUTATION_DEFINITIONS: readonly ToolDefinition[] = [
  { name: 'git.branch.create', description: 'Create a work/* branch from an exact Git SHA.', mutates: true },
  { name: 'git.commit.create', description: 'Create files in one commit and advance an existing work/* branch from an expected head SHA.', mutates: true },
  { name: 'pull-request.create', description: 'Open a work/* pull request targeting preview.', mutates: true },
  { name: 'pull-request.comment.create', description: 'Add a comment to a pull request.', mutates: true },
  { name: 'pull-request.labels.update', description: 'Add/remove pull-request labels while preserving unrelated labels.', mutates: true },
  { name: 'pull-request.merge.integration', description: 'Merge an exact PR candidate into a non-accepted integration branch.', mutates: true },
  { name: 'pull-request.merge.promote', description: 'Promote an exact explicitly approved PR candidate into the repository default branch.', mutates: true },
];

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
  mutationProvider?: ProjectMutationProvider;
  mutationExecutor?: IdempotentMutationExecutor;
  projectResolver?: ProjectReferenceResolver;
  pullRequestProvider?: PullRequestReadProvider;
  workItemProvider?: WorkItemMutationProvider;
}

export class ConductorToolRuntime {
  private readonly providers: ToolRuntimeProvider[];
  private readonly now: () => Date;
  private readonly createOperationId: () => string;
  private readonly mutationProvider?: ProjectMutationProvider;
  private readonly mutationExecutor?: IdempotentMutationExecutor;
  private readonly projectResolver?: ProjectReferenceResolver;
  private readonly pullRequestProvider?: PullRequestReadProvider;
  private readonly workItemProvider?: WorkItemMutationProvider;

  constructor(options: ConductorToolRuntimeOptions = {}) {
    this.providers = options.providers ?? [];
    this.now = options.now ?? (() => new Date());
    this.createOperationId =
      options.createOperationId ?? (() => randomUUID());
    this.mutationProvider = options.mutationProvider;
    this.mutationExecutor = options.mutationExecutor;
    this.projectResolver = options.projectResolver;
    this.pullRequestProvider = options.pullRequestProvider;
    this.workItemProvider = options.workItemProvider;
  }

  get mutationsEnabled(): boolean {
    return Boolean(this.mutationProvider && this.mutationExecutor);
  }

  get pullRequestReadEnabled(): boolean {
    return Boolean(this.pullRequestProvider);
  }

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
            operations: [
              ...TOOL_DEFINITIONS,
              ...(this.pullRequestReadEnabled ? [PULL_REQUEST_READ_DEFINITION] : []),
              ...(this.workItemReadEnabled ? WORK_ITEM_READ_DEFINITIONS : []),
              ...(this.mutationsEnabled ? MUTATION_DEFINITIONS : []),
              ...(this.workItemMutationsEnabled ? WORK_ITEM_MUTATION_DEFINITIONS : []),
            ],
            capabilities,
            providers,
          },
          diagnostics,
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

  async promotePullRequest(input: PromotePullRequestInput) {
    return await this.executeMutation(input, 'pull-request.merge.promote', async (provider) => {
      const result = await provider.promotePullRequest(input);
      return { result, identifiers: { pullRequestNumber: result.pullRequestNumber, mergeCommitSha: result.mergeCommitSha } };
    });
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
    mutate: (provider: ProjectMutationProvider) => Promise<import('./idempotency.js').MutationResult<Result>>,
  ): Promise<ExecutionReceipt<Result>> {
    if (!this.mutationProvider || !this.mutationExecutor) {
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
    }, async () => await mutate(this.mutationProvider!));
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
    target: { kind: 'runtime' | 'project'; id: string; ref?: string },
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
