import { createRuntimeFromEnvironment } from './runtime.js';
import { createConductorHttpHandler } from '../transport/http.js';
import { createWorkScopeHttpHandler } from '../transport/work-scope-http.js';
import { RedisWorkScopeStore, WorkScopeAuthorizer } from '../transport/work-scope.js';
import { handleOAuthHttpRequest } from '../transport/oauth-http.js';
import { assertOAuthConfiguration, oauthPublicBaseUrl, SelfHostedAccessTokenVerifier } from '../transport/oauth.js';

/** Shared by Vercel's function and the standalone server so authorization cannot drift. */
export function createConfiguredHttpHandler() {
  assertOAuthConfiguration();
  const publicUrl = oauthPublicBaseUrl();
  const runtime = createRuntimeFromEnvironment();
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (runtime.sourceControlMutationsEnabled || runtime.workItemMutationsEnabled) {
    if (!redisUrl || !redisToken) throw new Error('Owner-managed work scope requires Redis');
  }
  const store = redisUrl && redisToken ? new RedisWorkScopeStore(redisUrl, redisToken) : undefined;
  return createConductorHttpHandler({
    runtime,
    publicUrl,
    oauthIssuer: publicUrl,
    verifier: new SelfHostedAccessTokenVerifier(),
    workScope: store ? new WorkScopeAuthorizer(store) : undefined,
    handleWorkScopeRequest: store ? createWorkScopeHttpHandler(store) : undefined,
    handleOAuthRequest: handleOAuthHttpRequest,
  });
}
