import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAuthorization, type WorkEnvelope } from '../src/index.js';

function envelope(stage: WorkEnvelope['stage'] = 'build'): WorkEnvelope {
  return {
    project: 'pyralisxc/CardForge',
    objective: 'Retire CardForge Codebase MCP',
    constraints: ['Do not change CardForge product semantics'],
    stage,
    mode: stage === 'build' ? 'implement' : 'inspect',
    evidenceAppetite: 'targeted',
    activeFrontier: 'Prepare an evidence-backed Preview candidate',
    authorization: {
      id: 'grant-cf-retirement',
      actionClasses: ['inspect', 'develop', 'integrate-preview'],
      referent: 'cardforge-codebase-mcp-retirement-v1',
      exclusions: ['promote-main', 'admin-elevate'],
      issuedAt: '2026-09-20T00:00:00Z',
    },
    development: {},
    reality: { freshness: 'current' },
    capabilities: {
      available: ['github.contents.write'],
      permissionBlocked: [],
      unavailable: [],
    },
    gates: {},
  };
}

test('standing authorization permits ordinary development while Build is active', () => {
  const decision = evaluateAuthorization(envelope(), {
    actionClass: 'develop',
    project: 'pyralisxc/CardForge',
    referent: 'cardforge-codebase-mcp-retirement-v1',
  });
  assert.equal(decision.status, 'allowed');
  assert.equal(decision.grantId, 'grant-cf-retirement');
});

test('returning to Explore suspends mutation without deleting the standing grant', () => {
  const work = envelope('explore');
  const decision = evaluateAuthorization(work, {
    actionClass: 'develop',
    project: work.project,
    referent: work.authorization.referent,
  });
  assert.equal(decision.status, 'suspended');
  assert.equal(decision.grantId, work.authorization.id);
  assert.match(decision.reasons[0] ?? '', /explore/);
});

test('provider capability never substitutes for standing authorization', () => {
  const work = envelope();
  work.authorization.actionClasses = ['inspect'];
  assert.equal(work.capabilities.available.includes('github.contents.write'), true);
  const decision = evaluateAuthorization(work, {
    actionClass: 'develop',
    project: work.project,
    referent: work.authorization.referent,
  });
  assert.equal(decision.status, 'blocked');
});

test('main promotion requires approval bound to the exact candidate SHA', () => {
  const work = envelope();
  const request = {
    actionClass: 'promote-main' as const,
    project: work.project,
    referent: work.authorization.referent,
    candidateSha: 'a'.repeat(40),
  };
  assert.equal(evaluateAuthorization(work, request).status, 'human-gate');

  const wrong = evaluateAuthorization(work, {
    ...request,
    approval: {
      id: 'approval-1',
      actionClass: 'promote-main',
      project: work.project,
      referent: work.authorization.referent,
      candidateSha: 'b'.repeat(40),
      approvedAt: '2026-09-20T00:05:00Z',
    },
  });
  assert.equal(wrong.status, 'human-gate');

  const allowed = evaluateAuthorization(work, {
    ...request,
    approval: {
      id: 'approval-2',
      actionClass: 'promote-main',
      project: work.project,
      referent: work.authorization.referent,
      candidateSha: request.candidateSha,
      approvedAt: '2026-09-20T00:06:00Z',
    },
  });
  assert.equal(allowed.status, 'allowed');
  assert.equal(allowed.approvalId, 'approval-2');
});
