export const TOOL_RUNTIME_CONTRACT_VERSION = 'conductor.tool-runtime.v0' as const;

export type ToolOperationName =
  | 'capabilities'
  | 'preflight_project'
  | 'project.status'
  | 'pull-request.status'
  | 'work-item.status'
  | 'work-item.list';

export type PreflightIntent = 'inspect' | 'develop' | 'execute';

export type MutationOperationName =
  | 'git.branch.create'
  | 'git.commit.create'
  | 'git.push'
  | 'pull-request.create'
  | 'pull-request.comment.create'
  | 'pull-request.labels.update'
  | 'pull-request.merge.integration'
  | 'pull-request.merge.reconcile-preview'
  | 'pull-request.merge.promote'
  | 'work-item.create'
  | 'work-item.update-status'
  | 'work-item.classification.update';

export type RuntimeOperationName =
  | ToolOperationName
  | MutationOperationName;

export type DevelopmentCapability =
  | 'repository.read'
  | 'repository.write'
  | 'github.read'
  | 'github.write'
  | 'workspace.read'
  | 'workspace.write'
  | 'shell.execute'
  | 'tests.run'
  | 'git.diff'
  | 'git.branch'
  | 'git.commit'
  | 'git.push'
  | 'pull-request.read'
  | 'pull-request.write'
  | 'work-item.read'
  | 'work-item.write'
  | 'ci.read'
  | 'development-intelligence.read';

export type ToolErrorCode =
  | 'AUTH_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'TRANSIENT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TOOL_UNAVAILABLE'
  | 'COMMAND_FAILED';

export type DiagnosticValue = string | number | boolean | null;

export interface ToolDiagnostic {
  level: 'info' | 'warning' | 'error';
  message: string;
  source?: string;
  code?: ToolErrorCode;
  details?: Record<string, DiagnosticValue>;
}

export interface NormalizedToolError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  source?: string;
  diagnostics: ToolDiagnostic[];
}

export interface ToolDefinition {
  name: RuntimeOperationName;
  description: string;
  mutates: boolean;
}

export interface CapabilityAvailability {
  capability: DevelopmentCapability;
  available: boolean;
  provider: string;
  access: 'read' | 'write' | 'execute';
  auth: 'ready' | 'required' | 'denied' | 'not-applicable' | 'unknown';
  health: 'ready' | 'degraded' | 'unavailable';
  diagnostics: ToolDiagnostic[];
}

export interface ProviderHealth {
  provider: string;
  health: 'ready' | 'degraded' | 'unavailable';
  error?: NormalizedToolError;
}

export interface CapabilityReport {
  contractVersion: typeof TOOL_RUNTIME_CONTRACT_VERSION;
  operations: ToolDefinition[];
  capabilities: CapabilityAvailability[];
  providers: ProviderHealth[];
}

export interface ProjectReference {
  id: string;
  repository?: string;
  workspace?: string;
  ref?: string;
}

export interface GetProjectStatusInput {
  project: ProjectReference;
  limit?: number;
}

export interface ProjectStatusWorkItem {
  workItem: WorkItemRecord;
  candidates: PullRequestStatus[];
}

export interface ProjectStatusWorkCounts {
  backlog: number;
  ready: number;
  inProgress: number;
  blocked: number;
  review: number;
  done: number;
  unknown: number;
}

export interface ProjectStatusProjection {
  contractVersion: typeof TOOL_RUNTIME_CONTRACT_VERSION;
  project: ProjectReference;
  preflight: ProjectPreflight;
  work: {
    counts: ProjectStatusWorkCounts;
    ready: ProjectStatusWorkItem[];
    inProgress: ProjectStatusWorkItem[];
    blocked: ProjectStatusWorkItem[];
    review: ProjectStatusWorkItem[];
    truncated: boolean;
  };
}

export interface CreateBranchInput {
  project: ProjectReference;
  branch: string;
  fromSha: string;
  idempotencyKey: string;
}

export interface CreateCommitFile {
  path: string;
  content: string | null;
}

export interface CreateCommitInput {
  project: ProjectReference;
  branch: string;
  expectedHeadSha: string;
  message: string;
  files: CreateCommitFile[];
  idempotencyKey: string;
}

export interface CreatePullRequestInput {
  project: ProjectReference;
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
  idempotencyKey: string;
}

export interface CommentPullRequestInput {
  project: ProjectReference;
  pullRequestNumber: number;
  body: string;
  idempotencyKey: string;
}

export type PullRequestMergeMethod = 'merge' | 'squash' | 'rebase';

export interface GetPullRequestStatusInput {
  project: ProjectReference;
  pullRequestNumber: number;
}

export interface PullRequestCheckState {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  app: string | null;
}

export interface PullRequestWorkflowRunState {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}

export interface PullRequestStatus {
  repository: string;
  pullRequestNumber: number;
  url: string;
  state: string;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  labels: string[];
  checks: {
    total: number;
    pending: number;
    successful: number;
    failed: number;
    neutral: number;
    skipped: number;
    items: PullRequestCheckState[];
  };
  workflowRuns: PullRequestWorkflowRunState[];
}

export type WorkItemStatus =
  | 'backlog'
  | 'ready'
  | 'in-progress'
  | 'blocked'
  | 'review'
  | 'done'
  | 'unknown';

