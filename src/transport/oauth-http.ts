import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleVercelConnectionRequest } from './vercel-connections.js';
import {
  clearOwnerSession,
  normalizeReturnTo,
  ownerPasswordMatches,
  ownerSessionValid,
  renderOwnerLogin,
  setOwnerSession,
} from './owner-auth.js';
import {
  authorizationRedirect,
  exchangeOAuthToken,
  issueAuthorizationCode,
  oauthAuthorizationServerMetadata,
  oauthProtectedResourceMetadata,
  parseOAuthAuthorizationRequest,
  registerOAuthClient,
  renderOAuthConsent,
} from './oauth.js';

const MAX_OAUTH_BODY = 128 * 1024;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_OAUTH_BODY) {
      throw Object.assign(new Error('OAuth request body too large'), { status: 413, oauthError: 'invalid_request' });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400, oauthError: 'invalid_request' });
  }
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams((await readBody(req)).toString('utf8'));
}

function json(res: ServerResponse, status: number, value: unknown, metadata = false): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': metadata ? 'public, max-age=300' : 'no-store',
    'x-content-type-options': 'nosniff',
    ...(metadata ? { 'access-control-allow-origin': '*' } : { pragma: 'no-cache' }),
  });
  res.end(JSON.stringify(value));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  });
  res.end(body);
}

function oauthError(res: ServerResponse, error: unknown): void {
  const status = (error as { status?: number })?.status ?? 400;
  const code = (error as { oauthError?: string })?.oauthError ?? 'invalid_request';
  const description = error instanceof Error ? error.message : String(error);
  json(res, status, { error: code, error_description: description });
}

function authorizeReturnTo(requestUrl: URL): string {
  return `${requestUrl.pathname}${requestUrl.search}`;
}

export async function handleOAuthHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
): Promise<boolean> {
  if (await handleVercelConnectionRequest(req, res, requestUrl)) return true;
  if ((requestUrl.pathname === '/.well-known/oauth-protected-resource'
      || requestUrl.pathname === '/.well-known/oauth-protected-resource/mcp')
    && req.method === 'GET') {
    try {
      json(res, 200, oauthProtectedResourceMetadata(), true);
    } catch (error) {
      oauthError(res, error);
    }
    return true;
  }

  if (requestUrl.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
    try {
      json(res, 200, oauthAuthorizationServerMetadata(), true);
    } catch (error) {
      oauthError(res, error);
    }
    return true;
  }

  if (requestUrl.pathname === '/oauth/register') {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end();
      return true;
    }
    try {
      json(res, 201, registerOAuthClient(await readJson(req)));
    } catch (error) {
      oauthError(res, error);
    }
    return true;
  }

  if (requestUrl.pathname === '/oauth/authorize') {
    if (req.method === 'GET') {
      try {
        const request = parseOAuthAuthorizationRequest(requestUrl.searchParams);
        if (!ownerSessionValid(req)) {
          res.writeHead(303, {
            location: `/login?returnTo=${encodeURIComponent(authorizeReturnTo(requestUrl))}`,
            'cache-control': 'no-store',
          });
          res.end();
          return true;
        }
        html(res, 200, renderOAuthConsent(request));
      } catch (error) {
        oauthError(res, error);
      }
      return true;
    }
    if (req.method === 'POST') {
      if (!ownerSessionValid(req)) {
        html(res, 401, '<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorization expired</title><body><h1>Authorization session expired</h1><p>Restart the connection from your MCP client.</p></body></html>');
        return true;
      }
      try {
        const request = parseOAuthAuthorizationRequest(await readForm(req));
        const code = await issueAuthorizationCode(request);
        res.writeHead(303, { location: authorizationRedirect(request, code), 'cache-control': 'no-store' });
        res.end();
      } catch (error) {
        oauthError(res, error);
      }
      return true;
    }
    res.writeHead(405, { allow: 'GET, POST' });
    res.end();
    return true;
  }

  if (requestUrl.pathname === '/oauth/token') {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end();
      return true;
    }
    try {
      json(res, 200, await exchangeOAuthToken(await readForm(req)));
    } catch (error) {
      oauthError(res, error);
    }
    return true;
  }

  if (requestUrl.pathname === '/login') {
    const returnTo = normalizeReturnTo(requestUrl.searchParams.get('returnTo'));
    if (req.method === 'GET') {
      html(res, 200, renderOwnerLogin(returnTo));
      return true;
    }
    if (req.method === 'POST') {
      try {
        const form = await readForm(req);
        const formReturnTo = normalizeReturnTo(form.get('returnTo'));
        if (!ownerPasswordMatches(form.get('password') ?? '')) {
          html(res, 401, renderOwnerLogin(formReturnTo, 'That password was not accepted.'));
          return true;
        }
        setOwnerSession(res);
        res.writeHead(303, { location: formReturnTo, 'cache-control': 'no-store' });
        res.end();
      } catch (error) {
        html(res, (error as { status?: number })?.status ?? 400, renderOwnerLogin(returnTo, error instanceof Error ? error.message : String(error)));
      }
      return true;
    }
    res.writeHead(405, { allow: 'GET, POST' });
    res.end();
    return true;
  }

  if (requestUrl.pathname === '/logout') {
    clearOwnerSession(res);
    res.writeHead(303, { location: '/login', 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  return false;
}
