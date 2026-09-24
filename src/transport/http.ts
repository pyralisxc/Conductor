import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ConductorToolRuntime } from '../runtime/runtime.js';
import { TOOL_RUNTIME_CONTRACT_VERSION } from '../runtime/types.js';
import type { AccessTokenVerifier } from './auth.js';
import { CONDUCTOR_READ_SCOPE, CONDUCTOR_WRITE_SCOPE } from './auth.js';
import { createConductorMcpServer } from './mcp.js';
import type { WorkScopeAuthorizer } from './work-scope.js';

export interface ConductorHttpHandlerOptions {
  runtime: ConductorToolRuntime;
  verifier: AccessTokenVerifier;
  publicUrl: string;
  oauthIssuer: string;
  workScope?: WorkScopeAuthorizer;
  handleOAuthRequest?: (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) => Promise<boolean>;
  handleWorkScopeRequest?: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
}

export function createConductorHttpHandler(options: ConductorHttpHandlerOptions) {
  const mcpUrl = new URL('/mcp', ensureTrailingSlash(options.publicUrl));
  const metadata = {
    resource: mcpUrl.toString(),
    authorization_servers: [options.oauthIssuer.replace(/\/$/, '')],
    scopes_supported: [CONDUCTOR_READ_SCOPE, CONDUCTOR_WRITE_SCOPE],
    resource_name: 'Conductor Tool Runtime',
  };
  const challenge = `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', mcpUrl).toString()}", scope="${CONDUCTOR_READ_SCOPE}"`;

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', options.publicUrl);
    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, {
        status: 'ready',
        contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
      });
      return;
    }
    if (options.handleOAuthRequest && await options.handleOAuthRequest(request, response, url)) return;
    if (options.handleWorkScopeRequest && await options.handleWorkScopeRequest(request, response, url)) return;
    if (request.method === 'GET' && (
      url.pathname === '/.well-known/oauth-protected-resource' ||
      url.pathname === '/.well-known/oauth-protected-resource/mcp'
    )) {
      json(response, 200, metadata);
      return;
    }
    if (url.pathname !== '/mcp') {
      json(response, 404, { error: 'NOT_FOUND' });
      return;
    }

    const token = bearerToken(request.headers.authorization);
    if (!token) {
      unauthorized(response, challenge, 'Authentication required');
      return;
    }
    try {
      request.auth = await options.verifier.verifyAccessToken(token);
    } catch {
      unauthorized(response, `${challenge}, error="invalid_token"`, 'Invalid or expired access token');
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createConductorMcpServer(options.runtime, options.workScope);
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) {
        json(response, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
}

declare module 'node:http' {
  interface IncomingMessage {
    auth?: Awaited<ReturnType<AccessTokenVerifier['verifyAccessToken']>>;
  }
}

function bearerToken(authorization?: string): string | undefined {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function unauthorized(response: ServerResponse, challenge: string, message: string): void {
  response.setHeader('WWW-Authenticate', challenge);
  json(response, 401, { error: 'AUTH_REQUIRED', message });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
