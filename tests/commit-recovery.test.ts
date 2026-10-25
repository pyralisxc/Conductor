import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  ConductorToolRuntime, GitHubRuntimeProvider, IdempotentMutationExecutor, InMemoryIdempotencyStore,
  createConductorHttpHandler,
  type CommitCheckpoint, type CreateCommitInput, type IdempotencyRecord, type ExecutionReceipt,
} from '../src/index.js';
import { WorkScopeAuthorizer } from '../src/transport/work-scope.js';

process.env.CONDUCTOR_SESSION_SECRET = 'commit-recovery-test-context-signing-secret';

const repository = 'pyralisxc/conductor';
const project = { id: repository, repository };
const base = 'a'.repeat(40), parentTree = 'b'.repeat(40), tree = 'c'.repeat(40), candidate = 'd'.repeat(40), later = 'e'.repeat(40);
const caller = { clientId: 'client-original' };
const input: CreateCommitInput = { project, branch: 'work/304-recovery', expectedHeadSha: base,
  message: 'private commit message not retained', files: [{ path: 'source.ts', content: 'private source payload Ω' }, { path: 'retired.ts', content: null }], idempotencyKey: 'commit:304:fault-proof' };

class CapturingStore extends InMemoryIdempotencyStore {
  snapshots: string[] = [];
  candidateOutage = false;
  override async claim(record: IdempotencyRecord) {
    this.snapshots.push(JSON.stringify(record));
    return super.claim(record);
  }
  override async checkpoint(key: string, fingerprint: string, operationId: string, value: CommitCheckpoint, updatedAt: string) {
    if (this.candidateOutage && value.phase === 'commit-created') throw new Error('Checkpoint store unavailable');
    const record = await super.checkpoint(key, fingerprint, operationId, value, updatedAt);
    this.snapshots.push(JSON.stringify(record));
    return record;
  }
  override async complete(key: string, fingerprint: string, receipt: ExecutionReceipt<unknown>) {
    const result = await super.complete(key, fingerprint, receipt);
    this.snapshots.push(JSON.stringify(await this.get(key)));
    return result;
  }
}

type Fault = 'none' | 'ref-lost-applied' | 'ref-lost-not-applied' | 'tree-lost' | 'commit-lost';
function fixture(fault: Fault = 'none', options: { waitForTree?: Promise<void> } = {}) {
  let head = base;
  let parentMismatch = false;
  let compareAhead = false;
  const calls: { path: string; method: string; body?: any }[] = [];
  const store = new CapturingStore();
  const provider = new GitHubRuntimeProvider({
    allowedOwners: ['pyralisxc'], bindings: [{ id: 'Conductor', repository }],
    credentials: {
      async getIdentity() { return { kind: 'app' as const, appId: '12345' }; },
      async getCredential(repo) { return { token: 'never-persist-this-token', kind: 'app-installation' as const,
        identity: { kind: 'app' as const, appId: '12345', installationId: 42 }, repository: repo, permissions: { contents: 'write' as const } }; },
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, method, body });
      if (method === 'GET' && path.includes('/git/ref/heads/')) return Response.json({ object: { sha: head } });
      if (method === 'GET' && path.endsWith(`/git/commits/${base}`)) return Response.json({ sha: base, tree: { sha: parentTree }, parents: [] });
      if (method === 'GET' && path.endsWith(`/git/commits/${candidate}`)) return Response.json({ sha: candidate, tree: { sha: tree }, parents: [{ sha: parentMismatch ? later : base }] });
      if (method === 'GET' && path.includes('/compare/')) return Response.json({ status: compareAhead ? 'ahead' : 'diverged', merge_base_commit: { sha: compareAhead ? candidate : base } });
      if (method === 'POST' && path.endsWith('/git/trees')) {
        await options.waitForTree;
        if (fault === 'tree-lost') throw Object.assign(new Error('Lost immutable tree response'), { code: 'ECONNRESET' });
        return Response.json({ sha: tree });
      }
      if (method === 'POST' && path.endsWith('/git/commits')) {
        if (fault === 'commit-lost') throw Object.assign(new Error('Lost immutable commit response'), { code: 'ECONNRESET' });
        return Response.json({ sha: candidate });
      }
      if (method === 'PATCH' && path.includes('/git/refs/heads/')) {
        assert.deepEqual(body, { sha: candidate, force: false });
        if (fault !== 'ref-lost-not-applied') head = candidate;
        if (fault.startsWith('ref-lost')) throw Object.assign(new Error('Lost ref response'), { code: 'ECONNRESET' });
        return Response.json({ object: { sha: candidate } });
      }
      throw new Error(`Unexpected provider request ${method} ${path}`);
    },
  });
  const runtime = new ConductorToolRuntime({ providers: [provider], sourceControlMutationProvider: provider,
    projectResolver: provider, mutationExecutor: new IdempotentMutationExecutor({ store }) });
  return { runtime, store, calls, setHead(value: string) { head = value; }, setParentMismatch() { parentMismatch = true; }, setCompareAhead() { compareAhead = true; },
    mutations() { return calls.filter((call) => call.method !== 'GET'); } };
}

