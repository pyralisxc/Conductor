import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { Redis } from '@upstash/redis';
import type { ProjectReference, VercelReadEvidence, LifecycleGateSpec, LifecycleGateKind } from '../runtime/types.js';
import { derivedSecret } from './owner-auth.js';

export type WorkAction = 'route-work' | 'develop';

export interface WorkScopeGrant {
  primaryRepository: string;
  developRepositories: string[];
  expiresAt: number;
}

export interface ContextWorkScopeGrant {
  contextId: string;
  clientFingerprint: string;
  primaryRepository: string;
  developRepositories: string[];
  expiresAt: number;
}

export interface WorkScopeStore {
  get(clientFingerprint: string): Promise<WorkScopeGrant | null>;
  set(clientFingerprint: string, grant: WorkScopeGrant): Promise<void>;
  delete(clientFingerprint: string): Promise<void>;
  getContext?(contextId: string): Promise<ContextWorkScopeGrant | null>;
  setContext?(contextId: string, grant: ContextWorkScopeGrant): Promise<void>;
  deleteContext?(contextId: string): Promise<void>;
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const WORK_CONTEXT_TTL_MS = 12 * 60 * 60 * 1000;

interface WorkContext {
  v: 1;
  clientFingerprint: string;
  repository: string;
  expiresAt: number;
  id: string;
}

function contextSignature(payload: string): string {
  return createHmac('sha256', derivedSecret('work-context')).update(payload).digest('base64url');
}

function parseWorkContext(token: string, clientId: string): WorkContext {
  if (token.length > 1024) throw new Error('Invalid work context');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Invalid work context');
  const expected = Buffer.from(contextSignature(parts[0]));
  const received = Buffer.from(parts[1]);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error('Invalid work context');
  let value: WorkContext;
  try { value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as WorkContext; }
  catch { throw new Error('Invalid work context'); }
  if (!value || value.v !== 1 || value.clientFingerprint !== clientFingerprint(clientId)
    || typeof value.id !== 'string' || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + WORK_CONTEXT_TTL_MS) {
    throw new Error('Expired or mismatched work context');
  }
  try { return { ...value, repository: normalizeRepository(value.repository) }; }
  catch { throw new Error('Invalid work context'); }
}

function contextRepository(token: string, clientId: string): string {
  return parseWorkContext(token, clientId).repository;
}



const WORK_SCOPE_APPROVAL_GATE_TTL_MS = 2 * 60 * 60 * 1000;

export interface WorkScopeApprovalGateEvidence {
  v: 1;
  kind: 'additional-development-scope';
  allowedNextOperation: 'work-scope.approve';
  clientFingerprint: string;
  workContextId: string;
  primaryRepository: string;
  developRepositories: string[];
  grantExpiresAt: number;
  reason: string;
  protectedConcern: string;
  authorizes: string[];
  doesNotAuthorize: string[];
  evidence: string[];
  afterApproval: string;
  expiresAt: number;
  id: string;
}

function workScopeApprovalGateSignature(payload: string): string {
  return createHmac('sha256', derivedSecret('work-scope-approval-gate')).update(payload).digest('base64url');
}

export function issueWorkScopeApprovalGate(clientId: string, input: {
  workContext: string;
  developRepositories: string[];
  durationMinutes: number;
}): { handle: string; expiresAt: number; gateId: string; gate: Omit<WorkScopeApprovalGateEvidence, 'v' | 'clientFingerprint' | 'workContextId' | 'expiresAt' | 'id'> } {
  const context = parseWorkContext(input.workContext, clientId);
  const developRepositories = [...new Set(input.developRepositories.map(normalizeRepository))]
    .filter((repository) => repository !== context.repository);
  if (developRepositories.length < 1 || developRepositories.length > 20) throw new Error('Request 1-20 exact additional repositories');
  const durationMinutes = Math.trunc(input.durationMinutes);
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 720) {
    throw new Error('Additional repository scope duration must be 15-720 minutes');
  }
  const grantExpiresAt = Math.min(context.expiresAt, Date.now() + durationMinutes * 60_000);
  if (grantExpiresAt <= Date.now()) throw new Error('Active work context expires before the requested scope can be granted');
  const expiresAt = Math.min(Date.now() + WORK_SCOPE_APPROVAL_GATE_TTL_MS, context.expiresAt);
  const id = randomUUID();
  const gate = {
    kind: 'additional-development-scope' as const,
    allowedNextOperation: 'work-scope.approve' as const,
    primaryRepository: context.repository,
    developRepositories,
    grantExpiresAt,
    reason: 'Source or deployment mutation was requested outside the conversation’s active repository.',
    protectedConcern: 'Provider access alone must not let an agent silently expand code/deployment authority across repositories.',
    authorizes: [`Routine develop-class operations in: ${developRepositories.join(', ')} until ${new Date(grantExpiresAt).toISOString()}.`],
    doesNotAuthorize: ['Changing the active repository/referent.', 'Main/production approval.', 'Destructive provider actions that have their own owner gate.', 'Any repository not listed in this gate.'],
    evidence: [`Active repository: ${context.repository}.`, `Additional repositories requested: ${developRepositories.join(', ')}.`, 'Cross-repository issue routing remains separate and does not require this grant.'],
    afterApproval: 'Conductor stores this exact additional repository set against this signed work context only; normal provider and operation gates still apply.',
  };
  const value: WorkScopeApprovalGateEvidence = {
    ...gate,
    v: 1,
    clientFingerprint: clientFingerprint(clientId),
    workContextId: context.id,
    expiresAt,
    id,
  };
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return {
    handle: `${payload}.${workScopeApprovalGateSignature(payload)}`,
    expiresAt,
    gateId: id,
    gate,
  };
}

