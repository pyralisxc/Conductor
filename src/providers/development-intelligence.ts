import { normalizeToolError } from '../runtime/errors.js';
import type {
  CapabilityAvailability,
  PreflightCheck,
  OperationPreflightCheck,
  ProjectReference,
  RuntimeOperationName,
} from '../runtime/types.js';
import type { OperationPreflightProvider, ProjectPreflightProvider } from './runtime.js';

/**
 * Truthful placeholder used until a deployed Development Intelligence API
 * adapter is configured. It never converts missing integration into evidence.
 */
export class UnavailableDevelopmentIntelligenceProvider implements ProjectPreflightProvider, OperationPreflightProvider {
  readonly id = 'development-intelligence';

  async getCapabilities(): Promise<CapabilityAvailability[]> {
    return [{
      capability: 'development-intelligence.read',
      available: false,
      provider: this.id,
      access: 'read',
      auth: 'unknown',
      health: 'unavailable',
      diagnostics: [{
        level: 'warning',
        source: this.id,
        code: 'TOOL_UNAVAILABLE',
        message: 'No deployed Development Intelligence adapter is configured',
      }],
    }];
  }

  async preflightOperation(
    project: ProjectReference,
    operation: RuntimeOperationName,
  ): Promise<OperationPreflightCheck[] | undefined> {
    if (operation !== 'development.status') return undefined;
    return operationChecks(await this.preflightProject(project));
  }

  async preflightProject(_project: ProjectReference): Promise<PreflightCheck[]> {
    const error = normalizeToolError({
      code: 'TOOL_UNAVAILABLE',
      message: 'No deployed Development Intelligence adapter is configured',
    }, 'TOOL_UNAVAILABLE', this.id);
    return [{
      check: 'development-intelligence.read',
      status: 'unavailable',
      provider: this.id,
      summary: error.message,
      error,
      diagnostics: error.diagnostics,
    }];
  }
}

interface DevelopmentIntelligenceRpcResponse {
  error?: { code?: number; message?: string };
  result?: {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };
}

export interface DevelopmentIntelligenceProviderOptions {
  endpoint: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export class DevelopmentIntelligenceProvider implements ProjectPreflightProvider, OperationPreflightProvider {
  readonly id = 'development-intelligence';
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: DevelopmentIntelligenceProviderOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async getCapabilities(): Promise<CapabilityAvailability[]> {
    if (!this.token) return [unavailableIntelligenceCapability('AUTH_REQUIRED', 'Development Intelligence authentication is not configured')];
    try {
      const response = await this.rpc('tools/list', {});
      const tools = (response.result as { tools?: Array<{ name?: string }> } | undefined)?.tools ?? [];
      if (!tools.some((tool) => tool.name === 'project_status')) {
        return [unavailableIntelligenceCapability('TOOL_UNAVAILABLE', 'Development Intelligence does not expose project_status')];
      }
      return [{
        capability: 'development-intelligence.read',
        available: true,
        provider: this.id,
        access: 'read',
        auth: 'ready',
        health: 'ready',
        diagnostics: [],
      }];
    } catch (error) {
      const normalized = normalizeToolError(error, 'TOOL_UNAVAILABLE', this.id);
      return [unavailableIntelligenceCapability(normalized.code, normalized.message)];
    }
  }

  async preflightOperation(
    project: ProjectReference,
    operation: RuntimeOperationName,
  ): Promise<OperationPreflightCheck[] | undefined> {
    if (operation !== 'development.status') return undefined;
    return operationChecks(await this.preflightProject(project));
  }

  async preflightProject(project: ProjectReference): Promise<PreflightCheck[]> {
    if (!this.token) return [failedIntelligenceCheck('AUTH_REQUIRED', 'Development Intelligence authentication is not configured')];
    const projectIdentity = project.repository ?? project.id;
    try {
      const response = await this.rpc('tools/call', {
        name: 'project_status',
        arguments: { project: projectIdentity, checkUpstream: true },
      });
      const result = response.result as DevelopmentIntelligenceRpcResponse['result'];
      if (result?.isError) {
        const message = result.content?.find((item) => item.type === 'text')?.text
          ?? `Development Intelligence rejected ${projectIdentity}`;
        return [failedIntelligenceCheck('TOOL_UNAVAILABLE', message)];
      }
      const status = result?.structuredContent;
      const projectFailure = developmentIntelligenceProjectFailure(status, projectIdentity);
      if (projectFailure) {
        return [failedIntelligenceCheck(projectFailure.code, projectFailure.message)];
      }
      return [{
        check: 'development-intelligence.read',
        status: 'ready',
        provider: this.id,
        summary: `Development Intelligence can inspect ${projectIdentity}`,
        diagnostics: [],
      }];
    } catch (error) {
      const normalized = normalizeToolError(error, 'TOOL_UNAVAILABLE', this.id);
      return [failedIntelligenceCheck(normalized.code, normalized.message)];
    }
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<DevelopmentIntelligenceRpcResponse> {
    const response = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'conductor', method, params }),
    });
    if (!response.ok) throw { status: response.status, message: `Development Intelligence returned HTTP ${response.status}` };
    const body = await response.json() as DevelopmentIntelligenceRpcResponse;
    if (body.error) throw { code: 'TOOL_UNAVAILABLE', message: body.error.message ?? 'Development Intelligence RPC failed' };
    return body;
  }
}

