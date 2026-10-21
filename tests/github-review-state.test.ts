import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewReaderFixture, reviewRow, commentRow } from './helpers/github-review-reader.js';

test('fresh review reader recognizes edits, dismissal and comment lifecycle without text or provider URLs', async () => {
  const f = reviewReaderFixture(); const first = await f.read();
  assert.equal(first.currentHeadApprovals, 1);
  f.data.reviews[0].body = 'CHANGED PRIVATE TEXT'; const edited = await f.read();
  assert.notEqual(edited.revision, first.revision); assert.notEqual(edited.latestActivity[0].version, first.latestActivity[0].version);
  f.data.reviews[0].state = 'DISMISSED'; assert.equal((await f.read()).currentHeadApprovals, 0);
  f.data.comments.push(commentRow(2)); const added = await f.read(); assert.equal(added.comments.length, 2);
  f.data.comments[0].body = 'EDITED COMMENT'; const changed = await f.read(); assert.notEqual(changed.revision, added.revision);
  f.data.comments.splice(0, 1); const deleted = await f.read(); assert.deepEqual(deleted.comments.map(c => c.id), [2]);
  assert.equal(deleted.comments[0].url, 'https://github.com/owner/repo/pull/7#discussion_r2');
  assert.doesNotMatch(JSON.stringify([first, edited, added, changed, deleted]), /PRIVATE|EDITED COMMENT|malicious|SECRET|test-token/);
});

