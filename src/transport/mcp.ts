import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { ConductorToolRuntime } from '../runtime/runtime.js';

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
  operation: z.enum(['capabilities', 'preflight_project']),
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
        name: z.enum(['capabilities', 'preflight_project']),
        description: z.string(),
        mutates: z.literal(false),
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
  id: z.string().min(1).describe('Allowlisted Conductor project ID'),
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
    inputSchema: z.object({ project: projectSchema }),
    outputSchema: z.object({ receipt: preflightReceiptSchema }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { securitySchemes: oauthSecurity },
  }, async ({ project }) => result(await runtime.preflightProject(project)));

  return server;
}

function result(receipt: object) {
  return {
    structuredContent: { receipt },
    content: [{ type: 'text' as const, text: JSON.stringify(receipt) }],
  };
}
