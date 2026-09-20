import type {
  CapabilityAvailability,
  PreflightCheck,
  ProjectReference,
  CreateBranchInput,
  CreateCommitInput,
  CreatePullRequestInput,
  CommentPullRequestInput,
  GetPullRequestStatusInput,
  PullRequestStatus,
  UpdatePullRequestLabelsInput,
  MergeIntegrationPullRequestInput,
  PromotePullRequestInput,
  GetWorkItemStatusInput,
  ListWorkItemsInput,
  WorkItemRecord,
  WorkItemList,
  CreateWorkItemInput,
  UpdateWorkItemStatusInput,
} from '../runtime/types.js';

export interface RuntimeCapabilityProvider {
  readonly id: string;
  getCapabilities(): Promise<CapabilityAvailability[]>;
}

export interface ProjectPreflightProvider extends RuntimeCapabilityProvider {
  preflightProject(project: ProjectReference): Promise<PreflightCheck[]>;
}

export interface ProjectReferenceResolver {
  resolveProjectReference(project: ProjectReference): ProjectReference;
}

export interface PullRequestReadProvider extends RuntimeCapabilityProvider {
  getPullRequestStatus(input: GetPullRequestStatusInput): Promise<PullRequestStatus>;
}

export interface WorkItemReadProvider extends RuntimeCapabilityProvider {
  getWorkItemStatus(input: GetWorkItemStatusInput): Promise<WorkItemRecord>;
  listWorkItems(input: ListWorkItemsInput): Promise<WorkItemList>;
}

export interface WorkItemMutationProvider extends WorkItemReadProvider {
  createWorkItem(input: CreateWorkItemInput): Promise<WorkItemRecord>;
  updateWorkItemStatus(input: UpdateWorkItemStatusInput): Promise<WorkItemRecord>;
}

export interface ProjectMutationProvider extends RuntimeCapabilityProvider {
  createBranch(input: CreateBranchInput): Promise<{ repository: string; branch: string; commitSha: string }>;
  createCommit(input: CreateCommitInput): Promise<{ repository: string; branch: string; commitSha: string }>;
  createPullRequest(input: CreatePullRequestInput): Promise<{ repository: string; pullRequestNumber: number; url: string }>;
  commentPullRequest(input: CommentPullRequestInput): Promise<{ repository: string; pullRequestNumber: number; commentId: string; url: string }>;
  updatePullRequestLabels(input: UpdatePullRequestLabelsInput): Promise<{ repository: string; pullRequestNumber: number; labels: string[] }>;
  mergeIntegrationPullRequest(input: MergeIntegrationPullRequestInput): Promise<{ repository: string; pullRequestNumber: number; merged: boolean; mergeCommitSha: string; message: string }>;
  promotePullRequest(input: PromotePullRequestInput): Promise<{ repository: string; pullRequestNumber: number; merged: boolean; mergeCommitSha: string; message: string; approvalReference: string }>;
}

export type ToolRuntimeProvider =
  | RuntimeCapabilityProvider
  | ProjectPreflightProvider;

export function supportsProjectPreflight(
  provider: ToolRuntimeProvider,
): provider is ProjectPreflightProvider {
  return 'preflightProject' in provider;
}
