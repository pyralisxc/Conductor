import { createRuntimeFromEnvironment, parseRuntimeBindings } from './runtime.js';
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
  const boundRepositories = parseRuntimeBindings(process.env.CONDUCTOR_PROJECTS_JSON).flatMap(x => x.repository ? [x.repository] : []);
  const defaultRepository = process.env.CONDUCTOR_DEFAULT_WORK_REPOSITORY ?? (boundRepositories.length === 1 ? boundRepositories[0] : undefined);
  if (runtime.sourceControlMutationsEnabled || runtime.workItemMutationsEnabled) {
    if (!redisUrl || !redisToken) throw new Error('Owner-managed work scope requires Redis');
    if (!defaultRepository) throw new Error('Configure CONDUCTOR_DEFAULT_WORK_REPOSITORY when multiple projects are bound');
  }
  const store = redisUrl && redisToken && defaultRepository ? new RedisWorkScopeStore(redisUrl, redisToken) : undefined;
  return createConductorHttpHandler({
    runtime,
    publicUrl,
    oauthIssuer: publicUrl,
    verifier: new SelfHostedAccessTokenVerifier(),
    workScope: store && defaultRepository ? new WorkScopeAuthorizer(store, defaultRepository) : undefined,
    handleWorkScopeRequest: store ? createWorkScopeHttpHandler(store) : undefined,
    handleOAuthRequest: handleOAuthHttpRequest,
  });
}
