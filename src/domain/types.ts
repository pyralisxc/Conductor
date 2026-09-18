export type WorkState =
  | 'proposed'
  | 'shaping'
  | 'ready'
  | 'working'
  | 'preview'
  | 'needs-founder'
  | 'promotion-ready'
  | 'done';

export type DevOSStage =
  | 'explore'
  | 'resolve'
  | 'crystallize'
  | 'build'
  | 'accept-deliver';

export type OwnerClass =
  | 'interactive-session'
  | 'autonomous-worker'
  | 'deterministic-automation'
  | 'human'
  | 'waiting-on-event';

export type SessionState =
  | 'warm'
  | 'waiting'
  | 'human-gate'
  | 'rotation-candidate'
  | 'superseded'
  | 'retired';

export type EvidenceAppetite = 'representative' | 'targeted' | 'exhaustive';
export type AutomationMode = 'observe' | 'assisted' | 'preview-autonomous' | 'hold';

export type GateKind =
  | 'founder-semantics'
  | 'consequence'
  | 'experiential-acceptance'
  | 'integration-conflict'
  | 'main-promotion';

export interface WorkItem {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  ambition?: string;
  workState: WorkState;
  devosStage: DevOSStage;
  ownerClass: OwnerClass;
  evidenceAppetite: EvidenceAppetite;
  currentFrontier?: string;
  buildAuthorized: boolean;
  branch?: string;
  pullRequest?: number;
  integratedPreviewSha?: string;
  parentSessionId?: string;
  humanGate?: GateKind;
  holdIntegration?: boolean;
}

export interface ConversationalSession {
  id: string;
  projectId: string;
  workItemIds: string[];
  state: SessionState;
  autoContinue: boolean;
  currentFrontier?: string;
  humanInputRequired: boolean;
  rotationReason?: string;
}

export interface ProjectPolicy {
  projectId: string;
  automationMode: AutomationMode;
  mainBranch: string;
  previewBranch: string;
  mainHumanApprovalRequired: true;
  allowProvenRepairToPreview: boolean;
  allowAutomaticPreviewIntegration: boolean;
}

export interface PreviewHealth {
  projectId: string;
  healthy: boolean;
  mainSha: string;
  previewSha: string;
  deploymentUrl?: string;
  failingChecks: string[];
}

export interface Delegation {
  id: string;
  workItemId: string;
  parentSessionId?: string;
  objective: string;
  authorizationScope: string[];
  requiredCapabilities: string[];
  returnCondition: string;
}
