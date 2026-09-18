import test from 'node:test';
import assert from 'node:assert/strict';
import { canIntegrateToPreview, canPromoteToMain } from '../src/domain/policy.js';
import type { ProjectPolicy, WorkItem } from '../src/domain/types.js';

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
  id: 'CF-1',
  projectId: 'cardforge',
  title: 'Repair established defect',
  objective: 'Restore established reaction behavior',
  workState: 'working',
  devosStage: 'build',
  ownerClass: 'autonomous-worker',
  evidenceAppetite: 'targeted',
  buildAuthorized: true,
};

test('authorized work may integrate to Preview under Preview Autonomous policy', () => {
  assert.equal(canIntegrateToPreview(work, policy).allowed, true);
});

test('human gate blocks automatic Preview integration', () => {
  assert.equal(
    canIntegrateToPreview({ ...work, humanGate: 'founder-semantics' }, policy).allowed,
    false,
  );
});

test('main promotion is never inferred by Conductor', () => {
  assert.equal(canPromoteToMain(), false);
});
