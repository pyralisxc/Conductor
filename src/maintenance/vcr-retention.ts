import { createHash } from 'node:crypto';
import type { ConductorToolRuntime } from '../runtime/runtime.js';
import type { DeploymentRecord, ExecutionReceipt, ProjectReference } from '../runtime/types.js';

const DAY_MS = 86_400_000;
const COMMIT_TAG = /^[0-9a-f]{7,40}$/iu;
type Json = Record<string, unknown>;
type Runtime = Pick<ConductorToolRuntime, 'deploymentStatus' | 'deploymentVcrImagesList' | 'vercelVcrImageDelete'>;

export interface VcrRetentionTarget {
  project: ProjectReference;
  name: string;
  enabled: boolean;
  retainedImageTarget: number;
  nonProductionDays: number;
  productionDays: number;
  rollbackCount: number;
  previewBranches: string[];
  maxPages: number;
}
export interface VcrRetentionDecision {
  id: string | null;
  digest: string | null;
  sizeInBytes: number;
  tags: string[];
  createdAt: number | null;
  action: 'keep' | 'delete' | 'review';
  reason: string;
  protected: boolean;
}

export function parseVcrRetentionTargets(value?: string): VcrRetentionTarget[] {
  if (!value?.trim()) return [];
  const parsed: unknown = JSON.parse(value);
  const entries = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.targets) ? parsed.targets : null;
  if (!entries) throw new Error('CONDUCTOR_VCR_RETENTION_JSON must be an array or { targets: [] }');
  if (entries.length > 25) throw new Error('At most 25 VCR retention targets are allowed');
  return entries.map((entry, index) => {
    const item = record(entry, `target ${index}`);
    const nested = isRecord(item.project) ? item.project : {};
    const id = text(nested.id ?? item.projectId ?? item.id);
    const repositoryValue = text(nested.repository ?? item.gitRepository ?? item.repository);
    const repository = repositoryValue?.includes('/') ? repositoryValue : undefined;
    const name = text(item.name ?? item.vcrRepository ?? item.vcrRepositoryName ?? (!repositoryValue?.includes('/') ? repositoryValue : undefined)) ?? 'dockerfile';
    if (!id) throw new Error(`VCR retention target ${index} requires a project id`);
    if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(name)) throw new Error(`VCR retention target ${index} has an invalid repository name`);
    return {
      project: { id, ...(repository ? { repository } : {}) },
      name,
      enabled: item.enabled !== false,
      retainedImageTarget: integer(item.retainedImageTarget, 10, 1, 100),
      nonProductionDays: number(item.nonProductionDays, 1, 0, 365),
      productionDays: number(item.productionDays, 7, 0, 365),
      rollbackCount: integer(item.rollbackCount, 1, 0, 10),
      previewBranches: strings(item.previewBranches, ['preview']),
      maxPages: integer(item.maxPages, 10, 1, 25),
    };
  });
}

export function vcrRetentionCronAuthorized(authorization: string | undefined, secret: string | undefined): boolean {
  const expected = secret?.trim();
  return Boolean(expected && authorization === `Bearer ${expected}`);
}

