export const TOOL_RUNTIME_CONTRACT_VERSION = 'conductor.tool-runtime.v0' as const;

export type ToolOperationName = 'capabilities' | 'preflight_project';

export type PreflightIntent = 'inspect' | 'develop' | 'execute';

export type MutationOperationName =
  | 'git.branch.create'
  | 'git.commit.create'
  | 'git.push'
  | 'pull-request.create'
  | 'pull-request.comment.create';

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

export interface CreateBranchInput {
  project: ProjectReference;
  branch: string;
  fromSha: string;
  idempotencyKey: string;
}

export interface CreateCommitFile {
  path: string;
  content: string;
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
  base: 'preview';
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