test('latest submitted review per reviewer never counts stale-head, dismissed, pending or historical approval', async () => {
  const f = reviewReaderFixture();
  f.data.reviews = [reviewRow(1), reviewRow(2, { user: { id: 1, login: 'reviewer-1' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-21T01:00:00Z' }), reviewRow(3, { commit_id: 'c'.repeat(40) }), reviewRow(4, { state: 'PENDING', submitted_at: null }), reviewRow(5, { state: 'DISMISSED' })];
  const result = await f.read(); assert.equal(result.currentHeadApprovals, null);
  assert.deepEqual(result.latestActivity.map(r => r.id), [2, 3, 5]); assert.equal(result.latestActivity[1].currentHead, false);
  f.data.reviews.reverse(); assert.deepEqual(await f.read(), result);
});

test('pagination exhausts bounded pages; full final pages never claim latest decisions or comment deletions', async () => {
  const f = reviewReaderFixture(); f.data.reviews = Array.from({ length: 51 }, (_, i) => reviewRow(i + 1));
  assert.equal((await f.read()).latestActivity.length, 51); assert.ok(f.paths.some(p => p.endsWith('/reviews?per_page=50&page=2')));
  for (const kind of ['reviews', 'comments'] as const) {
    f.data.reviews = [reviewRow()]; f.data.comments = [commentRow()];
    if (kind === 'reviews') f.data.reviews = Array.from({ length: 101 }, (_, i) => reviewRow(i + 1));
    else f.data.comments = Array.from({ length: 101 }, (_, i) => commentRow(i + 1));
    const partial = await f.read(); assert.equal(partial.complete, false); assert.equal(partial.reason, 'page-limit');
    assert.equal(partial.currentHeadApprovals, null); assert.equal(partial.effectiveDecisions, null); assert.deepEqual(partial.latestActivity, []); assert.deepEqual(partial.comments, []);
  }
  assert.ok(!f.paths.some(p => p.includes('page=3')));
});

test('reader rejects duplicate pagination, malformed metadata, foreign installation and exact-resource drift', async () => {
  const duplicate = reviewReaderFixture(); duplicate.data.reviews = [reviewRow(), reviewRow()]; await assert.rejects(duplicate.read(), /pagination/);
  const invalid = reviewReaderFixture(); invalid.data.comments[0].updated_at = 'arbitrary text'; await assert.rejects(invalid.read());
  for (const field of ['head', 'base', 'baseRef', 'repository'] as const) {
    const f = reviewReaderFixture(); f.data[field] = 'wrong'; await assert.rejects(f.read(), /wait changed/);
  }
  const wrongPr = reviewReaderFixture(); wrongPr.data.number = 8; await assert.rejects(wrongPr.read(), /wait changed/);
  const foreign = reviewReaderFixture(); foreign.credential.identity.installationId = 456; await assert.rejects(foreign.read(), /installation/); assert.equal(foreign.paths.length, 0);
  const staticToken = reviewReaderFixture(); staticToken.credential.kind = 'static-token'; await assert.rejects(staticToken.read(), /installation/);
  const drift = reviewReaderFixture(); drift.beforeFetch(() => { if (drift.paths.length === 3) drift.data.head = 'd'.repeat(40); }); await assert.rejects(drift.read(), /wait changed/);
});

test('grant authorization is checked before every private request and after in-flight reads', async () => {
  const f = reviewReaderFixture(); let revoked = true;
  const authorize = async () => { if (revoked) throw new Error('grant revoked'); };
  await assert.rejects(f.read(authorize), /revoked/); assert.equal(f.paths.length, 0);
  revoked = false; f.beforeFetch(() => { if (f.paths.length === 2) revoked = true; });
  await assert.rejects(f.read(authorize), /revoked/); assert.equal(f.paths.length, 2);
});

test('COMMENTED preserves effective request/approval while remaining latest activity', async () => {
  for (const state of ['CHANGES_REQUESTED', 'APPROVED']) {
    const f = reviewReaderFixture();
    f.data.reviews = [reviewRow(1, { state }), reviewRow(2, { user: { id: 1, login: 'reviewer-1' }, state: 'COMMENTED' })];
    const result = await f.read();
    assert.equal(result.latestActivity[0].state, 'COMMENTED');
    assert.equal(result.effectiveDecisions![0].state, state); assert.equal(result.effectiveDecisions![0].reviewId, 1);
    assert.equal(result.currentHeadApprovals, state === 'APPROVED' ? 1 : 0);
  }
});

test('subsequent current-head approval resolves only its reviewer; stale approval cannot clear a request', async () => {
  const f = reviewReaderFixture();
  f.data.reviews = [reviewRow(1, { state: 'CHANGES_REQUESTED' }), reviewRow(2, { state: 'CHANGES_REQUESTED' }),
    reviewRow(3, { user: { id: 1, login: 'reviewer-1' } }), reviewRow(4, { user: { id: 1, login: 'reviewer-1' }, state: 'COMMENTED' })];
  const result = await f.read();
  assert.deepEqual(result.effectiveDecisions!.map(d => [d.reviewer?.id, d.state]), [[2, 'CHANGES_REQUESTED'], [1, 'APPROVED']]);
  assert.equal(result.currentHeadApprovals, 1);
  f.data.reviews[2].commit_id = 'c'.repeat(40);
  const stale = await f.read(); assert.equal(stale.currentHeadApprovals, 0);
  assert.ok(stale.effectiveDecisions!.every(d => d.state === 'CHANGES_REQUESTED'));
  f.data.reviews[0].commit_id = 'd'.repeat(40); // A stale-head request still needs resolution.
  assert.ok((await f.read()).effectiveDecisions!.every(d => d.state === 'CHANGES_REQUESTED'));
});

test('provider dismissal clears that review only and never revives older approval', async () => {
  const f = reviewReaderFixture(); f.data.reviews = [reviewRow(1, { state: 'CHANGES_REQUESTED' }), reviewRow(2, { user: { id: 1, login: 'reviewer-1' }, state: 'COMMENTED' })];
  assert.equal((await f.read()).effectiveDecisions![0].state, 'CHANGES_REQUESTED');
  f.data.reviews[0].state = 'DISMISSED';
  assert.equal((await f.read()).effectiveDecisions![0].state, 'NONE');
  f.data.reviews = [reviewRow(1), reviewRow(2, { user: { id: 1, login: 'reviewer-1' }, state: 'DISMISSED' })];
  assert.equal((await f.read()).effectiveDecisions![0].state, 'UNKNOWN');
  assert.equal((await f.read()).currentHeadApprovals, null);
  f.data.reviews[0].state = 'CHANGES_REQUESTED';
  assert.equal((await f.read()).effectiveDecisions![0].state, 'CHANGES_REQUESTED');
  f.data.reviews.push(reviewRow(3, { user: { id: 1, login: 'reviewer-1' } }));
  assert.equal((await f.read()).effectiveDecisions![0].state, 'APPROVED');
});

test('stale approval and unidentified reviewer remain unknown; comments cannot manufacture a decision', async () => {
  const f = reviewReaderFixture(); f.data.reviews = [reviewRow(1, { commit_id: 'c'.repeat(40) }), reviewRow(2, { user: { id: 1, login: 'reviewer-1' }, state: 'COMMENTED' }), reviewRow(3, { user: null })];
  const result = await f.read(); assert.equal(result.currentHeadApprovals, null);
  assert.ok(result.effectiveDecisions!.every(d => d.state === 'UNKNOWN'));
  f.data.reviews = [reviewRow(1, { state: 'COMMENTED' })];
  assert.equal((await f.read()).effectiveDecisions![0].state, 'NONE');
});
