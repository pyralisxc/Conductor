import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderUsageTracker } from '../src/providers/usage.js';

test('provider usage tracker measures calls, duplicate reads, request bytes, and truthful response-byte coverage', async () => {
  let now = Date.parse('2026-09-28T00:00:00Z');
  const tracker = new ProviderUsageTracker('example', () => now, 30_000);
  const rawFetch: typeof globalThis.fetch = async () => new Response('okay', {
    headers: { 'content-length': '4' },
  });

  await tracker.fetch(rawFetch, 'https://example.test/resource');
  now += 1_000;
  await tracker.fetch(rawFetch, 'https://example.test/resource');
  now += 31_000;
  await tracker.fetch(rawFetch, 'https://example.test/resource');
  await tracker.fetch(rawFetch, 'https://example.test/write', {
    method: 'POST',
    body: JSON.stringify({ ok: true }),
  });

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.provider, 'example');
  assert.equal(snapshot.calls, 4);
  assert.equal(snapshot.duplicateReads, 1);
  assert.equal(snapshot.requestBodyBytes, Buffer.byteLength(JSON.stringify({ ok: true })));
  assert.equal(snapshot.reportedResponseBytes, 16);
  assert.equal(snapshot.responsesWithUnknownBytes, 0);
});

test('provider usage tracker does not invent response bytes when Content-Length is absent', async () => {
  const tracker = new ProviderUsageTracker('example');
  await tracker.fetch(async () => Response.json({ ok: true }), 'https://example.test/resource');
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.calls, 1);
  assert.equal(snapshot.reportedResponseBytes, 0);
  assert.equal(snapshot.responsesWithUnknownBytes, 1);
});
