import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { ConductorToolRuntime } from '../runtime/runtime.js';
import { CONDUCTOR_WRITE_SCOPE } from './auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { ProjectReference } from '../runtime/types.js';
import type { WorkAction, WorkScopeAuthorizer } from './work-scope.js';
import { clientFingerprint } from './work-scope.js';

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
  'capabilities', 'preflight_project', 'preflight_operation',
  'development.status', 'pull-request.status', 'source.artifact.read', 'ci.run.read', 'deployment.status', 'deployment.logs', 'deployment.audit', 'deployment.runtime-logs', 'deployment.env.list', 'deployment.vcr.get', 'work-item.status', 'work-item.list',
  'git.branch.create', 'git.branch.delete', 'git.commit.create', 'git.push',
  'pull-request.create', 'pull-request.comment.create', 'pull-request.labels.update',
  'pull-request.merge.integration', 'pull-request.merge.reconcile-preview', 'pull-request.merge.promote',
  'work-item.create', 'work-item.comment.create', 'work-item.update-status', 'work-item.classification.update',
  'deployment.redeploy', 'deployment.git.create', 'deployment.promote', 'deployment.rollback', 'deployment.delete',
  'deployment.env.upsert', 'deployment.env.update', 'deployment.env.remove', 'deployment.vcr.create',
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
  'bug', 'feature', 'investigation', 'improvement', 'maintenance', 'operations', 'unknown',
]);
const workItemOriginSchema = z.enum([
  'human', 'agent-audit', 'di-finding', 'ci', 'runtime', 'dependency', 'user-feedback', 'unknown',
]);
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
      description: 'Verify whether one exact exposed operation can execute against the supplied execution-routing referent. This does not infer which operation the project needs.',
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
            'verification-failed', 'merge-blocked', 'promotion-ready',
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


  if (runtime.sourceArtifactReadEnabled) {
    server.registerTool('source.artifact.read', {
      title: 'Read exact source artifact',
      description: 'Use after Development Intelligence has narrowed the source area. Read one complete bounded UTF-8 file at an exact 40-character Git SHA and repository-relative path. This tool does no browsing, repository-wide search, architecture inference, or semantic interpretation.',
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
      }),
      outputSchema: readReceiptSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthSecurity },
    }, async (input) => result(await runtime.deploymentStatus(input)));

    server.registerTool('deployment.logs', {
      title: 'Read deployment logs',
      description: 'Read bounded, redacted Vercel deployment event logs for one exact deployment. This surface is intended for deployment/build diagnosis and does not expose credentials.',
      inputSchema: z.object({
        project: projectSchema,
        deploymentId: z.string().min(3).max(256),
        limit: z.number().int().min(1).max(200).default(100),
      }),
      outputSchema: readReceiptSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthSecurity },
    }, async (input) => result(await runtime.deploymentLogs(input)));
  }


  if (runtime.deploymentReadEnabled) {
    const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
    const readTool = (name: 'deployment.audit' | 'deployment.runtime-logs' | 'deployment.env.list' | 'deployment.vcr.get', title: string, description: string, inputSchema: z.ZodObject<any>, run: (input: any) => Promise<object>) => {
      server.registerTool(name, { title, description, inputSchema, outputSchema: readReceiptSchema, annotations: readOnly, _meta: { securitySchemes: oauthSecurity } },
        async (input) => result(await run(input)));
    };
    readTool('deployment.audit', 'Audit Vercel project operations', 'Bounded project, domains, aliases, custom environments, deployment and environment metadata. Unsupported account usage and billing are explicit.', z.object({ project: projectSchema }), input => runtime.deploymentAudit(input));
    readTool('deployment.runtime-logs', 'Read Vercel runtime logs', 'Read bounded redacted runtime logs for one exact bound deployment.', z.object({ project: projectSchema, deploymentId: z.string().min(3), limit: z.number().int().min(1).max(100).default(50) }), input => runtime.deploymentRuntimeLogs(input));
    readTool('deployment.env.list', 'List Vercel variable metadata', 'List exact project variable metadata; values are never returned.', z.object({ project: projectSchema }), input => runtime.deploymentEnvironmentList(input));
    readTool('deployment.vcr.get', 'Read exact Vercel Container Registry repository', 'Read one exact project-scoped VCR repository by name. No image contents or credentials are returned.', z.object({ project: projectSchema, name: z.string().min(1).max(128).regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u) }), input => runtime.deploymentVcrGet(input));
  }

  if (runtime.vercelMutationEnabled) {
    const idempotencyKey = z.string().min(8).max(200);
    const deploymentId = z.string().regex(/^dpl_[A-Za-z0-9]+$/u);
    const approvalReference = z.string().optional().describe('Exact owner approval for production actions; must begin owner-approved:');
    const base = { project: projectSchema, idempotencyKey, workContext: workContextSchema };
    const deployment = z.object({ ...base, deploymentId, approvalReference });
    const variable = z.object({ ...base, key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), value: z.string(), type: z.enum(['plain', 'encrypted', 'sensitive']), target: z.array(z.enum(['production','preview','development'])).min(1).max(3), gitBranch: z.string().optional(), customEnvironmentIds: z.array(z.string()).max(20).optional(), approvalReference });
    const writeTool = (name: 'deployment.redeploy' | 'deployment.git.create' | 'deployment.promote' | 'deployment.rollback' | 'deployment.delete' | 'deployment.env.upsert' | 'deployment.env.update' | 'deployment.env.remove' | 'deployment.vcr.create', title: string, description: string, inputSchema: z.ZodObject<any>, run: (input: any) => Promise<object>, destructive = false) => {
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

  if (runtime.sourceControlMutationsEnabled) {
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

    server.registerTool('pull-request.create', {
      title: 'Open a pull request',
      description: 'Open a work/* pull request against an explicit branch, or propose exact preview/vercel-preview to the provider-native default branch. Creating a proposal never authorizes merge or production promotion.',
      inputSchema: z.object({
        project: projectSchema,
        workContext: workContextSchema,
        head: z.string().min(6),
        base: z.string().min(1).max(255).describe('Target branch for the pull request, for example main, preview, or vercel-preview'),
        title: z.string().min(1).max(256),
        body: z.string().optional(),
        draft: z.boolean().optional(),
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
      description: 'Merge an exact approved Preview candidate into the repository default branch with a merge commit. Requires exact head SHA, exact base SHA, and an owner approval reference.',
      inputSchema: z.object({
        project: projectSchema,
        workContext: workContextSchema,
        pullRequestNumber: z.number().int().positive(),
        expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i),
        expectedBaseSha: z.string().regex(/^[0-9a-f]{40}$/i),
        approvalReference: z.string().min(1).max(500),
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
  if (operation.startsWith('deployment.') && !['deployment.status','deployment.logs','deployment.audit','deployment.runtime-logs','deployment.env.list','deployment.vcr.get'].includes(operation)) return 'develop';
  if (operation.startsWith('git.') || operation.startsWith('pull-request.')) return 'develop';
  return undefined;
}

function result(receipt: object) {
  return {
    structuredContent: { receipt },
    content: [{ type: 'text' as const, text: JSON.stringify(receipt) }],
  };
}