export type MutableWorkItemStatus = Exclude<WorkItemStatus, 'unknown'>;
export type NewWorkItemStatus = Exclude<MutableWorkItemStatus, 'done'>;
export type WorkItemStatusSource = 'label' | 'issue-state' | 'default' | 'conflict';

export type WorkItemKind =
  | 'bug'
  | 'feature'
  | 'investigation'
  | 'improvement'
  | 'maintenance'
  | 'operations'
  | 'unknown';

export type MutableWorkItemKind = Exclude<WorkItemKind, 'unknown'>;

export type WorkItemOrigin =
  | 'human'
  | 'agent-audit'
  | 'di-finding'
  | 'ci'
  | 'runtime'
  | 'dependency'
  | 'user-feedback'
  | 'unknown';

export type MutableWorkItemOrigin = Exclude<WorkItemOrigin, 'unknown'>;
export type WorkItemClassificationSource = 'label' | 'default' | 'conflict';

export interface WorkItemRecord {
  repository: string;
  issueNumber: number;
  url: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  status: WorkItemStatus;
  statusSource: WorkItemStatusSource;
  kind: WorkItemKind;
  kindSource: WorkItemClassificationSource;
  origin: WorkItemOrigin;
  originSource: WorkItemClassificationSource;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemList {
  repository: string;
  items: WorkItemRecord[];
  truncated: boolean;
}

export interface GetWorkItemStatusInput {
  project: ProjectReference;
  issueNumber: number;
}

export interface GetWorkItemCandidatesInput {
  project: ProjectReference;
  issueNumber: number;
}

export interface ListWorkItemsInput {
  project: ProjectReference;
  statuses?: WorkItemStatus[];
  kinds?: WorkItemKind[];
  origins?: WorkItemOrigin[];
  limit?: number;
}

export interface CreateWorkItemInput {
  project: ProjectReference;
  title: string;
  body?: string;
  status?: NewWorkItemStatus;
  kind?: WorkItemKind;
  origin?: WorkItemOrigin;
  labels?: string[];
  idempotencyKey: string;
}

export interface UpdateWorkItemStatusInput {
  project: ProjectReference;
  issueNumber: number;
  status: MutableWorkItemStatus;
  idempotencyKey: string;
}

export interface UpdateWorkItemClassificationInput {
  project: ProjectReference;
  issueNumber: number;
  kind?: WorkItemKind;
  origin?: WorkItemOrigin;
  idempotencyKey: string;
}

export interface UpdatePullRequestLabelsInput {
  project: ProjectReference;
  pullRequestNumber: number;
  add?: string[];
  remove?: string[];
  idempotencyKey: string;
}

export interface MergeIntegrationPullRequestInput {
  project: ProjectReference;
  pullRequestNumber: number;
  expectedHeadSha: string;
  expectedBaseSha: string;
  mergeMethod?: PullRequestMergeMethod;
  idempotencyKey: string;
}

export interface ReconcilePreviewPullRequestInput {
  project: ProjectReference;
  pullRequestNumber: number;
  expectedHeadSha: string;
  expectedBaseSha: string;
  idempotencyKey: string;
}

export interface PromotePullRequestInput {
  project: ProjectReference;
  pullRequestNumber: number;
  expectedHeadSha: string;
  expectedBaseSha: string;
  approvalReference: string;
  mergeMethod?: PullRequestMergeMethod;
  idempotencyKey: string;
}

export type PreflightCheckId =
  | 'repository.access'
  | 'github.read'
  | 'github.write'
  | 'workspace.access'
  | 'shell.execute'
  | 'tests.run'
  | 'development-intelligence.read';

export interface PreflightCheck {
  check: PreflightCheckId;
  status: 'ready' | 'degraded' | 'blocked' | 'unavailable';
  provider: string;
  summary: string;
  error?: NormalizedToolError;
  diagnostics: ToolDiagnostic[];
}

export interface ProjectPreflight {
  contractVersion: typeof TOOL_RUNTIME_CONTRACT_VERSION;
  project: ProjectReference;
  intent: PreflightIntent;
  status: 'ready' | 'degraded' | 'blocked';
  checks: PreflightCheck[];
}

export interface ExecutionTarget {
  kind: 'runtime' | 'project' | 'repository' | 'workspace';
  id: string;
  ref?: string;
}

export interface ExecutionIdentifiers {
  branch?: string;
  commitSha?: string;
  pullRequestNumber?: number;
  issueNumber?: number;
  commentId?: string;
  workflowRunId?: string;
  mergeCommitSha?: string;
}

export interface ReceiptBase {
  contractVersion: typeof TOOL_RUNTIME_CONTRACT_VERSION;
  operationId: string;
  operation: RuntimeOperationName;
  target: ExecutionTarget;
  startedAt: string;
  finishedAt: string;
  diagnostics: ToolDiagnostic[];
  identifiers?: ExecutionIdentifiers;
  idempotency?: {
    key: string;
    fingerprint: string;
    replayed: boolean;
  };
}

export interface SuccessfulExecutionReceipt<Result> extends ReceiptBase {
  status: 'succeeded';
  result: Result;
}

export interface FailedExecutionReceipt extends ReceiptBase {
  status: 'failed';
  error: NormalizedToolError;
}

export type ExecutionReceipt<Result> =
  | SuccessfulExecutionReceipt<Result>
  | FailedExecutionReceipt;