test('lost successful ref response reconciles the exact candidate without another mutation', async () => {
  const f = fixture('ref-lost-applied');
  const result = await f.runtime.createCommit(input, caller);
  assert.ok(result.status === 'succeeded');
  assert.equal(result.result.commitSha, candidate);
  const before = f.mutations().length;
  const status = await f.runtime.operationStatus(input, caller);
  assert.ok(status.status === 'succeeded');
  assert.equal(status.result.state, 'completed');
  assert.equal(status.result.outcome, 'succeeded');
  const retry = await f.runtime.createCommit({ ...input, project: { id: 'Conductor' } }, caller);
  assert.ok(retry.status === 'succeeded');
  assert.equal(retry.operationId, result.operationId);
  assert.equal(retry.idempotency?.key, input.idempotencyKey);
  assert.equal(f.mutations().length, before);
  const requested = f.store.snapshots.map((snapshot) => JSON.parse(snapshot) as IdempotencyRecord)
    .find((record) => record.checkpoint?.phase === 'ref-update-requested');
  assert.equal(requested?.checkpoint?.candidateCommitSha, candidate);
  assert.equal(requested?.checkpoint?.expectedHeadSha, base);
});

test('a 53-entry approximately 1 MiB interrupted ref response recovers by status key alone', async () => {
  const f = fixture('ref-lost-not-applied');
  const files = Array.from({ length: 51 }, (_, index) => ({ path: `src/file-${index}.ts`, content: 'Ω'.repeat(10_240) }));
  const large: CreateCommitInput = { ...input, idempotencyKey: 'commit:304:large-response-loss', files: [...files, { path: 'empty.txt', content: '' }, { path: 'obsolete.txt', content: null }] };
  const first = await f.runtime.createCommit(large, caller);
  assert.equal(first.status, 'failed');
  const payload = f.calls.find((call) => call.method === 'POST' && call.path.endsWith('/git/trees'))!.body;
  assert.equal(payload.tree.length, 53);
  assert.equal(files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0), 1_044_480);
  const writes = f.mutations().length;
  // The uncertain request's effect becomes observable after the first response.
  f.setHead(candidate);
  const status = await f.runtime.operationStatus({ project, idempotencyKey: large.idempotencyKey }, caller);
  assert.ok(status.status === 'succeeded');
  assert.equal(status.result.outcome, 'succeeded');
  assert.equal(status.result.operationId, first.operationId);
  assert.equal(status.result.receipt?.identifiers?.commitSha, candidate);
  assert.equal(f.mutations().length, writes, 'status does not resend source or mutate provider state');
});

