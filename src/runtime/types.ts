export const TOOL_RUNTIME_CONTRACT_VERSION = 'conductor.tool-runtime.v0' as const;

export type ToolOperationName =
  | 'capabilities'
  | 'preflight_project'
  | 'preflight_operation'
  | 'repository.acquire.preflight'
  | 'development.status'
  | 'pull-request.status'
  | 'source.artifact.read'
  | 'ci.run.read'
  | 'work-item.status'
  | 'work-item.list'
  | 'deployment.status'
  | 'deployment.logs'
  | 'deployment.audit'
  | 'deployment.runtime-logs'
  | 'deployment.env.list'
  | 'deployment.vcr.get';

export type PreflightIntent = 'inspect' | 'develop' | 'execute';

export type MutationOperationName =
  | 'repository.acquire'
  | 'git.branch.create'
  | 'git.branch.delete'
  | 'git.commit.create'
  | 'git.push'
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
  | 'deployment.redeploy'
  | 'deployment.git.create'
  | 'deployment.promote'
  | 'deployment.rollback'
  | 'deployment.delete'
  | 'deployment.env.upsert'
  | 'deployment.env.update'
  | 'deployment.env.remove'
  | 'deployment.vcr.create';

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
  | 'development-intelligence.read'
  | 'deployment.read'
  | 'deployment.logs.read'
  | 'deployment.audit.read'
  | 'deployment.write'
  | 'deployment.env.read'
  | 'deployment.env.write'
  | 'deployment.vcr.read'
  | 'deployment.vcr.write';

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

/**
 * Opaque execution-routing referent supplied by an upstream caller.
 *
 * This identifies provider resources Conductor may address; it is not a
 * product/project model and must not accumulate architecture or domain meaning.
 * Optional repository/workspace/ref fields are exact routing expectations used
 * to fail closed on mismatched execution targets.
 */
export interface ProjectReference {
  id: string;
  repository?: string;
  workspace?: string;
  ref?: string;
}

export interface GetOperationPreflightInput {
  project: ProjectReference;
  operation: RuntimeOperationName;
}

export interface RepositoryAcquisitionPreflightInput {
  upstreamRepository: string;
  upstreamRef: string;
  destinationOwner: string;
  destinationRepository: string;
  destinationBranch?: string;
}

export interface RepositoryAcquisitionPreflight {
  provider: 'github';
  status: 'ready' | 'blocked';
  method: 'snapshot-existing-destination';
  upstream: {
    repository: string;
    url: string;
    ref: string;
    sha: string | null;
    treeSha: string | null;
    fileCount: number | null;
    totalBytes: number | null;
  };
  destination: {
    repository: string;
    branch: string;
    exists: boolean;
    empty: boolean | null;
    authorized: boolean;
    recoverableBootstrap?: boolean;
    bootstrapCommitSha?: string | null;
  };
  limits: {
    maxFiles: number;
    maxTotalBytes: number;
    maxSingleBlobBytes: number;
  };
  reason: string | null;
  codeWorkGranted: false;
  observedAt: string;
}

export interface AcquireRepositoryInput extends RepositoryAcquisitionPreflightInput {
  expectedUpstreamSha: string;
  approvalReference: string;
  idempotencyKey: string;
}

export interface RepositoryAcquisitionResult {
  provider: 'github';
  destinationRepository: string;
  url: string;
  branch: string;
  commitSha: string;
  treeSha: string;
  importedFiles: number;
  totalBytes: number;
  provenance: {
    upstreamRepository: string;
    upstreamUrl: string;
    upstreamRef: string;
    upstreamSha: string;
    acquiredAt: string;
  };
  approvalReference: string;
  codeWorkGranted: false;
  cleanup: 'owner-provider-cleanup';
}

export interface OperationPreflightCheck {
  provider: string;
  status: 'ready' | 'degraded' | 'blocked' | 'unavailable';
  summary: string;
  error?: NormalizedToolError;
  diagnostics: ToolDiagnostic[];
}

export interface OperationPreflight {
  contractVersion: typeof TOOL_RUNTIME_CONTRACT_VERSION;
  project: ProjectReference;
  operation: RuntimeOperationName;
  exposed: boolean;
  status: 'ready' | 'degraded' | 'blocked';
  checks: OperationPreflightCheck[];
}

