import { oauthGrantStore, requireOAuthGrant } from '../transport/oauth-grant-store.js';
import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';
import * as z from 'zod/v4';
import type { ConductorToolRuntime } from '../runtime/runtime.js';
import { PrEvents, RedisPrEventStore, eventOwnerEqual, prEventArguments } from '../runtime/pr-events.js';
import { GitHubAppCredentialProvider } from '../connections/github/app-installation.js';
import { providerCredentialVaultFromEnvironment } from '../connections/universal/credential-vault.js';
import { GitHubRuntimeProvider } from '../providers/github.js';
import { safeCallbackPost } from '../transport/event-callback.js';

const configuration = z.object({
  target: prEventArguments,
  owner: z.object({ issuer: z.url(), subject: z.string().min(1).max(200), clientId: z.string().min(1).max(2048) }).strict(),
  installationId: z.number().int().positive(),
  callbackHostname: z.string().max(253).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/),
}).strict();

/** Disabled by default. Provisioning/approving a live Preview subscription is a separate gate. */
export function createConfiguredPrEvents(runtime: ConductorToolRuntime, environment: NodeJS.ProcessEnv = process.env): PrEvents | undefined {
  if (!environment.CONDUCTOR_PR_EVENTS_JSON) return undefined;
  if (environment.VERCEL_ENV !== 'preview') throw new Error('PR events are limited to Preview');
  const config = configuration.parse(JSON.parse(environment.CONDUCTOR_PR_EVENTS_JSON));
  const url = environment.UPSTASH_REDIS_REST_URL ?? environment.KV_REST_API_URL;
  const token = environment.UPSTASH_REDIS_REST_TOKEN ?? environment.KV_REST_API_TOKEN;
  const appId = environment.CONDUCTOR_GITHUB_APP_ID;
  const privateKey = environment.CONDUCTOR_GITHUB_APP_PRIVATE_KEY;
  const webhookSecret = environment.CONDUCTOR_GITHUB_WEBHOOK_SECRET;
  if (!url || !token || !appId || !privateKey || !webhookSecret || webhookSecret.length < 32) throw new Error('PR events require existing shared storage and approved GitHub App webhook configuration');
  const app = new GitHubAppCredentialProvider({ appId, privateKey });
  const reviewProvider = new GitHubRuntimeProvider({ credentials: app, bindings: [{ id: config.target.repository, repository: config.target.repository, write: false }] });
  const vault = providerCredentialVaultFromEnvironment('pr-events', environment);
  vault.seal('configuration-check'); // Fail at startup if the existing vault is unavailable.
  const digest = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const redis = new Redis({ url, token, enableTelemetry: false, automaticDeserialization: false });
  const grants = oauthGrantStore(environment);
  return new PrEvents({ ...config, webhookSecret, vault, grants,
    store: new RedisPrEventStore(redis, `conductor:preview:pr-events:v1:${digest}`),
    post: safeCallbackPost(config.callbackHostname),
    source: { async read(owner, target, generation) {
      if (!eventOwnerEqual(owner, config.owner)) throw new Error('Event principal revoked');
      await requireOAuthGrant(grants, owner, generation);
      // Native installation attestation is fresh, not a cached token/account or OAuth-client inference.
      await app.getRepositoryAttestation(target.repository, config.installationId);
      const project = runtime.resolveProjectReference({ id: target.repository, repository: target.repository });
      await requireOAuthGrant(grants, owner, generation);
      const receipt = await runtime.pullRequestStatus({ project, pullRequestNumber: target.pullRequestNumber });
      if (receipt.status !== 'succeeded') throw new Error('Provider reconciliation unavailable');
      const reviews = await reviewProvider.getPullRequestReviewState(target, config.installationId, () => requireOAuthGrant(grants, owner, generation));
      return { ...receipt.result, reviews };
    } },
  });
}
