import { createServer } from 'node:http';
import { createRuntimeFromEnvironment } from './config/runtime.js';
import { createConductorHttpHandler } from './transport/http.js';
import { handleOAuthHttpRequest } from './transport/oauth-http.js';
import {
  assertOAuthConfiguration,
  oauthPublicBaseUrl,
  SelfHostedAccessTokenVerifier,
} from './transport/oauth.js';

const port = integerEnvironment('PORT', 3000);
assertOAuthConfiguration();
const publicUrl = oauthPublicBaseUrl();

const handler = createConductorHttpHandler({
  runtime: createRuntimeFromEnvironment(),
  publicUrl,
  oauthIssuer: publicUrl,
  verifier: new SelfHostedAccessTokenVerifier(),
  handleOAuthRequest: handleOAuthHttpRequest,
});

createServer((request, response) => {
  void handler(request, response);
}).listen(port, () => {
  console.log(`Conductor runtime listening on port ${port}`);
});

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return parsed;
}
