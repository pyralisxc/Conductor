import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRuntimeFromEnvironment } from '../src/config/runtime.js';
import { createConductorHttpHandler } from '../src/transport/http.js';
import { handleOAuthHttpRequest } from '../src/transport/oauth-http.js';
import {
  assertOAuthConfiguration,
  oauthPublicBaseUrl,
  SelfHostedAccessTokenVerifier,
} from '../src/transport/oauth.js';

let handler: ReturnType<typeof createConductorHttpHandler> | undefined;

function conductorHandler(): ReturnType<typeof createConductorHttpHandler> {
  if (handler) return handler;

  assertOAuthConfiguration();
  const publicUrl = oauthPublicBaseUrl();
  handler = createConductorHttpHandler({
    runtime: createRuntimeFromEnvironment(),
    publicUrl,
    oauthIssuer: publicUrl,
    verifier: new SelfHostedAccessTokenVerifier(),
    handleOAuthRequest: handleOAuthHttpRequest,
  });
  return handler;
}

export default async function vercelHandler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  await conductorHandler()(request, response);
}