export function verifyWorkScopeApprovalGate(handle: string, clientId: string, workContext: string): WorkScopeApprovalGateEvidence {
  if (handle.length > 4096) throw new Error('Invalid work-scope approval gate');
  const parts = handle.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Invalid work-scope approval gate');
  const expectedSignature = Buffer.from(workScopeApprovalGateSignature(parts[0]));
  const received = Buffer.from(parts[1]);
  if (expectedSignature.length !== received.length || !timingSafeEqual(expectedSignature, received)) throw new Error('Invalid work-scope approval gate');
  let value: WorkScopeApprovalGateEvidence;
  try { value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as WorkScopeApprovalGateEvidence; }
  catch { throw new Error('Invalid work-scope approval gate'); }
  const context = parseWorkContext(workContext, clientId);
  if (!value || value.v !== 1
    || value.kind !== 'additional-development-scope'
    || value.allowedNextOperation !== 'work-scope.approve'
    || value.clientFingerprint !== clientFingerprint(clientId)
    || value.workContextId !== context.id
    || value.primaryRepository !== context.repository
    || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= Date.now()
    || value.expiresAt > Date.now() + WORK_SCOPE_APPROVAL_GATE_TTL_MS
    || !Number.isSafeInteger(value.grantExpiresAt)
    || value.grantExpiresAt <= Date.now()
    || value.grantExpiresAt > context.expiresAt
    || typeof value.id !== 'string') {
    throw new Error('Expired or mismatched work-scope approval gate');
  }
  const normalized = [...new Set(value.developRepositories.map(normalizeRepository))];
  if (normalized.length !== value.developRepositories.length || normalized.some((repository, index) => repository !== value.developRepositories[index])) {
    throw new Error('Work-scope approval gate repository set is invalid');
  }
  return value;
}

