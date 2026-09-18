import type {
  AutomationMode,
  ConversationalSession,
  GateKind,
  PreviewHealth,
  WorkItem,
} from '../domain/types.js';

export interface OwnerInboxItem {
  projectId: string;
  workItemId: string;
  gate: GateKind;
  decision: string;
  whyHuman: string;
  resumeBehavior: string;
}

export interface ProjectCockpitView {
  projectId: string;
  automationMode: AutomationMode;
  preview: PreviewHealth;
  activeWork: WorkItem[];
  warmSessions: ConversationalSession[];
  ownerInbox: OwnerInboxItem[];
  releaseCandidate?: {
    id: string;
    sha: string;
    previewUrl?: string;
  };
}

export interface MissionControlView {
  projects: ProjectCockpitView[];
  ownerInbox: OwnerInboxItem[];
  providerHealth: Array<{
    provider: string;
    healthy: boolean;
    note?: string;
  }>;
}
