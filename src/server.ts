import { createServer } from 'node:http';
import { createRuntimeFromEnvironment } from './config/runtime.js';
import { JwtAccessTokenVerifier } from './transport/auth.js';
import { createConductorHttpHandler } from './transport/http.js';

const port = integerEnvironment('PORT', 3000);
const publicUrl = requiredEnvironment('CONDUCTOR_PUBLIC_URL');
const oauthIssuer = requiredEnvironment('CONDUCTOR_OAUTH_ISSUER');
const oauthJwksUrl = requiredEnvironment('CONDUCTOR_OAUTH_JWKS_URL');
const mcpAudience = new URL('/mcp', publicUrl.endsWith('/') ? publicUrl : `${publicUrl}/`).toString();

const handler = createConductorHttpHandler({
  runtime: createRuntimeFromEnvironment(),
  publicUrl,
  oauthIssuer,
  verifier: new JwtAccessTokenVerifier({
    issuer: oauthIssuer,
    audience: mcpAudience,
    jwksUrl: oauthJwksUrl,
  }),
});

createServer((request, response) => {
  void handler(request, response);
}).listen(port, () => {
  console.log(`Conductor runtime listening on port ${port}`);
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return parsed;
}
