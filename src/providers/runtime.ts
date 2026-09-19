import type {
  CapabilityAvailability,
  PreflightCheck,
  ProjectReference,
  CreateBranchInput,
  CreateCommitInput,
  CreatePullRequestInput,
  CommentPullRequestInput,
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

export interface ProjectMutationProvider extends RuntimeCapabilityProvider {
  createBranch(input: CreateBranchInput): Promise<{ repository: string; branch: string; commitSha: string }>;
  createCommit(input: CreateCommitInput): Promise<{ repository: string; branch: string; commitSha: string }>;
  createPullRequest(input: CreatePullRequestInput): Promise<{ repository: string; pullRequestNumber: number; url: string }>;
  commentPullRequest(input: CommentPullRequestInput): Promise<{ repository: string; pullRequestNumber: number; commentId: string; url: string }>;
}

export type ToolRuntimeProvider =
  | RuntimeCapabilityProvider
  | ProjectPreflightProvider;

export function supportsProjectPreflight(
  provider: ToolRuntimeProvider,
): provider is ProjectPreflightProvider {
  return 'preflightProject' in provider;
}