const LIFECYCLE_GATE_TTL_MS = 2 * 60 * 60 * 1000;
export interface LifecycleGateEvidence extends LifecycleGateSpec {
  v: 1;
  clientFingerprint: string;
  repository: string;
  projectId: string;
  expiresAt: number;
  id: string;
}
function lifecycleGateSignature(payload: string): string {
  return createHmac('sha256', derivedSecret('lifecycle-gate')).update(payload).digest('base64url');
}
export function issueLifecycleGate(clientId: string, input: { repository: string; projectId: string; gate: LifecycleGateSpec }): { handle: string; expiresAt: number; gateId: string } {
  const repository = normalizeRepository(input.repository);
  if (!Number.isSafeInteger(input.gate.issueNumber) || input.gate.issueNumber < 1) throw new Error('Invalid lifecycle gate issue');
  const expiresAt = Date.now() + LIFECYCLE_GATE_TTL_MS;
  const id = randomUUID();
  const value: LifecycleGateEvidence = { ...input.gate, v: 1, clientFingerprint: clientFingerprint(clientId), repository, projectId: input.projectId, expiresAt, id };
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return { handle: `${payload}.${lifecycleGateSignature(payload)}`, expiresAt, gateId: id };
}
export function verifyLifecycleGate(handle: string, clientId: string, expected: { repository: string; projectId: string; issueNumber?: number; kind?: LifecycleGateKind; allowedNextOperation?: 'lifecycle.advance' | 'lifecycle.resume' }): LifecycleGateEvidence {
  if (handle.length > 4096) throw new Error('Invalid lifecycle gate');
  const parts = handle.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Invalid lifecycle gate');
  const expectedSignature = Buffer.from(lifecycleGateSignature(parts[0]));
  const received = Buffer.from(parts[1]);
  if (expectedSignature.length !== received.length || !timingSafeEqual(expectedSignature, received)) throw new Error('Invalid lifecycle gate');
  let value: LifecycleGateEvidence;
  try { value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as LifecycleGateEvidence; } catch { throw new Error('Invalid lifecycle gate'); }
  if (!value || value.v !== 1 || value.clientFingerprint !== clientFingerprint(clientId) || value.repository !== normalizeRepository(expected.repository) || value.projectId !== expected.projectId || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + LIFECYCLE_GATE_TTL_MS || typeof value.id !== 'string') throw new Error('Expired or mismatched lifecycle gate');
  if (expected.issueNumber !== undefined && value.issueNumber !== expected.issueNumber) throw new Error('Lifecycle gate issue mismatch');
  if (expected.kind !== undefined && value.kind !== expected.kind) throw new Error('Lifecycle gate kind mismatch');
  if (expected.allowedNextOperation !== undefined && value.allowedNextOperation !== expected.allowedNextOperation) throw new Error('Lifecycle gate operation mismatch');
  return value;
}

const BOOTSTRAP_EVIDENCE_TTL_MS = 5 * 60 * 1000;

export interface BootstrapEvidence {
  v: 1;
  clientFingerprint: string;
  repository: string;
  projectId: string;
  catalogDigest: string;
  observedAt: string;
  expiresAt: number;
  id: string;
  vercel?: VercelReadEvidence;
}

function bootstrapEvidenceSignature(payload: string): string {
  return createHmac('sha256', derivedSecret('bootstrap-evidence')).update(payload).digest('base64url');
}

export function issueBootstrapEvidence(clientId: string, input: {
  repository: string;
  projectId: string;
  catalogDigest: string;
  observedAt: string;
  vercel?: VercelReadEvidence;
}): { handle: string; expiresAt: number } {
  const repository = normalizeRepository(input.repository);
  if (!/^[0-9a-f]{64}$/u.test(input.catalogDigest)) throw new Error('Invalid catalog digest');
  const expiresAt = Date.now() + BOOTSTRAP_EVIDENCE_TTL_MS;
  const vercel = input.vercel ? {
    ...input.vercel,
    repository: normalizeRepository(input.vercel.repository),
  } : undefined;
  if (vercel) {
    if (vercel.provider !== 'vercel' || !/^prj_[A-Za-z0-9]+$/u.test(vercel.projectId)) throw new Error('Invalid Vercel bootstrap evidence');
    if (vercel.teamId !== null && !/^team_[A-Za-z0-9]+$/u.test(vercel.teamId)) throw new Error('Invalid Vercel bootstrap team identity');
    if (vercel.repository !== repository) throw new Error('Vercel bootstrap repository mismatch');
    if (!vercel.projectName.trim() || Number.isNaN(Date.parse(vercel.observedAt))) throw new Error('Invalid Vercel bootstrap project metadata');
    if (vercel.productionDeploymentId !== null && !/^dpl_[A-Za-z0-9]+$/u.test(vercel.productionDeploymentId)) throw new Error('Invalid Vercel bootstrap production deployment identity');
  }
  const value: BootstrapEvidence = {
    v: 1,
    clientFingerprint: clientFingerprint(clientId),
    repository,
    projectId: input.projectId,
    catalogDigest: input.catalogDigest,
    observedAt: input.observedAt,
    expiresAt,
    id: randomUUID(),
    ...(vercel ? { vercel } : {}),
  };
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return { handle: `${payload}.${bootstrapEvidenceSignature(payload)}`, expiresAt };
}

