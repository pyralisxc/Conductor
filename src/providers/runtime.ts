import type {
  CapabilityAvailability,
  PreflightCheck,
  OperationPreflightCheck,
  ProjectReference,
  RuntimeOperationName,
  CreateBranchInput,
  DeleteBranchInput,
  CreateCommitInput,
  CreatePullRequestInput,
  CommentPullRequestInput,
  GetPullRequestStatusInput,
  PullRequestStatus,
  GetSourceArtifactInput,
  SourceArtifactRead,
  GetCiRunEvidenceInput,
  CiRunEvidence,
  UpdatePullRequestLabelsInput,
  MergeIntegrationPullRequestInput,
  ReconcilePreviewPullRequestInput,
  PromotePullRequestInput,
  GetWorkItemStatusInput,
  GetWorkItemCandidatesInput,
  ListWorkItemsInput,
  WorkItemRecord,
  WorkItemList,
  CreateWorkItemInput,
  CommentWorkItemInput,
  UpdateWorkItemStatusInput,
  UpdateWorkItemClassificationInput,
  GetDeploymentStatusInput,
  GetDeploymentLogsInput,
  DeploymentProjectStatus,
  DeploymentLogs,
  VercelProjectInput, VercelDeploymentInput, VercelGitDeploymentInput, VercelEnvInput, VercelEnvEditInput, VercelEnvRemoveInput, VercelRuntimeLogsInput, VercelVcrRepositoryInput, VercelVcrCreateInput,
} from '../runtime/types.js';

export interface RuntimeCapabilityProvider {
  readonly id: string;
  getCapabilities(): Promise<CapabilityAvailability[]>;
}

export interface ProjectPreflightProvider extends RuntimeCapabilityProvider {
  preflightProject(project: ProjectReference): Promise<PreflightCheck[]>;
}

export interface OperationPreflightProvider extends RuntimeCapabilityProvider {
  preflightOperation(
    project: ProjectReference,
    operation: RuntimeOperationName,
  ): Promise<OperationPreflightCheck[] | undefined>;
}

export interface ProjectReferenceResolver {
  resolveProjectReference(project: ProjectReference): ProjectReference;
}

export interface PullRequestReadProvider extends RuntimeCapabilityProvider {
  getPullRequestStatus(input: GetPullRequestStatusInput): Promise<PullRequestStatus>;
}

export interface SourceArtifactReadProvider extends RuntimeCapabilityProvider {
  getSourceArtifact(input: GetSourceArtifactInput): Promise<SourceArtifactRead>;
}

export interface CiReadProvider extends RuntimeCapabilityProvider {
  getCiRunEvidence(input: GetCiRunEvidenceInput): Promise<CiRunEvidence>;
}

export interface WorkItemReadProvider extends RuntimeCapabilityProvider {
  getWorkItemStatus(input: GetWorkItemStatusInput): Promise<WorkItemRecord>;
  listWorkItems(input: ListWorkItemsInput): Promise<WorkItemList>;
}

export interface WorkItemCandidateReadProvider extends WorkItemReadProvider {
  listWorkItemPullRequests(input: GetWorkItemCandidatesInput): Promise<PullRequestStatus[]>;
}

export interface WorkItemMutationProvider extends WorkItemReadProvider {
  createWorkItem(input: CreateWorkItemInput): Promise<WorkItemRecord>;
  commentWorkItem(input: CommentWorkItemInput): Promise<{ repository: string; issueNumber: number; commentId: string; url: string }>;
  updateWorkItemStatus(input: UpdateWorkItemStatusInput): Promise<WorkItemRecord>;
  updateWorkItemClassification(input: UpdateWorkItemClassificationInput): Promise<WorkItemRecord>;
}

export interface DeploymentReadProvider extends RuntimeCapabilityProvider {
  getDeploymentStatus(input: GetDeploymentStatusInput): Promise<DeploymentProjectStatus>;
  getDeploymentLogs(input: GetDeploymentLogsInput): Promise<DeploymentLogs>;
}

export interface VercelOperationsProvider extends DeploymentReadProvider {
  getAudit(input: VercelProjectInput): Promise<Record<string, unknown>>;
  getRuntimeLogs(input: VercelRuntimeLogsInput): Promise<Record<string, unknown>>;
  listEnvironment(input: VercelProjectInput): Promise<Record<string, unknown>>;
  getVcrRepository(input: VercelVcrRepositoryInput): Promise<Record<string, unknown>>;
  createVcrRepository(input: VercelVcrCreateInput): Promise<Record<string, unknown>>;
  redeploy(input: VercelDeploymentInput): Promise<Record<string, unknown>>;
  createGitDeployment(input: VercelGitDeploymentInput): Promise<Record<string, unknown>>;
  promote(input: VercelDeploymentInput): Promise<Record<string, unknown>>;
  rollback(input: VercelDeploymentInput): Promise<Record<string, unknown>>;
  deleteDeployment(input: VercelDeploymentInput): Promise<Record<string, unknown>>;
  upsertEnvironment(input: VercelEnvInput): Promise<Record<string, unknown>>;
  updateEnvironment(input: VercelEnvEditInput): Promise<Record<string, unknown>>;
  removeEnvironment(input: VercelEnvRemoveInput): Promise<Record<string, unknown>>;
}

export interface SourceControlMutationProvider extends RuntimeCapabilityProvider {
  createBranch(input: CreateBranchInput): Promise<{ repository: string; branch: string; commitSha: string }>;
  deleteBranch(input: DeleteBranchInput): Promise<{ repository: string; branch: string; commitSha: string; deleted: true; containedIn: string }>;
  createCommit(input: CreateCommitInput): Promise<{ repository: string; branch: string; commitSha: string }>;
  createPullRequest(input: CreatePullRequestInput): Promise<{ repository: string; pullRequestNumber: number; url: string }>;
  commentPullRequest(input: CommentPullRequestInput): Promise<{ repository: string; pullRequestNumber: number; commentId: string; url: string }>;
  updatePullRequestLabels(input: UpdatePullRequestLabelsInput): Promise<{ repository: string; pullRequestNumber: number; labels: string[] }>;
  mergeIntegrationPullRequest(input: MergeIntegrationPullRequestInput): Promise<{ repository: string; pullRequestNumber: number; merged: boolean; mergeCommitSha: string; message: string }>;
  reconcilePreviewPullRequest(input: ReconcilePreviewPullRequestInput): Promise<{ repository: string; pullRequestNumber: number; merged: boolean; mergeCommitSha: string; message: string }>;
  promotePullRequest(input: PromotePullRequestInput): Promise<{ repository: string; pullRequestNumber: number; merged: boolean; mergeCommitSha: string; message: string; approvalReference: string }>;
}

export type ToolRuntimeProvider =
  | RuntimeCapabilityProvider
  | ProjectPreflightProvider
  | OperationPreflightProvider;

export function supportsProjectPreflight(
  provider: ToolRuntimeProvider,
): provider is ProjectPreflightProvider {
  return 'preflightProject' in provider;
}


export function supportsOperationPreflight(
  provider: ToolRuntimeProvider,
): provider is OperationPreflightProvider {
  return 'preflightOperation' in provider;
}
