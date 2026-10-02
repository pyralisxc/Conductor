import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVcrRetentionTargets, planVcrRetention, runVcrRetentionTarget, vcrRetentionCronAuthorized, type VcrRetentionTarget } from '../src/maintenance/vcr-retention.js';

const sha = (c: string) => c.repeat(40);
const deployment = (id: string, sourceRevision: string, createdAt: string, target: string | null, sourceRef = 'main') => ({
  id, url: null, state: 'READY', target, createdAt, readyAt: createdAt, sourceRevision, sourceRef,
  sourceRepository: 'owner/app', aliases: [], errorCode: null, errorMessage: null,
});

test('retention config accepts generic flat and nested targets', () => {
  const targets = parseVcrRetentionTargets(JSON.stringify({ targets: [
    { id: 'Development-Intelligence', repository: 'pyralisxc/Development-Intelligence', vcrRepository: 'dockerfile' },
    { project: { id: 'Other', repository: 'owner/other' }, name: 'container', retainedImageTarget: 12 },
  ] }));
  assert.deepEqual(targets[0]?.project, { id: 'Development-Intelligence', repository: 'pyralisxc/Development-Intelligence' });
  assert.equal(targets[0]?.name, 'dockerfile');
  assert.equal(targets[0]?.retainedImageTarget, 10);
  assert.equal(targets[1]?.retainedImageTarget, 12);
});

test('planner protects current production, distinct rollback and latest Preview across duplicate production SHAs', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const images = [
    { imageId: 'current', manifestDigest: 'sha256:current', tags: [sha('a').slice(0, 12)], createdAt: '2026-09-20T00:00:00Z' },
    { imageId: 'duplicate-current', manifestDigest: 'sha256:duplicate', tags: [sha('a').slice(0, 12)], createdAt: '2026-09-20T00:00:00Z' },
    { imageId: 'rollback', manifestDigest: 'sha256:rollback', tags: [sha('b').slice(0, 12)], createdAt: '2026-09-20T00:00:00Z' },
    { imageId: 'preview', manifestDigest: 'sha256:preview', tags: [sha('c').slice(0, 12)], createdAt: '2026-09-20T00:00:00Z' },
    { imageId: 'expired', manifestDigest: 'sha256:expired', tags: [sha('d').slice(0, 12)], createdAt: '2026-09-20T00:00:00Z' },
    { imageId: 'untagged', manifestDigest: 'sha256:untagged', tags: [], createdAt: '2026-09-20T00:00:00Z' },
  ];
  const deployments = [
    deployment('prod', sha('a'), '2026-10-02T11:00:00Z', 'production'),
    deployment('prod-duplicate', sha('a'), '2026-10-02T10:00:00Z', 'production'),
    deployment('rollback', sha('b'), '2026-10-01T10:00:00Z', 'production'),
    deployment('preview', sha('c'), '2026-10-02T11:30:00Z', null, 'preview'),
    deployment('expired', sha('d'), '2026-09-20T00:00:00Z', null, 'preview'),
  ] as any;
  const actions = new Map(planVcrRetention({ images, deployments, now }).decisions.map(d => [d.id, d.action]));
  assert.equal(actions.get('current'), 'keep');
  assert.equal(actions.get('duplicate-current'), 'keep');
  assert.equal(actions.get('rollback'), 'keep');
  assert.equal(actions.get('preview'), 'keep');
  assert.equal(actions.get('expired'), 'delete');
  assert.equal(actions.get('untagged'), 'delete');
});

test('cron auth fails closed', () => {
  assert.equal(vcrRetentionCronAuthorized(undefined, undefined), false);
  assert.equal(vcrRetentionCronAuthorized('Bearer wrong', 'right'), false);
  assert.equal(vcrRetentionCronAuthorized('Bearer right', 'right'), true);
});

test('runner paginates, deletes exact id/digest and re-reads inventory', async () => {
  const target: VcrRetentionTarget = { project: { id: 'app' }, name: 'dockerfile', enabled: true, retainedImageTarget: 1, nonProductionDays: 1, productionDays: 7, rollbackCount: 0, previewBranches: ['preview'], maxPages: 3 };
  const live = new Map<string, any>([
    ['keep', { imageId: 'keep', manifestDigest: 'sha256:keep', tags: [sha('a').slice(0, 12)], createdAt: '2026-10-02T00:00:00Z', sizeInBytes: 100 }],
    ['delete', { imageId: 'delete', manifestDigest: 'sha256:delete', tags: [], createdAt: '2026-09-20T00:00:00Z', sizeInBytes: 50 }],
  ]);
  const deleted: string[] = [];
  let firstPageReads = 0;
  const runtime = {
    async deploymentStatus() { return { status: 'succeeded', result: { production: deployment('prod', sha('a'), '2026-10-02T00:00:00Z', 'production'), recent: [] } }; },
    async deploymentVcrImagesList(input: any) {
      const all = [...live.values()];
      if (!input.cursor) { firstPageReads += 1; if (all.length > 1) return { status: 'succeeded', result: { images: [all[0]], nextCursor: 'next' } }; }
      return { status: 'succeeded', result: { images: input.cursor ? all.slice(1) : all, nextCursor: null } };
    },
    async vercelVcrImageDelete(input: any) {
      assert.equal(live.get(input.imageId)?.manifestDigest, input.expectedManifestDigest);
      deleted.push(input.imageId); live.delete(input.imageId);
      return { status: 'succeeded', result: { deleted: true, verified: true } };
    },
  } as any;
  const result = await runVcrRetentionTarget(runtime, target, Date.parse('2026-10-02T12:00:00Z'));
  assert.deepEqual(deleted, ['delete']);
  assert.equal(result.beforeImages, 2);
  assert.equal(result.afterImages, 1);
  assert.equal(result.reclaimedKnownBytes, 50);
  assert.ok(firstPageReads >= 2);
});

test('runner stops immediately on a partial delete failure', async () => {
  const target: VcrRetentionTarget = { project: { id: 'app' }, name: 'dockerfile', enabled: true, retainedImageTarget: 1, nonProductionDays: 1, productionDays: 7, rollbackCount: 0, previewBranches: ['preview'], maxPages: 2 };
  const images = [
    { imageId: 'one', manifestDigest: 'sha256:one', tags: [], createdAt: '2026-09-20T00:00:00Z' },
    { imageId: 'two', manifestDigest: 'sha256:two', tags: [], createdAt: '2026-09-20T00:00:00Z' },
  ];
  const attempted: string[] = [];
  const runtime = {
    async deploymentStatus() { return { status: 'succeeded', result: { production: null, recent: [] } }; },
    async deploymentVcrImagesList() { return { status: 'succeeded', result: { images, nextCursor: null } }; },
    async vercelVcrImageDelete(input: any) { attempted.push(input.imageId); return { status: 'failed', error: { message: 'provider denied delete' } }; },
  } as any;
  await assert.rejects(runVcrRetentionTarget(runtime, target, Date.parse('2026-10-02T12:00:00Z')), /provider denied delete/u);
  assert.deepEqual(attempted, ['one']);
});
