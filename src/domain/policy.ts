import type { ProjectPolicy, WorkItem } from './types.js';

export interface PreviewIntegrationDecision {
  allowed: boolean;
  reasons: string[];
}

export function canIntegrateToPreview(
  work: WorkItem,
  policy: ProjectPolicy,
): PreviewIntegrationDecision {
  const reasons: string[] = [];

  if (policy.automationMode === 'hold') reasons.push('project automation is on hold');
  if (work.holdIntegration) reasons.push('work item integration is explicitly held');
  if (!work.buildAuthorized) reasons.push('build/integration referent is not authorized');
  if (work.humanGate) reasons.push(`human gate is active: ${work.humanGate}`);

  if (
    policy.automationMode !== 'preview-autonomous' ||
    !policy.allowAutomaticPreviewIntegration
  ) {
    reasons.push('automatic Preview integration is not enabled by project policy');
  }

  if (work.workState !== 'working' && work.workState !== 'ready') {
    reasons.push(`work state ${work.workState} is not integration-eligible`);
  }

  return { allowed: reasons.length === 0, reasons };
}

export function canPromoteToMain(): false {
  // Hard v0.1 invariant: Conductor never infers production approval.
  return false;
}
