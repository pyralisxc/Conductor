import { clientFingerprint } from '../transport/work-scope.js';
import { oauthGrantKey, requireOAuthGrant, grantGenerationSchema, type OAuthGrantStore } from '../transport/oauth-grant-store.js';
import { ingestGitHubPrEvent } from '../providers/github-events.js';
import { createHash, randomUUID } from 'node:crypto';
import { ProtocolError, type AuthInfo } from '@modelcontextprotocol/server';
import { Redis } from '@upstash/redis';
import * as z from 'zod/v4';
import type { VersionedProviderCredentialVault } from '../connections/universal/credential-vault.js';
import type { PullRequestStatus } from './types.js';
import { callbackUrl, signingKey, signedCallback, verifyCallback, type CallbackPost } from '../transport/event-callback.js';

export const prEventIntegrationBranch = z.enum(['preview', 'vercel-preview']);
export type PrEventIntegrationBranch = z.infer<typeof prEventIntegrationBranch>;
export const PR_EVENT = 'pull_request.verification_changed';


export const prEventArguments = z.object({
  repository: z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).refine(value => !containsCredentialLike(value), 'Sensitive material is not allowed'),
  pullRequestNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
export type PrEventArguments = z.infer<typeof prEventArguments>;
export const CHECKPOINT_EVENT = 'agent.checkpoint_published';

const credentialLike = /(?:\bBearer\s+|whsec_[A-Za-z0-9+/=]{16,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|sk-[A-Za-z0-9_-]{16,}|(?:access[_-]?token|api[_-]?key|client[_-]?secret|password)=|-----BEGIN [A-Z ]+-----)/i;
function containsCredentialLike(value: string): boolean {
  if (credentialLike.test(value)) return true;
  try { const u=new URL(value); return credentialLike.test(decodeURIComponent(u.pathname))||credentialLike.test(decodeURIComponent(u.hostname))||credentialLike.test(decodeURIComponent(u.search))||credentialLike.test(decodeURIComponent(u.hash)); } catch { return false; }
}
const safeCallerString=(max:number,url=false)=>{const value=z.string().max(max);return (url?value.url():value).refine(text=>!containsCredentialLike(text),'Sensitive material is not allowed');};

export const checkpointPublicationArguments = z.object({
 resource: prEventArguments,
 source: z.object({conversationUrl:safeCallerString(500,true),conversationId:safeCallerString(200).nullable(),replyId:safeCallerString(200).nullable(),replyState:z.enum(['known','unavailable','not-yet-confirmed'])}).strict(),
 checkpointId:safeCallerString(160).min(8).regex(/^[A-Za-z0-9._:-]+$/),
 summary:safeCallerString(1200).min(1),
 evidence:z.array(z.object({kind:z.enum(['github','ci','deployment','slack']),reference:safeCallerString(500,true)}).strict()).max(12),
 pending:z.array(safeCallerString(300).min(1)).max(8),
}).strict().superRefine((v,ctx)=>{
 const u=new URL(v.source.conversationUrl);
 if(u.protocol!=='https:'||u.hostname!=='chatgpt.com'||u.username||u.password||u.search||u.hash)ctx.addIssue({code:'custom',path:['source','conversationUrl'],message:'Canonical HTTPS ChatGPT conversation URL required'});
 for(const e of v.evidence){const x=new URL(e.reference);const ok=e.kind==='github'||e.kind==='ci'?['github.com','api.github.com'].includes(x.hostname):e.kind==='deployment'?x.hostname==='vercel.com'||x.hostname.endsWith('.vercel.app'):x.hostname==='slack.com'||x.hostname.endsWith('.slack.com');if(x.protocol!=='https:'||!ok||x.username||x.password||x.search||x.hash)ctx.addIssue({code:'custom',path:['evidence'],message:'Evidence URL host does not match kind'});}
});
export type CheckpointPublicationArguments = z.infer<typeof checkpointPublicationArguments>;

export const prEventBindingStatusSchema = z.object({
  status: z.enum(['empty', 'pending', 'challenging', 'active', 'expired', 'invalid_authority', 'unavailable']),
  configuredResource: prEventArguments,
  eventName: z.enum([PR_EVENT, CHECKPOINT_EVENT]).nullable(),
  phase: z.enum(['pending', 'challenging', 'active']).nullable(),
  subscriptionExpiresAt: z.number().int().nullable(),
  delegationExpiresAt: z.number().int().nullable(),
  bindingGuard: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  ownerMatchesConfigured: z.boolean(),
  clientMatchesConfigured: z.boolean(),
  resourceMatchesConfigured: z.boolean(),
  bindingMatchesConfigured: z.boolean(),
  currentGrantValid: z.boolean(),
  subscriptionGrantMatches: z.boolean(),
  approvalMatches: z.boolean(),
  approvalValid: z.boolean(),
  observedAt: z.iso.datetime(),
}).strict();
export type PrEventBindingStatus = z.infer<typeof prEventBindingStatusSchema>;
export const prEventExpiredBindingReleaseArguments = z.object({
  resource: prEventArguments, eventName: z.enum([PR_EVENT, CHECKPOINT_EVENT]),
  expectedPhase: z.enum(['pending', 'challenging', 'active']),
  expectedSubscriptionExpiresAt: z.number().int().positive(),
  expectedDelegationExpiresAt: z.number().int().positive(),
  expectedBindingGuard: z.string().regex(/^[a-f0-9]{64}$/),
  approvalReference: z.string().trim().min(16).max(500).refine(v => v.startsWith('owner-approved:') && v.slice('owner-approved:'.length).trim().length > 0, 'Owner approval reference required'),
  confirm: z.literal(true),
}).strict();
export type PrEventExpiredBindingReleaseArguments = z.infer<typeof prEventExpiredBindingReleaseArguments>;


export interface EventOwner { issuer: string; subject: string; clientId: string }
// Allowlisted metadata only; unknown provider fields (including bodies) are stripped.
const reviewActor = z.object({ id: z.number().int().positive(), login: z.string().max(100).regex(/^[A-Za-z0-9_\[\]-]+$/).nullable() }).nullable();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const version = z.string().regex(/^[a-f0-9]{64}$/);
export const prReviewEvidence = z.object({
  complete: z.boolean(), reason: z.enum(['complete', 'page-limit']),
  revision: version, effectiveDecisions: z.array(z.object({ reviewer: reviewActor,
    state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'NONE', 'UNKNOWN']),
    reviewId: z.number().int().positive().nullable(), commitSha: sha.nullable(),
  })).max(100).nullable(), currentHeadApprovals: z.number().int().nonnegative().nullable(),
  latestActivity: z.array(z.object({ id: z.number().int().positive(), reviewer: reviewActor,
    state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']),
    commitSha: sha, currentHead: z.boolean(), submittedAt: z.iso.datetime(), version,
  })).max(100),
  comments: z.array(z.object({ id: z.number().int().positive(), reviewId: z.number().int().positive().nullable(),
    author: reviewActor, commitSha: sha, currentHead: z.boolean(), updatedAt: z.iso.datetime(),
    url: z.string().max(400).regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+#discussion_r[0-9]+$/), version,
  })).max(100),
});
export type PrReviewEvidence = z.infer<typeof prReviewEvidence>;
export type PrEventSnapshot = PullRequestStatus & { reviews?: PrReviewEvidence };
/** Generic protocol metadata only; never inspect a configured wait or live state. */
export function prEventCatalog() {
  return { events: [{ name: PR_EVENT, description: 'Current verification and bounded review metadata for one exact authorized Preview PR wait. Re-read current native PR and review state before any already-authorized continuation.',
    delivery: ['webhook'], inputSchema: z.toJSONSchema(prEventArguments),
    payloadSchema: { type: 'object', properties: {
      repository: { type: 'string' }, pullRequestNumber: { type: 'integer' }, headSha: { type: 'string' }, baseSha: { type: 'string' },
      state: { type: 'string' }, merged: { type: 'boolean' }, draft: { type: 'boolean' }, checks: { type: 'object' }, url: { type: 'string' }, reviews: z.toJSONSchema(prReviewEvidence),
    }, required: ['repository', 'pullRequestNumber', 'headSha', 'baseSha', 'state', 'merged', 'draft', 'checks', 'url'], additionalProperties: false },

    },
    { name: CHECKPOINT_EVENT, description: 'Explicit agent work-result checkpoint for this exact authorized Preview PR resource. The subscription selects the recipient; publication cannot select a chat or destination.',
      delivery: ['webhook'], inputSchema: z.toJSONSchema(prEventArguments),
      payloadSchema: { type: 'object', properties: { origin: { type: 'string' }, eventClass: { type: 'string' }, project: { type: 'string' }, resource: z.toJSONSchema(prEventArguments), source: { type: 'object' }, checkpointId: { type: 'string' }, publishedAt: { type: 'string' }, summary: { type: 'string' }, evidence: { type: 'array' }, pending: { type: 'array' } },
      required: ['origin','eventClass','project','resource','source','checkpointId','publishedAt','summary','evidence','pending'], additionalProperties: false },
    }
  ] };
}
export type PrEventService = PrEvents | 'discovery-only';
export interface PrEventSource {
  /** Revalidate principal/resource authority and current installation access on every call. */
  read(owner: EventOwner, target: PrEventArguments, generation: string): Promise<PrEventSnapshot>;
}
interface Subscription {
  id: string; owner: EventOwner; generation: string; url: string; secret: string; expiresAt: number; eventName?: string;
  previousSecret?: string; rotationUntil?: number; verifiedUntil: number;
  binding?: { id: string; approvalId: string; phase: 'pending' | 'challenging' | 'active'; fingerprint: string; target: PrEventArguments; integrationBranch?: PrEventIntegrationBranch; attemptId?: string };
}
interface Delivery {
  id: string; source: string; fingerprint: string; body: string; createdAt: number; resourceFingerprint?: string;
  attempts: number; leaseUntil?: number; status: 'pending' | 'accepted' | 'failed' | 'stopped' | 'uncertain' | 'superseded' | 'blocked';
}
export interface PrEventState {
  subscription?: Subscription; baseline?: string;
  deliveries: Delivery[];
  sources?: { id: string; observedAt: number }[];
  usedBindingAttempts?: string[];
}
export interface PrEventStore {
  load(): Promise<{ version: string | null; state: PrEventState }>;
  save(version: string | null, state: PrEventState): Promise<boolean>;
  releaseExpiredBinding(version: string | null, state: PrEventState, owner: EventOwner, currentGeneration: string,
    expectedSubscriptionId: string, now: number, approvalExpiresAt: number): Promise<boolean>;
}
/** One bounded exact-wait record. CAS fences concurrent processes; no process-local subscription fallback. */
export class RedisPrEventStore implements PrEventStore {
  constructor(private readonly redis: Redis, private readonly key: string) {}
  async load() {
    const raw = await this.redis.get<string>(this.key);
    const version = raw === null ? null : typeof raw === 'string' ? raw : JSON.stringify(raw);
    return { version, state: version ? JSON.parse(version) as PrEventState : { deliveries: [] } };
  }

