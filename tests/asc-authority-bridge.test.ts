import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  SourceArtifactReadProvider,
  SourceControlMutationProvider
} from '../src/index.js';
import {
  AscAuthorityExecutor,
  AscAuthorityRejectedError,
  ConductorToolRuntime,
  IdempotentMutationExecutor,
  InMemoryIdempotencyStore,
  WorkScopeAuthorizer,
  type AscDelegationVerifier,
  type WorkScopeGrant,
  type WorkScopeStore
} from '../src/index.js';

function receipt(input: {
  capabilityId: string;
  effectClass: 'read' | 'mutate';
  approvalReference?: string;
}) {
  return Object.freeze({
    accountDomainId: 'domain:personal',
    delegationId: 'delegation:test',
    bindingId: 'binding:test',
    connectionId: 'connection:github:test',
    connectionGeneration: 7,
    projectId: 'asc',
    capabilityId: input.capabilityId,
    effectClass: input.effectClass,
    resource: Object.freeze({
      kind: 'github_repository',
      value: 'pyralisxc/AI-Systems-Control'
    }),
    audience: 'conductor',
    ...(input.approvalReference
      ? {
          approvalReference:
            input.approvalReference
        }
      : {}),
    consumedAt: '2026-09-29T01:30:00.000Z'
  });
}

class MemoryScopeStore implements WorkScopeStore {
  readonly values = new Map<string, WorkScopeGrant>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: WorkScopeGrant) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

test('ASC authority source canary derives repository only from the consumed delegation', async () => {
  let providerRepository = '';
  let consumed:
    | Parameters<AscDelegationVerifier['consume']>[0]
    | undefined;
  const source: SourceArtifactReadProvider = {
    id: 'source',
    async getCapabilities() {
      return [];
    },
    async getSourceArtifact(input) {
      providerRepository =
        input.project.repository ?? '';
      return {
        provider: 'github',
        repository: providerRepository,
        revisionSha: input.sha,
        path: input.path,
        blobSha: 'blob',
        size: 4,
        status: 'available',
        content: 'text',
        encoding: 'utf-8',
        reason: null,
        observedAt: '2026-09-29T01:30:00.000Z'
      };
    }
  };
  const verifier: AscDelegationVerifier = {
    async consume(input) {
      consumed = input;
      return receipt({
        capabilityId: 'source.read',
        effectClass: 'read'
      });
    }
  };
  const executor = new AscAuthorityExecutor({
    runtime: new ConductorToolRuntime({
      sourceArtifactProvider: source
    }),
    verifier
  });

  const result = await executor.sourceArtifactRead({
    delegationHandle: 'ascd_' + 'a'.repeat(43),
    accountDomainId: 'domain:personal',
    projectId: 'asc',
    sha: 'a'.repeat(40),
    path: 'README.md'
  });

  assert.deepEqual(consumed, {
    handle: 'ascd_' + 'a'.repeat(43),
    accountDomainId: 'domain:personal',
    projectId: 'asc',
    capabilityId: 'source.read',
    effectClass: 'read'
  });
  assert.equal(
    providerRepository,
    'pyralisxc/ai-systems-control'
  );
  assert.equal(result.authority.source, 'asc');
  assert.equal(
    result.authority.connectionGeneration,
    7
  );
  assert.equal(
    JSON.stringify(result).includes(
      'ascd_' + 'a'.repeat(43)
    ),
    false,
    'delegation handles are not echoed in receipts'
  );
});

test('ASC authority mutation canary retains Conductor work scope and idempotent mutation execution', async () => {
  let mutationCalls = 0;
  let providerRepository = '';
  const provider: SourceControlMutationProvider = {
    id: 'github',
    async getCapabilities() {
      return [];
    },
    async createBranch() {
      throw new Error('unused');
    },
    async bootstrapIntegrationBranch() {
      throw new Error('unused');
    },
    async deleteBranch() {
      throw new Error('unused');
    },
    async createCommit() {
      throw new Error('unused');
    },
    async createPullRequest() {
      throw new Error('unused');
    },
    async commentPullRequest(input) {
      mutationCalls += 1;
      providerRepository =
        input.project.repository ?? '';
      return {
        repository: providerRepository,
        pullRequestNumber:
          input.pullRequestNumber,
        commentId: 'comment:1',
        url:
          'https://github.com/pyralisxc/AI-Systems-Control/pull/72#issuecomment-1'
      };
    },
    async updatePullRequestLabels() {
      throw new Error('unused');
    },
    async mergeIntegrationPullRequest() {
      throw new Error('unused');
    },
    async reconcilePreviewPullRequest() {
      throw new Error('unused');
    },
    async promotePullRequest() {
      throw new Error('unused');
    }
  };
  const verifier: AscDelegationVerifier = {
    async consume() {
      return receipt({
        capabilityId: 'pull_request.write',
        effectClass: 'mutate',
        approvalReference:
          'owner-verified:asc-61'
      });
    }
  };
  const executor = new AscAuthorityExecutor({
    runtime: new ConductorToolRuntime({
      sourceControlMutationProvider: provider,
      mutationExecutor:
        new IdempotentMutationExecutor({
          store: new InMemoryIdempotencyStore()
        })
    }),
    verifier,
    workScope: new WorkScopeAuthorizer(
      new MemoryScopeStore()
    )
  });

  const result = await executor.pullRequestComment({
    delegationHandle: 'ascd_' + 'b'.repeat(43),
    accountDomainId: 'domain:personal',
    projectId: 'asc',
    pullRequestNumber: 72,
    body: 'ASC authority canary.',
    idempotencyKey:
      'asc-authority-canary-comment'
  });

  assert.equal(mutationCalls, 1);
  assert.equal(
    providerRepository,
    'pyralisxc/ai-systems-control'
  );
  assert.equal(
    result.authority.approvalReference,
    'owner-verified:asc-61'
  );
  assert.equal(result.execution.status, 'succeeded');
});

test('ASC authority rejection stops before provider execution with no legacy fallback', async () => {
  let providerCalls = 0;
  const source: SourceArtifactReadProvider = {
    id: 'source',
    async getCapabilities() {
      return [];
    },
    async getSourceArtifact() {
      providerCalls += 1;
      throw new Error('must not execute');
    }
  };
  const executor = new AscAuthorityExecutor({
    runtime: new ConductorToolRuntime({
      sourceArtifactProvider: source
    }),
    verifier: {
      async consume() {
        throw new AscAuthorityRejectedError();
      }
    }
  });

  await assert.rejects(
    () => executor.sourceArtifactRead({
      delegationHandle:
        'ascd_' + 'c'.repeat(43),
      accountDomainId: 'domain:personal',
      projectId: 'asc',
      sha: 'a'.repeat(40),
      path: 'README.md'
    }),
    AscAuthorityRejectedError
  );
  assert.equal(providerCalls, 0);
});
