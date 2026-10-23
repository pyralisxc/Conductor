import { validateCallbackRecipient } from '../transport/event-callback.js';
import { ProjectEvents, projectRelationship } from '../runtime/project-events.js';
import { oauthGrantStore, requireOAuthGrant } from '../transport/oauth-grant-store.js';
import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';
import * as z from 'zod/v4';
import type { ConductorToolRuntime } from '../runtime/runtime.js';
import { PrEvents, RedisPrEventStore, eventOwnerAuthorized, prEventArguments, prEventIntegrationBranch, type PrEventService } from '../runtime/pr-events.js';
import { GitHubAppCredentialProvider } from '../connections/github/app-installation.js';
import { providerCredentialVaultFromEnvironment } from '../connections/universal/credential-vault.js';
import { GitHubRuntimeProvider } from '../providers/github.js';
import { safeCallbackPost } from '../transport/event-callback.js';

const commonConfiguration = {
  target: prEventArguments,
  integrationBranch: prEventIntegrationBranch.optional(),
  owner: z.object({ issuer: z.url(), subject: z.string().min(1).max(200), clientId: z.string().min(1).max(2048) }).strict(),
  installationId: z.number().int().positive(),
};
const configuration = z.union([
  z.object({ mode: z.literal('projects'), owner: commonConfiguration.owner.omit({ clientId: true }).strict(),
    clientFingerprint: z.string().regex(/^[a-f0-9]{64}$/), relationships: z.array(projectRelationship).min(1).max(8) }).strict(),
  z.object({ ...commonConfiguration, callbackHostname: z.string().max(253).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/) }).strict(),
  z.object({ ...commonConfiguration, owner: commonConfiguration.owner.omit({ clientId: true }).strict(), delegatedRecipient: z.object({
    clientFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    approval: z.object({ id: z.uuid(), expiresAt: z.number().int().positive() }).strict().optional(),
  }).strict() }).strict(),
]);

/** Disabled by default. Provisioning/approving a live Preview subscription is a separate gate. */
export function createConfiguredPrEvents(runtime: ConductorToolRuntime, environment: NodeJS.ProcessEnv = process.env): PrEventService | undefined {
  const discovery = environment.CONDUCTOR_PR_EVENTS_DISCOVERY_ONLY;
  if (discovery !== undefined) {
    if (discovery !== 'true') throw new Error('Discovery-only mode must be explicitly true or absent');
    if (environment.VERCEL_ENV !== 'preview') throw new Error('Event discovery is limited to Preview');
    if (environment.CONDUCTOR_PR_EVENTS_JSON !== undefined) throw new Error('Discovery-only and live events are mutually exclusive');
    return 'discovery-only';
  }
  if (!environment.CONDUCTOR_PR_EVENTS_JSON) return undefined;
  if (environment.VERCEL_ENV !== 'preview') throw new Error('PR events are limited to Preview');
  const config = configuration.parse(JSON.parse(environment.CONDUCTOR_PR_EVENTS_JSON));
  const delegated = 'delegatedRecipient' in config ? config.delegatedRecipient : undefined;
  const url = environment.UPSTASH_REDIS_REST_URL ?? environment.KV_REST_API_URL;
  const token = environment.UPSTASH_REDIS_REST_TOKEN ?? environment.KV_REST_API_TOKEN;
  const appId = environment.CONDUCTOR_GITHUB_APP_ID;
  const privateKey = environment.CONDUCTOR_GITHUB_APP_PRIVATE_KEY;
  const webhookSecret = environment.CONDUCTOR_GITHUB_WEBHOOK_SECRET;
  if (!url || !token || !appId || !privateKey || !webhookSecret || webhookSecret.length < 32) throw new Error('PR events require existing shared storage and approved GitHub App webhook configuration');
  const app = new GitHubAppCredentialProvider({ appId, privateKey });
  const vault = providerCredentialVaultFromEnvironment('pr-events', environment);
  vault.seal('configuration-check'); // Fail at startup if the existing vault is unavailable.
  const redis = new Redis({ url, token, enableTelemetry: false, automaticDeserialization: false });
  const grants = oauthGrantStore(environment);
  if ('mode' in config) {
    const projectProvider = new GitHubRuntimeProvider({credentials:app,
      bindings:config.relationships.map(r=>({id:r.repository,repository:r.repository,write:false}))});
    return new ProjectEvents({relationships:config.relationships,owner:config.owner,clientFingerprint:config.clientFingerprint,
      redis,grants,vault,webhookSecret,validateRecipient:validateCallbackRecipient,
      post:(url,body,headers)=>safeCallbackPost(new URL(url).hostname)(url,body,headers),
      source:{async read(owner,rel,number,generation) {
        await requireOAuthGrant(grants,owner,generation);
        await app.getRepositoryAttestation(rel.repository,rel.installationId);
        const project=runtime.resolveProjectReference({id:rel.repository,repository:rel.repository});
        const receipt=await runtime.pullRequestStatus({project,pullRequestNumber:number});
        if(receipt.status!=='succeeded')throw new Error('Provider reconciliation unavailable');
        if(receipt.result.base.ref!==rel.integrationBranch)throw new Error('Wrong integration branch');
        const target={repository:rel.repository,pullRequestNumber:number,headSha:receipt.result.head.sha,baseSha:receipt.result.base.sha};
        const reviews=await projectProvider.getPullRequestReviewState(target,rel.installationId,
          ()=>requireOAuthGrant(grants,owner,generation),rel.integrationBranch);
        await requireOAuthGrant(grants,owner,generation);
        return {...receipt.result,reviews};
      }}
    });
  }
  const reviewProvider = new GitHubRuntimeProvider({ credentials: app, bindings: [{ id: config.target.repository, repository: config.target.repository, write: false }] });
  // Stable single delegated slot prevents config edits silently moving existing authority.
  const digest = createHash('sha256').update(delegated ? `delegated:${config.installationId}` : JSON.stringify(config)).digest('hex');
  return new PrEvents({ ...config, webhookSecret, vault, grants,
    store: new RedisPrEventStore(redis, `conductor:preview:pr-events:v1:${digest}`),
    validateRecipient: delegated ? validateCallbackRecipient : undefined,
    post: 'callbackHostname' in config ? safeCallbackPost(config.callbackHostname) : (url, body, headers) => safeCallbackPost(new URL(url).hostname)(url, body, headers),
    source: { async read(owner, target, generation) {
      if (!eventOwnerAuthorized(owner, config.owner, delegated?.clientFingerprint)) throw new Error('Event principal revoked');
      await requireOAuthGrant(grants, owner, generation);
      // Native installation attestation is fresh, not a cached token/account or OAuth-client inference.
      await app.getRepositoryAttestation(target.repository, config.installationId);
      const project = runtime.resolveProjectReference({ id: target.repository, repository: target.repository });
      await requireOAuthGrant(grants, owner, generation);
      const receipt = await runtime.pullRequestStatus({ project, pullRequestNumber: target.pullRequestNumber });
      if (receipt.status !== 'succeeded') throw new Error('Provider reconciliation unavailable');
      const reviews = await reviewProvider.getPullRequestReviewState(target, config.installationId, () => requireOAuthGrant(grants, owner, generation), config.integrationBranch ?? 'preview');
      return { ...receipt.result, reviews };
    } },
  });
}
