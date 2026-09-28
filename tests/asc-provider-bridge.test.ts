import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse
} from 'node:http';

import {
  handleAscProviderBridgeRequest
} from '../src/transport/asc-provider-bridge.js';

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';

  writeHead(
    status: number,
    headers: Record<string, string> = {}
  ) {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }

  end(body: string = '') {
    this.body = String(body);
  }
}

function request(
  token = 'a'.repeat(40)
): IncomingMessage {
  return {
    method: 'GET',
    headers: {
      authorization: 'Bearer ' + token,
    } as IncomingHttpHeaders,
  } as IncomingMessage;
}

test('ASC provider bridge exposes only safe GitHub App identity metadata', async () => {
  const res = new FakeResponse();
  const handled = await handleAscProviderBridgeRequest(
    request(),
    res as unknown as ServerResponse,
    new URL('https://conductor.example/internal/asc/github/app'),
    {
      secret: 'a'.repeat(40),
      githubApp: {
        async getIdentity() {
          return {
            kind: 'app',
            appId: '123',
            appSlug: 'asc-control',
          };
        },
        async getInstallationAttestation() {
          throw new Error('not used by this test');
        },
      },
    }
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    appId: '123',
    appSlug: 'asc-control',
  });
});

test('ASC provider bridge rejects wrong service secret before GitHub access', async () => {
  let called = false;
  const res = new FakeResponse();

  await handleAscProviderBridgeRequest(
    request('wrong-secret-value-that-is-long-enough'),
    res as unknown as ServerResponse,
    new URL('https://conductor.example/internal/asc/github/app'),
    {
      secret: 'a'.repeat(40),
      githubApp: {
        async getIdentity() {
          called = true;
          return {
            kind: 'app',
            appId: '123',
            appSlug: 'asc-control',
          };
        },
        async getInstallationAttestation() {
          throw new Error('not used by this test');
        },
      },
    }
  );

  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'unauthorized',
  });
});
