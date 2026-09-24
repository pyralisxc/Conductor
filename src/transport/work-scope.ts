import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { Redis } from '@upstash/redis';
import type { ProjectReference } from '../runtime/types.js';
import { derivedSecret } from './owner-auth.js';

export type WorkAction = 'route-work' | 'develop';

export interface WorkScopeGrant {
  primaryRepository: string;
  developRepositories: string[];
  expiresAt: number;
}

export interface WorkScopeStore {
  get(clientFingerprint: string): Promise<WorkScopeGrant | null>;
  set(clientFingerprint: string, grant: WorkScopeGrant): Promise<void>;
  delete(clientFingerprint: string): Promise<void>;
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

function contextRepository(token: string, clientId: string): string {
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
  try { return normalizeRepository(value.repository); }
  catch { throw new Error('Invalid work context'); }
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

  async assertAllowed(auth: AuthInfo | undefined, action: WorkAction, project: ProjectReference, workContext?: string): Promise<void> {
    if (!auth?.clientId) throw new Error('Authenticated client identity is required');
    // The caller supplies a routing referent. Resolve aliases before invoking this guard.
    const repository = normalizeRepository(project.repository ?? project.id);
    // Routing remains subject to the provider's repository access and the
    // session's destination/visibility decision, but needs no code-work grant.
    if (action === 'route-work') return;
    if (!workContext) throw new Error('Begin a work context for the active repository before code work');
    const primary = contextRepository(workContext, auth.clientId);
    const grant = await this.store.get(clientFingerprint(auth.clientId));
    const permitted = repository === primary || repository === grant?.primaryRepository || Boolean(grant?.developRepositories.includes(repository));
    if (!permitted) throw new Error(`${action} is outside this client's owner-approved repository scope`);
  }
}
