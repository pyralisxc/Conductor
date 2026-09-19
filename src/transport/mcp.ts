import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { ConductorToolRuntime } from '../runtime/runtime.js';
import { CONDUCTOR_WRITE_SCOPE } from './auth.js';

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

const receiptBase = {
  contractVersion: z.literal('conductor.tool-runtime.v0'),
  operationId: z.string(),
  operation: z.enum([
    'capabilities', 'preflight_project', 'pull-request.status', 'git.branch.create', 'git.commit.create',
    'pull-request.create', 'pull-request.comment.create', 'pull-request.labels.update',
    'pull-request.merge.integration', 'pull-request.merge.promote',
  ]),
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
        name: z.enum([
          'capabilities', 'preflight_project', 'pull-request.status', 'git.branch.create', 'git.commit.create',
          'pull-request.create', 'pull-request.comment.create', 'pull-request.labels.update',
    'pull-request.merge.integration', 'pull-request.merge.promote',
        ]),
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
  id: z.string().min(1).describe('Project alias, repository name, or authorized owner/repository'),
  repository: z.string().optional().describe('Optional expected owner/repository'),
  workspace: z.string().optional().describe('Optional expected absolute workspace path'),
  ref: z.string().optional().describe('Git ref to verify'),
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
      mergeCommitSha: z.string().optional(),
    }).optional(),
    idempotency: idempotencySchema,
  }),
  z.object({ ...failedReceiptSchema.shape, idempotency: idempotencySchema.optional() }),
]);

const mutationOutputSchema = z.object({ receipt: mutationReceiptSchema });

export function createConductorMcpServer(runtime: ConductorToolRuntime): McpServer {
  const server = new McpServer(
    { name: 'conductor', version: '0.1.0' },
    {
      instructions: 'Call capabilities first in a fresh conversation. Call preflight_project before project work. Treat unavailable or blocked checks as hard evidence; do not infer hidden access.',
    },
  );

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

  if (runtime.pullRequestReadEnabled) {
    server.registerTool('pull-request.status', {
      title: 'Read pull request status',
      description: 'Read one pull request with exact head/base SHAs, labels, check runs, and workflow runs. Use before merge or CI decisions.',
      inputSchema: z.object({
        project: projectSchema,
        pullRequestNumber: z.number().int().positive(),
      }),
      outputSchema: z.object({ receipt: z.union([
        z.object({ ...receiptBase, status: z.literal('succeeded'), result: z.record(z.string(), z.unknown()) }),
        failedReceiptSchema,
      ]) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthSecurity },
    }, async (input) => result(await runtime.pullRequestStatus(input)));
  }

  if (runtime.mutationsEnabled) {
    server.registerTool('git.branch.create', {
      title: 'Create a work branch',
      description: 'Create one work/* branch from an exact full Git SHA. Requires durable idempotency and conductor.write.',
      inputSchema: z.object({
        project: projectSchema,
        branch: z.string().min(6),
        fromSha: z.string().regex(/^[0-9a-f]{40}$/i),
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      requireWriteScope(extra.authInfo?.scopes);
      return result(await runtime.createBranch(input));
    });

    server.registerTool('git.commit.create', {
      title: 'Commit files to a work branch',
      description: 'Create one bounded commit, including tracked-file deletions via null content, and advance a work/* branch only when its head matches expectedHeadSha.',
      inputSchema: z.object({
        project: projectSchema,
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
      requireWriteScope(extra.authInfo?.scopes);
      return result(await runtime.createCommit(input));
    });

    server.registerTool('pull-request.create', {
      title: 'Open a pull request',
      description: 'Open a work/* pull request against an explicit branch. Creating a proposal is allowed; merging or promoting accepted branches is a separate consequential operation.',
      inputSchema: z.object({
        project: projectSchema,
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
      requireWriteScope(extra.authInfo?.scopes);
      return result(await runtime.createPullRequest(input));
    });

    server.registerTool('pull-request.comment.create', {
      title: 'Comment on a pull request',
      description: 'Add one idempotent comment to a pull request in an authorized repository.',
      inputSchema: z.object({
        project: projectSchema,
        pullRequestNumber: z.number().int().positive(),
        body: z.string().min(1),
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      requireWriteScope(extra.authInfo?.scopes);
      return result(await runtime.commentPullRequest(input));
    });


    server.registerTool('pull-request.labels.update', {
      title: 'Update pull request labels',
      description: 'Add or remove labels while preserving unrelated labels. Requires conductor.write.',
      inputSchema: z.object({
        project: projectSchema,
        pullRequestNumber: z.number().int().positive(),
        add: z.array(z.string().min(1).max(100)).max(50).optional(),
        remove: z.array(z.string().min(1).max(100)).max(50).optional(),
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      requireWriteScope(extra.authInfo?.scopes);
      return result(await runtime.updatePullRequestLabels(input));
    });

    server.registerTool('pull-request.merge.integration', {
      title: 'Merge an integration pull request',
      description: 'Merge an exact PR head/base candidate into a non-default integration branch. Main/master/default branches are rejected.',
      inputSchema: z.object({
        project: projectSchema,
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
      requireWriteScope(extra.authInfo?.scopes);
      return result(await runtime.mergeIntegrationPullRequest(input));
    });

    server.registerTool('pull-request.merge.promote', {
      title: 'Promote an approved pull request',
      description: 'Merge an exact approved PR candidate into the repository default branch. Requires exact head SHA, exact base SHA, and an owner approval reference.',
      inputSchema: z.object({
        project: projectSchema,
        pullRequestNumber: z.number().int().positive(),
        expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i),
        expectedBaseSha: z.string().regex(/^[0-9a-f]{40}$/i),
        approvalReference: z.string().min(1).max(500),
        mergeMethod: z.enum(['merge', 'squash', 'rebase']).default('squash'),
        idempotencyKey: z.string().min(8).max(200),
      }),
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: oauthWriteSecurity },
    }, async (input, extra) => {
      requireWriteScope(extra.authInfo?.scopes);
      return result(await runtime.promotePullRequest(input));
    });
  }

  return server;
}

function requireWriteScope(scopes?: string[]): void {
  if (!scopes?.includes(CONDUCTOR_WRITE_SCOPE)) {
    throw new Error('This operation requires the conductor.write OAuth scope');
  }
}

function result(receipt: object) {
  return {
    structuredContent: { receipt },
    content: [{ type: 'text' as const, text: JSON.stringify(receipt) }],
  };
}




