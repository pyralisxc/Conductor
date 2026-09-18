import type {
  Delegation,
  PreviewHealth,
  ProjectPolicy,
  WorkItem,
} from '../domain/types.js';

export interface WorkProvider {
  getWork(id: string): Promise<WorkItem | null>;
  updateWork(work: WorkItem): Promise<void>;
  createWork(work: WorkItem): Promise<void>;
}

export interface SourceProvider {
  getMainSha(projectId: string): Promise<string>;
  getPreviewSha(projectId: string): Promise<string>;
  createWorkBranch(projectId: string, name: string, fromSha: string): Promise<void>;
  integrateToPreview(projectId: string, branch: string): Promise<string>;
  createReleaseCandidate(projectId: string, fromSha: string): Promise<string>;
}

export interface PreviewProvider {
  getHealth(projectId: string): Promise<PreviewHealth>;
  getPreviewUrl(projectId: string, ref: string): Promise<string | null>;
}

export interface WorkflowProvider {
  dispatch(event: ConductorEvent): Promise<void>;
  suspendUntil(key: string, condition: string): Promise<void>;
}

export interface ProjectIntelligenceProvider {
  summarizeProject(projectId: string, ref?: string): Promise<string>;
  summarizeOverlap(projectId: string, workId: string): Promise<string>;
  summarizeMainPreviewDelta(projectId: string): Promise<string>;
}

export interface WorkerProvider {
  supports(capabilities: string[]): Promise<boolean>;
  delegate(delegation: Delegation): Promise<{ workerRunId: string }>;
  cancel(workerRunId: string): Promise<void>;
}

export interface NotificationProvider {
  notifyOwner(input: {
    projectId: string;
    workItemId?: string;
    title: string;
    body: string;
    deepLink?: string;
  }): Promise<void>;
}

export interface PolicyProvider {
  getProjectPolicy(projectId: string): Promise<ProjectPolicy>;
}

export type ConductorEvent =
  | { type: 'work.changed'; workItemId: string }
  | { type: 'worker.completed'; delegationId: string }
  | { type: 'ci.completed'; workItemId: string; passed: boolean }
  | { type: 'deployment.completed'; projectId: string; ref: string; healthy: boolean }
  | { type: 'owner.command'; projectId: string; command: string };
