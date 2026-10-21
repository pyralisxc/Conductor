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
  repository: z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  pullRequestNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
export type PrEventArguments = z.infer<typeof prEventArguments>;
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
  }] };
}
export type PrEventService = PrEvents | 'discovery-only';
export interface PrEventSource {
  /** Revalidate principal/resource authority and current installation access on every call. */
  read(owner: EventOwner, target: PrEventArguments, generation: string): Promise<PrEventSnapshot>;
}
interface Subscription {
  id: string; owner: EventOwner; generation: string; url: string; secret: string; expiresAt: number;
  previousSecret?: string; rotationUntil?: number; verifiedUntil: number;
  binding?: { id: string; approvalId: string; phase: 'pending' | 'challenging' | 'active'; fingerprint: string; target: PrEventArguments; integrationBranch?: PrEventIntegrationBranch; attemptId?: string };
}
interface Delivery {
  id: string; source: string; fingerprint: string; body: string; createdAt: number;
  attempts: number; leaseUntil?: number; status: 'pending' | 'accepted' | 'failed' | 'stopped';
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
}
/** One bounded exact-wait record. CAS fences concurrent processes; no process-local subscription fallback. */
export class RedisPrEventStore implements PrEventStore {
  constructor(private readonly redis: Redis, private readonly key: string) {}
  async load() {
    const raw = await this.redis.get<string>(this.key);
    const version = raw === null ? null : typeof raw === 'string' ? raw : JSON.stringify(raw);
    return { version, state: version ? JSON.parse(version) as PrEventState : { deliveries: [] } };
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
      (sub.binding.integrationBranch ?? 'preview') === (this.options.integrationBranch ?? 'preview') && hash(sub.binding.target) === hash(this.options.target) && sub.id === this.identity(sub.owner, sub.url);
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
  async list(auth?: AuthInfo) {
    const owner = await this.authorize(auth);
    await this.read(owner, auth!.extra!.grantGeneration as string);
    return prEventCatalog();
  }

  private identity(owner: EventOwner, url: string) { return `sub_${hash([owner.issuer, owner.subject, owner.clientId, url, PR_EVENT, this.options.target])}`; }
  private evidence(pull: PrEventSnapshot) {
    const target = this.options.target;
    if (pull.repository !== target.repository || pull.pullRequestNumber !== target.pullRequestNumber || pull.head.sha !== target.headSha || pull.base.sha !== target.baseSha || pull.base.ref !== (this.options.integrationBranch ?? 'preview')) throw new Error('Exact Preview wait no longer matches');
    return { ...target, state: pull.state, merged: pull.merged, draft: pull.draft,
      ...(pull.reviews ? { reviews: prReviewEvidence.parse(pull.reviews) } : {}),
      checks: { total: pull.checks.total, pending: pull.checks.pending, successful: pull.checks.successful, failed: pull.checks.failed, neutral: pull.checks.neutral, skipped: pull.checks.skipped },
      url: `https://github.com/${target.repository}/pull/${target.pullRequestNumber}` };
  }
  async subscribe(auth: AuthInfo | undefined, args: PrEventArguments, delivery: { url: string; secret: string }, ttlMs?: number | null) {
    const owner = await this.authorize(auth, args);
    const generation = auth!.extra!.grantGeneration as string;
    const url = this.recipientUrl(delivery.url); signingKey(delivery.secret);
    if (this.options.delegatedRecipient) return this.subscribeDelegated(auth!, args, owner, generation, url, delivery.secret, ttlMs);
    const id = this.identity(owner, url);
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
    const subscription: Subscription = { id, owner, generation, url, secret: this.options.vault.seal(delivery.secret), expiresAt, verifiedUntil: this.now() + 300000 };
    if (oldSecret && oldSecret !== delivery.secret) { subscription.previousSecret = old!.secret; subscription.rotationUntil = this.now() + 60000; }
    else if (same && old?.previousSecret && (old.rotationUntil ?? 0) > this.now()) { subscription.previousSecret = old.previousSecret; subscription.rotationUntil = old.rotationUntil; }
    const state: PrEventState = { subscription, baseline: same && old.expiresAt > this.now() ? loaded.state.baseline : hash(initial), deliveries: loaded.state.deliveries.filter(d => d.createdAt > this.now() - 86400000), sources: loaded.state.sources?.filter(s => s.observedAt > this.now() - 86400000) };
    if (!await this.save(loaded.version, state)) throw new Error('Subscription changed; retry request');
    // Second authoritative read closes the baseline-read/store race. No replay cursor is invented.
    await this.reconcile(`baseline_${randomUUID()}`);
    await this.checkSubscription(subscription).catch(async error => { await this.stop(subscription); throw error; });
    return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
  }
  private async subscribeDelegated(auth: AuthInfo, args: PrEventArguments, owner: EventOwner, generation: string, url: string, secret: string, ttlMs?: number | null) {
    const mode = this.options.delegatedRecipient!;
    const approval = mode.approval;
    if (!approval || approval.expiresAt <= this.now() || approval.expiresAt > this.now() + 3600000) throw new ProtocolError(-32000, 'Recipient delegation is not approved', { reason: 'delegation_not_approved' });
    let loaded = await this.options.store.load();
    let old = loaded.state.subscription;
    const id = this.identity(owner, url);
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
      const pending: Subscription = { id, owner, generation, url, secret: this.options.vault.seal(secret), expiresAt: Math.min(expiresAt, approval.expiresAt), verifiedUntil: 0,
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
  async unsubscribe(auth: AuthInfo | undefined, args: PrEventArguments, url: string) {
    const owner = await this.authorize(auth, args);
    const id = this.identity(owner, this.recipientUrl(url));
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
  async ingest(body: Buffer, event: string, deliveryId: string, signature: string): Promise<string> {
    return ingestGitHubPrEvent({ ...this.options, reconcile: source => this.reconcile(source) }, body, event, deliveryId, signature);
  }

  async reconcile(source: string): Promise<string> {
    let loaded = await this.options.store.load();
    const sub = loaded.state.subscription;
    if (!sub || (sub.binding && sub.binding.phase !== 'active')) return 'inactive';
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