test('a no-apply lost ref response remains unknown; same-key retries never rerun execution', async () => {
  const f = fixture('ref-lost-not-applied');
  const first = await f.runtime.createCommit(input, caller);
  assert.ok(first.status === 'failed');
  assert.equal(first.error.code, 'TRANSIENT');
  const before = f.mutations().length;
  const retry = await f.runtime.createCommit(input, caller);
  assert.equal(retry.status, 'failed');
  const status = await f.runtime.operationStatus(input, caller);
  assert.ok(status.status === 'succeeded');
  assert.equal(status.result.state, 'incomplete');
  assert.equal(status.result.outcome, 'unknown');
  assert.equal(status.result.phase, 'ref-update-requested');
  assert.equal(status.result.receipt, undefined);
  assert.equal(f.mutations().length, before);
  // A subsequent authoritative observation, not elapsed time, settles it.
  f.setHead(candidate);
  const observed = await f.runtime.operationStatus(input, caller);
  assert.ok(observed.status === 'succeeded');
  assert.equal(observed.result.outcome, 'succeeded');
  assert.equal(f.mutations().length, before);
});

for (const fault of ['tree-lost', 'commit-lost'] as const) test(`${fault} cannot advance a ref or blindly repeat staging`, async () => {
  const f = fixture(fault);
  const result = await f.runtime.createCommit(input, caller);
  assert.equal(result.status, 'failed');
  assert.equal(f.calls.some((call) => call.method === 'PATCH'), false);
  const before = f.mutations().length;
  await f.runtime.createCommit(input, caller);
  assert.equal(f.mutations().length, before);
  const status = await f.runtime.operationStatus(input, caller);
  assert.ok(status.status === 'succeeded');
  assert.equal(status.result.outcome, 'failed');
  assert.equal(status.result.phase, fault === 'tree-lost' ? 'validated' : 'tree-created');
});

test('candidate checkpoint outage blocks PATCH even after immutable commit creation', async () => {
  const f = fixture();
  f.store.candidateOutage = true;
  const result = await f.runtime.createCommit(input, caller);
  assert.equal(result.status, 'failed');
  assert.equal(f.calls.some((call) => call.path.endsWith('/git/commits') && call.method === 'POST'), true);
  assert.equal(f.calls.some((call) => call.method === 'PATCH'), false);
});

test('status is available during the original pending call and says nothing about liveness', async () => {
  let release!: () => void;
  const waitForTree = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture('none', { waitForTree });
  const pending = f.runtime.createCommit(input, caller);
  while (!f.calls.some((call) => call.method === 'POST')) await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const status = await f.runtime.operationStatus(input, caller);
    assert.ok(status.status === 'succeeded');
    assert.equal(status.result.state, 'incomplete');
    assert.equal(status.result.outcome, 'unknown');
    assert.equal(status.result.phase, 'validated');
    assert.equal(/still in progress|live process|running/i.test(JSON.stringify(status.result)), false);
  } finally { release(); }
  assert.equal((await pending).status, 'succeeded');
});

test('status and replay isolate OAuth clients and canonical repositories; legacy keys are not exposed', async () => {
  const f = fixture();
  await f.runtime.createCommit(input, caller);
  const before = f.calls.length;
  for (const [query, identity] of [[input, { clientId: 'another-client' }], [{ ...input, project: { id: 'pyralisxc/other', repository: 'pyralisxc/other' } }, caller]] as const) {
    const status = await f.runtime.operationStatus(query, identity);
    assert.ok(status.status === 'succeeded');
    assert.deepEqual(status.result, { state: 'not-retained', outcome: 'unknown' });
  }
  assert.equal(f.calls.length, before);
  await f.store.claim({ key: 'legacy:304:claim', fingerprint: 'legacy-fingerprint', operationId: 'legacy-private-id', startedAt: '2020-01-01T00:00:00Z', state: 'in-progress' });
  const legacy = await f.runtime.operationStatus({ project, idempotencyKey: 'legacy:304:claim' }, caller);
  assert.ok(legacy.status === 'succeeded');
  assert.deepEqual(legacy.result, { state: 'not-retained', outcome: 'unknown' });
  const conflict = await f.runtime.createCommit({ ...input, message: 'different payload' }, caller);
  assert.ok(conflict.status === 'failed');
  assert.equal(conflict.error.code, 'CONFLICT');
});

