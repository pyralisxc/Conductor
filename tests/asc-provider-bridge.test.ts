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
        async getRepositoryAttestation() {
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
        async getRepositoryAttestation() {
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


test('ASC provider bridge returns safe exact-repository attestation only', async () => {
  const res = new FakeResponse();
  let repository = '';
  let expectedInstallationId = '';

  const handled = await handleAscProviderBridgeRequest(
    request(),
    res as unknown as ServerResponse,
    new URL(
      'https://conductor.example/internal/asc/github/installations/456/repositories/pyralisxc/AI-Systems-Control/attest'
    ),
    {
      secret: 'a'.repeat(40),
      githubApp: {
        async getIdentity() {
          throw new Error('not used');
        },
        async getInstallationAttestation() {
          throw new Error('not used');
        },
        async getRepositoryAttestation(
          repositoryInput,
          installationIdInput
        ) {
          repository = repositoryInput;
          expectedInstallationId =
            String(installationIdInput);
          return {
            installationId: '456',
            repository:
              'pyralisxc/AI-Systems-Control',
            accountId: '789',
            accountLogin: 'pyralisxc',
            accountType: 'User',
            permissions: {
              contents: 'write',
            },
            capabilities: [
              'source.read',
              'source.write',
            ],
            verifiedAt:
              '2026-09-28T02:40:00.000Z',
          };
        },
      },
    }
  );

  assert.equal(handled, true);
  assert.equal(
    repository,
    'pyralisxc/AI-Systems-Control'
  );
  assert.equal(expectedInstallationId, '456');
  assert.deepEqual(JSON.parse(res.body), {
    installationId: '456',
    repository:
      'pyralisxc/AI-Systems-Control',
    accountId: '789',
    accountLogin: 'pyralisxc',
    accountType: 'User',
    capabilities: [
      'source.read',
      'source.write',
    ],
    verifiedAt:
      '2026-09-28T02:40:00.000Z',
  });
});


test('ASC provider bridge exposes safe Vercel installation and exact repository attestation', async () => {
  const installationResponse = new FakeResponse();
  const repositoryResponse = new FakeResponse();
  const provider = {
    async listInstallations() {
      return [{
        configurationId: 'icfg_A',
        teamId: 'team_A',
        connectedAt:
          '2026-09-29T02:00:00.000Z'
      }];
    },
    async getInstallationMetadata(configurationId: string) {
      assert.equal(configurationId, 'icfg_A');
      return {
        configurationId: 'icfg_A',
        teamId: 'team_A',
        connectedAt: '2026-09-29T02:00:00.000Z'
      };
    },
    async getRepositoryAttestation(
      repository: string,
      configurationId: string
    ) {
      assert.equal(
        repository,
        'pyralisxc/Development-Intelligence'
      );
      assert.equal(configurationId, 'icfg_A');
      return {
        connectionId: 'icfg_A',
        teamId: 'team_A',
        repository:
          'pyralisxc/development-intelligence',
        projectId: 'prj_di',
        projectName: 'development-intelligence',
        productionBranch: 'main',
        capabilities: ['deployment.read'],
        verifiedAt:
          '2026-09-29T02:30:00.000Z'
      };
    }
  };

  await handleAscProviderBridgeRequest(
    request(),
    installationResponse as unknown as ServerResponse,
    new URL(
      'https://conductor.example/internal/asc/vercel/installations/icfg_A/attest'
    ),
    {
      secret: 'a'.repeat(40),
      vercel: provider
    }
  );
  assert.equal(installationResponse.statusCode, 200);
  assert.deepEqual(
    JSON.parse(installationResponse.body),
    {
      configurationId: 'icfg_A',
      teamId: 'team_A',
      connectedAt:
        '2026-09-29T02:00:00.000Z'
    }
  );

  await handleAscProviderBridgeRequest(
    request(),
    repositoryResponse as unknown as ServerResponse,
    new URL(
      'https://conductor.example/internal/asc/vercel/installations/icfg_A/repositories/pyralisxc/Development-Intelligence/attest'
    ),
    {
      secret: 'a'.repeat(40),
      vercel: provider
    }
  );
  assert.equal(repositoryResponse.statusCode, 200);
  assert.equal(
    JSON.stringify(
      JSON.parse(repositoryResponse.body)
    ).includes('token'),
    false
  );
  assert.deepEqual(
    JSON.parse(repositoryResponse.body),
    {
      connectionId: 'icfg_A',
      teamId: 'team_A',
      repository:
        'pyralisxc/development-intelligence',
      projectId: 'prj_di',
      projectName: 'development-intelligence',
      productionBranch: 'main',
      capabilities: ['deployment.read'],
      verifiedAt:
        '2026-09-29T02:30:00.000Z'
    }
  );
});


test('ASC provider bridge lists safe Vercel installation identities without credentials', async () => {
  const response = new FakeResponse();
  await handleAscProviderBridgeRequest(
    request(),
    response as unknown as ServerResponse,
    new URL(
      'https://conductor.example/internal/asc/vercel/installations'
    ),
    {
      secret: 'a'.repeat(40),
      vercel: {
        async listInstallations() {
          return [
            {
              configurationId: 'icfg_A',
              teamId: 'team_A',
              connectedAt:
                '2026-09-29T02:00:00.000Z'
            },
            {
              configurationId: 'icfg_B',
              teamId: null,
              connectedAt:
                '2026-09-29T02:10:00.000Z'
            }
          ];
        },
        async getInstallationMetadata() {
          throw new Error('not used');
        },
        async getRepositoryAttestation() {
          throw new Error('not used');
        }
      }
    }
  );

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.deepEqual(payload, {
    installations: [
      {
        configurationId: 'icfg_A',
        teamId: 'team_A',
        connectedAt:
          '2026-09-29T02:00:00.000Z'
      },
      {
        configurationId: 'icfg_B',
        teamId: null,
        connectedAt:
          '2026-09-29T02:10:00.000Z'
      }
    ]
  });
  assert.equal(
    JSON.stringify(payload).includes('token'),
    false
  );
});
