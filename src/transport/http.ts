import type { PrEvents } from '../runtime/pr-events.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { withRequestCorrelation, traceCommitBoundary } from './request-correlation.js';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { ConductorToolRuntime } from '../runtime/runtime.js';
import { TOOL_RUNTIME_CONTRACT_VERSION } from '../runtime/types.js';
import type { AccessTokenVerifier } from './auth.js';
import { CONDUCTOR_READ_SCOPE, CONDUCTOR_WRITE_SCOPE } from './auth.js';
import { createConductorMcpServer } from './mcp.js';
import type { WorkScopeAuthorizer } from './work-scope.js';

export interface ConductorHttpHandlerOptions {
  runtime: ConductorToolRuntime;
  events?: PrEvents;
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
  const mcpHandler = toNodeHandler(createMcpHandler(ctx => createConductorMcpServer(options.runtime, options.workScope, ctx.era === 'modern' ? options.events : undefined)));
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
    if (url.pathname === '/events/github' && options.events) {
      if (request.method !== 'POST') { json(response, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk); size += bytes.length;
          if (size > 262144) { json(response, 413, { error: 'PAYLOAD_TOO_LARGE' }); return; }
          chunks.push(bytes);
        }
        const header = (name: string) => typeof request.headers[name] === 'string' ? request.headers[name] as string : '';
        const status = await options.events.ingest(Buffer.concat(chunks), header('x-github-event'), header('x-github-delivery'), header('x-hub-signature-256'));
        json(response, status === 'pending' || status === 'failed' || status === 'capacity' ? 503 : 200, { status });
      } catch { json(response, 400, { error: 'EVENT_REJECTED' }); }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      response.statusCode = 303;
      response.setHeader('Location', '/connections/vercel');
      response.setHeader('Cache-Control', 'no-store');
      response.end();
      return;
    }
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

    return withRequestCorrelation(async () => {
      const started = Date.now();
      const lengthHeader = request.headers['content-length'];
      const parsedLength = parseContentLength(lengthHeader);
      traceCommitBoundary('http-admitted', { contentLength: parsedLength !== null && Number.isSafeInteger(parsedLength) ? parsedLength : null });
      try {
        await mcpHandler(request, response);
      } catch {
      if (!response.headersSent) {
        json(response, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
      } finally {
        traceCommitBoundary('http-completed', { statusCode: response.statusCode, durationMs: Date.now() - started });
      }
    });
  };
}

declare module 'node:http' {
  interface IncomingMessage {
    auth?: Awaited<ReturnType<AccessTokenVerifier['verifyAccessToken']>>;
  }
}

/** Parse a numeric Content-Length header without exposing request data. */
export function parseContentLength(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
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