export function verifyBootstrapEvidence(handle: string, clientId: string, expected?: {
  repository?: string;
  projectId?: string;
  catalogDigest?: string;
}): BootstrapEvidence {
  if (handle.length > 2048) throw new Error('Invalid bootstrap evidence');
  const parts = handle.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Invalid bootstrap evidence');
  const expectedSignature = Buffer.from(bootstrapEvidenceSignature(parts[0]));
  const received = Buffer.from(parts[1]);
  if (expectedSignature.length !== received.length || !timingSafeEqual(expectedSignature, received)) throw new Error('Invalid bootstrap evidence');
  let value: BootstrapEvidence;
  try { value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as BootstrapEvidence; }
  catch { throw new Error('Invalid bootstrap evidence'); }
  if (!value || value.v !== 1 || value.clientFingerprint !== clientFingerprint(clientId)
    || typeof value.id !== 'string' || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + BOOTSTRAP_EVIDENCE_TTL_MS) {
    throw new Error('Expired or mismatched bootstrap evidence');
  }
  if (expected?.repository && value.repository !== normalizeRepository(expected.repository)) throw new Error('Bootstrap evidence repository mismatch');
  if (expected?.projectId && value.projectId !== expected.projectId) throw new Error('Bootstrap evidence project mismatch');
  if (expected?.catalogDigest && value.catalogDigest !== expected.catalogDigest) throw new Error('Bootstrap evidence catalog mismatch');
  return value;
}

export function clientFingerprint(clientId: string): string {
  return createHash('sha256').update(clientId).digest('hex');
}

export function normalizeRepository(value: string): string {
  if (!REPOSITORY.test(value)) throw new Error('Use an exact owner/repository name');
  return value.toLowerCase();
}

export function parseWorkScopeGrant(input: {
  primaryRepository: string;
  developRepositories?: string[];
  expiresAt: number;
}): WorkScopeGrant {
  const primaryRepository = normalizeRepository(input.primaryRepository);
  const developRepositories = [...new Set((input.developRepositories ?? []).map(normalizeRepository))];
  if (developRepositories.length > 20) throw new Error('Too many work-scope destinations');
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 24 * 60 * 60 * 1000) {
    throw new Error('Work scope must expire within 24 hours');
  }
  return { primaryRepository, developRepositories, expiresAt: input.expiresAt };
}

export class RedisWorkScopeStore implements WorkScopeStore {
  private readonly redis: Redis;

  constructor(url: string, token: string) {
    this.redis = new Redis({ url, token, enableTelemetry: false });
  }

  async get(fingerprint: string): Promise<WorkScopeGrant | null> {
    if (!/^[0-9a-f]{64}$/u.test(fingerprint)) return null;
    const grant = await this.redis.get<WorkScopeGrant>(`conductor:work-scope:${fingerprint}`);
    if (!grant || grant.expiresAt <= Date.now()) return null;
    return parseWorkScopeGrant(grant);
  }

  async set(fingerprint: string, grant: WorkScopeGrant): Promise<void> {
    if (!/^[0-9a-f]{64}$/u.test(fingerprint)) throw new Error('Invalid client fingerprint');
    const validated = parseWorkScopeGrant(grant);
    await this.redis.set(`conductor:work-scope:${fingerprint}`, validated, { px: validated.expiresAt - Date.now() });
  }

  async delete(fingerprint: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/u.test(fingerprint)) throw new Error('Invalid client fingerprint');
    await this.redis.del(`conductor:work-scope:${fingerprint}`);
  }

  async getContext(contextId: string): Promise<ContextWorkScopeGrant | null> {
    if (!/^[0-9a-f-]{36}$/iu.test(contextId)) return null;
    const grant = await this.redis.get<ContextWorkScopeGrant>(`conductor:work-context-scope:${contextId}`);
    if (!grant || grant.expiresAt <= Date.now()) return null;
    return grant;
  }

  async setContext(contextId: string, grant: ContextWorkScopeGrant): Promise<void> {
    if (!/^[0-9a-f-]{36}$/iu.test(contextId) || grant.contextId !== contextId) throw new Error('Invalid work context grant');
    if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now()) throw new Error('Work context grant must be active');
    await this.redis.set(`conductor:work-context-scope:${contextId}`, grant, { px: grant.expiresAt - Date.now() });
  }

  async deleteContext(contextId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/iu.test(contextId)) throw new Error('Invalid work context grant');
    await this.redis.del(`conductor:work-context-scope:${contextId}`);
  }
}