export interface GetDevelopmentStatusInput {
  project: ProjectReference;
  limit?: number;
}

export type WorkTransportRole = 'preview-integration' | 'main-promotion' | 'other';
export type WorkLifecycleStage = 'implementation' | 'preview-integration' | 'preview-integrated' | 'main-promotion';

export interface DevelopmentStatusTransportArtifact {
  role: WorkTransportRole;
  pullRequest: PullRequestStatus;
}

export interface DevelopmentStatusWorkItem {
  workItem: WorkItemRecord;
  lifecycleStage: WorkLifecycleStage;
  candidates: PullRequestStatus[];
  artifacts: DevelopmentStatusTransportArtifact[];
}

export interface DevelopmentStatusWorkCounts {
  backlog: number;
  ready: number;
  inProgress: number;
  blocked: number;
  review: number;
  done: number;
  unknown: number;
}

export interface DevelopmentStatusProjection {
  contractVersion: typeof TOOL_RUNTIME_CONTRACT_VERSION;
  project: ProjectReference;
  preflight: ProjectPreflight;
  work: {
    counts: DevelopmentStatusWorkCounts;
    ready: DevelopmentStatusWorkItem[];
    inProgress: DevelopmentStatusWorkItem[];
    blocked: DevelopmentStatusWorkItem[];
    review: DevelopmentStatusWorkItem[];
    truncated: boolean;
  };
}


export interface DeploymentRecord {
  id: string;
  url: string | null;
  state: string | null;
  target: string | null;
  createdAt: string | null;
  readyAt: string | null;
  sourceRevision: string | null;
  sourceRef: string | null;
  sourceRepository: string | null;
  aliases: string[];
  errorCode: string | null;
  errorMessage: string | null;
}

export interface DeploymentProjectStatus {
  provider: 'vercel';
  project: {
    id: string;
    name: string;
    productionBranch: string | null;
    teamId: string | null;
  };
  production: DeploymentRecord | null;
  latestProductionAttempt: DeploymentRecord | null;
  recent: DeploymentRecord[];
  domains: Array<{ name: string; verified: boolean | null }>;
  observedAt: string;
}

export interface GetDeploymentStatusInput {
  project: ProjectReference;
  limit?: number;
}

export interface DeploymentLogEntry {
  createdAt: string | null;
  type: string | null;
  level: string | null;
  text: string;
}

export interface DeploymentLogs {
  provider: 'vercel';
  projectId: string;
  deploymentId: string;
  entries: DeploymentLogEntry[];
  truncated: boolean;
  source: 'deployment-events';
  observedAt: string;
  note: string;
}

export interface GetDeploymentLogsInput {
  project: ProjectReference;
  deploymentId: string;
  limit?: number;
}

export interface CreateBranchInput {
  project: ProjectReference;
  branch: string;
  fromSha: string;
  idempotencyKey: string;
}

export interface DeleteBranchInput {
  project: ProjectReference;
  branch: string;
  expectedHeadSha: string;
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
  workItemNumbers?: number[];
  idempotencyKey: string;
}

export interface CommentPullRequestInput {
  project: ProjectReference;
  pullRequestNumber: number;
  body: string;
  idempotencyKey: string;
}

export type PullRequestMergeMethod = 'merge' | 'squash' | 'rebase';

export type PullRequestOrchestrationState =
  | 'merged'
  | 'draft'
  | 'external-gate-pending'
  | 'pre-seal-checkpoint'
  | 'sealed-head-verification-required'
  | 'action-required'
  | 'verification-failed'
  | 'merge-blocked'
  | 'integration-ready'
  | 'promotion-ready';

export type PullRequestOrchestrationAction =
  | 'none'
  | 'wait'
  | 'rerun-exact-head'
  | 'resume-external-gate'
  | 'inspect-failure'
  | 'integration-merge'
  | 'promotion-gate';

export interface PullRequestPriorObservation {
  headSha: string;
  orchestrationState?: PullRequestOrchestrationState;
}

export interface GetPullRequestStatusInput {
  project: ProjectReference;
  pullRequestNumber: number;
  previous?: PullRequestPriorObservation;
}