test('later native ancestry can prove exact candidate containment; drift or corrupted identity cannot', async () => {
  for (const mode of ['ancestor', 'diverged', 'wrong-parent'] as const) {
    const f = fixture('ref-lost-not-applied');
    await f.runtime.createCommit(input, caller);
    f.setHead(mode === 'wrong-parent' ? candidate : later);
    if (mode === 'ancestor') f.setCompareAhead();
    if (mode === 'wrong-parent') f.setParentMismatch();
    const before = f.mutations().length;
    const status = await f.runtime.operationStatus(input, caller);
    assert.ok(status.status === 'succeeded');
    assert.equal(status.result.outcome, mode === 'ancestor' ? 'succeeded' : 'unknown');
    assert.equal(f.mutations().length, before);
  }
});

test('durable state excludes source, message and credentials; the native tree request retains exact content and deletion', async () => {
  const f = fixture();
  assert.equal((await f.runtime.createCommit(input, caller)).status, 'succeeded');
  const serialized = f.store.snapshots.join('\n');
  for (const privateValue of [input.message, input.files[0].content!, 'never-persist-this-token', caller.clientId]) assert.equal(serialized.includes(privateValue), false);
  assert.equal(f.calls.some((call) => call.path.endsWith('/git/blobs')), false);
  const trees = f.calls.filter((call) => call.path.endsWith('/git/trees'));
  assert.equal(trees.length, 1);
  assert.deepEqual(trees[0].body, { base_tree: parentTree, tree: [
    { path: 'source.ts', mode: '100644', type: 'blob', content: input.files[0].content },
    { path: 'retired.ts', mode: '100644', type: 'blob', sha: null },
  ] });
});

test('HTTP MCP status uses verified client identity and read scope while commit retries retain workContext/write gates', async () => {
  const f = fixture('ref-lost-not-applied');
  const server = createServer((request, response) => void createConductorHttpHandler({ runtime: f.runtime,
    publicUrl: 'http://127.0.0.1', oauthIssuer: 'http://127.0.0.1',
    workScope: new WorkScopeAuthorizer({ async get() { return null; }, async set() {}, async delete() {} }),
    verifier: { async verifyAccessToken(token) { return { token, clientId: token === 'other' ? 'client-other' : caller.clientId,
      scopes: token === 'reader' ? ['conductor.read'] : ['conductor.read', 'conductor.write'], resource: new URL('http://127.0.0.1/mcp') }; } },
  })(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const clients: Client[] = [];
  async function connect(token: string) {
    const client = new Client({ name: 'commit-recovery-proof', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(address as { port: number }).port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    clients.push(client); return client;
  }
  try {
    const writer = await connect('writer');
    const listed = await writer.listTools();
    assert.equal(listed.tools.find((tool) => tool.name === 'operation.status')?.annotations?.readOnlyHint, true);
    const context = await writer.callTool({ name: 'work-scope.begin', arguments: { repository } });
    const workContext = JSON.parse((context.content as { text: string }[])[0].text).workContext as string;
    await writer.callTool({ name: 'git.commit.create', arguments: { ...input, workContext } });
    const before = f.mutations().length;
    const reader = await connect('reader');
    const own = await reader.callTool({ name: 'operation.status', arguments: { project, idempotencyKey: input.idempotencyKey, clientId: 'forged-client' } });
    assert.equal((own.structuredContent as any).receipt.result.state, 'incomplete');
    const blocked = await reader.callTool({ name: 'git.commit.create', arguments: { ...input, workContext } });
    assert.equal(blocked.isError, true);
    const outsider = await connect('other');
    const hidden = await outsider.callTool({ name: 'operation.status', arguments: { project, idempotencyKey: input.idempotencyKey } });
    assert.equal((hidden.structuredContent as any).receipt.result.state, 'not-retained');
    const missingContext = await writer.callTool({ name: 'git.commit.create', arguments: input as unknown as Record<string, unknown> });
    assert.equal(missingContext.isError, true);
    assert.equal(f.mutations().length, before);
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    server.close(); await once(server, 'close');
  }
});
