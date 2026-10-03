import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { ConductorToolRuntime } from '../runtime/runtime.js';
import { CONDUCTOR_WRITE_SCOPE } from './auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { ProjectReference } from '../runtime/types.js';
import type { WorkAction, WorkScopeAuthorizer } from './work-scope.js';
import { clientFingerprint, issueBootstrapEvidence, verifyBootstrapEvidence, issueLifecycleGate, verifyLifecycleGate, issueWorkScopeApprovalGate, verifyWorkScopeApprovalGate } from './work-scope.js';

const diagnosticSchema = z.object({
  level: z.enum(['info', 'warning', 'error']),
  message: z.string(),
  source: z.string().optional(),
  code: z.enum([
    'AUTH_REQUIRED', 'PERMISSION_DENIED', 'TRANSIENT', 'NOT_FOUND',
    'CONFLICT', 'TOOL_UNAVAILABLE', 'COMMAND_FAILED',
  ]).optional(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

const errorSchema = z.object({
  code: z.enum([
    'AUTH_REQUIRED', 'PERMISSION_DENIED', 'TRANSIENT', 'NOT_FOUND',
    'CONFLICT', 'TOOL_UNAVAILABLE', 'COMMAND_FAILED',
  ]),
  message: z.string(),
  retryable: z.boolean(),
  source: z.string().optional(),
  diagnostics: z.array(diagnosticSchema),
});

const runtimeOperationSchema = z.enum([
  'capabilities', 'preflight_project', 'preflight_operation', 'repository.acquire.preflight',
  'work.bootstrap', 'repository.audit', 'evidence.bundle', 'development.status', 'pull-request.status', 'source.discover', 'source.artifact.read', 'ci.run.read', 'deployment.status', 'deployment.logs', 'deployment.audit', 'deployment.runtime-logs', 'deployment.env.list', 'deployment.vcr.get', 'deployment.vcr.list', 'deployment.vcr.images.list', 'work-item.status', 'work-item.list',
  'repository.acquire', 'lifecycle.advance', 'lifecycle.resume',
  'git.branch.create', 'git.integration.bootstrap', 'git.branch.delete', 'git.commit.create', 'git.workflow.commit', 'git.push',
  'pull-request.create', 'pull-request.comment.create', 'pull-request.labels.update',
  'pull-request.close', 'pull-request.ready-for-review', 'pull-request.verify.rerun',
  'pull-request.merge.integration', 'pull-request.merge.reconcile-preview', 'pull-request.merge.promote',
  'work-item.create', 'work-item.comment.create', 'work-item.update-status', 'work-item.classification.update', 'work-item.triage.update',
  'deployment.redeploy', 'deployment.git.create', 'deployment.promote', 'deployment.rollback', 'deployment.delete',
  'deployment.env.upsert', 'deployment.env.update', 'deployment.env.remove', 'deployment.vcr.create', 'deployment.vcr.image.delete',
]);

const receiptBase = {
  contractVersion: z.literal('conductor.tool-runtime.v0'),
  operationId: z.string(),
  operation: runtimeOperationSchema,
  target: z.object({
    kind: z.enum(['runtime', 'project', 'repository', 'workspace']),
    id: z.string(),
    ref: z.string().optional(),
  }),
  startedAt: z.string(),
  finishedAt: z.string(),
  diagnostics: z.array(diagnosticSchema),
};

const failedReceiptSchema = z.object({
  ...receiptBase,
  status: z.literal('failed'),
  error: errorSchema,
});

const capabilitySchema = z.object({
  capability: z.string(),
  available: z.boolean(),
  provider: z.string(),
  access: z.enum(['read', 'write', 'execute']),
  auth: z.enum(['ready', 'required', 'denied', 'not-applicable', 'unknown']),
  health: z.enum(['ready', 'degraded', 'unavailable']),
  diagnostics: z.array(diagnosticSchema),
});

const capabilitiesReceiptSchema = z.union([
  z.object({
    ...receiptBase,
    status: z.literal('succeeded'),
    result: z.object({
      contractVersion: z.literal('conductor.tool-runtime.v0'),
      catalogVersion: z.literal('conductor.catalog.v14'),
      catalogDigest: z.string().regex(/^[0-9a-f]{64}$/u),
      operations: z.array(z.object({
        name: runtimeOperationSchema,
        description: z.string(),
        mutates: z.boolean(),
      })),
      capabilities: z.array(capabilitySchema),
      providers: z.array(z.object({
        provider: z.string(),
        health: z.enum(['ready', 'degraded', 'unavailable']),
        error: errorSchema.optional(),
      })),
    }),
  }),
  failedReceiptSchema,
]);

const projectSchema = z.object({
  id: z.string().min(1).describe('Execution-routing alias/referent, repository name, or authorized owner/repository; not a product model'),
  repository: z.string().optional().describe('Optional exact owner/repository routing expectation'),
  workspace: z.string().optional().describe('Optional exact workspace routing expectation'),
  ref: z.string().optional().describe('Optional exact Git ref expectation'),
});

const preflightReceiptSchema = z.union([
  z.object({
    ...receiptBase,
    status: z.literal('succeeded'),
    result: z.object({
      contractVersion: z.literal('conductor.tool-runtime.v0'),
      project: projectSchema,
      intent: z.enum(['inspect', 'develop', 'execute']),
      status: z.enum(['ready', 'degraded', 'blocked']),
      checks: z.array(z.object({
        check: z.string(),
        status: z.enum(['ready', 'degraded', 'blocked', 'unavailable']),
        provider: z.string(),
        summary: z.string(),
        error: errorSchema.optional(),
        diagnostics: z.array(diagnosticSchema),
      })),
    }),
  }),
  failedReceiptSchema,
]);

const oauthSecurity = [{ type: 'oauth2', scopes: ['conductor.read'] }];
const oauthWriteSecurity = [{ type: 'oauth2', scopes: ['conductor.read', 'conductor.write'] }];
const workContextSchema = z.string().min(20).max(1024).describe('Token from work-scope.begin for this conversation’s active repository; required for code/deployment writes');
const bootstrapEvidenceSchema = z.string().min(20).max(2048).optional().describe('Short-lived signed handle from work.bootstrap; valid only for safe adjacent reads and never for mutations');

function withoutWorkContext<T extends Record<string, unknown>>(input: T): Omit<T, 'workContext'> {
  const { workContext: _context, ...operationInput } = input;
  return operationInput;
}

const idempotencySchema = z.object({
  key: z.string(),
  fingerprint: z.string(),
  replayed: z.boolean(),
});

const mutationReceiptSchema = z.union([
  z.object({
    ...receiptBase,
    status: z.literal('succeeded'),
    result: z.record(z.string(), z.unknown()),
    identifiers: z.object({
      branch: z.string().optional(),
      commitSha: z.string().optional(),
      pullRequestNumber: z.number().optional(),
      issueNumber: z.number().optional(),
      commentId: z.string().optional(),
      workflowRunId: z.string().optional(),
      deploymentId: z.string().optional(),
      mergeCommitSha: z.string().optional(),
    }).optional(),
    idempotency: idempotencySchema,
  }),
  z.object({ ...failedReceiptSchema.shape, idempotency: idempotencySchema.optional() }),
]);

const mutationOutputSchema = z.object({ receipt: mutationReceiptSchema });

export const compositeMutationOutputSchema = z.object({ receipt: z.union([
  z.object({
    ...receiptBase,
    status: z.literal('succeeded'),
    result: z.record(z.string(), z.unknown()),
    identifiers: z.object({
      branch: z.string().optional(),
      commitSha: z.string().optional(),
      pullRequestNumber: z.number().optional(),
      issueNumber: z.number().optional(),
      commentId: z.string().optional(),
      workflowRunId: z.string().optional(),
      deploymentId: z.string().optional(),
      mergeCommitSha: z.string().optional(),
    }).optional(),
    idempotency: idempotencySchema.optional(),
  }),
  z.object({ ...failedReceiptSchema.shape, idempotency: idempotencySchema.optional() }),
]) });

const workItemReadStatusSchema = z.enum([
  'backlog', 'ready', 'in-progress', 'blocked', 'review', 'done', 'unknown',
]);
const workItemWriteStatusSchema = z.enum([
  'backlog', 'ready', 'in-progress', 'blocked', 'review', 'done',
]);
const newWorkItemStatusSchema = z.enum([
  'backlog', 'ready', 'in-progress', 'blocked', 'review',
]);
const workItemKindSchema = z.enum([
  'bug', 'feature', 'investigation', 'improvement', 'maintenance', 'operations', 'audit', 'unknown',
]);
const workItemOriginSchema = z.enum([
  'human', 'agent-audit', 'di-finding', 'ci', 'runtime', 'dependency', 'user-feedback', 'unknown',
]);
const workItemSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'unknown']);
const workItemPrioritySchema = z.enum(['p0', 'p1', 'p2', 'p3', 'unknown']);
const readReceiptSchema = z.object({ receipt: z.union([
  z.object({ ...receiptBase, status: z.literal('succeeded'), result: z.record(z.string(), z.unknown()) }),
  failedReceiptSchema,
]) });

export function createConductorMcpServer(runtime: ConductorToolRuntime, workScope?: WorkScopeAuthorizer): McpServer {
  async function requireScopedWrite(auth: AuthInfo | undefined, action: WorkAction, project: ProjectReference, workContext?: string): Promise<void> {
    requireWriteScope(auth?.scopes);
    if (!workScope) throw new Error('Owner-managed work scope is not configured');
    await workScope.assertAllowed(auth, action, runtime.resolveProjectReference(project), workContext);
  }

  function withBootstrapReadEvidence(input: Record<string, any>, extra: { authInfo?: AuthInfo }): Record<string, any> {
    const handle = typeof input.bootstrapEvidence === 'string' ? input.bootstrapEvidence : undefined;
    const { bootstrapEvidence: _handle, ...rest } = input;
    if (!handle) return rest;
    const clientId = extra.authInfo?.clientId;
    if (!clientId) throw new Error('Authenticated client identity is required for bootstrap evidence reuse');
    const project = runtime.resolveProjectReference(input.project as ProjectReference);
    const repository = project.repository ?? project.id;
    const evidence = verifyBootstrapEvidence(handle, clientId, {
      repository,
      projectId: project.id,
      catalogDigest: runtime.catalogDigest(),
    });
    if (!evidence.vercel) throw new Error('Bootstrap evidence does not contain reusable Vercel project identity');
    return { ...rest, project, readEvidence: evidence.vercel };
  }
  const server = new McpServer(
    { name: 'conductor', version: '0.1.0' },
    {
      instructions: 'Call capabilities first in a fresh conversation. Establish the active repository from the user or workspace, then call work-scope.begin once and reuse its workContext for code and deployment writes; issue routing and maintenance in another repository do not change the active repository. Search for an existing issue before creating another; comment there when it owns the new evidence, and link a confirmed duplicate before closing it. Use preflight_project for readiness and preflight_operation with workContext for code/deployment writes or without it for issue routing. Treat unavailable or blocked checks as hard evidence; do not infer hidden access or project meaning.',
    },
  );

  if (workScope) server.registerTool('work-scope.identity', {
    title: 'Identify this connected client for owner scope management',
    description: 'Return this OAuth client fingerprint and any owner-granted code-work exceptions. Start each conversation’s active repository with work-scope.begin. Issue routing depends on provider access and current session authorization. Share the fingerprint with the owner to grant a temporary wider scope in the Conductor owner page.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: oauthSecurity },
  }, async (_input, extra) => {
    const clientId = extra.authInfo?.clientId;
    if (!clientId) throw new Error('Authenticated client identity is required');
    const scope = await workScope.describe(clientId);
    return { content: [{ type: 'text', text: JSON.stringify(scope) }] };
  });

  if (workScope) server.registerTool('work-scope.begin', {
    title: 'Begin code work in the active repository',
    description: 'After establishing this conversation’s active repository from the user or workspace, call once with its exact owner/repository. Reuse the returned workContext for code and deployment writes in this conversation. Do not switch the active repository merely to work on an issue routed elsewhere; ask the owner for an additional scoped grant. The declaration is agent supplied and cannot independently prove the chat’s workspace.',
    inputSchema: z.object({ repository: z.string().min(3).describe('Exact owner/repository of the active development project') }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { securitySchemes: oauthWriteSecurity },
  }, async ({ repository }, extra) => {
    requireWriteScope(extra.authInfo?.scopes);
    const clientId = extra.authInfo?.clientId;
    if (!clientId) throw new Error('Authenticated client identity is required');
    return { content: [{ type: 'text', text: JSON.stringify(workScope.begin(clientId, repository)) }] };
  });


  if (workScope) server.registerTool('work-scope.request', {
    title: 'Request additional repository development scope',
    description: 'Create a signed self-describing human gate for an exact additional repository set without changing the active repository. This does not grant authority by itself; the owner must explicitly approve the returned exact scope in chat before work-scope.approve may apply it.',
    inputSchema: z.object({
      workContext: workContextSchema,
      developRepositories: z.array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)).min(1).max(20),
      durationMinutes: z.number().int().min(15).max(720).default(240),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { securitySchemes: oauthWriteSecurity },
  }, async (input, extra) => {
    requireWriteScope(extra.authInfo?.scopes);
    const clientId = extra.authInfo?.clientId;
    if (!clientId) throw new Error('Authenticated client identity is required');
    const issued = issueWorkScopeApprovalGate(clientId, input);
    const result = {
      stage: 'human-gate',
      summary: issued.gate.reason,
      gate: issued.gate,
      continuation: { handle: issued.handle, expiresAt: issued.expiresAt, gateId: issued.gateId },
    };
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  if (workScope) server.registerTool('work-scope.approve', {
    title: 'Approve exact additional repository development scope',
    description: 'Apply only a signed additional-repository gate after fresh explicit owner approval. The grant is bound to this exact work context and cannot change the active repository or authorize Main/production/destructive actions.',
    inputSchema: z.object({
      workContext: workContextSchema,
      gate: z.string().min(20).max(4096),
      approvalReference: z.string().regex(/^owner-approved:/u).max(500),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: oauthWriteSecurity },
  }, async (input, extra) => {
    requireWriteScope(extra.authInfo?.scopes);
    const clientId = extra.authInfo?.clientId;
    if (!clientId) throw new Error('Authenticated client identity is required');
    const gate = verifyWorkScopeApprovalGate(input.gate, clientId, input.workContext);
    const grant = await workScope.approveAdditionalScope(clientId, input.workContext, gate);
    const result = {
      status: 'approved',
      approvalReference: input.approvalReference,
      gateId: gate.id,
      grant,
      doesNotAuthorize: gate.doesNotAuthorize,
    };
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  });


  const bootstrapWorkScope = workScope;
  if (runtime.workBootstrapReadEnabled && bootstrapWorkScope) {
    server.registerTool('work.bootstrap', {
      title: 'Bootstrap one development conversation',
      description: 'Use at the start/resume of a development conversation. In one call it establishes the exact active repository work context and returns compact Main/Preview topology, active work/preflight, DI posture, deployment posture, and server catalog freshness. Echo a previously observed catalogDigest as clientCatalogDigest; stale-client-schema means refresh/reconnect before treating absent tools as unavailable.',
      inputSchema: z.object({
        project: projectSchema,
        limit: z.number().int().min(1).max(25).default(10),
        clientCatalogDigest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
      }),
      outputSchema: readReceiptSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      requireWriteScope(extra.authInfo?.scopes);
      const clientId = extra.authInfo?.clientId;
      if (!clientId) throw new Error('Authenticated client identity is required');
      const project = runtime.resolveProjectReference(input.project);
      const repository = project.repository ?? project.id;
      const workContext = bootstrapWorkScope.begin(clientId, repository);
      const ownerScope = await bootstrapWorkScope.describe(clientId);
      const receipt = await runtime.workBootstrap({ ...input, project });
      if (receipt.status === 'succeeded') {
        const evidence = issueBootstrapEvidence(clientId, {
          repository: workContext.repository,
          projectId: project.id,
          catalogDigest: receipt.result.catalogDigest,
          observedAt: receipt.result.observedAt,
          ...(receipt.result.deployment ? {
            vercel: {
              provider: 'vercel',
              projectId: receipt.result.deployment.projectId,
              teamId: receipt.result.deployment.teamId,
              repository: workContext.repository,
              projectName: receipt.result.deployment.projectName,
              productionBranch: receipt.result.deployment.productionBranch,
              productionDeploymentId: receipt.result.deployment.production?.id ?? null,
              observedAt: receipt.result.deployment.observedAt,
            },
          } : {}),
        });
        Object.assign(receipt.result, {
          workScope: { ...workContext, ownerScope },
          evidence: {
            handle: evidence.handle,
            expiresAt: evidence.expiresAt,
            reusableFor: ['deployment.status', 'deployment.logs', 'deployment.runtime-logs', 'deployment.env.list'],
            note: 'Short-lived client/repository/catalog-bound proof only. Mutations still re-read TOCTOU-sensitive provider truth.',
          },
        });
      }
      return result(receipt);
    });
  }

  server.registerTool('capabilities', {
    title: 'Report Conductor capabilities',
    description: 'Use first to discover the exact development actions, providers, authentication state, and health available through this Conductor runtime.',
    inputSchema: z.object({}),
    outputSchema: z.object({ receipt: capabilitiesReceiptSchema }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { securitySchemes: oauthSecurity },
  }, async () => result(await runtime.capabilities()));

  server.registerTool('preflight_project', {
    title: 'Preflight a development project',
    description: 'Verify allowlisted repository, GitHub read/write, workspace, shell, tests, and read-only Development Intelligence access before development work begins.',
    inputSchema: z.object({
      project: projectSchema,
      intent: z.enum(['inspect', 'develop', 'execute']).default('develop'),
    }),
    outputSchema: z.object({ receipt: preflightReceiptSchema }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { securitySchemes: oauthSecurity },
  }, async ({ project, intent }) => result(await runtime.preflightProject(project, intent)));

  if (runtime.operationPreflightEnabled) {
    server.registerTool('preflight_operation', {
      title: 'Preflight one exact Conductor operation',
      description: 'Verify whether one exact exposed operation can execute against the supplied execution-routing referent. This does not infer which operation the project needs. Repository acquisition is specialized: use repository.acquire.preflight with exact upstream/ref/destination inputs before repository.acquire.',
      inputSchema: z.object({
        project: projectSchema,
        operation: runtimeOperationSchema,
        workContext: workContextSchema.optional(),
      }),
      outputSchema: readReceiptSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { securitySchemes: oauthSecurity },
    }, async (input, extra) => {
      const receipt = await runtime.preflightOperation(input);
      const action = writeAction(input.operation);
      if (receipt.status === 'succeeded' && action) {
        try {
          await requireScopedWrite(extra.authInfo, action, input.project, input.workContext);
          receipt.result.checks.push({ provider: 'work-scope', status: 'ready', summary: 'Owner-managed repository scope permits this operation', diagnostics: [] });
        } catch {
          receipt.result.status = 'blocked';
          receipt.result.checks.push({ provider: 'work-scope', status: 'blocked', summary: 'Active repository context or owner exception does not permit this operation', diagnostics: [{ level: 'warning', source: 'work-scope', code: 'PERMISSION_DENIED', message: 'Begin work-scope.begin for the active repository, or ask the owner to grant an exact additional repository.' }] });
        }
      }
      return result(receipt);
    });
  }


  const evidenceBundleItemSchema = z.discriminatedUnion('operation', [
    z.object({
      key: z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/u),
      operation: z.literal('preflight_project'),
      project: projectSchema,
      intent: z.enum(['inspect', 'develop', 'execute']).default('inspect'),
    }),
    z.object({
      key: z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/u),
      operation: z.literal('deployment.status'),
      project: projectSchema,
      limit: z.number().int().min(1).max(10).default(5),
    }),
    z.object({
      key: z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/u),
      operation: z.literal('deployment.runtime-logs'),
      project: projectSchema,
      deploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/u),
      limit: z.number().int().min(1).max(20).default(20),
    }),
    z.object({
      key: z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/u),
      operation: z.literal('pull-request.status'),
      project: projectSchema,
      pullRequestNumber: z.number().int().positive(),
    }),
    z.object({
      key: z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/u),
      operation: z.literal('repository.audit'),
      project: projectSchema,
      limit: z.number().int().min(1).max(12).default(8),
    }),
  ]);

  server.registerTool('evidence.bundle', {
    title: 'Run bounded parallel evidence reads',
    description: 'Batch 1-12 declared-safe read operations with concurrency 1-4. Preserves input order, exact project/resource identity and per-item errors; performs no mutations and no hidden retries.',
    inputSchema: z.object({
      items: z.array(evidenceBundleItemSchema).min(1).max(12)
        .refine((items) => new Set(items.map((item) => item.key)).size === items.length, { message: 'Evidence bundle keys must be unique' }),
      concurrency: z.number().int().min(1).max(4).default(3),
    }),
    outputSchema: readReceiptSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: { securitySchemes: oauthSecurity },
  }, async (input) => result(await runtime.evidenceBundle(input)));

  if (runtime.repositoryAuditReadEnabled) {
    server.registerTool('repository.audit', {
      title: 'Audit repository provider state',
      description: 'Run one bounded read-only provider-facts audit across GitHub topology, active PR/check/workflow state, durable-work hygiene, project preflight, Vercel posture, and an optional separate Development Intelligence semantic audit. The audit does not rank work, infer architecture, mutate code, or change the active objective.',
      inputSchema: z.object({
        project: projectSchema,
        limit: z.number().int().min(1).max(20).default(12),
      }),
      outputSchema: readReceiptSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthSecurity },
    }, async (input) => result(await runtime.repositoryAudit(input)));
  }

  if (runtime.developmentStatusReadEnabled) {
    server.registerTool('development.status', {
      title: 'Read compact development status',
      description: 'Reconstruct inspect-time development preflight plus ready/in-progress/blocked/review work and native cross-referenced PR candidate checks. This read does not rank or select work or describe project architecture.',
      inputSchema: z.object({
        project: projectSchema,
        limit: z.number().int().min(1).max(50).default(25),
      }),
      outputSchema: readReceiptSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthSecurity },
    }, async (input) => result(await runtime.developmentStatus(input)));
  }

  if (runtime.pullRequestReadEnabled) {
    server.registerTool('pull-request.status', {
      title: 'Read state-aware pull request status',
      description: 'Read exact PR identity plus checks/workflows and a derived orchestration state. Supply the prior observation when available to detect meaningful head/state transitions. When the result says external gate pending with shouldAct=false, do not repeatedly poll identical state; wait for provider/user/event-driven re-entry.',
      inputSchema: z.object({
        project: projectSchema,
        pullRequestNumber: z.number().int().positive(),
        previous: z.object({
          headSha: z.string().regex(/^[0-9a-f]{40}$/i),
          orchestrationState: z.enum([
            'merged', 'draft', 'external-gate-pending', 'pre-seal-checkpoint',
            'sealed-head-verification-required', 'action-required',
            'verification-failed', 'merge-blocked', 'integration-ready', 'promotion-ready',
          ]).optional(),
        }).optional(),
      }),
      outputSchema: z.object({ receipt: z.union([
        z.object({ ...receiptBase, status: z.literal('succeeded'), result: z.record(z.string(), z.unknown()) }),
        failedReceiptSchema,
      ]) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthSecurity },
    }, async (input) => result(await runtime.pullRequestStatus(input)));
  }


  if (runtime.sourceDiscoveryReadEnabled) {
    server.registerTool('source.discover', {
      title: 'Discover source paths at an exact revision',
      description: 'Read a bounded exact-SHA repository manifest or perform bounded literal source discovery. This is provider-native source location evidence only: no semantic ranking, architecture inference, impact analysis, or mutation authority.',
      inputSchema: z.object({
        project: projectSchema,
        sha: z.string().regex(/^[0-9a-f]{40}$/i),
        query: z.string().min(1).max(256).optional(),
        pathPrefix: z.string().min(1).max(1024).optional(),
        caseSensitive: z.boolean().default(false),
        maxFiles: z.number().int().min(1).max(120).default(80),
        maxBytes: z.number().int().min(1024).max(5 * 1024 * 1024).default(2 * 1024 * 1024),
        maxFileBytes: z.number().int().min(1024).max(512 * 1024).default(128 * 1024),
        maxMatches: z.number().int().min(1).max(50).default(20),
      }),
      outputSchema: readReceiptSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthSecurity },
    }, async (input) => result(await runtime.sourceDiscover(input)));
  }

  if (runtime.sourceArtifactReadEnabled) {
    server.registerTool('source.artifact.read', {
      title: 'Read exact source artifact',
      description: 'Read one complete bounded UTF-8 file at an exact 40-character Git SHA and repository-relative path, typically after `source.discover` or Development Intelligence has identified the path. This tool does no repository-wide search, architecture inference, or semantic interpretation.',
      inputSchema: z.object({
        project: projectSchema,
        sha: z.string().regex(/^[0-9a-f]{40}$/i),
        path: z.string().min(1).max(1024),
        maxBytes: z.number().int().min(1).max(1024 * 1024).default(256 * 1024),
      }),
      outputSchema: readReceiptSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthSecurity },
    }, async (input) => result(await runtime.sourceArtifactRead(input)));
  }

  if (runtime.ciReadEnabled) {
    server.registerTool('ci.run.read', {
      title: 'Read exact CI run evidence',
      description: 'Use after pull-request.status identifies an actionable workflow failure. Verify the exact PR head and workflow run, then return bounded jobs/steps plus redacted tail logs for the requested job or up to three failed jobs. This tool never reruns, cancels, approves, or mutates CI.',
      inputSchema: z.object({
        project: projectSchema,
        pullRequestNumber: z.number().int().positive(),
        expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i),
        workflowRunId: z.number().int().positive(),
        jobId: z.number().int().positive().optional(),
        logTailBytes: z.number().int().min(1024).max(50_000).default(12_000),
      }),
      outputSchema: readReceiptSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthSecurity },
    }, async (input) => result(await runtime.ciRunRead(input)));
  }


  if (runtime.deploymentReadEnabled) {
    server.registerTool('deployment.status', {
      title: 'Read deployment status',
      description: 'Read the configured Vercel project, current production deployment, latest production attempt, recent deployments, source Git revisions, and domains. Vercel remains authoritative for deployment state.',
      inputSchema: z.object({
        project: projectSchema,
        limit: z.number().int().min(1).max(50).default(10),
        bootstrapEvidence: bootstrapEvidenceSchema,
      }),
      outputSchema: readReceiptSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthSecurity },
    }, async (input, extra) => result(await runtime.deploymentStatus(withBootstrapReadEvidence(input, extra) as any)));

    server.registerTool('deployment.logs', {
      title: 'Read deployment logs',
      description: 'Read bounded, redacted Vercel deployment event logs for one exact deployment. This surface is intended for deployment/build diagnosis and does not expose credentials.',
      inputSchema: z.object({
        project: projectSchema,
        deploymentId: z.string().min(3).max(256),
        limit: z.number().int().min(1).max(200).default(100),
        direction: z.enum(['forward', 'backward']).default('forward'),
        bootstrapEvidence: bootstrapEvidenceSchema,
      }),
      outputSchema: readReceiptSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthSecurity },
    }, async (input, extra) => result(await runtime.deploymentLogs(withBootstrapReadEvidence(input, extra) as any)));
  }


  if (runtime.deploymentReadEnabled) {
    const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
    const readTool = (name: 'deployment.audit' | 'deployment.runtime-logs' | 'deployment.env.list' | 'deployment.vcr.get' | 'deployment.vcr.list' | 'deployment.vcr.images.list', title: string, description: string, inputSchema: z.ZodObject<any>, run: (input: any, extra: { authInfo?: AuthInfo }) => Promise<object>) => {
      server.registerTool(name, { title, description, inputSchema, outputSchema: readReceiptSchema, annotations: readOnly, _meta: { securitySchemes: oauthSecurity } },
        async (input, extra) => result(await run(input, extra)));
    };
    readTool('deployment.audit', 'Audit Vercel project operations', 'Bounded project, domains, aliases, custom environments, deployment and environment metadata. Unsupported account usage and billing are explicit.', z.object({ project: projectSchema }), input => runtime.deploymentAudit(input));
    readTool('deployment.runtime-logs', 'Read Vercel runtime logs', 'Read bounded redacted runtime logs for one exact bound deployment. A fresh work.bootstrap handle may reuse only the already-proven project identity.', z.object({ project: projectSchema, deploymentId: z.string().min(3), limit: z.number().int().min(1).max(100).default(50), bootstrapEvidence: bootstrapEvidenceSchema }), (input, extra) => runtime.deploymentRuntimeLogs(withBootstrapReadEvidence(input, extra) as any));
    readTool('deployment.env.list', 'List Vercel variable metadata', 'List exact project variable metadata; values are never returned. A fresh work.bootstrap handle may reuse only the already-proven project identity.', z.object({ project: projectSchema, bootstrapEvidence: bootstrapEvidenceSchema }), (input, extra) => runtime.deploymentEnvironmentList(withBootstrapReadEvidence(input, extra) as any));
    readTool('deployment.vcr.get', 'Read exact Vercel Container Registry repository', 'Read one exact project-scoped VCR repository by name. No image contents or credentials are returned.', z.object({ project: projectSchema, name: z.string().min(1).max(128).regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u) }), input => runtime.deploymentVcrGet(input));
    readTool('deployment.vcr.list', 'List Vercel Container Registry repositories', 'List bounded project-scoped VCR repository metadata and explicitly report whether authoritative capacity/headroom is available.', z.object({ project: projectSchema, limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(512).optional() }), input => runtime.deploymentVcrList(input));
    readTool('deployment.vcr.images.list', 'List Vercel Container Registry images', 'List bounded image digest/tag/size/status metadata for one exact project-scoped VCR repository. Image contents are never downloaded.', z.object({ project: projectSchema, name: z.string().min(1).max(128).regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u), limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(512).optional(), untagged: z.boolean().optional() }), input => runtime.deploymentVcrImagesList(input));
  }

  if (runtime.vercelMutationEnabled) {
    const idempotencyKey = z.string().min(8).max(200);
    const deploymentId = z.string().regex(/^dpl_[A-Za-z0-9]+$/u);
    const approvalReference = z.string().min(16).max(500).regex(/^owner-approved:/u).optional().describe('Exact owner approval for production actions; must begin owner-approved: and include a non-empty approval reference.');
    const base = { project: projectSchema, idempotencyKey, workContext: workContextSchema };
    const deployment = z.object({ ...base, deploymentId, approvalReference });
    const variable = z.object({ ...base, key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), value: z.string(), type: z.enum(['plain', 'encrypted', 'sensitive']), target: z.array(z.enum(['production','preview','development'])).min(1).max(3), gitBranch: z.string().optional(), customEnvironmentIds: z.array(z.string()).max(20).optional(), approvalReference });
    const writeTool = (name: 'deployment.redeploy' | 'deployment.git.create' | 'deployment.promote' | 'deployment.rollback' | 'deployment.delete' | 'deployment.env.upsert' | 'deployment.env.update' | 'deployment.env.remove' | 'deployment.vcr.create' | 'deployment.vcr.image.delete', title: string, description: string, inputSchema: z.ZodObject<any>, run: (input: any) => Promise<object>, destructive = false) => {
      server.registerTool(name, { title, description, inputSchema, outputSchema: mutationOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: destructive, idempotentHint: true, openWorldHint: true },
        _meta: { securitySchemes: oauthWriteSecurity } }, async (input, extra) => {
        await requireScopedWrite(extra.authInfo, 'develop', input.project as ProjectReference, input.workContext as string);
        return result(await run(withoutWorkContext(input)));
      });
    };
    writeTool('deployment.redeploy', 'Redeploy exact Vercel deployment', 'Redeploy one bound deployment. Production sources require exact owner approval.', deployment, input => runtime.vercelRedeploy(input));
    writeTool('deployment.git.create', 'Deploy exact Git revision', 'Deploy linked repository full commit SHA and explicit ref to preview or approved production.', z.object({ ...base, repository: z.string(), ref: z.string(), sha: z.string().regex(/^[0-9a-f]{40}$/iu), target: z.enum(['preview','production']), approvalReference }), input => runtime.vercelCreateGitDeployment(input));
    writeTool('deployment.promote', 'Promote READY Vercel deployment', 'Point production at one exact READY bound deployment after owner approval.', deployment, input => runtime.vercelPromote(input), true);
    writeTool('deployment.rollback', 'Rollback READY Vercel deployment', 'Point production at one exact prior READY bound deployment after owner approval.', deployment, input => runtime.vercelRollback(input), true);
    writeTool('deployment.delete', 'Delete exact Vercel deployment', 'Delete one exact terminal bound deployment. Current production and active builds are refused; historical production artifacts require exact owner approval.', deployment, input => runtime.vercelDeleteDeployment(input), true);
    writeTool('deployment.env.upsert', 'Upsert Vercel environment variable', 'Write-only value; production requires exact owner approval; receipt has metadata only.', variable, input => runtime.vercelEnvUpsert(input));
    writeTool('deployment.env.update', 'Update exact Vercel environment variable', 'Write-only value with exact variable ID/key and scoped targets.', variable.extend({ envId: z.string().min(3) }), input => runtime.vercelEnvUpdate(input));
    writeTool('deployment.env.remove', 'Remove exact Vercel environment variable', 'Remove exact ID/key after confirming project and production approval if applicable.', z.object({ ...base, envId: z.string().min(3), key: z.string(), approvalReference }), input => runtime.vercelEnvRemove(input), true);
    writeTool('deployment.vcr.create', 'Create Vercel Container Registry repository', 'Create one exact project-scoped VCR repository by name, then read it back from Vercel to verify the result.', z.object({ ...base, name: z.string().min(1).max(128).regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u) }), input => runtime.vercelVcrCreate(input));
    writeTool('deployment.vcr.image.delete', 'Delete exact Vercel Container Registry image', 'Delete one exact image ID + manifest digest only after Conductor proves it is unreferenced by protected current deployments. Until authoritative reachability is available, the operation fails closed before DELETE.', z.object({ ...base, name: z.string().min(1).max(128).regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u), imageId: z.string().min(1).max(256), expectedManifestDigest: z.string().min(1).max(512) }), input => runtime.vercelVcrImageDelete(input), true);
  }

  if (runtime.workItemReadEnabled) {
    server.registerTool('work-item.status', {
      title: 'Read work item status',
      description: 'Read one durable project work item with a normalized Conductor status while preserving native GitHub issue identity and labels.',
      inputSchema: z.object({
        project: projectSchema,
        issueNumber: z.number().int().positive(),
      }),
      outputSchema: readReceiptSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthSecurity },
    }, async (input) => result(await runtime.workItemStatus(input)));

    server.registerTool('work-item.list', {
      title: 'List project work items',
      description: 'List durable project work items, optionally filtered by normalized status. GitHub Issues are the initial backing store; pull requests are excluded.',
      inputSchema: z.object({
        project: projectSchema,
        statuses: z.array(workItemReadStatusSchema).max(7).optional(),
        kinds: z.array(workItemKindSchema).max(7).optional(),
        origins: z.array(workItemOriginSchema).max(8).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      outputSchema: readReceiptSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthSecurity },
    }, async (input) => result(await runtime.listWorkItems(input)));
  }


  if (runtime.repositoryAcquisitionReadEnabled) {
    const acquisitionInputSchema = z.object({
      upstreamRepository: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u),
      upstreamRef: z.string().trim().min(1).max(255),
      destinationOwner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u),
      destinationRepository: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/u),
      destinationBranch: z.string().trim().min(1).max(255).optional(),
    });
    server.registerTool('repository.acquire.preflight', {
      title: 'Preflight an external repository acquisition',
      description: 'Resolve one exact public GitHub upstream/ref and verify that an exact owner-approved destination already exists, is empty, and authorizes bounded snapshot acquisition. This never changes active code-work scope.',
      inputSchema: acquisitionInputSchema,
      outputSchema: readReceiptSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthSecurity },
    }, async (input) => result(await runtime.repositoryAcquisitionPreflight(input)));

    if (runtime.repositoryAcquisitionMutationEnabled) {
      server.registerTool('repository.acquire', {
        title: 'Acquire an exact external repository snapshot',
        description: 'Import one bounded exact public GitHub snapshot into an already-authorized empty repository. Requires an exact upstream SHA and explicit owner approval. Acquisition does not grant or switch code-work authority.',
        inputSchema: acquisitionInputSchema.extend({
          expectedUpstreamSha: z.string().regex(/^[0-9a-f]{40}$/iu),
          approvalReference: z.string().trim().min(1).max(500),
          idempotencyKey: z.string().min(8).max(200),
        }),
        outputSchema: mutationOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        _meta: { securitySchemes: oauthWriteSecurity },
      }, async (input, extra) => {
        requireWriteScope(extra.authInfo?.scopes);
        return result(await runtime.acquireRepository(input));
      });
    }
  }

  if (runtime.sourceControlMutationsEnabled) {

    if (runtime.lifecycleAdvanceEnabled) {
      server.registerTool('lifecycle.advance', {
        title: 'Advance work until the next gate',
        description: 'Advance one canonical issue through deterministic already-authorized PR verification, Preview integration, safe merged-branch cleanup, and bounded Preview deployment proof. Stops at READY Preview by default. Main promotion preparation is explicit and may carry a release-batch issue set; Main itself still requires a signed human gate.',
        inputSchema: z.object({
          project: projectSchema, workContext: workContextSchema, issueNumber: z.number().int().positive(),
          maxPolls: z.number().int().min(0).max(4).default(2), pollIntervalMs: z.number().int().min(0).max(1500).default(500),
          preparePromotion: z.boolean().default(false),
          promotionWorkItemNumbers: z.array(z.number().int().positive()).max(20).optional(),
          idempotencyKey: z.string().min(8).max(200), continuation: z.string().min(20).max(4096).optional(),
        }),
        outputSchema: compositeMutationOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        _meta: { securitySchemes: oauthWriteSecurity },
      }, async (input, extra) => {
        await requireScopedWrite(extra.authInfo, 'develop', input.project, input.workContext);
        const clientId = extra.authInfo?.clientId;
        if (!clientId) throw new Error('Authenticated client identity is required');
        const resolved = runtime.resolveProjectReference(input.project);
        const repository = resolved.repository ?? resolved.id;
        if (input.continuation) verifyLifecycleGate(input.continuation, clientId, { repository, projectId: resolved.id, issueNumber: input.issueNumber, kind: 'external-wait', allowedNextOperation: 'lifecycle.advance' });
        const { workContext: _scope, continuation: _continuation, ...runtimeInput } = input;
        const receipt = await runtime.advanceLifecycle({ ...runtimeInput, project: resolved });
        if (receipt.status === 'succeeded' && receipt.result.gate) {
          const issued = issueLifecycleGate(clientId, { repository, projectId: resolved.id, gate: receipt.result.gate });
          Object.assign(receipt.result, { continuation: { handle: issued.handle, expiresAt: issued.expiresAt, gateId: issued.gateId } });
        }
        return result(receipt);
      });
    }

    if (runtime.lifecycleResumeEnabled) {
      server.registerTool('lifecycle.resume', {
        title: 'Resume exact approved Main gate',
        description: 'Resume only a signed human-approval lifecycle gate. Revalidates exact promotion PR head/base, requires a new owner-approved: reference, and may carry an explicit exact production-blocker override list into the existing audited promotion gate.',
        inputSchema: z.object({
          project: projectSchema, workContext: workContextSchema, gate: z.string().min(20).max(4096),
          approvalReference: z.string().regex(/^owner-approved:/u).max(500),
          overrideBlockerIssueNumbers: z.array(z.number().int().positive()).max(100).optional(),
          idempotencyKey: z.string().min(8).max(200),
        }),
        outputSchema: compositeMutationOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        _meta: { securitySchemes: oauthWriteSecurity },
      }, async (input, extra) => {
        await requireScopedWrite(extra.authInfo, 'develop', input.project, input.workContext);
        const clientId = extra.authInfo?.clientId;
        if (!clientId) throw new Error('Authenticated client identity is required');
        const resolved = runtime.resolveProjectReference(input.project);
        const repository = resolved.repository ?? resolved.id;
        const gate = verifyLifecycleGate(input.gate, clientId, { repository, projectId: resolved.id, kind: 'human-approval', allowedNextOperation: 'lifecycle.resume' });
        if (!gate.pullRequestNumber || !gate.expectedHeadSha || !gate.expectedBaseSha) throw new Error('Lifecycle promotion gate is missing exact pull-request identity');
        return result(await runtime.resumeLifecycle({
          project: resolved, issueNumber: gate.issueNumber, gateId: gate.id, pullRequestNumber: gate.pullRequestNumber,
          expectedHeadSha: gate.expectedHeadSha, expectedBaseSha: gate.expectedBaseSha,
          approvalReference: input.approvalReference,
          overrideBlockerIssueNumbers: input.overrideBlockerIssueNumbers,
          idempotencyKey: input.idempotencyKey,
        }));
      });
    }

    server.registerTool('git.branch.create', {
      title: 'Create a work branch',
      description: 'Create one work/* branch from an exact full Git SHA. Requires durable idempotency and conductor.write.',
      inputSchema: z.object({
        project: projectSchema,
        workContext: workContextSchema,
        branch: z.string().min(6),
        fromSha: z.string().regex(/^[0-9a-f]{40}$/i),
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      await requireScopedWrite(extra.authInfo, 'develop', input.project, input.workContext);
      return result(await runtime.createBranch(withoutWorkContext(input)));
    });

    server.registerTool('git.integration.bootstrap', {
      title: 'Bootstrap Preview integration branch',
      description: 'Create exactly preview or vercel-preview from the current provider-native default-branch SHA. Requires active code-work scope, durable idempotency, and an explicit owner-approved: approval reference. Existing same-SHA branch reconciles idempotently; conflicts are never overwritten.',
      inputSchema: z.object({
        project: projectSchema,
        workContext: workContextSchema,
        branch: z.enum(['preview', 'vercel-preview']),
        fromSha: z.string().regex(/^[0-9a-f]{40}$/i),
        approvalReference: z.string().trim().min(1).max(500),
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      await requireScopedWrite(extra.authInfo, 'develop', input.project, input.workContext);
      return result(await runtime.bootstrapIntegrationBranch(withoutWorkContext(input)));
    });

    server.registerTool('git.branch.delete', {
      title: 'Delete an integrated development branch',
      description: 'Delete one exact work/*, repair/*, or audit/* branch only when its expected head is unchanged, no open pull request uses it, and GitHub proves that exact head is already contained in Preview or the repository default branch.',
      inputSchema: z.object({
        project: projectSchema,
        workContext: workContextSchema,
        branch: z.string().min(6),
        expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i),
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      await requireScopedWrite(extra.authInfo, 'develop', input.project, input.workContext);
      return result(await runtime.deleteBranch(withoutWorkContext(input)));
    });

    server.registerTool('git.commit.create', {
      title: 'Commit files to a work branch',
      description: 'Create one bounded commit, including tracked-file deletions via null content, and advance a work/* branch only when its head matches expectedHeadSha.',
      inputSchema: z.object({
        project: projectSchema,
        workContext: workContextSchema,
        branch: z.string().min(6),
        expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i),
        message: z.string().min(1).max(500),
        files: z.array(z.object({ path: z.string().min(1).max(1024), content: z.string().max(1024 * 1024).nullable().describe('Full UTF-8 file content, or null to delete the tracked path') })).min(1).max(100),
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      await requireScopedWrite(extra.authInfo, 'develop', input.project, input.workContext);
      return result(await runtime.createCommit(withoutWorkContext(input)));
    });

    if (runtime.workflowCommitEnabled) {
      server.registerTool('git.workflow.commit', {
        title: 'Commit a GitHub Actions workflow',
        description: 'Create or edit one .github/workflows/*.yml|yaml file on an exact work/* branch. Requires provable GitHub App contents:write + workflows:write and returns bounded security-review findings. It never writes Preview/Main directly.',
        inputSchema: z.object({
          project: projectSchema,
          workContext: workContextSchema,
          branch: z.string().min(6),
          expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i),
          message: z.string().min(1).max(500),
          path: z.string().regex(/^\.github\/workflows\/[^/]+\.(?:ya?ml)$/iu),
          content: z.string().min(1).max(1024 * 1024),
          idempotencyKey: z.string().min(8).max(200),
        }),
        outputSchema: mutationOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        _meta: { securitySchemes: oauthWriteSecurity },
      }, async (input, extra) => {
        await requireScopedWrite(extra.authInfo, 'develop', input.project, input.workContext);
        return result(await runtime.createWorkflowCommit(withoutWorkContext(input)));
      });
    }

    server.registerTool('pull-request.create', {
      title: 'Open a pull request',
      description: 'Open ordinary work/* into preview/vercel-preview, propose exact preview/vercel-preview to the provider-native default branch, or prepare exact provider-default-branch to Preview reconciliation. Optional canonical work-item numbers create native GitHub cross-references so transport PRs remain subordinate to one work identity. Creating a proposal never authorizes merge or production promotion.',
      inputSchema: z.object({
        project: projectSchema,
        workContext: workContextSchema,
        head: z.string().min(1).max(255),
        base: z.string().min(1).max(255).describe('Target branch for the pull request, for example main, preview, or vercel-preview'),
        title: z.string().min(1).max(256),
        body: z.string().optional(),
        draft: z.boolean().optional(),
        workItemNumbers: z.array(z.number().int().positive()).max(20).optional().describe('Canonical GitHub issue numbers carried by this transport/promotion PR'),
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      await requireScopedWrite(extra.authInfo, 'develop', input.project, input.workContext);
      return result(await runtime.createPullRequest(withoutWorkContext(input)));
    });

    server.registerTool('pull-request.comment.create', {
      title: 'Comment on a pull request',
      description: 'Add one idempotent comment to a pull request in an authorized repository.',
      inputSchema: z.object({
        project: projectSchema,
        workContext: workContextSchema,
        pullRequestNumber: z.number().int().positive(),
        body: z.string().min(1),
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      await requireScopedWrite(extra.authInfo, 'develop', input.project, input.workContext);
      return result(await runtime.commentPullRequest(withoutWorkContext(input)));
    });


    server.registerTool('pull-request.labels.update', {
      title: 'Update pull request labels',
      description: 'Add or remove labels while preserving unrelated labels. Requires conductor.write.',
      inputSchema: z.object({
        project: projectSchema,
        workContext: workContextSchema,
        pullRequestNumber: z.number().int().positive(),
        add: z.array(z.string().min(1).max(100)).max(50).optional(),
        remove: z.array(z.string().min(1).max(100)).max(50).optional(),
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      await requireScopedWrite(extra.authInfo, 'develop', input.project, input.workContext);
      return result(await runtime.updatePullRequestLabels(withoutWorkContext(input)));
    });


    if (runtime.pullRequestLifecycleMutationsEnabled) {
      const exactPullSchema = z.object({
        project: projectSchema,
        workContext: workContextSchema,
        pullRequestNumber: z.number().int().positive(),
        expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i),
        idempotencyKey: z.string().min(8).max(200),
      });

      server.registerTool('pull-request.close', {
        title: 'Close an exact pull request',
        description: 'Close one exact unmerged pull request without merging it. Already-closed unmerged pull requests are idempotent; merged pull requests are rejected.',
        inputSchema: exactPullSchema,
        outputSchema: mutationOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        _meta: { securitySchemes: oauthWriteSecurity },
      }, async (input, extra) => {
        await requireScopedWrite(extra.authInfo, 'develop', input.project, input.workContext);
        return result(await runtime.closePullRequest(withoutWorkContext(input)));
      });

      server.registerTool('pull-request.ready-for-review', {
        title: 'Mark an exact draft pull request ready',
        description: 'Mark one exact open draft pull request ready for review. This changes review state only and does not authorize merge or promotion.',
        inputSchema: exactPullSchema,
        outputSchema: mutationOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        _meta: { securitySchemes: oauthWriteSecurity },
      }, async (input, extra) => {
        await requireScopedWrite(extra.authInfo, 'develop', input.project, input.workContext);
        return result(await runtime.readyPullRequestForReview(withoutWorkContext(input)));
      });

      server.registerTool('pull-request.verify.rerun', {
        title: 'Rerun exact-head pull request verification',
        description: 'Rerun one exact GitHub Actions verify workflow run only after proving the run belongs to the expected pull-request head. Requires GitHub Actions write permission.',
        inputSchema: exactPullSchema.extend({ workflowRunId: z.number().int().positive() }),
        outputSchema: mutationOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        _meta: { securitySchemes: oauthWriteSecurity },
      }, async (input, extra) => {
        await requireScopedWrite(extra.authInfo, 'develop', input.project, input.workContext);
        return result(await runtime.rerunPullRequestVerification(withoutWorkContext(input)));
      });
    }

    server.registerTool('pull-request.merge.integration', {
      title: 'Merge an integration pull request',
      description: 'Merge an exact PR head/base candidate into a non-default integration branch. Main/master/default branches are rejected.',
      inputSchema: z.object({
        project: projectSchema,
        workContext: workContextSchema,
        pullRequestNumber: z.number().int().positive(),
        expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i),
        expectedBaseSha: z.string().regex(/^[0-9a-f]{40}$/i),
        mergeMethod: z.enum(['merge', 'squash', 'rebase']).default('squash'),
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      await requireScopedWrite(extra.authInfo, 'develop', input.project, input.workContext);
      return result(await runtime.mergeIntegrationPullRequest(withoutWorkContext(input)));
    });

    server.registerTool('pull-request.merge.reconcile-preview', {
      title: 'Reconcile Main ancestry into Preview',
      description: 'Merge an exact repository-default-branch PR candidate into preview/vercel-preview using a merge commit. This repairs post-promotion ancestry and never targets production.',
      inputSchema: z.object({
        project: projectSchema,
        workContext: workContextSchema,
        pullRequestNumber: z.number().int().positive(),
        expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i),
        expectedBaseSha: z.string().regex(/^[0-9a-f]{40}$/i),
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      await requireScopedWrite(extra.authInfo, 'develop', input.project, input.workContext);
      return result(await runtime.reconcilePreviewPullRequest(withoutWorkContext(input)));
    });

    server.registerTool('pull-request.merge.promote', {
      title: 'Promote an approved pull request',
      description: 'Merge an exact approved Preview candidate into the repository default branch with a merge commit, then create or reconcile the exact-SHA Vercel Production deployment when a verified binding exists. Requires exact head/base identity, owner approval, and no open production-blocking work items unless every current blocker is explicitly named for override.',
      inputSchema: z.object({
        project: projectSchema,
        workContext: workContextSchema,
        pullRequestNumber: z.number().int().positive(),
        expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i),
        expectedBaseSha: z.string().regex(/^[0-9a-f]{40}$/i),
        approvalReference: z.string().min(1).max(500),
        overrideBlockerIssueNumbers: z.array(z.number().int().positive()).max(100).optional(),
        mergeMethod: z.literal('merge').optional(),
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      await requireScopedWrite(extra.authInfo, 'develop', input.project, input.workContext);
      return result(await runtime.promotePullRequest(withoutWorkContext(input)));
    });
  }


  if (runtime.workItemMutationsEnabled) {
    server.registerTool('work-item.create', {
      title: 'Create a durable work item',
      description: 'Create one durable work item in the owning project. Issue routing can reach any provider-accessible repository; this does not grant code-work authority. The agent must verify destination ownership, visibility, and current routing authorization. GitHub Issues are the initial backing store; no scheduling or autonomous assignment occurs. Bodies may start sparse; when known prefer Problem, Desired outcome, Evidence, Constraints, and Acceptance sections.',
      inputSchema: z.object({
        project: projectSchema,
        title: z.string().min(1).max(256),
        body: z.string().max(100000).optional(),
        status: newWorkItemStatusSchema.default('backlog'),
        kind: workItemKindSchema.optional(),
        origin: workItemOriginSchema.optional(),
        severity: workItemSeveritySchema.optional(),
        priority: workItemPrioritySchema.optional(),
        productionBlocking: z.boolean().optional(),
        labels: z.array(z.string().min(1).max(100)).max(20).optional(),
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      await requireScopedWrite(extra.authInfo, 'route-work', input.project);
      return result(await runtime.createWorkItem(input));
    });

    server.registerTool('work-item.comment.create', {
      title: 'Add evidence to an existing issue',
      description: 'Add one idempotent comment to an existing issue in an exact provider-accessible repository. Search for an existing issue before creating another; add new evidence to the canonical issue and link any confirmed duplicate before closing it. Destination ownership, visibility, and routing authorization still apply. This does not grant code-work authority.',
      inputSchema: z.object({
        project: projectSchema,
        issueNumber: z.number().int().positive(),
        body: z.string().trim().min(1).max(100000),
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      await requireScopedWrite(extra.authInfo, 'route-work', input.project);
      return result(await runtime.commentWorkItem(input));
    });

    server.registerTool('work-item.classification.update', {
      title: 'Classify a work item',
      description: 'Update normalized work kind and/or origin on an exact routed issue. Use unknown to clear a classification; unrelated labels and lifecycle status are preserved. Cross-repository issue maintenance does not grant code-work authority.',
      inputSchema: z.object({
        project: projectSchema,
        issueNumber: z.number().int().positive(),
        kind: workItemKindSchema.optional(),
        origin: workItemOriginSchema.optional(),
        idempotencyKey: z.string().min(8).max(200),
      }).refine((value) => value.kind !== undefined || value.origin !== undefined, {
        message: 'At least one of kind or origin is required',
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      await requireScopedWrite(extra.authInfo, 'route-work', input.project);
      return result(await runtime.updateWorkItemClassification(input));
    });

    server.registerTool('work-item.triage.update', {
      title: 'Update work item triage',
      description: 'Update normalized severity, priority, and production-blocking release-gate state on one exact routed issue. unknown clears severity/priority; false clears the production gate. Status, kind, origin, and unrelated labels are preserved.',
      inputSchema: z.object({
        project: projectSchema,
        issueNumber: z.number().int().positive(),
        severity: workItemSeveritySchema.optional(),
        priority: workItemPrioritySchema.optional(),
        productionBlocking: z.boolean().optional(),
        idempotencyKey: z.string().min(8).max(200),
      }).refine((value) => value.severity !== undefined || value.priority !== undefined || value.productionBlocking !== undefined, {
        message: 'At least one of severity, priority, or productionBlocking is required',
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      await requireScopedWrite(extra.authInfo, 'route-work', input.project);
      return result(await runtime.updateWorkItemTriage(input));
    });

    server.registerTool('work-item.update-status', {
      title: 'Update work item status',
      description: 'Move one exact routed issue to an explicit normalized status. done closes the backing issue; active statuses reopen it. For a duplicate, link the canonical issue in a comment first. Cross-repository issue maintenance does not grant code-work authority.',
      inputSchema: z.object({
        project: projectSchema,
        issueNumber: z.number().int().positive(),
        status: workItemWriteStatusSchema,
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      await requireScopedWrite(extra.authInfo, 'route-work', input.project);
      return result(await runtime.updateWorkItemStatus(input));
    });
  }

  return server;
}

function requireWriteScope(scopes?: string[]): void {
  if (!scopes?.includes(CONDUCTOR_WRITE_SCOPE)) {
    throw new Error('This operation requires the conductor.write OAuth scope');
  }
}

function writeAction(operation: string): WorkAction | undefined {
  if (operation.startsWith('work-item.')) return ['work-item.status', 'work-item.list'].includes(operation) ? undefined : 'route-work';
  if (operation === 'pull-request.status') return undefined;
  if (operation.startsWith('deployment.') && !['deployment.status','deployment.logs','deployment.audit','deployment.runtime-logs','deployment.env.list','deployment.vcr.get','deployment.vcr.list','deployment.vcr.images.list'].includes(operation)) return 'develop';
  if (operation.startsWith('lifecycle.')) return 'develop';
  if (operation.startsWith('git.') || operation.startsWith('pull-request.')) return 'develop';
  return undefined;
}

function result(receipt: object) {
  return {
    structuredContent: { receipt },
    content: [{ type: 'text' as const, text: JSON.stringify(receipt) }],
  };
}