function unavailableIntelligenceCapability(
  code: import('../runtime/types.js').ToolErrorCode,
  message: string,
): CapabilityAvailability {
  return {
    capability: 'development-intelligence.read',
    available: false,
    provider: 'development-intelligence',
    access: 'read',
    auth: code === 'AUTH_REQUIRED' ? 'required' : 'unknown',
    health: 'unavailable',
    diagnostics: [{ level: 'warning', source: 'development-intelligence', code, message }],
  };
}

function failedIntelligenceCheck(
  code: import('../runtime/types.js').ToolErrorCode,
  message: string,
): PreflightCheck {
  const error = normalizeToolError({ code, message }, code, 'development-intelligence');
  return {
    check: 'development-intelligence.read',
    status: code === 'AUTH_REQUIRED' || code === 'PERMISSION_DENIED' || code === 'NOT_FOUND'
      ? 'blocked'
      : 'unavailable',
    provider: 'development-intelligence',
    summary: message,
    error,
    diagnostics: error.diagnostics,
  };
}

function developmentIntelligenceProjectFailure(
  status: Record<string, unknown> | undefined,
  projectIdentity: string,
): { code: import('../runtime/types.js').ToolErrorCode; message: string } | undefined {
  if (!status) {
    return {
      code: 'TOOL_UNAVAILABLE',
      message: `Development Intelligence returned no project status for ${projectIdentity}`,
    };
  }

  const upstreamError = readableStatusError(status.upstreamError);
  if (upstreamError) {
    return {
      code: classifyStatusError(upstreamError),
      message: `Development Intelligence cannot read ${projectIdentity}: ${upstreamError}`,
    };
  }

  const graphError = readableStatusError(status.graphError);
  if (graphError) {
    return {
      code: 'COMMAND_FAILED',
      message: `Development Intelligence cannot inspect ${projectIdentity}: ${graphError}`,
    };
  }

  if (!status.upstreamSha || !status.graph) {
    return {
      code: 'TOOL_UNAVAILABLE',
      message: `Development Intelligence has no usable project graph for ${projectIdentity}`,
    };
  }

  return undefined;
}

function readableStatusError(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value instanceof Error && value.message.trim()) return value.message.trim();
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return undefined;
}

function classifyStatusError(message: string): import('../runtime/types.js').ToolErrorCode {
  if (/\b403\b|permission|access denied|not granted/i.test(message)) return 'PERMISSION_DENIED';
  if (/\b401\b|unauthenticated|authentication/i.test(message)) return 'AUTH_REQUIRED';
  if (/\b404\b|not found/i.test(message)) return 'NOT_FOUND';
  if (/timeout|timed out|temporar|rate limit|\b429\b|\b5\d\d\b/i.test(message)) return 'TRANSIENT';
  return 'TOOL_UNAVAILABLE';
}


function operationChecks(checks: PreflightCheck[]): OperationPreflightCheck[] {
  return checks.map((check) => ({
    provider: check.provider,
    status: check.status,
    summary: check.summary,
    error: check.error,
    diagnostics: check.diagnostics,
  }));
}