export function planVcrRetention(input: {
  images: Json[];
  deployments: DeploymentRecord[];
  now?: number;
  retainedImageTarget?: number;
  nonProductionDays?: number;
  productionDays?: number;
  rollbackCount?: number;
  previewBranches?: string[];
}): { counts: { current: number; keep: number; delete: number; review: number; retained: number; deleteBytes: number }; decisions: VcrRetentionDecision[] } {
  const now = input.now ?? Date.now();
  const target = input.retainedImageTarget ?? 10;
  const nonProdDays = input.nonProductionDays ?? 1;
  const prodDays = input.productionDays ?? 7;
  const rollbackCount = input.rollbackCount ?? 1;
  const previewBranches = input.previewBranches ?? ['preview'];

  const production = input.deployments
    .filter(d => d.target === 'production' && d.state?.toUpperCase() === 'READY' && fullSha(d.sourceRevision))
    .sort((a, b) => time(b.createdAt) - time(a.createdAt));
  const protectedIds = new Set<string>();
  const protectedShas = new Set<string>();
  for (const d of production) {
    const sha = d.sourceRevision!.toLowerCase();
    if (protectedShas.has(sha)) continue;
    protectedShas.add(sha);
    protectedIds.add(d.id);
    if (protectedShas.size >= 1 + rollbackCount) break;
  }
  for (const branch of previewBranches) {
    const latest = input.deployments
      .filter(d => d.target !== 'production' && d.state?.toUpperCase() === 'READY' && d.sourceRef === branch)
      .sort((a, b) => time(b.createdAt) - time(a.createdAt))[0];
    if (latest) protectedIds.add(latest.id);
  }

  const refs = input.deployments
    .filter(d => fullSha(d.sourceRevision))
    .map(d => ({ id: d.id, sha: d.sourceRevision!.toLowerCase(), production: d.target === 'production', ref: d.sourceRef, createdAt: time(d.createdAt) }));

  const decisions: VcrRetentionDecision[] = input.images.map(image => {
    const id = text(image.imageId ?? image.id);
    const digest = text(image.manifestDigest ?? image.digest);
    const tags = Array.isArray(image.tags) ? image.tags.filter((v): v is string => typeof v === 'string' && Boolean(v.trim())).map(v => v.trim()) : [];
    const createdAt = time(image.createdAt ?? image.created);
    const matches = refs.filter(ref => tags.some(tag => COMMIT_TAG.test(tag) && ref.sha.startsWith(tag.toLowerCase())));
    const alias = tags.some(tag => ['latest', 'production', 'prod'].includes(tag.toLowerCase()));
    const protectedMatch = matches.find(ref => protectedIds.has(ref.id));
    const recent = matches.some(ref => now - ref.createdAt <= (ref.production ? prodDays : nonProdDays) * DAY_MS);
    const ageDays = createdAt ? (now - createdAt) / DAY_MS : null;
    let action: VcrRetentionDecision['action'] = 'keep';
    let reason = 'within retention window';
    if (!id || !digest) { action = 'review'; reason = 'missing exact image identity'; }
    else if (alias) reason = 'protected production tag';
    else if (protectedMatch) reason = protectedMatch.ref && previewBranches.includes(protectedMatch.ref) ? `latest READY ${protectedMatch.ref} deployment` : 'active production or distinct rollback deployment';
    else if (recent) reason = 'referenced by retained deployment';
    else if (matches.length) { action = 'delete'; reason = 'only referenced by expired deployments'; }
    else if (!tags.length && ageDays !== null && ageDays > nonProdDays) { action = 'delete'; reason = 'untagged beyond nonproduction retention'; }
    else if (tags.length && tags.every(tag => COMMIT_TAG.test(tag)) && ageDays !== null && ageDays > prodDays) { action = 'delete'; reason = 'orphaned commit tag beyond production retention'; }
    else if (!createdAt) { action = 'review'; reason = 'missing creation time'; }
    else if (ageDays !== null && ageDays > prodDays) { action = 'review'; reason = 'old image has uncorrelated tags'; }
    return { id, digest, sizeInBytes: finite(image.sizeInBytes) ?? 0, tags, createdAt: createdAt || null, action, reason, protected: alias || Boolean(protectedMatch) };
  });

  const retained = () => decisions.filter(d => d.action !== 'delete').length;
  for (const candidate of decisions.filter(d => d.action === 'keep' && !d.protected).sort((a, b) => (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER))) {
    if (retained() <= target) break;
    candidate.action = 'delete';
    candidate.reason = `oldest nonprotected image above retained target of ${target}`;
  }
  const deleted = decisions.filter(d => d.action === 'delete');
  return {
    counts: {
      current: input.images.length,
      keep: decisions.filter(d => d.action === 'keep').length,
      delete: deleted.length,
      review: decisions.filter(d => d.action === 'review').length,
      retained: input.images.length - deleted.length,
      deleteBytes: deleted.reduce((sum, d) => sum + d.sizeInBytes, 0),
    },
    decisions,
  };
}

export async function runConfiguredVcrRetention(runtime: Runtime, value: string | undefined, now = Date.now()): Promise<Record<string, unknown>> {
  const targets = parseVcrRetentionTargets(value).filter(t => t.enabled);
  const results: Record<string, unknown>[] = [];
  for (const target of targets) results.push(await runVcrRetentionTarget(runtime, target, now));
  return { targets: results.length, results, observedAt: new Date(now).toISOString() };
}