export class WorkScopeAuthorizer {
  constructor(private readonly store: WorkScopeStore) {}

  async describe(clientId: string): Promise<{ clientFingerprint: string; ownerPrimaryRepository: string | null; developRepositories: string[]; expiresAt: number | null }> {
    const fingerprint = clientFingerprint(clientId);
    const grant = await this.store.get(fingerprint);
    return {
      clientFingerprint: fingerprint,
      ownerPrimaryRepository: grant?.primaryRepository ?? null,
      developRepositories: grant?.developRepositories ?? [],
      expiresAt: grant?.expiresAt ?? null,
    };
  }

  begin(clientId: string, repository: string): { workContext: string; repository: string; expiresAt: number } {
    const primary = normalizeRepository(repository);
    const expiresAt = Date.now() + WORK_CONTEXT_TTL_MS;
    const payload = Buffer.from(JSON.stringify({ v: 1, clientFingerprint: clientFingerprint(clientId), repository: primary, expiresAt, id: randomUUID() } satisfies WorkContext)).toString('base64url');
    return { workContext: `${payload}.${contextSignature(payload)}`, repository: primary, expiresAt };
  }

  async approveAdditionalScope(clientId: string, workContext: string, gate: WorkScopeApprovalGateEvidence): Promise<{ primaryRepository: string; developRepositories: string[]; expiresAt: number; contextId: string }> {
    if (!this.store.setContext) throw new Error('Chat-native additional repository scope requires context-bound scope storage');
    const context = parseWorkContext(workContext, clientId);
    if (gate.clientFingerprint !== clientFingerprint(clientId)
      || gate.workContextId !== context.id
      || gate.primaryRepository !== context.repository) {
      throw new Error('Work-scope approval gate does not match this active context');
    }
    const grant: ContextWorkScopeGrant = {
      contextId: context.id,
      clientFingerprint: clientFingerprint(clientId),
      primaryRepository: context.repository,
      developRepositories: [...gate.developRepositories],
      expiresAt: gate.grantExpiresAt,
    };
    await this.store.setContext(context.id, grant);
    return { primaryRepository: grant.primaryRepository, developRepositories: grant.developRepositories, expiresAt: grant.expiresAt, contextId: grant.contextId };
  }

  async assertAllowed(auth: AuthInfo | undefined, action: WorkAction, project: ProjectReference, workContext?: string): Promise<void> {
    if (!auth?.clientId) throw new Error('Authenticated client identity is required');
    // The caller supplies a routing referent. Resolve aliases before invoking this guard.
    const repository = normalizeRepository(project.repository ?? project.id);
    // Routing remains subject to the provider's repository access and the
    // session's destination/visibility decision, but needs no code-work grant.
    if (action === 'route-work') return;
    if (!workContext) throw new Error('Begin a work context for the active repository before code work');
    const context = parseWorkContext(workContext, auth.clientId);
    const primary = context.repository;
    const [legacyGrant, contextGrant] = await Promise.all([
      this.store.get(clientFingerprint(auth.clientId)),
      this.store.getContext ? this.store.getContext(context.id) : Promise.resolve(null),
    ]);
    const contextPermitted = Boolean(
      contextGrant
      && contextGrant.clientFingerprint === clientFingerprint(auth.clientId)
      && contextGrant.primaryRepository === primary
      && contextGrant.expiresAt <= context.expiresAt
      && contextGrant.developRepositories.includes(repository)
    );
    const permitted = repository === primary
      || repository === legacyGrant?.primaryRepository
      || Boolean(legacyGrant?.developRepositories.includes(repository))
      || contextPermitted;
    if (!permitted) throw new Error(`${action} is outside this client's owner-approved repository scope`);
  }
}
