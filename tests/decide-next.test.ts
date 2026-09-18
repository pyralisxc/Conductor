import test from 'node:test';
import assert from 'node:assert/strict';
import { decideNextAction } from '../src/workflow/decide-next.js';
import type {
  ConversationalSession,
  ProjectPolicy,
  WorkItem,
} from '../src/domain/types.js';

const policy: ProjectPolicy = {
  projectId: 'cardforge',
  automationMode: 'preview-autonomous',
  mainBranch: 'main',
  previewBranch: 'preview',
  mainHumanApprovalRequired: true,
  allowProvenRepairToPreview: true,
  allowAutomaticPreviewIntegration: true,
};

const work: WorkItem = {
  id: 'CF-421',
  projectId: 'cardforge',
  title: 'Artifact editing',
  objective: 'Create Artifact-native editing',
  ambition: 'Preserve spatial orientation',
  workState: 'working',
  devosStage: 'build',
  ownerClass: 'interactive-session',
  evidenceAppetite: 'targeted',
  buildAuthorized: true,
  currentFrontier: 'Review delegated browser evidence',
};

const session: ConversationalSession = {
  id: 'chat-a',
  projectId: 'cardforge',
  workItemIds: ['CF-421'],
  state: 'warm',
  autoContinue: true,
  currentFrontier: 'Review delegated browser evidence',
  humanInputRequired: false,
};

test('warm productive session is continued before replacement', () => {
  assert.deepEqual(
    decideNextAction({ work, policy, session }),
    { type: 'continue-session', sessionId: 'chat-a' },
  );
});

test('deterministic waiting takes the model out of the loop', () => {
  assert.deepEqual(
    decideNextAction({
      work,
      policy,
      session,
      deterministicWaitReason: 'CI in progress',
    }),
    { type: 'wait', reason: 'CI in progress' },
  );
});

test('founder gate wins over continuation', () => {
  assert.equal(
    decideNextAction({
      work: { ...work, humanGate: 'founder-semantics' },
      policy,
      session,
    }).type,
    'notify-founder',
  );
});
