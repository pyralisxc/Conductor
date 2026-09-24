import type { DevOSStage, EvidenceAppetite } from './types.js';

export type WorkMode =
  | 'inspect'
  | 'audit'
  | 'shape'
  | 'diagnose'
  | 'implement'
  | 'repair'
  | 'deliver';

export type ActionClass =
  | 'inspect'
  | 'route-work'
  | 'develop'
  | 'integrate-preview'
  | 'promote-main'
  | 'admin-elevate';

export interface AuthorizationGrant {
  id: string;
  actionClasses: ActionClass[];
  referent: string;
  /** Exact destination repositories permitted for routing outside the active project. */
  routingDestinations?: string[];
  exclusions: ActionClass[];
  issuedAt: string;
  expiresOn?: string;
  status?: 'active' | 'revoked';
}

export interface DevelopmentState {
  baseRevision?: string;
  workBranch?: string;
  pullRequest?: number;
  previewRevision?: string;
}

export interface RealityState {
  sourceRevision?: string;
  intelligenceRevision?: string;
  freshness: 'current' | 'stale' | 'unknown';
}

export interface CapabilityState {
  available: string[];
  permissionBlocked: string[];
  unavailable: string[];
}

export interface GateState {
  humanDecision?: string;
  experientialAcceptance?: string;
  permissionElevation?: string;
  providerSignIn?: string;
  mainPromotion?: string;
}

export interface WorkEnvelope {
  project: string;
  objective: string;
  ambition?: string;
  constraints: string[];
  stage: DevOSStage;
  mode: WorkMode;
  evidenceAppetite: EvidenceAppetite;
  activeFrontier?: string;
  authorization: AuthorizationGrant;
  development: DevelopmentState;
  reality: RealityState;
  capabilities: CapabilityState;
  gates: GateState;
  lastEffect?: string;
  resumeCondition?: string;
}

export interface ConsequentialApproval {
  id: string;
  actionClass: 'promote-main' | 'admin-elevate';
  project: string;
  referent: string;
  approvedAt: string;
  expiresOn?: string;
  candidateSha?: string;
}

export interface AuthorizationRequest {
  actionClass: ActionClass;
  project: string;
  referent: string;
  candidateSha?: string;
  now?: Date;
  approval?: ConsequentialApproval;
}

export interface AuthorizationDecision {
  status: 'allowed' | 'suspended' | 'blocked' | 'human-gate';
  reasons: string[];
  grantId?: string;
  approvalId?: string;
}

/** Development OS authorization for the work-item.create routing operation. */
export function evaluateWorkItemCreationAuthorization(
  envelope: WorkEnvelope,
  request: Omit<AuthorizationRequest, 'actionClass' | 'candidateSha' | 'approval'>,
): AuthorizationDecision {
  return evaluateAuthorization(envelope, { ...request, actionClass: 'route-work' });
}

export function evaluateAuthorization(
  envelope: WorkEnvelope,
  request: AuthorizationRequest,
): AuthorizationDecision {
  const now = request.now ?? new Date();
  const reasons: string[] = [];
  const grant = envelope.authorization;

  if (request.project !== envelope.project && (
    request.actionClass !== 'route-work' ||
    !grant.routingDestinations?.includes(request.project)
  )) reasons.push('project is outside the authorized routing scope');
  if (request.referent !== grant.referent) reasons.push('authorization referent changed');
  if (grant.status === 'revoked') reasons.push('authorization grant was revoked');
  if (grant.expiresOn && Date.parse(grant.expiresOn) <= now.getTime()) reasons.push('authorization grant expired');
  if (reasons.length > 0) return { status: 'blocked', reasons, grantId: grant.id };

  if (request.actionClass === 'promote-main' || request.actionClass === 'admin-elevate') {
    const approvalReasons = validateApproval(envelope, request, now);
    if (approvalReasons.length > 0) {
      return { status: 'human-gate', reasons: approvalReasons, grantId: grant.id };
    }
    return {
      status: 'allowed',
      reasons: [],
      grantId: grant.id,
      approvalId: request.approval?.id,
    };
  }

  if (grant.exclusions.includes(request.actionClass)) {
    return {
      status: 'blocked',
      reasons: [`action class ${request.actionClass} is explicitly excluded`],
      grantId: grant.id,
    };
  }

  if (!grant.actionClasses.includes(request.actionClass)) {
    return {
      status: 'blocked',
      reasons: [`action class ${request.actionClass} is outside the standing authorization`],
      grantId: grant.id,
    };
  }

  if (
    (request.actionClass === 'develop' || request.actionClass === 'integrate-preview') &&
    envelope.stage !== 'build'
  ) {
    return {
      status: 'suspended',
      reasons: [`Dev OS stage ${envelope.stage} suspends repository mutation`],
      grantId: grant.id,
    };
  }

  return { status: 'allowed', reasons: [], grantId: grant.id };
}

function validateApproval(
  envelope: WorkEnvelope,
  request: AuthorizationRequest,
  now: Date,
): string[] {
  const approval = request.approval;
  if (!approval) return [`${request.actionClass} requires an exact owner approval`];
  const reasons: string[] = [];
  if (approval.actionClass !== request.actionClass) reasons.push('approval action class does not match');
  if (approval.project !== envelope.project) reasons.push('approval project does not match');
  if (approval.referent !== request.referent) reasons.push('approval referent does not match');
  if (approval.expiresOn && Date.parse(approval.expiresOn) <= now.getTime()) reasons.push('approval expired');
  if (request.actionClass === 'promote-main') {
    if (!request.candidateSha) reasons.push('promotion candidate SHA is required');
    if (approval.candidateSha !== request.candidateSha) reasons.push('approval candidate SHA does not match');
  }
  return reasons;
}
