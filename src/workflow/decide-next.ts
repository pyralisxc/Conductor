import type {
  ConversationalSession,
  ProjectPolicy,
  WorkItem,
} from '../domain/types.js';
import { canIntegrateToPreview } from '../domain/policy.js';

export type NextAction =
  | { type: 'continue-session'; sessionId: string }
  | { type: 'wait'; reason: string }
  | { type: 'notify-founder'; reason: string }
  | { type: 'integrate-preview'; workItemId: string }
  | { type: 'dispatch-worker'; workItemId: string }
  | { type: 'none'; reason: string };

export function decideNextAction(input: {
  work: WorkItem;
  policy: ProjectPolicy;
  session?: ConversationalSession;
  deterministicWaitReason?: string;
  delegatedWorkerPending?: boolean;
}): NextAction {
  const { work, policy, session, deterministicWaitReason, delegatedWorkerPending } = input;

  if (policy.automationMode === 'hold') {
    return { type: 'wait', reason: 'project automation is on hold' };
  }

  if (work.humanGate) {
    return { type: 'notify-founder', reason: `human gate: ${work.humanGate}` };
  }

  if (deterministicWaitReason) {
    return { type: 'wait', reason: deterministicWaitReason };
  }

  if (delegatedWorkerPending) {
    return { type: 'wait', reason: 'delegated worker has not returned' };
  }

  if (
    session &&
    session.state === 'warm' &&
    session.autoContinue &&
    !session.humanInputRequired &&
    work.currentFrontier
  ) {
    return { type: 'continue-session', sessionId: session.id };
  }

  const preview = canIntegrateToPreview(work, policy);
  if (preview.allowed) {
    return { type: 'integrate-preview', workItemId: work.id };
  }

  if (work.workState === 'ready' && work.buildAuthorized) {
    return { type: 'dispatch-worker', workItemId: work.id };
  }

  return { type: 'none', reason: 'no currently authorized self-executable transition' };
}