export async function runVcrRetentionTarget(runtime: Runtime, target: VcrRetentionTarget, now = Date.now()): Promise<Record<string, unknown>> {
  const status = result(await runtime.deploymentStatus({ project: target.project, limit: 50 }), 'deployment.status');
  const recent = Array.isArray(status.recent) ? status.recent.filter(isRecord) : [];
  const production = isRecord(status.production) ? [status.production] : [];
  const seen = new Set<string>();
  const deployments = [...production, ...recent].filter(d => {
    const id = text(d.id); if (!id || seen.has(id)) return false; seen.add(id); return true;
  }) as unknown as DeploymentRecord[];

  const before = await allImages(runtime, target);
  const plan = planVcrRetention({
    images: before, deployments, now,
    retainedImageTarget: target.retainedImageTarget,
    nonProductionDays: target.nonProductionDays,
    productionDays: target.productionDays,
    rollbackCount: target.rollbackCount,
    previewBranches: target.previewBranches,
  });
  const requested = plan.decisions.filter(d => d.action === 'delete');
  const deleted: VcrRetentionDecision[] = [];
  for (const decision of requested) {
    if (!decision.id || !decision.digest) throw new Error('Delete candidate lacks exact id/digest');
    const suffix = createHash('sha256').update(`${target.project.id}:${target.name}:${decision.id}:${decision.digest}`).digest('hex').slice(0, 24);
    result(await runtime.vercelVcrImageDelete({
      project: target.project, name: target.name, imageId: decision.id,
      expectedManifestDigest: decision.digest, idempotencyKey: `vcr-retention-${suffix}`,
    }), `delete ${decision.id}`);
    deleted.push(decision);
  }

  const after = await allImages(runtime, target);
  const remaining = new Set(after.map(i => text(i.imageId ?? i.id)).filter((v): v is string => Boolean(v)));
  if (deleted.some(d => d.id && remaining.has(d.id))) throw new Error('Provider readback still contains a requested deletion');
  const beforeBytes = before.reduce((sum, i) => sum + (finite(i.sizeInBytes) ?? 0), 0);
  const afterBytes = after.reduce((sum, i) => sum + (finite(i.sizeInBytes) ?? 0), 0);
  return {
    project: target.project.id, repository: target.name,
    beforeImages: before.length, afterImages: after.length,
    plannedDeleteImages: requested.length, deletedImages: deleted.length,
    reviewImages: plan.counts.review,
    beforeKnownBytes: beforeBytes, afterKnownBytes: afterBytes,
    reclaimedKnownBytes: Math.max(0, beforeBytes - afterBytes),
    retainedImageTarget: target.retainedImageTarget,
    retainedTargetReached: after.length <= target.retainedImageTarget || plan.counts.review > 0,
    providerCapacity: 'unsupported',
  };
}

async function allImages(runtime: Runtime, target: VcrRetentionTarget): Promise<Json[]> {
  const images: Json[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < target.maxPages; page++) {
    const payload = result(await runtime.deploymentVcrImagesList({ project: target.project, name: target.name, limit: 100, ...(cursor ? { cursor } : {}) }), 'deployment.vcr.images.list');
    if (Array.isArray(payload.images)) images.push(...payload.images.filter(isRecord));
    const next = text(payload.nextCursor);
    if (!next) return images;
    if (cursors.has(next)) throw new Error('VCR pagination cursor repeated');
    cursors.add(next); cursor = next;
  }
  throw new Error(`VCR inventory exceeded ${target.maxPages} pages`);
}

function result(receipt: ExecutionReceipt<unknown>, operation: string): Json {
  if (receipt.status !== 'succeeded') throw new Error(`${operation} failed: ${receipt.error.message}`);
  return record(receipt.result, operation);
}
function fullSha(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{40}$/iu.test(value); }
function time(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === 'string') { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; }
  return 0;
}
function finite(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function integer(value: unknown, fallback: number, min: number, max: number): number { const n = finite(value); return n === null ? fallback : Math.min(max, Math.max(min, Math.trunc(n))); }
function number(value: unknown, fallback: number, min: number, max: number): number { const n = finite(value); return n === null ? fallback : Math.min(max, Math.max(min, n)); }
function strings(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const found = value.filter((v): v is string => typeof v === 'string' && Boolean(v.trim())).map(v => v.trim());
  return found.length ? [...new Set(found)] : fallback;
}
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function isRecord(value: unknown): value is Json { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function record(value: unknown, name: string): Json { if (!isRecord(value)) throw new Error(`${name} must be an object`); return value; }
