import { createRuntimeFromEnvironment, parseRuntimeBindings } from './runtime.js';
import { createConductorHttpHandler } from '../transport/http.js';
import { createWorkScopeHttpHandler } from '../transport/work-scope-http.js';
import { RedisWorkScopeStore, WorkScopeAuthorizer } from '../transport/work-scope.js';
import { handleOAuthHttpRequest } from '../transport/oauth-http.js';
import { handleAscAuthorityBridgeRequest } from '../transport/asc-authority-bridge.js';
import { handleSymphonyConnectionRequest } from '../transport/symphony-connection-http.js';
import { assertOAuthConfiguration, oauthPublicBaseUrl, SelfHostedAccessTokenVerifier } from '../transport/oauth.js';
import { runConfiguredVcrRetention, vcrRetentionCronAuthorized } from '../maintenance/vcr-retention.js';

/** Shared by Vercel's function and the standalone server so authorization cannot drift. */
export function createConfiguredHttpHandler() {
  assertOAuthConfiguration();
  const publicUrl = oauthPublicBaseUrl();
  const runtime = createRuntimeFromEnvironment();
  const symphonyBindings = parseRuntimeBindings(process.env.CONDUCTOR_PROJECTS_JSON)
    .filter((binding) => binding.workerRuntimeEndpoint && binding.workerRuntimeConnectionId);
  const symphonyBinding = symphonyBindings[0] && symphonyBindings[0].repository
    ? {
        endpoint: symphonyBindings[0].workerRuntimeEndpoint!,
        connectionId: symphonyBindings[0].workerRuntimeConnectionId!,
        repository: symphonyBindings[0].repository!,
      }
    : undefined;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (runtime.sourceControlMutationsEnabled || runtime.workItemMutationsEnabled) {
    if (!redisUrl || !redisToken) throw new Error('Owner-managed work scope requires Redis');
  }
  const store = redisUrl && redisToken ? new RedisWorkScopeStore(redisUrl, redisToken) : undefined;
  const conductorHandler = createConductorHttpHandler({
    runtime,
    publicUrl,
    oauthIssuer: publicUrl,
    verifier: new SelfHostedAccessTokenVerifier(),
    workScope: store ? new WorkScopeAuthorizer(store) : undefined,
    handleWorkScopeRequest: store ? createWorkScopeHttpHandler(store) : undefined,
    handleOAuthRequest: async (
      request,
      response,
      url,
    ) => {
      if (
        await handleSymphonyConnectionRequest(
          request,
          response,
          url,
          { binding: symphonyBinding },
        )
      ) {
        return true;
      }
      if (
        await handleAscAuthorityBridgeRequest(
          request,
          response,
          url,
          {
            runtime,
            ...(store
              ? {
                  workScope:
                    new WorkScopeAuthorizer(store),
                }
              : {}),
          },
        )
      ) {
        return true;
      }
      return handleOAuthHttpRequest(
        request,
        response,
        url,
      );
    },
  });
  return async (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => {
    const url = new URL(request.url ?? '/', publicUrl);
    if (url.pathname === '/internal/vcr-retention') {
      if (request.method !== 'GET') {
        response.statusCode = 405;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }));
        return;
      }
      if (!vcrRetentionCronAuthorized(request.headers.authorization, process.env.CRON_SECRET)) {
        response.statusCode = 401;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ error: 'AUTH_REQUIRED' }));
        return;
      }
      try {
        const maintenance = await runConfiguredVcrRetention(runtime, process.env.CONDUCTOR_VCR_RETENTION_JSON);
        const summaries = Array.isArray(maintenance.results) ? maintenance.results.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object')) : [];
        console.info(JSON.stringify({
          event: 'vcr-retention-complete',
          targets: maintenance.targets ?? 0,
          results: summaries.map(value => ({
            project: value.project ?? null,
            repository: value.repository ?? null,
            beforeImages: value.beforeImages ?? null,
            afterImages: value.afterImages ?? null,
            deletedImages: value.deletedImages ?? null,
            reclaimedKnownBytes: value.reclaimedKnownBytes ?? null,
            reviewImages: value.reviewImages ?? null,
            retainedTargetReached: value.retainedTargetReached ?? null,
          })),
        }));
        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(maintenance));
      } catch (error) {
        console.error(JSON.stringify({ event: 'vcr-retention-error', message: error instanceof Error ? error.message.slice(0, 500) : 'VCR retention failed' }));
        response.statusCode = 500;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ error: 'VCR_RETENTION_FAILED' }));
      }
      return;
    }
    await conductorHandler(request, response);
  };
}
