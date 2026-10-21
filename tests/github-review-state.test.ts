import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewReaderFixture, reviewRow, commentRow } from './helpers/github-review-reader.js';

test('fresh review reader recognizes edits, dismissal and comment lifecycle without text or provider URLs', async () => {
  const f = reviewReaderFixture(); const first = await f.read();
  assert.equal(first.currentHeadApprovals, 1);
  f.data.reviews[0].body = 'CHANGED PRIVATE TEXT'; const edited = await f.read();
  assert.notEqual(edited.revision, first.revision); assert.notEqual(edited.latest[0].version, first.latest[0].version);
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
  const result = await f.read(); assert.equal(result.currentHeadApprovals, 0);
  assert.deepEqual(result.latest.map(r => r.id), [2, 3, 5]); assert.equal(result.latest[1].currentHead, false);
  f.data.reviews.reverse(); assert.deepEqual(await f.read(), result);
});

test('pagination exhausts bounded pages; full final pages never claim latest decisions or comment deletions', async () => {
  const f = reviewReaderFixture(); f.data.reviews = Array.from({ length: 51 }, (_, i) => reviewRow(i + 1));
  assert.equal((await f.read()).latest.length, 51); assert.ok(f.paths.some(p => p.endsWith('/reviews?per_page=50&page=2')));
  for (const kind of ['reviews', 'comments'] as const) {
    f.data.reviews = [reviewRow()]; f.data.comments = [commentRow()];
    if (kind === 'reviews') f.data.reviews = Array.from({ length: 101 }, (_, i) => reviewRow(i + 1));
    else f.data.comments = Array.from({ length: 101 }, (_, i) => commentRow(i + 1));
    const partial = await f.read(); assert.equal(partial.complete, false); assert.equal(partial.reason, 'page-limit');
    assert.equal(partial.currentHeadApprovals, null); assert.deepEqual(partial.latest, []); assert.deepEqual(partial.comments, []);
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
