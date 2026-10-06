import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRuntimeBindings } from '../src/config/runtime.js';
import { OhMySymphonyProvider } from '../src/providers/oh-my-symphony.js';

test('runtime binding accepts exact Symphony endpoint plus encrypted credential identity', () => {
  const [binding] = parseRuntimeBindings(JSON.stringify([{
    id: 'DI',
    repository: 'pyralisxc/Development-Intelligence',
    workerRuntimeEndpoint: 'https://worker.example.test',
    workerRuntimeConnectionId: 'oms-owner-host',
  }]));
  assert.equal(binding?.workerRuntimeEndpoint, 'https://worker.example.test');
  assert.equal(binding?.workerRuntimeConnectionId, 'oms-owner-host');
  assert.throws(() => parseRuntimeBindings(JSON.stringify([{
    id: 'DI',
    repository: 'pyralisxc/Development-Intelligence',
    workerRuntimeEndpoint: 'https://worker.example.test',
  }])), /endpoint and connection ID must be configured together/);
});

test('Symphony provider resolves an opaque encrypted connection credential at request time', async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const resolver = {
    async resolve(request: { provider: string; connectionId: string; accountId?: string }) {
      assert.deepEqual(request, {
        provider: 'oh-my-symphony',
        connectionId: 'oms-owner-host',
        accountId: 'pyralisxc/Development-Intelligence',
      });
      return { ...request, token: 'opaque-runtime-credential', resolvedAt: '2026-10-06T00:00:00.000Z' };
    },
  };
  const provider = new OhMySymphonyProvider({
    endpoint: 'https://worker.example.test',
    repository: 'pyralisxc/Development-Intelligence',
    connectionId: 'oms-owner-host',
    credentialResolver: resolver,
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      return Response.json({ dispatch: { enabled: false }, counts: { running: 0, retrying: 0 }, running: [] });
    },
  });
  const capabilities = await provider.getCapabilities();
  assert.equal(capabilities.every(item => item.auth === 'ready'), true);
  assert.doesNotMatch(JSON.stringify(capabilities), /opaque-runtime-credential/);
  const status = await provider.getRuntimeStatus();
  assert.equal(status.repository, 'pyralisxc/Development-Intelligence');
  assert.deepEqual(requests, [{
    url: 'https://worker.example.test/api/v1/state',
    authorization: 'Bearer opaque-runtime-credential',
  }]);
});
