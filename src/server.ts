import { createServer } from 'node:http';
import { createRuntimeFromEnvironment, parseRuntimeBindings } from './config/runtime.js';
import { createConductorHttpHandler } from './transport/http.js';
import { createWorkScopeHttpHandler } from './transport/work-scope-http.js';
import { RedisWorkScopeStore, WorkScopeAuthorizer } from './transport/work-scope.js';
import { handleOAuthHttpRequest } from './transport/oauth-http.js';
import {
  assertOAuthConfiguration,
  oauthPublicBaseUrl,
  SelfHostedAccessTokenVerifier,
} from './transport/oauth.js';

const port = integerEnvironment('PORT', 3000);
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
const workScopeStore = redisUrl && redisToken && defaultRepository ? new RedisWorkScopeStore(redisUrl, redisToken) : undefined;

const handler = createConductorHttpHandler({
  runtime,
  publicUrl,
  oauthIssuer: publicUrl,
  verifier: new SelfHostedAccessTokenVerifier(),
  workScope: workScopeStore && defaultRepository ? new WorkScopeAuthorizer(workScopeStore, defaultRepository) : undefined,
  handleWorkScopeRequest: workScopeStore ? createWorkScopeHttpHandler(workScopeStore) : undefined,
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