export interface PullRequestCheckState {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  app: string | null;
  historical?: boolean;
}

export interface PullRequestWorkflowRunState {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  runAttempt?: number | null;
  createdAt?: string | null;
  historical?: boolean;
}

export interface PullRequestOrchestration {
  state: PullRequestOrchestrationState;
  action: PullRequestOrchestrationAction;
  shouldAct: boolean;
  summary: string;
  resumeWhen: string | null;
  transition: {
    observed: boolean;
    previousHeadSha: string | null;
    previousState: PullRequestOrchestrationState | null;
    headChanged: boolean | null;
    stateChanged: boolean | null;
    meaningful: boolean | null;
  };
  seal: {
    requested: boolean;
    expectedPreSealCheckpoint: boolean;
    exactHeadVerificationRequired: boolean;
  };
  signals: {
    pending: string[];
    actionRequired: string[];
    failed: string[];
  };
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
  orchestration: PullRequestOrchestration;
}

export type SourceArtifactStatus = 'available' | 'too-large' | 'binary' | 'unsupported';

export interface GetSourceArtifactInput {
  project: ProjectReference;
  sha: string;
  path: string;
  maxBytes?: number;
}

export interface SourceArtifactRead {
  provider: 'github';
  repository: string;
  revisionSha: string;
  path: string;
  blobSha: string | null;
  size: number | null;
  status: SourceArtifactStatus;
  content: string | null;
  encoding: 'utf-8' | null;
  reason: string | null;
  observedAt: string;
}

export interface GetCiRunEvidenceInput {
  project: ProjectReference;
  pullRequestNumber: number;
  expectedHeadSha: string;
  workflowRunId: number;
  jobId?: number;
  logTailBytes?: number;
}

export interface CiStepEvidence {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CiJobLogEvidence {
  status: 'available' | 'unavailable' | 'not-requested';
  text: string | null;
  truncated: boolean;
  totalBytes: number | null;
  reason: string | null;
}

export interface CiJobEvidence {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  steps: CiStepEvidence[];
  log: CiJobLogEvidence;
}

export interface CiRunEvidence {
  provider: 'github';
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  workflowRun: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    url: string | null;
    event: string | null;
    headSha: string;
  };
  jobs: CiJobEvidence[];
  jobsTruncated: boolean;
  observedAt: string;
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

export interface CommentWorkItemInput {
  project: ProjectReference;
  issueNumber: number;
  body: string;
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

export interface ClosePullRequestInput {
  project: ProjectReference;
  pullRequestNumber: number;
  expectedHeadSha: string;
  idempotencyKey: string;
}

export interface ReadyPullRequestForReviewInput {
  project: ProjectReference;
  pullRequestNumber: number;
  expectedHeadSha: string;
  idempotencyKey: string;
}

export interface RerunPullRequestVerificationInput {
  project: ProjectReference;
  pullRequestNumber: number;
  expectedHeadSha: string;
  workflowRunId: number;
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
  deploymentId?: string;
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

export interface VercelProjectInput { project: ProjectReference }
export interface VercelDeploymentInput extends VercelProjectInput { deploymentId: string; idempotencyKey: string; approvalReference?: string }
export interface VercelGitDeploymentInput extends VercelProjectInput { repository: string; ref: string; sha: string; target: 'preview' | 'production'; idempotencyKey: string; approvalReference?: string }
export interface VercelEnvInput extends VercelProjectInput { key: string; value: string; type: 'plain' | 'encrypted' | 'sensitive'; target: ('production' | 'preview' | 'development')[]; gitBranch?: string; customEnvironmentIds?: string[]; idempotencyKey: string; approvalReference?: string }
export interface VercelEnvEditInput extends VercelEnvInput { envId: string }
export interface VercelEnvRemoveInput extends VercelProjectInput { envId: string; key: string; idempotencyKey: string; approvalReference?: string }
export interface VercelRuntimeLogsInput extends VercelProjectInput { deploymentId: string; limit?: number }
export interface VercelVcrRepositoryInput extends VercelProjectInput { name: string }
export interface VercelVcrCreateInput extends VercelVcrRepositoryInput { idempotencyKey: string }