  async releaseExpiredBinding(version: string | null, state: PrEventState, owner: EventOwner, currentGeneration: string,
    expectedSubscriptionId: string, now: number, approvalExpiresAt: number) {
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > 262144 || !grantGenerationSchema.safeParse(currentGeneration).success) return false;
    const script = [
      "local clock = redis.call('TIME')",
      "local serverNow = math.max(tonumber(ARGV[3]), tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000))",
      "local grantRaw = redis.call('GET', KEYS[2]); if not grantRaw then return 0 end",
      "local okGrant, grant = pcall(cjson.decode, grantRaw)",
      "if not okGrant or grant.status ~= 'active' or grant.generation ~= ARGV[4] or type(grant.expiresAt) ~= 'number' or grant.expiresAt <= serverNow then return 0 end",
      "local hasRead = false; local hasWrite = false; if type(grant.scopes) == 'table' then for _, scope in ipairs(grant.scopes) do if scope == 'conductor.read' then hasRead = true elseif scope == 'conductor.write' then hasWrite = true end end end",
      "if not hasRead or not hasWrite then return 0 end",
      "local current = redis.call('GET', KEYS[1]); if (current or '') ~= ARGV[1] or not current then return 0 end",
      "local okState, prior = pcall(cjson.decode, current); if not okState or type(prior.subscription) ~= 'table' then return 0 end",
      "local sub = prior.subscription; if sub.id ~= ARGV[5] or type(sub.expiresAt) ~= 'number' then return 0 end",
      "local phase = sub.binding and sub.binding.phase or ''; if phase ~= 'pending' and phase ~= 'challenging' and phase ~= 'active' then return 0 end",
      "if sub.expiresAt > serverNow and tonumber(ARGV[6]) > serverNow then return 0 end",
      "redis.call('SET', KEYS[1], ARGV[2], 'EX', 172800); return 1"
    ].join('\n');
    return Number(await this.redis.eval(script, [this.key, oauthGrantKey(owner)],
      [version ?? '', serialized, now, currentGeneration, expectedSubscriptionId, approvalExpiresAt])) === 1;
  }
  async save(version: string | null, state: PrEventState) {
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > 262144) throw new Error('Event state capacity reached');
    const sub = state.subscription;
    if (sub && !grantGenerationSchema.safeParse(sub.generation).success) return false;
    if (sub?.binding && (!z.uuid().safeParse(sub.binding.id).success || !z.uuid().safeParse(sub.binding.approvalId).success)) return false;
    return Number(await this.redis.eval(
      `if ARGV[4] ~= '' then
        local clock = redis.call('TIME')
        local now = math.max(tonumber(ARGV[3]), tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000))
        if tonumber(ARGV[5]) <= now then return 0 end
        local raw = redis.call('GET', KEYS[2]); if not raw then return 0 end
        local ok, grant = pcall(cjson.decode, raw)
        if not ok or grant.status ~= 'active' or grant.generation ~= ARGV[4] or type(grant.expiresAt) ~= 'number' or grant.expiresAt <= now then return 0 end
      end
      local current = redis.call('GET', KEYS[1]); if (current or '') ~= ARGV[1] then return 0 end
      if ARGV[6] ~= '' then
        local marker = redis.call('GET', KEYS[3])
        if marker then
          if marker ~= ARGV[6] then return 0 end
        else
          if ARGV[7] ~= 'pending' then return 0 end
          if current then
            local ok, prior = pcall(cjson.decode, current)
            if not ok or prior.subscription then return 0 end
          end
          redis.call('SET', KEYS[3], ARGV[6])
        end
      end
      redis.call('SET', KEYS[1], ARGV[2], 'EX', 172800); return 1`,
      sub ? [this.key, oauthGrantKey(sub.owner), ...(sub.binding ? [`conductor:preview:pr-events:approval:${sub.binding.approvalId}`] : [])] : [this.key], [version ?? '', serialized, Date.now(), sub?.generation ?? '', sub?.expiresAt ?? 0, sub?.binding?.id ?? '', sub?.binding?.phase ?? ''],
    )) === 1;
  }
}
export function eventOwner(auth?: AuthInfo): EventOwner {
  const issuer = auth?.extra?.issuer; const subject = auth?.extra?.subject;
  if (!auth?.scopes.includes('conductor.read') || typeof issuer !== 'string' || !issuer || typeof subject !== 'string' || !subject || !auth.clientId) {
    throw new Error('Verified event principal and issuer are required');
  }
  return { issuer, subject, clientId: auth.clientId };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const eventOwnerEqual = (a: EventOwner, b: EventOwner) => a.issuer === b.issuer && a.subject === b.subject && a.clientId === b.clientId;
/** Owner/tenant remain configured; delegated client identity comes only from verified authentication. */
export function eventOwnerAuthorized(owner: EventOwner, expected: { issuer: string; subject: string; clientId?: string }, fingerprint?: string): boolean {
  return owner.issuer === expected.issuer && owner.subject === expected.subject &&
    (fingerprint !== undefined ? clientFingerprint(owner.clientId) === fingerprint && (expected.clientId === undefined || owner.clientId === expected.clientId)
      : !!expected.clientId && owner.clientId === expected.clientId);
}
export interface PrEventsOptions {
  integrationBranch?: PrEventIntegrationBranch;
  target: PrEventArguments; owner: { issuer: string; subject: string; clientId?: string }; installationId: number;
  callbackHostname?: string;
  delegatedRecipient?: { clientFingerprint: string; approval?: { id: string; expiresAt: number } };
  validateRecipient?: (url: string) => Promise<void>;
  webhookSecret: string; store: PrEventStore;
  grants: OAuthGrantStore;
  source: PrEventSource; vault: VersionedProviderCredentialVault; post: CallbackPost; now?: () => number;
}
export class PrEvents {
  private readonly now: () => number;
  constructor(private readonly options: PrEventsOptions) {
    this.now = options.now ?? Date.now;
    prEventIntegrationBranch.parse(options.integrationBranch ?? 'preview');
    if (!options.delegatedRecipient && !options.owner.clientId) throw new Error('Fixed-host client identity is required');
    if (options.delegatedRecipient && !options.validateRecipient) throw new Error('Delegated recipient preflight is required');
    if (Boolean(options.callbackHostname) === Boolean(options.delegatedRecipient)) throw new Error('Exactly one recipient mode is required');
  }
  private recipientUrl(value: string) {
    return callbackUrl(value, this.options.callbackHostname ?? new URL(value).hostname).toString();
  }
  private bindingMatches(sub: Subscription) {
    const mode = this.options.delegatedRecipient;
    if (!mode) return !sub.binding;
    return !!sub.binding && sub.binding.fingerprint === mode.clientFingerprint &&
      clientFingerprint(sub.owner.clientId) === mode.clientFingerprint && eventOwnerAuthorized(sub.owner, this.options.owner, mode.clientFingerprint) &&
      (sub.binding.integrationBranch ?? 'preview') === (this.options.integrationBranch ?? 'preview') && hash(sub.binding.target) === hash(this.options.target) && sub.id === this.identity(sub.owner, sub.url, sub.eventName ?? PR_EVENT);
  }
  private activationMatches(sub: Subscription) {
    const approval = this.options.delegatedRecipient?.approval;
    return !!approval && approval.id === sub.binding?.approvalId && approval.expiresAt > this.now();
  }
  private async authorize(auth: AuthInfo | undefined, args?: PrEventArguments) {
    const owner = eventOwner(auth);
    if (!eventOwnerAuthorized(owner, this.options.owner, this.options.delegatedRecipient?.clientFingerprint) || (args && hash(args) !== hash(this.options.target))) throw new Error('Event resource is not authorized');
    if (this.options.delegatedRecipient && clientFingerprint(owner.clientId) !== this.options.delegatedRecipient.clientFingerprint) throw new Error('Event client fingerprint is not authorized');
    await this.grant(owner, auth?.extra?.grantGeneration);
    return owner;
  }
  private grant(owner: EventOwner, generation: unknown) {
    return requireOAuthGrant(this.options.grants, owner, generation, ['conductor.read'], this.now);
  }
  private async read(owner: EventOwner, generation: string, target = this.options.target) {
    await this.grant(owner, generation);
    const result = await this.options.source.read(owner, target, generation);
    await this.grant(owner, generation);
    return result;
  }
  private async checkSubscription(sub: Subscription) {
    if (!this.bindingMatches(sub) || (sub.binding && (sub.binding.phase !== 'active' || !this.activationMatches(sub)))) throw new Error('Recipient binding is not active');
    if (sub.expiresAt <= this.now()) throw new Error('Subscription expired');
    await this.grant(sub.owner, sub.generation);
    if (sub.expiresAt <= this.now()) throw new Error('Subscription expired');
  }
  private async stop(sub: Subscription) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const loaded = await this.options.store.load();
      if (loaded.state.subscription?.id !== sub.id || loaded.state.subscription.generation !== sub.generation) return;
      delete loaded.state.subscription;
      if (await this.options.store.save(loaded.version, loaded.state)) return;
    }
    throw new Error('Subscription cancellation pending');
  }
  private async save(version: string | null, state: PrEventState) {
    const saved = await this.options.store.save(version, state);
    if (!saved && state.subscription) {
      try { await this.checkSubscription(state.subscription); }
      catch { await this.stop(state.subscription); }
    }
    return saved;
  }

  /** Read the stable delegated slot without mutating state or revealing recipient/grant secrets. */
  get delegatedBindingStatusEnabled() { return !!this.options.delegatedRecipient; }

  async bindingStatus(auth?: AuthInfo): Promise<PrEventBindingStatus> {
    const caller = eventOwner(auth);
    const mode = this.options.delegatedRecipient;
    if (!mode || !eventOwnerAuthorized(caller, this.options.owner, mode.clientFingerprint) ||
        clientFingerprint(caller.clientId) !== mode.clientFingerprint) {
      throw new Error('Delegated binding status is not authorized');
    }
    const generation = auth?.extra?.grantGeneration;
    let currentGrantValid = false;
    try { await this.grant(caller, generation); currentGrantValid = true; } catch { /* Report validity without disclosing grant details. */ }
    const observedAt = new Date(this.now()).toISOString();
    const baseResult = {
      configuredResource: this.options.target,
      delegationExpiresAt: mode.approval?.expiresAt ?? null,
      bindingGuard: null,
      ownerMatchesConfigured: true,
      clientMatchesConfigured: true,
      currentGrantValid,
      observedAt,
    };
    let loaded: { version: string | null; state: PrEventState };
    try { loaded = await this.options.store.load(); }
    catch {
      const approvalValid = !!mode.approval && mode.approval.expiresAt > this.now() && mode.approval.expiresAt <= this.now() + 3600000;
      return { ...baseResult, status: 'unavailable', eventName: null, phase: null, subscriptionExpiresAt: null,
        resourceMatchesConfigured: false, bindingMatchesConfigured: false, subscriptionGrantMatches: false,
        approvalMatches: false, approvalValid };
    }
    const sub = loaded.state.subscription;
    const approvalValid = !!mode.approval && mode.approval.expiresAt > this.now() && mode.approval.expiresAt <= this.now() + 3600000;
    if (!sub) {
      return { ...baseResult, status: 'empty', eventName: null, phase: null, subscriptionExpiresAt: null,
        resourceMatchesConfigured: true, bindingMatchesConfigured: false, subscriptionGrantMatches: false,
        approvalMatches: false, approvalValid };
    }
    const ownerMatchesConfigured = eventOwnerEqual(sub.owner, caller) &&
      eventOwnerAuthorized(sub.owner, this.options.owner, mode.clientFingerprint);
    const clientMatchesConfigured = !!sub.binding && sub.binding.fingerprint === mode.clientFingerprint &&
      clientFingerprint(sub.owner.clientId) === mode.clientFingerprint;
    const resourceMatchesConfigured = !!sub.binding &&
      hash(sub.binding.target) === hash(this.options.target) &&
      (sub.binding.integrationBranch ?? 'preview') === (this.options.integrationBranch ?? 'preview');
    const bindingMatchesConfigured = ownerMatchesConfigured && clientMatchesConfigured &&
      resourceMatchesConfigured && this.bindingMatches(sub);
    const subscriptionGrantMatches = typeof generation === 'string' && sub.generation === generation && currentGrantValid;
    const approvalMatches = !!mode.approval && sub.binding?.approvalId === mode.approval.id;
    if (!ownerMatchesConfigured || !clientMatchesConfigured || !resourceMatchesConfigured) {
      return { ...baseResult, status: 'invalid_authority', eventName: null, phase: null, subscriptionExpiresAt: null,
        ownerMatchesConfigured, clientMatchesConfigured, resourceMatchesConfigured, bindingMatchesConfigured: false,
        subscriptionGrantMatches: false, approvalMatches: false, approvalValid };
    }
    const storedEventName = sub.eventName ?? PR_EVENT;
    const eventName: typeof PR_EVENT | typeof CHECKPOINT_EVENT | null =
      storedEventName === PR_EVENT ? PR_EVENT : storedEventName === CHECKPOINT_EVENT ? CHECKPOINT_EVENT : null;
    const phase = sub.binding?.phase;
    const safePhase = phase === 'pending' || phase === 'challenging' || phase === 'active' ? phase : null;
    const bindingGuard = hash(sub);
    const shared = { ...baseResult, eventName, phase: safePhase, subscriptionExpiresAt: sub.expiresAt, bindingGuard,
      ownerMatchesConfigured, clientMatchesConfigured, resourceMatchesConfigured, bindingMatchesConfigured,
      subscriptionGrantMatches, approvalMatches, approvalValid };
    if (sub.expiresAt <= this.now()) return { ...shared, status: 'expired' };
    if (!bindingMatchesConfigured || !subscriptionGrantMatches || !approvalMatches || !approvalValid || !safePhase || !eventName) {
      return { ...shared, status: 'invalid_authority' };
    }
    return { ...shared, eventName: eventName!, phase: safePhase!, status: safePhase! };
  }


  async releaseExpiredBinding(auth: AuthInfo | undefined, input: PrEventExpiredBindingReleaseArguments) {
    const args = prEventExpiredBindingReleaseArguments.parse(input);
    const owner = await this.authorize(auth, args.resource);
    const mode = this.options.delegatedRecipient;
    if (!mode || !eventOwnerAuthorized(owner, this.options.owner, mode.clientFingerprint) ||
        clientFingerprint(owner.clientId) !== mode.clientFingerprint) throw new Error('Expired binding release is not authorized');
    const generation = auth?.extra?.grantGeneration;
    if (typeof generation !== 'string') throw new Error('Current authority is required');
    if (!auth?.scopes.includes('conductor.write')) throw new Error('conductor.write scope is required for binding release');
    await requireOAuthGrant(this.options.grants, owner, generation, ['conductor.read', 'conductor.write'], this.now);
    if (!mode.approval || mode.approval.expiresAt !== args.expectedDelegationExpiresAt) throw new Error('Delegation approval changed; reread binding status');
    const loaded = await this.options.store.load();
    const sub = loaded.state.subscription;
    if (!sub || !sub.binding || !this.bindingMatches(sub) || !eventOwnerEqual(sub.owner, owner) ||
        clientFingerprint(sub.owner.clientId) !== mode.clientFingerprint ||
        hash(sub.binding.target) !== hash(args.resource) ||
        (sub.binding.integrationBranch ?? 'preview') !== (this.options.integrationBranch ?? 'preview') ||
        (sub.eventName ?? PR_EVENT) !== args.eventName || sub.binding.phase !== args.expectedPhase ||
        sub.expiresAt !== args.expectedSubscriptionExpiresAt || sub.binding.approvalId !== mode.approval.id ||
        hash(sub) !== args.expectedBindingGuard) {
      throw new Error('Observed binding changed; reread status before release');
    }
    const approvalExpired = mode.approval.expiresAt <= this.now();
    if (!(sub.expiresAt <= this.now() || approvalExpired)) throw new Error('Binding is still valid; release refused');
    const next = structuredClone(loaded.state);
    delete next.subscription;
    delete next.baseline;
    const released = await this.options.store.releaseExpiredBinding(loaded.version, next, owner, generation, sub.id, this.now(), mode.approval.expiresAt);
    if (!released) throw new Error('Binding changed or current authority no longer permits release');
    return { released: true, resource: args.resource, eventName: args.eventName, previousPhase: args.expectedPhase,
      previousSubscriptionExpiresAt: args.expectedSubscriptionExpiresAt, approvalReference: args.approvalReference.trim(), observedAt: new Date(this.now()).toISOString(),
      deliveryHistoryPreserved: true, approvalHistoryPreserved: true };
  }

  async list(auth?: AuthInfo) {
    const owner = await this.authorize(auth);
    await this.read(owner, auth!.extra!.grantGeneration as string);
    return prEventCatalog();
  }

  private identity(owner: EventOwner, url: string, eventName: string = PR_EVENT) { return 'sub_' + hash([owner.issuer, owner.subject, owner.clientId, url, eventName, this.options.target]); }
  private evidence(pull: PrEventSnapshot) {
    const target = this.options.target;
    if (pull.repository !== target.repository || pull.pullRequestNumber !== target.pullRequestNumber || pull.head.sha !== target.headSha || pull.base.sha !== target.baseSha || pull.base.ref !== (this.options.integrationBranch ?? 'preview')) throw new Error('Exact Preview wait no longer matches');
    return { ...target, state: pull.state, merged: pull.merged, draft: pull.draft,
      ...(pull.reviews ? { reviews: prReviewEvidence.parse(pull.reviews) } : {}),
      checks: { total: pull.checks.total, pending: pull.checks.pending, successful: pull.checks.successful, failed: pull.checks.failed, neutral: pull.checks.neutral, skipped: pull.checks.skipped },
      url: `https://github.com/${target.repository}/pull/${target.pullRequestNumber}` };
  }
  async subscribe(auth: AuthInfo | undefined, args: PrEventArguments, delivery: { url: string; secret: string }, ttlMs?: number | null, eventName: string = PR_EVENT) {
    const owner = await this.authorize(auth, args);
    const generation = auth!.extra!.grantGeneration as string;
    const url = this.recipientUrl(delivery.url); signingKey(delivery.secret);
    if (this.options.delegatedRecipient) return this.subscribeDelegated(auth!, args, owner, generation, url, delivery.secret, ttlMs, eventName);
    const id = this.identity(owner, url, eventName);
    const initial = this.evidence(await this.read(owner, generation, args));
    const loaded = await this.options.store.load();
    const old = loaded.state.subscription;
    if (old && old.expiresAt > this.now() && old.id !== id) throw new Error('Exact wait already has an active subscription');
    const same = old?.id === id && old.generation === generation;
    const oldSecret = same ? this.options.vault.open(old.secret).plaintext : undefined;
    if (!same || old.verifiedUntil <= this.now() || oldSecret !== delivery.secret) {
      try { await verifyCallback(async (...params) => { await this.grant(owner, generation); return this.options.post(...params); }, { id, url, secret: delivery.secret }); }
      catch { throw new ProtocolError(-32015, 'Callback verification failed', { reason: 'challenge_failed' }); }
    }
    const grant = await this.grant(owner, generation);
    const expiresAt = Math.min(grant.expiresAt, this.now() + Math.min(ttlMs ?? 3600000, 3600000), auth?.expiresAt === undefined ? Infinity : auth.expiresAt * 1000);
    if (expiresAt <= this.now()) throw new Error('Event authorization expired');
    const subscription: Subscription = { id, owner, generation, url, secret: this.options.vault.seal(delivery.secret), expiresAt, verifiedUntil: this.now() + 300000, eventName };
    if (oldSecret && oldSecret !== delivery.secret) { subscription.previousSecret = old!.secret; subscription.rotationUntil = this.now() + 60000; }
    else if (same && old?.previousSecret && (old.rotationUntil ?? 0) > this.now()) { subscription.previousSecret = old.previousSecret; subscription.rotationUntil = old.rotationUntil; }
    const state: PrEventState = { subscription, baseline: same && old.expiresAt > this.now() ? loaded.state.baseline : hash(initial), deliveries: loaded.state.deliveries.filter(d => d.createdAt > this.now() - 86400000), sources: loaded.state.sources?.filter(s => s.observedAt > this.now() - 86400000) };
    if (!await this.save(loaded.version, state)) throw new Error('Subscription changed; retry request');
    // Second authoritative read closes the baseline-read/store race. No replay cursor is invented.
    await this.reconcile(`baseline_${randomUUID()}`);
    await this.checkSubscription(subscription).catch(async error => { await this.stop(subscription); throw error; });
    return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
  }
  private async subscribeDelegated(auth: AuthInfo, args: PrEventArguments, owner: EventOwner, generation: string, url: string, secret: string, ttlMs?: number | null, eventName: string = PR_EVENT) {
    const mode = this.options.delegatedRecipient!;
    const approval = mode.approval;
    if (!approval || approval.expiresAt <= this.now() || approval.expiresAt > this.now() + 3600000) throw new ProtocolError(-32000, 'Recipient delegation is not approved', { reason: 'delegation_not_approved' });
    let loaded = await this.options.store.load();
    let old = loaded.state.subscription;
    const id = this.identity(owner, url, eventName);
    const grant = await this.grant(owner, generation);
    const expiresAt = Math.min(grant.expiresAt, this.now() + Math.min(ttlMs ?? 3600000, 3600000), auth.expiresAt === undefined ? Infinity : auth.expiresAt * 1000);
    if (expiresAt <= this.now()) throw new Error('Event authorization expired');
    if (old) {
      if (!this.bindingMatches(old) || old.id !== id || old.generation !== generation || old.binding?.approvalId !== approval.id || old.expiresAt <= this.now() || this.options.vault.open(old.secret).plaintext !== secret) throw new Error('Recipient changed; explicit teardown and rebind required');
      if (old.binding!.phase === 'active') {
        await this.checkSubscription(old);
        return { id, refreshBefore: new Date(old.expiresAt).toISOString(), cursor: null, truncated: false };
      }
      if (old.binding!.phase !== 'pending') throw new Error('Incomplete challenge; explicit teardown and rebind required');
    } else {
      if ((loaded.state.usedBindingAttempts ?? []).includes(approval.id) || (loaded.state.usedBindingAttempts?.length ?? 0) >= 16) throw new Error('Delegation approval already consumed or capacity reached');
      // Pending persistence consumes this approval; no provider read or callback yet.
      await this.options.validateRecipient!(url);
      const pending: Subscription = { id, owner, generation, url, secret: this.options.vault.seal(secret), eventName, expiresAt: Math.min(expiresAt, approval.expiresAt), verifiedUntil: 0,
        binding: { id: randomUUID(), approvalId: approval.id, attemptId: randomUUID(), phase: 'pending', fingerprint: mode.clientFingerprint, target: args, integrationBranch: this.options.integrationBranch ?? 'preview' } };
      await this.grant(owner, generation);
      if (!await this.options.store.save(loaded.version, { subscription: pending, deliveries: [], usedBindingAttempts: [...(loaded.state.usedBindingAttempts ?? []), approval.id] })) throw new Error('Pending binding changed');
      loaded = await this.options.store.load();
      old = loaded.state.subscription;
      if (!old || old.binding?.id !== pending.binding!.id || old.binding.phase !== 'pending') throw new Error('Pending binding changed');
    }
    // Persist a single-use challenge claim. Restart/failure never automatically replays it.
    old.expiresAt = Math.min(old.expiresAt, approval.expiresAt);
    old.binding!.phase = 'challenging';
    await this.grant(owner, generation);
    if (!await this.options.store.save(loaded.version, loaded.state)) throw new Error('Challenge claim changed');
    const claim = JSON.stringify(loaded.state);
    const check = async () => {
      await this.grant(owner, generation);
      if (old.expiresAt <= this.now() || approval.expiresAt <= this.now() || (await this.options.store.load()).version !== claim) throw new Error('Challenge authority changed');
    };
    await check();
    const initial = this.evidence(await this.read(owner, generation, args));
    await check();
    try { await verifyCallback(async (...params) => { await check(); return this.options.post(...params); }, { id, url, secret }); }
    catch { throw new ProtocolError(-32015, 'Callback verification failed', { reason: 'challenge_failed' }); }
    await check();
    old.binding!.phase = 'active'; old.verifiedUntil = this.now() + 300000;
    loaded.state.baseline = hash(initial);
    if (!await this.options.store.save(claim, loaded.state)) throw new Error('Recipient activation changed');
    await this.checkSubscription(old);
    await this.reconcile(`baseline_${randomUUID()}`);
    await this.checkSubscription(old).catch(async error => { await this.stop(old); throw error; });
    return { id, refreshBefore: new Date(old.expiresAt).toISOString(), cursor: null, truncated: false };
  }
  async unsubscribe(auth: AuthInfo | undefined, args: PrEventArguments, url: string, eventName: string = PR_EVENT) {
    const owner = await this.authorize(auth, args);
    const id = this.identity(owner, this.recipientUrl(url), eventName);
    for (let attempt = 0; attempt < 3; attempt++) {
      const loaded = await this.options.store.load();
      if (loaded.state.subscription?.id !== id) return {};
      if (this.options.delegatedRecipient) {
        if (!this.bindingMatches(loaded.state.subscription) || (loaded.state.subscription.generation !== auth!.extra!.grantGeneration && loaded.state.subscription.binding?.phase === 'active')) throw new Error('Recipient binding requires owner teardown');
        // A fresh current grant may explicitly cancel the same principal/resource/recipient's
        // obsolete non-delivering binding. It cannot refresh, activate or inherit that binding.
        await this.grant(owner, auth!.extra!.grantGeneration);
      }
      delete loaded.state.subscription;
      if (await this.options.store.save(loaded.version, loaded.state)) return {};
    }
    throw new Error('Subscription changed; retry unsubscribe');
  }

  private async setCheckpointTerminal(eventId: string, expected: Subscription, status: 'uncertain' | 'superseded' | 'blocked' | 'stopped'): Promise<boolean> {
    for (let i=0;i<3;i++) { const l=await this.options.store.load(); const d=l.state.deliveries.find(x=>x.id===eventId);
      if(!d)return false; if(d.status!=='pending'&&d.status!=='failed')return d.status===status;
      const current=l.state.subscription;
      if(!current||current.id!==expected.id||current.generation!==expected.generation||
        current.binding?.id!==expected.binding?.id||current.binding?.approvalId!==expected.binding?.approvalId)return false;
      d.status=status; d.leaseUntil=0;
      // A blocked claimed attempt must remain durable even when its revoked grant
      // forbids saving the old subscription. Never restore delivery authority.
      if(status==='blocked'){delete l.state.subscription;delete l.state.baseline;}
      if(await this.options.store.save(l.version,l.state))return true;
    } return false;
  }
  async publishCheckpoint(auth: AuthInfo | undefined, input: CheckpointPublicationArguments) {
    const v=checkpointPublicationArguments.parse(input), owner=await this.authorize(auth,v.resource), generation=auth!.extra!.grantGeneration as string;
    const loaded=await this.options.store.load(), sub=loaded.state.subscription;
    if(!sub||(sub.eventName??PR_EVENT)!==CHECKPOINT_EVENT||!eventOwnerEqual(sub.owner,owner)||sub.generation!==generation||sub.id!==this.identity(owner,sub.url,CHECKPOINT_EVENT))
      throw new ProtocolError(-32000,'No exact checkpoint subscription is active',{reason:'checkpoint_subscription_missing'});
    await this.checkSubscription(sub);
    const fingerprint=hash(v),source='checkpoint:'+sub.id+':'+v.checkpointId,existing=loaded.state.deliveries.find(d=>d.source===source);
    if(existing){
      if(existing.fingerprint!==fingerprint)throw new ProtocolError(-32000,'Checkpoint identity reused with different content',{reason:'checkpoint_identity_conflict'});
      if(existing.status==='accepted')return {checkpointId:v.checkpointId,status:'duplicate' as const};
      if(['uncertain','superseded','blocked','stopped'].includes(existing.status))return {checkpointId:v.checkpointId,status:existing.status};
      if(existing.attempts>0){if((existing.leaseUntil??0)>this.now())return {checkpointId:v.checkpointId,status:'pending' as const};await this.setCheckpointTerminal(existing.id,sub,'uncertain');return {checkpointId:v.checkpointId,status:'uncertain' as const};}
      return {checkpointId:v.checkpointId,status:await this.deliverCheckpoint(sub,existing.id)};
    }
    const current=this.evidence(await this.read(owner,generation,v.resource));await this.checkSubscription(sub);
    const state=loaded.state;state.deliveries=state.deliveries.filter(d=>d.createdAt>this.now()-86400000);
    if(state.deliveries.length>=128)throw new ProtocolError(-32000,'Checkpoint delivery capacity reached',{reason:'delivery_capacity'});
    const id='evt_'+hash([sub.id,source,fingerprint]),data={origin:'conductor-project-agent',eventClass:'agent.work_result',project:v.resource.repository,resource:v.resource,source:v.source,checkpointId:v.checkpointId,publishedAt:new Date(this.now()).toISOString(),summary:v.summary,evidence:v.evidence,pending:v.pending};
    state.deliveries.push({id,source,fingerprint,resourceFingerprint:hash(current),createdAt:this.now(),attempts:0,status:'pending',body:JSON.stringify({eventId:id,name:CHECKPOINT_EVENT,timestamp:new Date(this.now()).toISOString(),data,cursor:null})});
    if(!await this.save(loaded.version,state))return {checkpointId:v.checkpointId,status:'pending' as const};
    return {checkpointId:v.checkpointId,status:await this.deliverCheckpoint(sub,id)};
  }
  private async deliverCheckpoint(sub: Subscription,eventId: string): Promise<string> {
    const loaded=await this.options.store.load(),active=loaded.state.subscription,record=loaded.state.deliveries.find(d=>d.id===eventId);
    if(!active||active.id!==sub.id||active.generation!==sub.generation||(active.eventName??PR_EVENT)!==CHECKPOINT_EVENT||!record)return 'inactive';
    if(['accepted','stopped','uncertain','superseded','blocked'].includes(record.status)||record.attempts>0)return record.status;
    try{await this.checkSubscription(active);if(hash(this.evidence(await this.read(active.owner,active.generation)))!==record.resourceFingerprint){await this.setCheckpointTerminal(eventId,active,'superseded');return 'superseded';}}
    catch{await this.setCheckpointTerminal(eventId,active,'blocked');return 'blocked';}
    record.attempts=1;record.leaseUntil=this.now()+30000;
    if(!await this.options.store.save(loaded.version,loaded.state))return 'pending';
    const claimed=await this.options.store.load();if(claimed.version!==JSON.stringify(loaded.state))return 'pending';
    const cr=claimed.state.deliveries.find(d=>d.id===eventId),cs=claimed.state.subscription;
    if(!cr||!cs||cs.id!==active.id||cs.generation!==active.generation||cs.expiresAt<=this.now())return 'pending';
    try{await this.checkSubscription(cs);const finalEvidence=this.evidence(await this.read(cs.owner,cs.generation));await this.checkSubscription(cs);if(hash(finalEvidence)!==cr.resourceFingerprint){await this.setCheckpointTerminal(eventId,active,'superseded');return 'superseded';}}
    catch{await this.setCheckpointTerminal(eventId,active,'blocked');return 'blocked';}
    let status:number|undefined;
    try{status=(await signedCallback(this.options.post,{id:cs.id,url:cs.url,secret:this.options.vault.open(cs.secret).plaintext,...(cs.previousSecret&&(cs.rotationUntil??0)>this.now()?{previousSecret:this.options.vault.open(cs.previousSecret).plaintext}:{})},cr.id,cr.body)).status;}
    catch{/* Ambiguous callback outcome is never replayed automatically. */}
    const terminal=status!==undefined&&status>=200&&status<300?'accepted':status===410?'stopped':'uncertain';
    for(let i=0;i<3;i++){const after=await this.options.store.load(),d=after.state.deliveries.find(x=>x.id===eventId);
      if(!d||after.state.subscription?.id!==active.id)return 'uncertain';if(d.status!=='pending')return d.status;
      d.status=terminal;d.leaseUntil=0;if(status===410)delete after.state.subscription;
      if(await this.options.store.save(after.version,after.state))return terminal;
    }return 'uncertain';
  }

  async ingest(body: Buffer, event: string, deliveryId: string, signature: string): Promise<string> {
    return ingestGitHubPrEvent({ ...this.options, reconcile: source => this.reconcile(source) }, body, event, deliveryId, signature);
  }

  async reconcile(source: string): Promise<string> {
    let loaded = await this.options.store.load();
    const sub = loaded.state.subscription;
    if (!sub || (sub.eventName ?? PR_EVENT) !== PR_EVENT || (sub.binding && sub.binding.phase !== 'active')) return 'inactive';
    if (sub.expiresAt <= this.now()) { await this.stop(sub); return 'inactive'; }
    try { await this.checkSubscription(sub); } catch { await this.stop(sub); return 'blocked'; }
    const existing = loaded.state.deliveries.find(d => d.source === source);
    if (!existing && loaded.state.sources?.some(s => s.id === source)) return 'duplicate';
    loaded.state.sources = loaded.state.sources?.filter(s => s.observedAt > this.now() - 86400000) ?? [];
    if (!loaded.state.sources.some(s => s.id === source)) {
      if (loaded.state.sources.length >= 256) return 'capacity';
      loaded.state.sources.push({ id: source, observedAt: this.now() });
    }
    let data;
    try { data = this.evidence(await this.read(sub.owner, sub.generation)); }
    catch { await this.stop(sub); return 'blocked'; }
    const fingerprint = hash(data);
    let record = loaded.state.deliveries.find(d => d.source === source);
    if (record && record.fingerprint !== fingerprint) return 'duplicate';
    if (!record) {
      if (loaded.state.baseline === fingerprint) return await this.save(loaded.version, loaded.state) ? 'unchanged' : 'pending';
      loaded.state.deliveries = loaded.state.deliveries.filter(d => d.createdAt > this.now() - 86400000);
      if (loaded.state.deliveries.length >= 128) return 'capacity';
      const id = `evt_${hash([sub.id, source, fingerprint])}`;
      record = { id, source, fingerprint, createdAt: this.now(), attempts: 0, status: 'pending', body: JSON.stringify({ eventId: id, name: PR_EVENT, timestamp: new Date(this.now()).toISOString(), data, cursor: null }) };
      loaded.state.deliveries.push(record); loaded.state.baseline = fingerprint;
      if (!await this.save(loaded.version, loaded.state)) return 'pending';
    }
    if (record.status === 'accepted' || record.status === 'stopped' || record.attempts >= 3) return record.status;
    const eventId = record.id;
    for (let attempt = 0; attempt < 3; attempt++) {
      loaded = await this.options.store.load();
      const active = loaded.state.subscription;
      record = loaded.state.deliveries.find(d => d.id === eventId)!;
      if (!active || active.id !== sub.id || active.generation !== sub.generation) return 'inactive';
      if (active.expiresAt <= this.now()) { await this.stop(active); return 'inactive'; }
      if (record?.status === 'pending' && (record.leaseUntil ?? 0) > this.now()) return 'pending';
      if (!record || record.status === 'accepted' || record.status === 'stopped' || record.attempts >= 3) return record?.status ?? 'inactive';
      try { await this.checkSubscription(active); } catch { await this.stop(active); return 'blocked'; }
      // Access and exact heads are revalidated before each attempt, including retries.
      try { if (hash(this.evidence(await this.read(active.owner, active.generation))) !== record.fingerprint) return 'superseded'; } catch { await this.stop(sub); return 'blocked'; }
      record.attempts++; record.status = 'pending'; record.leaseUntil = this.now() + 30000;
      if (!await this.save(loaded.version, loaded.state)) return 'pending';
      // Claim is durable before I/O. A crash/uncertain outcome never implies successful host action.
      const claimed = await this.options.store.load();
      if (claimed.version !== JSON.stringify(loaded.state)) return 'pending';
      if (claimed.state.subscription?.id !== active.id || claimed.state.subscription.expiresAt <= this.now()) return 'inactive';
      try { await this.checkSubscription(active); } catch { await this.stop(active); return 'blocked'; }
      let status = 503;
      try {
        status = (await signedCallback(this.options.post, { id: active.id, url: active.url, secret: this.options.vault.open(active.secret).plaintext,
          ...(active.previousSecret && (active.rotationUntil ?? 0) > this.now() ? { previousSecret: this.options.vault.open(active.previousSecret).plaintext } : {}) }, record.id, record.body)).status;
      } catch { /* No callback URL, credential, or response content is logged. */ }
      // An in-flight/check-to-send racing callback cannot be recalled. Its result
      // must not restore revoked/expired authority or schedule another attempt.
      try { await this.checkSubscription(active); } catch { await this.stop(active); return 'blocked'; }
      record.leaseUntil = 0;
      record.status = status >= 200 && status < 300 ? 'accepted' : status === 410 || status === 413 || (status >= 400 && status < 500 && status !== 429) ? 'stopped' : 'failed';
      if (status === 410) delete loaded.state.subscription;
      // Use the version after the durable attempt claim. Never overwrite unsubscribe/refresh/concurrent delivery.
      if (!await this.save(claimed.version, loaded.state)) return 'pending';
      if (record.status !== 'failed' || record.attempts >= 3) return record.status;
      await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
    }
    return 'failed';
  }
}
