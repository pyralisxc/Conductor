import { normalizeToolError } from '../runtime/errors.js';
import type {
  CapabilityAvailability,
  DeploymentLogEntry,
  DeploymentLogs,
  DeploymentProjectStatus,
  DeploymentRecord,
  GetDeploymentLogsInput,
  GetDeploymentStatusInput,
  OperationPreflightCheck,
  ProjectReference,
  VercelProjectInput, VercelReadProjectInput, VercelReadEvidence, VercelDeploymentInput, VercelGitDeploymentInput, VercelEnvInput, VercelEnvEditInput, VercelEnvRemoveInput, VercelRuntimeLogsInput, VercelVcrRepositoryInput, VercelVcrCreateInput, VercelVcrListInput, VercelVcrImageListInput, VercelVcrImageDeleteInput,
  RuntimeOperationName,
} from '../runtime/types.js';
import type { VercelOperationsProvider, OperationPreflightProvider } from './runtime.js';
import type { ProviderConnectionCredentialResolver } from '../connections/universal/provider-connections.js';
import { ProviderUsageTracker } from './usage.js';

interface VercelProjectBinding {
  id: string;
  project: string;
  repository?: string;
  teamId?: string;
  connectionId?: string;
  runtimeLogsDirect?: boolean;
}

export interface VercelRepositoryAttestation {
  readonly connectionId: string;
  readonly teamId: string | null;
  readonly repository: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly productionBranch: string | null;
  readonly capabilities: readonly string[];
  readonly verifiedAt: string;
}

interface VercelDeploymentProviderOptions {
  token?: string;
  tokenResolver?: (binding: VercelProjectBinding) => Promise<string | undefined>;
  credentialResolver?: ProviderConnectionCredentialResolver;
  runtimeConnectionId?: string;
  bindings: VercelProjectBinding[];
  apiBaseUrl?: string;
  logsBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  runtimeLogTotalMs?: number;
}

type JsonRecord = Record<string, unknown>;

export class VercelDeploymentProvider implements VercelOperationsProvider, OperationPreflightProvider {
  readonly id = 'vercel';
  private readonly token?: string;
  private readonly tokenResolver?: (binding: VercelProjectBinding) => Promise<string | undefined>;
  private readonly credentialResolver?: ProviderConnectionCredentialResolver;
  private readonly runtimeConnectionId?: string;
  private readonly bindings: ReadonlyMap<string, VercelProjectBinding>;
  private readonly apiBaseUrl: string;
  private readonly logsBaseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly usage: ProviderUsageTracker;
  private readonly now: () => Date;
  private readonly runtimeLogTotalMs: number;

  constructor(options: VercelDeploymentProviderOptions) {
    this.token = options.token?.trim() || undefined;
    this.tokenResolver = options.tokenResolver;
    this.credentialResolver = options.credentialResolver;
    this.runtimeConnectionId = options.runtimeConnectionId?.trim() || undefined;
    this.bindings = new Map(options.bindings.map(binding => [binding.id, { ...binding }]));
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.vercel.com').replace(/\/$/u, '');
    this.logsBaseUrl = (options.logsBaseUrl ?? (this.apiBaseUrl === 'https://api.vercel.com' ? 'https://vercel.com' : this.apiBaseUrl)).replace(/\/$/u, '');
    this.usage = new ProviderUsageTracker(this.id);
    this.fetch = this.usage.wrap(options.fetch ?? globalThis.fetch);
    this.now = options.now ?? (() => new Date());
    this.runtimeLogTotalMs = clamp(options.runtimeLogTotalMs ?? 8_000, 1_000, 20_000);
  }

  getUsageSnapshot() {
    return this.usage.snapshot();
  }

  async attestRepositoryProject(
    project: ProjectReference
  ): Promise<VercelRepositoryAttestation> {
    const bound = await this.readProject(project);
    if (!project.repository || !bound.binding.connectionId) {
      throw {
        code: 'NOT_FOUND',
        source: 'vercel',
        message: 'Vercel repository attestation requires an exact connected installation and repository',
      };
    }
    const capabilities = (await this.getCapabilities())
      .filter((item) => item.available)
      .map((item) => item.capability)
      .sort();
    const link = recordField(bound.data, 'link');
    return Object.freeze({
      connectionId: bound.binding.connectionId,
      teamId: bound.binding.teamId ?? null,
      repository: project.repository.toLowerCase(),
      projectId: bound.id,
      projectName:
        stringField(bound.data, 'name') ?? bound.id,
      productionBranch:
        link ? stringField(link, 'productionBranch') : null,
      capabilities: Object.freeze(capabilities),
      verifiedAt: this.now().toISOString(),
    });
  }

  async getCapabilities(): Promise<CapabilityAvailability[]> {
    const configured = this.bindings.size > 0;
    const authenticated = Boolean(this.token) || Boolean((this.credentialResolver || this.tokenResolver) && (await Promise.all(
      [...this.bindings.values()].filter(binding => binding.connectionId).map(binding => this.connectionToken(binding).catch(() => undefined)),
    )).some(Boolean));
    return [
      capability('deployment.read', configured, authenticated),
      capability('deployment.logs.read', configured, authenticated),
      capability('deployment.audit.read', configured, authenticated),
      capability('deployment.env.read', configured, authenticated),
      capability('deployment.write', configured, authenticated),
      capability('deployment.env.write', configured, authenticated),
      capability('deployment.vcr.read', configured, authenticated),
      capability('deployment.vcr.write', configured, authenticated),
    ];
  }

  async preflightOperation(
    project: ProjectReference,
    operation: RuntimeOperationName,
  ): Promise<OperationPreflightCheck[] | undefined> {
    if (!operation.startsWith('deployment.')) return undefined;
    const explicitlyBound = this.bindings.has(project.id);
    try {
      const { binding, data: resolved } = isDeploymentRead(operation)
        ? await this.readProject(project)
        : await this.mutationProject(project);
      const environmentOperation = operation === 'deployment.env.list' || operation.startsWith('deployment.env.');
      const vcrOperation = operation.startsWith('deployment.vcr.');
      if (environmentOperation) {
        // Project read access does not imply access to project environment variables.
        await this.listEnvironment({ project });
      }
      const runtimeRoute = operation === 'deployment.runtime-logs' ? await this.runtimeCredentialRoute(binding) : undefined;
      const vcrCredential = vcrOperation ? await this.vcrCredentialRoute(binding) : undefined;
      return [{
        provider: 'vercel',
        status: operation === 'deployment.runtime-logs'
          ? runtimeRoute === 'none' ? 'unavailable' : 'degraded'
          : operation === 'deployment.status' || operation === 'deployment.logs' || operation === 'deployment.audit' || operation === 'deployment.env.list' ? 'ready' : 'degraded',
        summary: `Vercel project ${resolved.name} (${resolved.id}) is ${explicitlyBound ? 'bound' : 'uniquely linked and verified'} for ${operation}`,
        diagnostics: [{ level: 'info', source: 'vercel', message: operation === 'deployment.runtime-logs'
          ? runtimeRoute === 'shared-connection'
            ? 'Project identity is verified through the bound installation; runtime request-log reads use the shared owner connection, while each exact deployment read remains authoritative for provider health.'
            : runtimeRoute === 'legacy-direct'
              ? 'Project identity remains verified through the bound installation; runtime-log reads use the legacy direct token compatibility path and remain unverified until one exact deployment read succeeds.'
              : runtimeRoute === 'direct-primary'
                ? 'Project read uses a direct Vercel token; each exact runtime request-log read remains authoritative for provider health.'
                : 'Vercel Integration API installation tokens do not authorize the documented runtime-log endpoint. Connect owner runtime-log access once in Conductor; deployment.logs remains available.'
          : environmentOperation
            ? operation === 'deployment.env.list'
              ? 'Environment metadata read verified.'
              : 'Environment metadata read verified; write permission cannot be proven without a mutation.'
            : vcrOperation
              ? vcrCredential === 'runtime'
                ? 'Vercel project identity is verified through the bound installation; VCR API requests use the shared owner credential, while exact provider reads remain authoritative.'
                : 'Vercel project identity is verified through the bound installation; no shared owner credential is available, so VCR requests use the bound installation and provider denial remains explicit.'
            : operation === 'deployment.status' || operation === 'deployment.logs' || operation === 'deployment.audit'
              ? 'Project binding and read credential verified; operation-specific provider access is confirmed only by the read itself.'
              : 'Vercel project binding and read credential verified; write permission cannot be proven without a mutation.' }],
      }];
    } catch (error) {
      const normalized = normalizeToolError(error, 'TOOL_UNAVAILABLE', 'vercel');
      return [{
        provider: 'vercel',
        status: normalized.code === 'TRANSIENT' ? 'degraded' : 'blocked',
        summary: normalized.message,
        error: normalized,
        diagnostics: normalized.diagnostics,
      }];
    }
  }

  async getDeploymentStatus(input: GetDeploymentStatusInput): Promise<DeploymentProjectStatus> {
    const { binding, data: project } = await this.readProject(input.project, input.readEvidence);
    const limit = clamp(input.limit ?? 10, 1, 50);
    const projectId = stringField(project, 'id') ?? binding.project;
    const [deploymentPayload, domainPayload] = await Promise.all([
      this.getJson('/v6/deployments', {
        ...scopeQuery(binding),
        projectId,
        limit: String(limit),
      }, binding),
      this.getJson(`/v9/projects/${encodeURIComponent(projectId)}/domains`, scopeQuery(binding), binding),
    ]);

    const recent = arrayField(deploymentPayload, 'deployments')
      .map(normalizeDeployment)
      .filter((item): item is DeploymentRecord => Boolean(item));

    const targets = recordField(project, 'targets');
    const productionTarget = targets ? recordField(targets, 'production') : null;
    const productionId = productionTarget ? (stringField(productionTarget, 'id') ?? stringField(productionTarget, 'uid')) : null;
    let production = productionId ? recent.find(item => item.id === productionId) ?? null : null;
    if (productionId && !production) {
      const detail = await this.getJson(`/v13/deployments/${encodeURIComponent(productionId)}`, scopeQuery(binding), binding);
      production = normalizeDeployment(detail);
    }
    if (!production) {
      production = recent.find(item => item.target === 'production' && item.state === 'READY') ?? null;
    }
    const latestProductionAttempt = recent.find(item => item.target === 'production') ?? null;

    const link = recordField(project, 'link');
    const domains = arrayField(domainPayload, 'domains')
      .map(item => {
        const value = record(item);
        const name = value ? stringField(value, 'name') : null;
        if (!name) return null;
        const verified = value?.verified;
        return { name, verified: typeof verified === 'boolean' ? verified : null };
      })
      .filter((item): item is { name: string; verified: boolean | null } => Boolean(item));

    return {
      provider: 'vercel',
      project: {
        id: projectId,
        name: stringField(project, 'name') ?? binding.project,
        productionBranch: link ? stringField(link, 'productionBranch') : null,
        teamId: binding.teamId ?? null,
      },
      production,
      latestProductionAttempt,
      recent,
      domains,
      observedAt: this.now().toISOString(),
    };
  }

  async getDeploymentLogs(input: GetDeploymentLogsInput): Promise<DeploymentLogs> {
    const { binding, data: project } = await this.readProject(input.project, input.readEvidence);
    const limit = clamp(input.limit ?? 100, 1, 200);
    const projectId = stringField(project, 'id') ?? binding.project;
    const deployment = await this.getJson(
      `/v13/deployments/${encodeURIComponent(input.deploymentId)}`,
      scopeQuery(binding), binding,
    );
    const deploymentProjectId = stringField(deployment, 'projectId')
      ?? (recordField(deployment, 'project') ? stringField(recordField(deployment, 'project')!, 'id') : null);
    if (deploymentProjectId !== projectId) {
      throw {
        code: 'PERMISSION_DENIED',
        source: 'vercel',
        message: `Deployment ${input.deploymentId} does not belong to configured Vercel project ${projectId}`,
      };
    }

    const response = await this.request(
      `/v3/deployments/${encodeURIComponent(input.deploymentId)}/events`,
      { ...scopeQuery(binding), direction: 'forward', follow: '0' }, binding,
    );
    const body = await response.text();
    const events = parseEventStream(body);
    const entries = events.slice(0, limit).map(normalizeLogEntry).filter((item): item is DeploymentLogEntry => Boolean(item));

    return {
      provider: 'vercel',
      projectId,
      deploymentId: input.deploymentId,
      entries,
      truncated: events.length > limit,
      source: 'deployment-events',
      observedAt: this.now().toISOString(),
      note: 'Vercel deployment-event output is bounded and redacted. Provider event availability varies by deployment lifecycle and must not be treated as a complete runtime log archive.',
    };
  }


  private async boundProject(project: ProjectReference): Promise<{ binding: VercelProjectBinding; id: string; data: JsonRecord }> {
    const binding = this.binding(project);
    if (binding.repository && project.repository && binding.repository.toLowerCase() !== project.repository.toLowerCase()) {
      throw { code: 'CONFLICT', source: 'vercel', message: 'Requested repository does not match the configured Vercel binding' };
    }
    const data = await this.getProject(binding);
    const id = stringField(data, 'id');
    if (!id) throw { code: 'NOT_FOUND', source: 'vercel', message: 'Bound Vercel project has no stable ID' };
    if (binding.repository && !linkedRepository(data, binding.repository)) {
      throw { code: 'PERMISSION_DENIED', source: 'vercel', message: 'Configured repository does not match the Vercel project Git linkage' };
    }
    return { binding, id, data };
  }

  private projectFromReadEvidence(
    project: ProjectReference,
    evidence?: VercelReadEvidence,
  ): { binding: VercelProjectBinding; id: string; data: JsonRecord } | null {
    if (!evidence) return null;
    const binding = this.bindings.get(project.id);
    if (!binding) return null;
    if (binding.project !== evidence.projectId) return null;
    if ((binding.teamId ?? null) !== evidence.teamId) return null;

    const requestedRepository = project.repository?.toLowerCase() ?? null;
    const boundRepository = binding.repository?.toLowerCase() ?? requestedRepository;
    if (!boundRepository || boundRepository !== evidence.repository.toLowerCase()) return null;
    if (requestedRepository && requestedRepository !== evidence.repository.toLowerCase()) return null;

    const [org, repo] = evidence.repository.split('/');
    const data: JsonRecord = {
      id: evidence.projectId,
      name: evidence.projectName,
      link: {
        type: 'github',
        org,
        repo,
        ...(evidence.productionBranch ? { productionBranch: evidence.productionBranch } : {}),
      },
      ...(evidence.productionDeploymentId ? {
        targets: { production: { id: evidence.productionDeploymentId } },
      } : {}),
    };
    return { binding, id: evidence.projectId, data };
  }

  // Discovery is confined to one already configured installation and team. It
  // never creates a write binding and never falls back to a server-wide token.
  private async readProject(project: ProjectReference, readEvidence?: VercelReadEvidence): Promise<{ binding: VercelProjectBinding; id: string; data: JsonRecord }> {
    const reused = this.projectFromReadEvidence(project, readEvidence);
    if (reused) return reused;
    if (this.bindings.has(project.id)) return this.boundProject(project);
    if (!project.repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(project.repository)) {
      throw { code: 'NOT_FOUND', source: 'vercel', message: 'Unbound Vercel reads require an exact Git repository' };
    }
    const connections = new Map<string, VercelProjectBinding>();
    for (const binding of this.bindings.values()) {
      if (binding.connectionId) connections.set(`${binding.connectionId}:${binding.teamId ?? 'personal'}`, binding);
    }
    if (connections.size !== 1) {
      throw { code: 'CONFLICT', source: 'vercel', message: 'Unbound Vercel reads require one unambiguous connected installation and team' };
    }
    const installation = [...connections.values()][0]!;
    await this.tokenValue(installation);
    const matches: string[] = [];
    let until: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const payload = await this.getJson('/v9/projects', { ...scopeQuery(installation), limit: '100', ...(until ? { until } : {}) }, installation);
      for (const value of arrayField(payload, 'projects')) {
        const candidate = record(value);
        const id = candidate && stringField(candidate, 'id');
        if (id && linkedRepository(candidate, project.repository)) matches.push(id);
      }
      const next = recordField(payload, 'pagination')?.next;
      if (next === null || next === undefined) {
        if (matches.length !== 1) break;
        const binding = { ...installation, id: project.id, project: matches[0]! };
        const data = await this.getProject(binding);
        if (stringField(data, 'id') !== binding.project || !linkedRepository(data, project.repository)) break;
        return { binding, id: binding.project, data };
      }
      until = String(next);
      if (!/^\d+$/u.test(until) || seen.has(until)) break;
      seen.add(until);
    }
    throw { code: 'NOT_FOUND', source: 'vercel', message: 'No unique, fully verified Vercel project matches the requested repository in the connected installation' };
  }

  private async mutationProject(project: ProjectReference): Promise<{ binding: VercelProjectBinding; id: string; data: JsonRecord }> {
    return this.bindings.has(project.id)
      ? await this.boundProject(project)
      : await this.readProject(project);
  }

  private async exactDeployment(project: ProjectReference, deploymentId: string, readOnly = false, readEvidence?: VercelReadEvidence) {
    if (!/^dpl_[A-Za-z0-9]+$/u.test(deploymentId)) throw { code: 'CONFLICT', source: 'vercel', message: 'An exact deployment ID is required' };
    const bound = readOnly ? await this.readProject(project, readEvidence) : await this.mutationProject(project);
    const detail = await this.getJson(`/v13/deployments/${encodeURIComponent(deploymentId)}`, scopeQuery(bound.binding), bound.binding);
    if (stringField(detail, 'projectId') !== bound.id) {
      throw { code: 'PERMISSION_DENIED', source: 'vercel', message: 'Deployment is outside the bound project' };
    }
    return { ...bound, detail };
  }

  private requireProductionApproval(reference?: string): void {
    const normalized = reference?.trim() ?? '';
    const approval = normalized.startsWith('owner-approved:') ? normalized.slice('owner-approved:'.length).trim() : '';
    if (!approval || normalized.length > 500) {
      throw { code: 'PERMISSION_DENIED', source: 'vercel', message: 'Exact owner approval reference is required for production changes' };
    }
  }

  async redeploy(input: VercelDeploymentInput): Promise<Record<string, unknown>> {
    const bound = await this.exactDeployment(input.project, input.deploymentId);
    const original = normalizeDeployment(bound.detail);
    if (original?.target === 'production') this.requireProductionApproval(input.approvalReference);
    const response = await this.request('/v13/deployments', scopeQuery(bound.binding), bound.binding, {
      method: 'POST', body: { name: stringField(bound.data, 'name') ?? bound.binding.project, project: bound.id, deploymentId: input.deploymentId },
    });
    const created = await response.json() as JsonRecord;
    const id = stringField(created, 'id') ?? stringField(created, 'uid');
    if (!id) throw { code: 'COMMAND_FAILED', source: 'vercel', message: 'Vercel did not return a redeployment ID; reconcile provider state before retrying' };
    return { provider: 'vercel', projectId: bound.id, deploymentId: id, sourceDeploymentId: input.deploymentId, state: stringField(created, 'readyState') ?? stringField(created, 'state'), observedAt: this.now().toISOString() };
  }

  async createGitDeployment(input: VercelGitDeploymentInput): Promise<Record<string, unknown>> {
    if (!/^[0-9a-f]{40}$/iu.test(input.sha) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository) || !/^[A-Za-z0-9._/-]+$/u.test(input.ref)) {
      throw { code: 'CONFLICT', source: 'vercel', message: 'Exact Git repository, ref, and full SHA are required' };
    }
    if (input.target === 'production') this.requireProductionApproval(input.approvalReference);
    const bound = await this.mutationProject(input.project);
    const link = recordField(bound.data, 'link');
    const [org, repo] = input.repository.split('/');
    const linkedRepo = stringField(link ?? {}, 'repo');
    const linkedOrg = stringField(link ?? {}, 'org');
    if (!link || !linkedRepo || !([repo?.toLowerCase(), input.repository.toLowerCase()].includes(linkedRepo.toLowerCase())) || (linkedOrg && linkedOrg.toLowerCase() !== org?.toLowerCase())) {
      throw { code: 'PERMISSION_DENIED', source: 'vercel', message: 'Git repository does not match the Vercel project Git linkage' };
    }
    const response = await this.request('/v13/deployments', scopeQuery(bound.binding), bound.binding, {
      method: 'POST', body: {
        name: stringField(bound.data, 'name') ?? bound.binding.project, project: bound.id,
        ...(input.target === 'production' ? { target: 'production' } : {}),
        gitSource: { type: 'github', org, repo, ref: input.ref, sha: input.sha },
      },
    });
    const created = await response.json() as JsonRecord;
    const id = stringField(created, 'id') ?? stringField(created, 'uid');
    if (!id) throw { code: 'COMMAND_FAILED', source: 'vercel', message: 'Vercel did not return a deployment ID; reconcile provider state before retrying' };
    return { provider: 'vercel', projectId: bound.id, deploymentId: id, sourceRevision: input.sha, sourceRef: input.ref, target: input.target, state: stringField(created, 'readyState') ?? stringField(created, 'state') };
  }

  private async changeTraffic(input: VercelDeploymentInput, mode: 'promote' | 'rollback'): Promise<Record<string, unknown>> {
    this.requireProductionApproval(input.approvalReference);
    const bound = await this.exactDeployment(input.project, input.deploymentId);
    const deployment = normalizeDeployment(bound.detail);
    if (stringField(bound.detail, 'readyState') !== 'READY') throw { code: 'CONFLICT', source: 'vercel', message: 'Target deployment must be READY' };

    const currentTarget = recordField(recordField(bound.data, 'targets') ?? {}, 'production');
    const currentProductionId = currentTarget ? (stringField(currentTarget, 'id') ?? stringField(currentTarget, 'uid')) : null;
    if (mode === 'promote') {
      if (currentProductionId === input.deploymentId) {
        return {
          provider: 'vercel',
          projectId: bound.id,
          deploymentId: input.deploymentId,
          action: mode,
          productionDeploymentId: currentProductionId,
          verified: true,
          idempotent: true,
          observedAt: this.now().toISOString(),
        };
      }
      if (deployment?.target !== 'production') {
        throw {
          code: 'CONFLICT',
          source: 'vercel',
          message: 'Vercel promotion requires a READY staged Production deployment; deploy an exact Git revision with target=production instead of promoting an ordinary Preview deployment',
        };
      }
    }
    if (mode === 'rollback' && deployment?.target !== 'production') {
      throw { code: 'CONFLICT', source: 'vercel', message: 'Rollback target must be a prior production deployment' };
    }

    const path = mode === 'promote'
      ? `/v10/projects/${encodeURIComponent(bound.id)}/promote/${encodeURIComponent(input.deploymentId)}`
      : `/v1/projects/${encodeURIComponent(bound.id)}/rollback/${encodeURIComponent(input.deploymentId)}`;
    await this.request(path, scopeQuery(bound.binding), bound.binding, { method: 'POST' });
    const project = await this.getProject(bound.binding);
    const target = recordField(recordField(project, 'targets') ?? {}, 'production');
    const observed = target ? (stringField(target, 'id') ?? stringField(target, 'uid')) : null;
    return { provider: 'vercel', projectId: bound.id, deploymentId: input.deploymentId, action: mode, productionDeploymentId: observed, verified: observed === input.deploymentId, observedAt: this.now().toISOString() };
  }
  async promote(input: VercelDeploymentInput) { return this.changeTraffic(input, 'promote'); }
  async rollback(input: VercelDeploymentInput) { return this.changeTraffic(input, 'rollback'); }

  async deleteDeployment(input: VercelDeploymentInput): Promise<Record<string, unknown>> {
    const bound = await this.exactDeployment(input.project, input.deploymentId);
    const deployment = normalizeDeployment(bound.detail);
    if (!deployment) throw { code: 'NOT_FOUND', source: 'vercel', message: 'Exact deployment could not be normalized before deletion' };

    const productionTarget = recordField(recordField(bound.data, 'targets') ?? {}, 'production');
    const currentProductionId = productionTarget
      ? (stringField(productionTarget, 'id') ?? stringField(productionTarget, 'uid'))
      : null;
    if (currentProductionId === input.deploymentId) {
      throw { code: 'CONFLICT', source: 'vercel', message: 'The deployment currently serving production cannot be deleted' };
    }

    const state = deployment.state?.toUpperCase() ?? null;
    if (!state || !['READY', 'ERROR', 'CANCELED'].includes(state)) {
      throw { code: 'CONFLICT', source: 'vercel', message: 'Deployment cleanup only deletes terminal READY, ERROR, or CANCELED deployments; active builds must not be canceled through cleanup' };
    }
    if (deployment.target === 'production') this.requireProductionApproval(input.approvalReference);

    const response = await this.request(
      `/v13/deployments/${encodeURIComponent(input.deploymentId)}`,
      scopeQuery(bound.binding),
      bound.binding,
      { method: 'DELETE' },
    );
    const payload = await response.json().catch(() => null) as JsonRecord | null;
    const removedId = payload ? (stringField(payload, 'uid') ?? stringField(payload, 'id')) : null;
    const removedState = payload ? stringField(payload, 'state') : null;
    if (removedId !== input.deploymentId || removedState !== 'DELETED') {
      throw { code: 'COMMAND_FAILED', source: 'vercel', message: 'Vercel did not confirm exact deployment deletion; reconcile provider state before retrying' };
    }
    return {
      provider: 'vercel',
      projectId: bound.id,
      deploymentId: input.deploymentId,
      priorState: deployment.state,
      priorTarget: deployment.target,
      state: removedState,
      verified: true,
      observedAt: this.now().toISOString(),
    };
  }

  async listEnvironment(input: VercelReadProjectInput): Promise<Record<string, unknown>> {
    const bound = await this.readProject(input.project, input.readEvidence);
    const payload = await this.getJson(`/v10/projects/${encodeURIComponent(bound.id)}/env`, { ...scopeQuery(bound.binding), decrypt: 'false' }, bound.binding);
    const raw = arrayField(payload, 'envs');
    return { provider: 'vercel', projectId: bound.id, variables: raw.slice(0, 200).map(item => envMetadata(record(item) ?? {})), truncated: raw.length > 200, observedAt: this.now().toISOString() };
  }

  async getVcrRepository(input: VercelVcrRepositoryInput): Promise<Record<string, unknown>> {
    assertVcrRepositoryName(input.name);
    const bound = await this.readProject(input.project);
    return await this.readVcrRepository(bound, input.name);
  }

  async listVcrRepositories(input: VercelVcrListInput): Promise<Record<string, unknown>> {
    const bound = await this.readProject(input.project);
    const limit = clamp(input.limit ?? 50, 1, 100);
    const payload = await this.getJson('/v1/vcr/repository', {
      ...scopeQuery(bound.binding),
      projectId: bound.id,
      limit: String(limit),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    }, bound.binding, await this.vcrCredentialRoute(bound.binding));
    const raw = [...arrayField(payload, 'repositories'), ...arrayField(payload, 'data')];
    const repositories = raw.slice(0, limit).flatMap((value) => {
      const item = record(value);
      if (!item) return [];
      const name = stringField(item, 'name');
      const projectId = stringField(item, 'projectId') ?? stringField(recordField(item, 'project') ?? {}, 'id');
      if (!name || (projectId && projectId !== bound.id)) return [];
      return [{
        repositoryId: stringField(item, 'id') ?? stringField(item, 'uid'),
        name,
        createdAt: item.createdAt ?? null,
        updatedAt: item.updatedAt ?? null,
      }];
    });
    return {
      provider: 'vercel',
      projectId: bound.id,
      repositories,
      truncated: raw.length > limit,
      nextCursor: stringField(payload, 'nextCursor') ?? stringField(recordField(payload, 'pagination') ?? {}, 'next'),
      capacity: {
        status: 'unsupported',
        reason: 'Vercel VCR project quota/headroom is not exposed authoritatively by this provider API; Conductor does not estimate it.',
      },
      observedAt: this.now().toISOString(),
    };
  }

  async listVcrImages(input: VercelVcrImageListInput): Promise<Record<string, unknown>> {
    assertVcrRepositoryName(input.name);
    const bound = await this.readProject(input.project);
    await this.readVcrRepository(bound, input.name);
    const limit = clamp(input.limit ?? 50, 1, 100);
    const payload = await this.getJson(
      `/v1/vcr/repository/${encodeURIComponent(input.name)}/images`,
      {
        ...scopeQuery(bound.binding),
        projectId: bound.id,
        limit: String(limit),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(typeof input.untagged === 'boolean' ? { untagged: input.untagged ? 'true' : 'false' } : {}),
      },
      bound.binding,
      await this.vcrCredentialRoute(bound.binding),
    );
    const raw = [...arrayField(payload, 'images'), ...arrayField(payload, 'data')];
    const images = raw.slice(0, limit).flatMap((value) => {
      const item = record(value);
      if (!item) return [];
      const id = stringField(item, 'id') ?? stringField(item, 'uid');
      const repositoryId = stringField(item, 'repositoryId') ?? stringField(recordField(item, 'repository') ?? {}, 'id');
      const manifestDigest = stringField(item, 'manifestDigest') ?? stringField(item, 'digest');
      if (!id || !manifestDigest) return [];
      const tags = arrayField(item, 'tags').slice(0, 50).flatMap(tag => {
        if (typeof tag === 'string') return [tag];
        const value = record(tag);
        return value ? [stringField(value, 'name') ?? stringField(value, 'tag')].filter((entry): entry is string => Boolean(entry)) : [];
      });
      return [{
        imageId: id,
        repositoryId,
        manifestDigest,
        sizeInBytes: typeof item.sizeInBytes === 'number' ? item.sizeInBytes : (typeof item.size === 'number' ? item.size : null),
        status: stringField(item, 'status'),
        kind: stringField(item, 'kind'),
        platform: stringField(item, 'platform'),
        architecture: stringField(item, 'architecture') ?? stringField(item, 'arch'),
        tags,
        createdAt: item.createdAt ?? null,
        updatedAt: item.updatedAt ?? null,
      }];
    });
    const knownBytes = images.reduce((sum, image) => sum + (typeof image.sizeInBytes === 'number' ? image.sizeInBytes : 0), 0);
    return {
      provider: 'vercel',
      projectId: bound.id,
      repository: input.name,
      images,
      truncated: raw.length > limit,
      nextCursor: stringField(payload, 'nextCursor') ?? stringField(recordField(payload, 'pagination') ?? {}, 'next'),
      knownBytes,
      knownBytesScope: 'returned-page-only',
      capacity: {
        status: 'unsupported',
        reason: 'Vercel VCR project quota/headroom is not exposed authoritatively by this provider API; Conductor does not estimate it.',
      },
      observedAt: this.now().toISOString(),
    };
  }

  async createVcrRepository(input: VercelVcrCreateInput): Promise<Record<string, unknown>> {
    assertVcrRepositoryName(input.name);
    const bound = await this.mutationProject(input.project);
    try {
      const existing = await this.readVcrRepository(bound, input.name);
      return { ...existing, created: false, verified: true };
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }

    await this.request('/v1/vcr/repository', scopeQuery(bound.binding), bound.binding, {
      method: 'POST',
      body: { projectId: bound.id, name: input.name },
    }, await this.vcrCredentialRoute(bound.binding));
    const verified = await this.readVcrRepository(bound, input.name);
    return { ...verified, created: true, verified: true };
  }

  async deleteVcrImage(input: VercelVcrImageDeleteInput): Promise<Record<string, unknown>> {
    assertVcrRepositoryName(input.name);
    if (!input.imageId.trim()) throw { code: 'CONFLICT', source: 'vercel', message: 'VCR image ID must not be empty' };
    if (!input.expectedManifestDigest.trim()) throw { code: 'CONFLICT', source: 'vercel', message: 'VCR image deletion requires an exact expected manifest digest' };
    const bound = await this.mutationProject(input.project);
    await this.readVcrRepository(bound, input.name);
    const credential = await this.vcrCredentialRoute(bound.binding);
    const imagePath = `/v1/vcr/repository/${encodeURIComponent(input.name)}/images/${encodeURIComponent(input.imageId)}`;
    const response = await this.request(
      imagePath,
      { ...scopeQuery(bound.binding), projectId: bound.id },
      bound.binding,
      undefined,
      credential,
    );
    const payload = await response.json().catch(() => null);
    const envelope = record(payload);
    const image = envelope ? (recordField(envelope, 'image') ?? envelope) : null;
    const id = image ? (stringField(image, 'id') ?? stringField(image, 'uid')) : null;
    const manifestDigest = image ? (stringField(image, 'manifestDigest') ?? stringField(image, 'digest')) : null;
    const tags = image ? stringArray(image.tags) : [];
    if (id !== input.imageId || manifestDigest !== input.expectedManifestDigest) {
      throw { code: 'CONFLICT', source: 'vercel', message: 'Exact VCR image ID/digest no longer matches provider state' };
    }
    if (tags.some(tag => !/^[0-9a-f]{7,40}$/iu.test(tag))) {
      throw {
        code: 'TOOL_UNAVAILABLE',
        source: 'vercel',
        message: 'VCR image deletion requires either an exact untagged image or only immutable-looking Git SHA tags; mutable/ambiguous tags remain fail-closed.',
      };
    }

    const deploymentStatus = await this.getDeploymentStatus({ project: input.project, limit: 50 });
    const latestPreview = deploymentStatus.recent.find(item =>
      item.state === 'READY'
      && ['preview', 'vercel-preview'].includes(item.sourceRef?.toLowerCase() ?? '')
    ) ?? null;
    const active = deploymentStatus.recent.filter(item => {
      const state = item.state?.toUpperCase() ?? '';
      return state !== '' && !['READY', 'ERROR', 'CANCELED', 'CANCELLED', 'DELETED'].includes(state);
    });
    const protectedById = new Map<string, DeploymentRecord>();
    for (const item of [deploymentStatus.production, latestPreview, ...active]) {
      if (item) protectedById.set(item.id, item);
    }
    const protectedDeployments = [...protectedById.values()];
    for (const deployment of protectedDeployments) {
      if (!deployment.sourceRevision) {
        throw {
          code: 'TOOL_UNAVAILABLE',
          source: 'vercel',
          message: `VCR image deletion cannot prove reachability because protected deployment ${deployment.id} has no source revision.`,
        };
      }
      const revision = deployment.sourceRevision.toLowerCase();
      if (tags.some(tag => revision.startsWith(tag.toLowerCase()))) {
        throw {
          code: 'CONFLICT',
          source: 'vercel',
          message: `VCR image is protected by current/active deployment ${deployment.id} at source revision ${deployment.sourceRevision}.`,
        };
      }
    }

    await this.request(
      imagePath,
      { ...scopeQuery(bound.binding), projectId: bound.id },
      bound.binding,
      { method: 'DELETE' },
      credential,
    );

    let verifiedRemoved = false;
    try {
      await this.request(
        imagePath,
        { ...scopeQuery(bound.binding), projectId: bound.id },
        bound.binding,
        undefined,
        credential,
      );
    } catch (error) {
      if ((error as { status?: number }).status === 404) verifiedRemoved = true;
      else throw error;
    }
    if (!verifiedRemoved) {
      throw { code: 'COMMAND_FAILED', source: 'vercel', message: 'VCR image deletion was not verified by provider readback' };
    }

    return {
      provider: 'vercel',
      projectId: bound.id,
      repository: input.name,
      imageId: input.imageId,
      manifestDigest,
      tags,
      deleted: true,
      verified: true,
      protectedDeployments: protectedDeployments.map(item => ({
        deploymentId: item.id,
        sourceRevision: item.sourceRevision,
        sourceRef: item.sourceRef,
        target: item.target,
        state: item.state,
      })),
      observedAt: this.now().toISOString(),
    };
  }

  private async readVcrRepository(
    bound: { binding: VercelProjectBinding; id: string; data: JsonRecord },
    name: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.request(
      `/v1/vcr/repository/${encodeURIComponent(name)}`,
      { ...scopeQuery(bound.binding), projectId: bound.id },
      bound.binding,
      undefined,
      await this.vcrCredentialRoute(bound.binding),
    );
    const payload = await response.json().catch(() => null);
    const envelope = record(payload);
    const value = envelope ? (recordField(envelope, 'repository') ?? envelope) : null;
    if (!value) throw { code: 'COMMAND_FAILED', source: 'vercel', message: 'Vercel returned an invalid VCR repository response' };
    const repositoryName = stringField(value, 'name');
    const projectId = stringField(value, 'projectId') ?? stringField(recordField(value, 'project') ?? {}, 'id');
    if (repositoryName !== name || (projectId && projectId !== bound.id)) {
      throw { code: 'PERMISSION_DENIED', source: 'vercel', message: 'VCR repository identity does not match the bound project and requested name' };
    }
    return {
      provider: 'vercel',
      projectId: bound.id,
      repositoryId: stringField(value, 'id') ?? stringField(value, 'uid'),
      name: repositoryName,
      createdAt: value.createdAt ?? null,
      updatedAt: value.updatedAt ?? null,
      observedAt: this.now().toISOString(),
    };
  }

  private async exactEnvironment(project: ProjectReference, envId: string, key: string) {
    const bound = await this.mutationProject(project);
    const listed = await this.listEnvironment({ project });
    const variables = listed.variables as Record<string, unknown>[];
    const variable = variables.find(item => item.id === envId && item.key === key);
    if (!variable) throw { code: 'NOT_FOUND', source: 'vercel', message: 'Exact variable ID and key do not match the bound project' };
    return { ...bound, variable };
  }

  async upsertEnvironment(input: VercelEnvInput): Promise<Record<string, unknown>> {
    validateEnvInput(input);
    if (input.target.includes('production')) this.requireProductionApproval(input.approvalReference);
    const bound = await this.mutationProject(input.project);
    const existing = await this.listEnvironment(input);
    const sameKey = (existing.variables as JsonRecord[]).filter(item => item.key === input.key);
    if (sameKey.some(item => JSON.stringify(item.target) !== JSON.stringify(input.target) || item.gitBranch !== (input.gitBranch ?? null) || JSON.stringify(item.customEnvironmentIds) !== JSON.stringify(input.customEnvironmentIds ?? []))) {
      throw { code: 'CONFLICT', source: 'vercel', message: 'Variable key already exists with a different target; use exact ID update' };
    }
    await this.request(`/v10/projects/${encodeURIComponent(bound.id)}/env`, { ...scopeQuery(bound.binding), upsert: 'true' }, bound.binding, {
      method: 'POST', body: { key: input.key, value: input.value, type: input.type, target: input.target, ...(input.gitBranch ? { gitBranch: input.gitBranch } : {}), ...(input.customEnvironmentIds ? { customEnvironmentIds: input.customEnvironmentIds } : {}) },
    });
    const listed = await this.listEnvironment(input);
    return { provider: 'vercel', projectId: bound.id, key: input.key, variables: (listed.variables as Record<string, unknown>[]).filter(item => item.key === input.key), verified: (listed.variables as Record<string, unknown>[]).some(item => item.key === input.key) };
  }

  async updateEnvironment(input: VercelEnvEditInput): Promise<Record<string, unknown>> {
    validateEnvInput(input);
    const bound = await this.exactEnvironment(input.project, input.envId, input.key);
    if (input.target.includes('production') || (bound.variable.target as string[] | undefined)?.includes('production')) this.requireProductionApproval(input.approvalReference);
    await this.request(`/v9/projects/${encodeURIComponent(bound.id)}/env/${encodeURIComponent(input.envId)}`, scopeQuery(bound.binding), bound.binding, {
      method: 'PATCH', body: { key: input.key, value: input.value, type: input.type, target: input.target, ...(input.gitBranch ? { gitBranch: input.gitBranch } : {}), ...(input.customEnvironmentIds ? { customEnvironmentIds: input.customEnvironmentIds } : {}) },
    });
    const listed = await this.listEnvironment(input);
    const variable = (listed.variables as Record<string, unknown>[]).find(item => item.id === input.envId && item.key === input.key);
    return { provider: 'vercel', projectId: bound.id, variable: variable ?? null, verified: Boolean(variable) };
  }

  async removeEnvironment(input: VercelEnvRemoveInput): Promise<Record<string, unknown>> {
    const bound = await this.exactEnvironment(input.project, input.envId, input.key);
    if ((bound.variable.target as string[] | undefined)?.includes('production')) this.requireProductionApproval(input.approvalReference);
    await this.request(`/v9/projects/${encodeURIComponent(bound.id)}/env/${encodeURIComponent(input.envId)}`, scopeQuery(bound.binding), bound.binding, { method: 'DELETE' });
    const listed = await this.listEnvironment(input);
    return { provider: 'vercel', projectId: bound.id, envId: input.envId, key: input.key, verifiedRemoved: !(listed.variables as Record<string, unknown>[]).some(item => item.id === input.envId) };
  }

  async getRuntimeLogs(input: VercelRuntimeLogsInput): Promise<Record<string, unknown>> {
    const bound = await this.exactDeployment(input.project, input.deploymentId, true, input.readEvidence);
    const runtimeRoute = await this.runtimeCredentialRoute(bound.binding);
    if (runtimeRoute === 'none') {
      throw { code: 'TOOL_UNAVAILABLE', source: 'vercel', message: 'Vercel Integration API installation tokens do not authorize runtime request-log reads; deployment.logs remains available. Connect owner runtime-log access once in Conductor to use deployment.runtime-logs.' };
    }

    const limit = clamp(input.limit ?? 50, 1, 100);
    const token = await this.runtimeTokenValue(bound.binding);
    let ownerId = bound.binding.teamId;
    if (!ownerId) {
      const accountResponse = await this.fetch(`${this.apiBaseUrl}/v2/user`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'Conductor-Tool-Runtime' },
      });
      if (!accountResponse.ok) throw { status: accountResponse.status, source: 'vercel', message: 'Vercel owner identity is unavailable for runtime request-log reads' };
      const accountPayload = await accountResponse.json().catch(() => null) as JsonRecord | null;
      const user = accountPayload ? (recordField(accountPayload, 'user') ?? accountPayload) : null;
      ownerId = user ? stringField(user, 'id') ?? undefined : undefined;
      if (!ownerId) throw { code: 'NOT_FOUND', source: 'vercel', message: 'Vercel owner identity is unavailable for runtime request-log reads' };
    }

    const deployment = normalizeDeployment(bound.detail);
    const nowMs = this.now().getTime();
    const defaultStart = nowMs - 24 * 60 * 60 * 1_000;
    const deploymentStart = deployment?.createdAt ? Date.parse(deployment.createdAt) : Number.NaN;
    const primaryStart = Number.isFinite(deploymentStart) ? Math.max(defaultStart, deploymentStart) : defaultStart;
    const environment = deployment?.target ?? null;
    const branch = deployment?.sourceRef ?? null;

    const fetchSnapshot = async (startDate: number): Promise<{ response: Response; startDate: number }> => {
      const url = new URL(`${this.logsBaseUrl}/api/logs/request-logs`);
      url.searchParams.set('projectId', bound.id);
      url.searchParams.set('ownerId', ownerId);
      url.searchParams.set('deploymentId', input.deploymentId);
      url.searchParams.set('page', '0');
      url.searchParams.set('startDate', String(startDate));
      url.searchParams.set('endDate', String(nowMs));
      if (environment) url.searchParams.set('environment', environment);
      if (branch) url.searchParams.set('branch', branch);

      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), this.runtimeLogTotalMs);
      try {
        const response = await this.fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'Conductor-Tool-Runtime' },
          signal: controller.signal,
        });
        return { response, startDate };
      } catch (error) {
        if (controller.signal.aborted) throw { code: 'TRANSIENT', source: 'vercel', message: 'Vercel request-log snapshot did not respond before the bounded deadline' };
        throw error;
      } finally {
        clearTimeout(deadline);
      }
    };

    let snapshot: { response: Response; startDate: number };
    try {
      snapshot = await fetchSnapshot(primaryStart);
    } catch (error) {
      const narrowedStart = Math.max(nowMs - 60 * 60 * 1_000, Number.isFinite(deploymentStart) ? deploymentStart : Number.NEGATIVE_INFINITY);
      if ((error as { code?: string }).code !== 'TRANSIENT' || narrowedStart <= primaryStart) throw error;
      snapshot = await fetchSnapshot(narrowedStart);
    }
    const { response, startDate } = snapshot;

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let message = `Vercel request-log snapshot failed with status ${response.status}`;
      try {
        const parsed = JSON.parse(body) as JsonRecord;
        const error = recordField(parsed, 'error');
        message = (error && stringField(error, 'message')) ?? stringField(parsed, 'message') ?? message;
      } catch {}
      throw { status: response.status, source: 'vercel', message };
    }

    const payload = await response.json().catch(() => null) as JsonRecord | null;
    if (!payload) throw { code: 'COMMAND_FAILED', source: 'vercel', message: 'Vercel returned a non-JSON runtime request-log response' };
    const rows = arrayField(payload, 'rows');
    for (const rowValue of rows) {
      const row = record(rowValue);
      const deploymentId = row ? stringField(row, 'deploymentId') : null;
      if (deploymentId && deploymentId !== input.deploymentId) {
        throw { code: 'PERMISSION_DENIED', source: 'vercel', message: 'Vercel runtime request-log response crossed the exact deployment boundary' };
      }
    }

    const entries = rows.slice(0, limit)
      .map(value => normalizeRuntimeRequestLog(value, input.deploymentId))
      .filter((value): value is Record<string, unknown> => Boolean(value));

    return {
      provider: 'vercel',
      source: 'request-logs',
      projectId: bound.id,
      deploymentId: input.deploymentId,
      environment: deployment?.target ?? null,
      sourceRevision: deployment?.sourceRevision ?? null,
      sourceRef: deployment?.sourceRef ?? null,
      sourceRepository: deployment?.sourceRepository ?? null,
      entries,
      truncated: payload.hasMoreRows === true || rows.length > limit,
      windowStart: new Date(startDate).toISOString(),
      windowEnd: new Date(nowMs).toISOString(),
      observedAt: this.now().toISOString(),
    };
  }

  async getAudit(input: VercelProjectInput): Promise<Record<string, unknown>> {
    const bound = await this.readProject(input.project);
    const requests = [
      this.getJson(`/v9/projects/${encodeURIComponent(bound.id)}/domains`, scopeQuery(bound.binding), bound.binding),
      this.getJson(`/v9/projects/${encodeURIComponent(bound.id)}/custom-environments`, scopeQuery(bound.binding), bound.binding),
      this.getJson('/v4/aliases', { ...scopeQuery(bound.binding), projectId: bound.id, limit: '50' }, bound.binding),
      this.getJson('/v6/deployments', { ...scopeQuery(bound.binding), projectId: bound.id, limit: '20' }, bound.binding),
      this.listEnvironment(input),
      this.getJson('/v10/projects', { ...scopeQuery(bound.binding), limit: '50' }, bound.binding),
      bound.binding.teamId ? this.getJson(`/v2/teams/${encodeURIComponent(bound.binding.teamId)}`, {}, bound.binding) : Promise.reject(new Error('No bound team')),
    ];
    const outcomes = await Promise.allSettled(requests);
    const section = (index: number, field: string) => outcomes[index]?.status === 'fulfilled'
      ? { status: 'available', data: arrayField(outcomes[index].value as JsonRecord, field).slice(0, 50).map(item => field === 'envs' ? envMetadata(record(item) ?? {}) : safeAuditItem(item)) }
      : { status: 'unavailable', reason: 'Vercel API did not provide this read for the bound project' };

    let deployments: Record<string, unknown>;
    if (outcomes[3]?.status === 'fulfilled') {
      const listed = arrayField(outcomes[3].value as JsonRecord, 'deployments')
        .slice(0, 20)
        .map(normalizeDeployment)
        .filter((item): item is DeploymentRecord => Boolean(item));
      const detailRoute = await this.runtimeCredentialRoute(bound.binding);
      const detailCredential: 'binding' | 'runtime' = detailRoute === 'none' ? 'binding' : 'runtime';
      const detailOutcomes = await Promise.allSettled(listed.map(item =>
        this.getJson(
          `/v13/deployments/${encodeURIComponent(item.id)}`,
          scopeQuery(bound.binding),
          bound.binding,
          detailCredential,
        )
      ));
      const data = listed.map((summary, index) => {
        const outcome = detailOutcomes[index];
        if (outcome?.status !== 'fulfilled') return summary;
        const detail = normalizeDeployment(outcome.value);
        return detail ? mergeDeploymentRecord(summary, detail) : summary;
      });
      const detailReadsSucceeded = detailOutcomes.filter(item => item.status === 'fulfilled').length;
      deployments = {
        status: 'available',
        data,
        detailEvidence: {
          status: detailReadsSucceeded === listed.length ? 'available' : detailReadsSucceeded > 0 ? 'partial' : 'unavailable',
          requested: listed.length,
          succeeded: detailReadsSucceeded,
          failed: listed.length - detailReadsSucceeded,
          credentialRoute: detailRoute === 'shared-connection'
            ? 'shared-owner'
            : detailRoute === 'legacy-direct' || detailRoute === 'direct-primary'
              ? 'direct-owner'
              : 'bound-installation',
          note: 'Project/list identity remains installation-backed; exact deployment detail uses the available owner credential route when present so provider-private build usage can be observed without exposing credentials.',
        },
      };
    } else {
      deployments = { status: 'unavailable', reason: 'Vercel API did not provide deployment inventory for the bound project' };
    }

    const vars = outcomes[4]?.status === 'fulfilled' ? { status: 'available', data: (outcomes[4].value as JsonRecord).variables } : { status: 'unavailable' };
    const team = outcomes[6]?.status === 'fulfilled' ? outcomes[6].value as JsonRecord : null;
    const teamPlan = team ? stringField(recordField(team, 'billing') ?? {}, 'plan') : null;
    return {
      provider: 'vercel', projectId: bound.id, observedAt: this.now().toISOString(),
      team: team ? { status: 'available', id: stringField(team, 'id') ?? bound.binding.teamId, name: stringField(team, 'name'), slug: stringField(team, 'slug'), plan: teamPlan } : { status: 'unavailable' },
      projectInventory: section(5, 'projects'),
      project: { id: bound.id, name: stringField(bound.data, 'name'), productionBranch: stringField(recordField(bound.data, 'link') ?? {}, 'productionBranch'), framework: stringField(bound.data, 'framework'), rootDirectory: stringField(bound.data, 'rootDirectory'), deploymentProtection: safeAuditItem(recordField(bound.data, 'ssoProtection') ?? {}) },
      domains: section(0, 'domains'), customEnvironments: section(1, 'environments'), aliases: section(2, 'aliases'), deployments, variables: vars,
      usageAndBilling: { status: teamPlan ? 'partial' : 'unavailable', plan: teamPlan, reason: 'Account-wide spend, limits and budget are separate from deployment-scoped build usage; unsupported values remain unavailable.' },
    };
  }

  private binding(project: ProjectReference): VercelProjectBinding {
    const binding = this.bindings.get(project.id);
    if (!binding) throw { code: 'NOT_FOUND', source: 'vercel', message: `No Vercel deployment binding is configured for ${project.id}` };
    return binding;
  }

  private async connectionToken(binding: VercelProjectBinding): Promise<string | undefined> {
    if (!binding.connectionId) return undefined;
    if (this.credentialResolver) {
      const credential = await this.credentialResolver.resolve({
        provider: 'vercel',
        connectionId: binding.connectionId,
        accountId: binding.teamId,
      });
      return credential?.token;
    }
    return this.tokenResolver ? await this.tokenResolver(binding) : undefined;
  }

  private async tokenValue(binding: VercelProjectBinding): Promise<string> {
    const token = binding.connectionId ? await this.connectionToken(binding) : this.token;
    if (!token) throw { code: 'AUTH_REQUIRED', source: 'vercel', message: 'Vercel deployment access requires an active account connection or CONDUCTOR_VERCEL_TOKEN' };
    return token;
  }

  private async sharedRuntimeToken(): Promise<string | undefined> {
    if (!this.runtimeConnectionId || !this.credentialResolver) return undefined;
    return (await this.credentialResolver.resolve({ provider: 'vercel', connectionId: this.runtimeConnectionId }))?.token;
  }

  private async runtimeCredentialRoute(binding: VercelProjectBinding): Promise<'shared-connection' | 'legacy-direct' | 'direct-primary' | 'none'> {
    if (await this.sharedRuntimeToken()) return 'shared-connection';
    if (binding.runtimeLogsDirect && this.token) return 'legacy-direct';
    if (!binding.connectionId && this.token) return 'direct-primary';
    return 'none';
  }

  private async runtimeTokenValue(binding: VercelProjectBinding): Promise<string> {
    const shared = await this.sharedRuntimeToken();
    if (shared) return shared;
    if ((binding.runtimeLogsDirect || !binding.connectionId) && this.token) return this.token;
    throw { code: 'AUTH_REQUIRED', source: 'vercel', message: 'Direct Vercel runtime-log access requires an active owner runtime connection' };
  }

  private async vcrCredentialRoute(binding: VercelProjectBinding): Promise<'binding' | 'runtime'> {
    return await this.runtimeCredentialRoute(binding) === 'none' ? 'binding' : 'runtime';
  }

  private async getProject(binding: VercelProjectBinding): Promise<JsonRecord> {
    return await this.getJson(
      `/v9/projects/${encodeURIComponent(binding.project)}`,
      scopeQuery(binding), binding,
    );
  }

  private async getJson(path: string, query: Record<string, string>, binding: VercelProjectBinding, credential: 'binding' | 'runtime' = 'binding'): Promise<JsonRecord> {
    const response = await this.request(path, query, binding, undefined, credential);
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      throw { code: 'COMMAND_FAILED', source: 'vercel', message: `Vercel returned a non-JSON response for ${path}` };
    }
    return body as JsonRecord;
  }

  private async request(path: string, query: Record<string, string>, binding: VercelProjectBinding, options?: { method: 'POST' | 'PATCH' | 'DELETE'; body?: object }, credential: 'binding' | 'runtime' = 'binding', signal?: AbortSignal): Promise<Response> {
    const token = credential === 'runtime' ? await this.runtimeTokenValue(binding) : await this.tokenValue(binding);
    const url = new URL(`${this.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) if (value) url.searchParams.set(key, value);
    const response = await this.fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, application/stream+json, text/plain;q=0.8',
        'User-Agent': 'Conductor-Tool-Runtime',
        ...(options ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options ? { method: options.method, ...(options.body ? { body: JSON.stringify(options.body) } : {}) } : {}),
      ...(signal ? { signal } : {}),
    });
    if (response.ok) return response;
    const text = await response.text().catch(() => '');
    let message = `Vercel request failed with status ${response.status}`;
    try {
      const parsed = JSON.parse(text) as JsonRecord;
      const error = recordField(parsed, 'error');
      message = (error && stringField(error, 'message')) ?? stringField(parsed, 'message') ?? message;
    } catch {}
    throw { status: response.status, source: 'vercel', message: options ? `Vercel mutation failed with status ${response.status}` : message };
  }
}

function capability(
  capabilityName: 'deployment.read' | 'deployment.logs.read' | 'deployment.audit.read' | 'deployment.env.read' | 'deployment.write' | 'deployment.env.write' | 'deployment.vcr.read' | 'deployment.vcr.write',
  configured: boolean,
  authenticated: boolean,
): CapabilityAvailability {
  const available = configured && authenticated;
  return {
    capability: capabilityName,
    available,
    provider: 'vercel',
    access: capabilityName.endsWith('.write') ? 'write' : 'read',
    auth: authenticated ? 'ready' : 'required',
    health: available ? 'ready' : 'unavailable',
    diagnostics: available ? [] : [{
      level: 'info',
      source: 'vercel',
      code: authenticated ? 'NOT_FOUND' : 'AUTH_REQUIRED',
      message: authenticated ? 'No Vercel project bindings are configured.' : 'Vercel read credential is not configured.',
    }],
  };
}

function scopeQuery(binding: VercelProjectBinding): Record<string, string> {
  return binding.teamId ? { teamId: binding.teamId } : {};
}

function isDeploymentRead(operation: RuntimeOperationName): boolean {
  return operation === 'deployment.status' || operation === 'deployment.logs' || operation === 'deployment.audit'
    || operation === 'deployment.runtime-logs' || operation === 'deployment.env.list'
    || operation === 'deployment.vcr.get' || operation === 'deployment.vcr.list' || operation === 'deployment.vcr.images.list';
}

function assertVcrRepositoryName(name: string): void {
  if (name.length < 1 || name.length > 128 || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(name)) {
    throw { code: 'CONFLICT', source: 'vercel', message: 'VCR repository name must use lowercase letters, numbers, periods, underscores, or dashes and cannot begin or end with punctuation' };
  }
}

function linkedRepository(project: JsonRecord, repository: string): boolean {
  const link = recordField(project, 'link');
  if (!link || stringField(link, 'type') && stringField(link, 'type') !== 'github') return false;
  const [org, repo] = repository.toLowerCase().split('/');
  const linkedRepo = stringField(link, 'repo')?.toLowerCase();
  const linkedOrg = stringField(link, 'org')?.toLowerCase();
  return Boolean(linkedRepo && ((linkedRepo === `${org}/${repo}` && (!linkedOrg || linkedOrg === org))
    || (linkedRepo === repo && linkedOrg === org)));
}

function mergeDeploymentRecord(summary: DeploymentRecord, detail: DeploymentRecord): DeploymentRecord {
  return {
    ...summary,
    ...detail,
    url: detail.url ?? summary.url,
    state: detail.state ?? summary.state,
    target: detail.target ?? summary.target,
    createdAt: detail.createdAt ?? summary.createdAt,
    readyAt: detail.readyAt ?? summary.readyAt,
    sourceRevision: detail.sourceRevision ?? summary.sourceRevision,
    sourceRef: detail.sourceRef ?? summary.sourceRef,
    sourceRepository: detail.sourceRepository ?? summary.sourceRepository,
    aliases: detail.aliases.length ? detail.aliases : summary.aliases,
    errorCode: detail.errorCode ?? summary.errorCode,
    errorMessage: detail.errorMessage ?? summary.errorMessage,
    buildUsage: detail.buildUsage.status !== 'unavailable' ? detail.buildUsage : summary.buildUsage,
  };
}

function normalizeDeployment(value: unknown): DeploymentRecord | null {
  const item = record(value);
  if (!item) return null;
  const id = stringField(item, 'uid') ?? stringField(item, 'id');
  if (!id) return null;
  const meta = recordField(item, 'meta');
  const gitSource = recordField(item, 'gitSource');
  const aliases = [
    ...stringArray(item.alias),
    ...stringArray(item.aliases),
  ];
  const urlValue = stringField(item, 'url');
  return {
    id,
    url: urlValue ? (/^https?:\/\//u.test(urlValue) ? urlValue : `https://${urlValue}`) : null,
    state: stringField(item, 'readyState') ?? stringField(item, 'state'),
    target: stringField(item, 'target'),
    createdAt: timestamp(item.createdAt ?? item.created),
    readyAt: timestamp(item.readyAt),
    sourceRevision: (meta && (
      stringField(meta, 'githubCommitSha')
      ?? stringField(meta, 'gitlabCommitSha')
      ?? stringField(meta, 'bitbucketCommitSha')
    )) ?? (gitSource ? stringField(gitSource, 'sha') : null),
    sourceRef: (meta && (
      stringField(meta, 'githubCommitRef')
      ?? stringField(meta, 'gitlabCommitRef')
      ?? stringField(meta, 'bitbucketCommitRef')
    )) ?? (gitSource ? stringField(gitSource, 'ref') : null),
    sourceRepository: (meta && (
      stringField(meta, 'githubCommitRepo')
      ?? stringField(meta, 'githubRepo')
      ?? stringField(meta, 'gitlabProjectName')
    )) ?? null,
    aliases: [...new Set(aliases)].sort(),
    errorCode: stringField(item, 'errorCode'),
    errorMessage: stringField(item, 'errorMessage'),
    buildUsage: deploymentBuildUsage(item),
  };
}

function deploymentBuildUsage(item: JsonRecord): DeploymentRecord['buildUsage'] {
  const buildUsage = recordField(item, 'buildUsage');
  const billing = recordField(item, 'billing');
  const usage = recordField(item, 'usage');
  const duration = recordField(item, 'duration');
  const buildMachine = recordField(item, 'buildMachine')
    ?? (recordField(item, 'resourceConfig') ? recordField(recordField(item, 'resourceConfig')!, 'buildMachine') : null);

  const buildDurationMs = firstFiniteNumber(
    item.buildDuration,
    item.buildDurationMs,
    buildUsage?.buildDuration,
    buildUsage?.buildDurationMs,
    billing?.buildDuration,
  );
  const postBuildDurationMs = firstFiniteNumber(
    item.postBuildDuration,
    item.postBuildDurationMs,
    buildUsage?.postBuildDuration,
    buildUsage?.postBuildDurationMs,
    billing?.postBuildDuration,
  );
  const billableDurationMs = firstFiniteNumber(
    item.billableDuration,
    item.billableDurationMs,
    buildUsage?.billableDuration,
    buildUsage?.billableDurationMs,
    billing?.billableDuration,
  );
  const cpuMinutes = firstFiniteNumber(
    item.cpuMinutes,
    item.cpuMinutesUsage,
    item.buildCpuMinutes,
    buildUsage?.cpuMinutes,
    buildUsage?.cpuMinutesUsage,
    billing?.cpuMinutes,
    usage?.cpuMinutes,
  );
  const vcpus = firstFiniteNumber(
    item.vcpus,
    item.vCpuCount,
    buildUsage?.vcpus,
    buildMachine?.vcpus,
    buildMachine?.vcpu,
  );
  const machine = firstNonEmptyString(
    item.buildMachineType,
    buildUsage?.machine,
    buildMachine?.type,
    buildMachine?.name,
  );
  const providerDuration = {
    startTime: firstFiniteNumber(duration?.startTime),
    endTime: firstFiniteNumber(duration?.endTime),
    endTimeCapped: firstFiniteNumber(duration?.endTimeCapped),
    timeForBilling: firstFiniteNumber(duration?.timeForBilling),
    timeToContainerExit: firstFiniteNumber(duration?.timeToContainerExit),
    timeToContainerExitCapped: firstFiniteNumber(duration?.timeToContainerExitCapped),
    timeToReady: firstFiniteNumber(duration?.timeToReady),
  };
  const providerNumericUsageEvidence = numericUsageEvidence(item);

  const values = [buildDurationMs, postBuildDurationMs, billableDurationMs, cpuMinutes, vcpus, machine];
  const observed = values.filter(value => value !== null).length;
  return {
    status: observed === 0 ? 'unavailable' : observed === values.length ? 'available' : 'partial',
    buildDurationMs,
    postBuildDurationMs,
    billableDurationMs,
    cpuMinutes,
    vcpus,
    machine,
    providerDuration,
    providerNumericUsageEvidence,
  };
}

function numericUsageEvidence(item: JsonRecord): Array<{ path: string; value: number }> {
  const matches: Array<{ path: string; value: number }> = [];
  const visit = (value: unknown, path: string, depth: number): void => {
    if (matches.length >= 40 || depth > 4) return;
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (/(?:^|\.)(?:duration|billing|usage|cpu|vcpu|machine|build)/iu.test(path)) {
        matches.push({ path, value });
      }
      return;
    }
    const object = record(value);
    if (!object) return;
    for (const [key, child] of Object.entries(object)) {
      if (matches.length >= 40) break;
      const next = path ? `${path}.${key}` : key;
      if (depth === 0 || /duration|billing|usage|cpu|vcpu|machine|build/iu.test(next)) {
        visit(child, next, depth + 1);
      }
    }
  };
  visit(item, '', 0);
  return matches.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeLogEntry(value: unknown): DeploymentLogEntry | null {
  const item = record(value);
  if (!item) return null;
  const payload = recordField(item, 'payload');
  const text = stringField(item, 'text')
    ?? stringField(item, 'message')
    ?? (payload ? (stringField(payload, 'text') ?? stringField(payload, 'message')) : null);
  if (!text) return null;
  return {
    createdAt: timestamp(item.createdAt ?? item.created ?? item.timestamp),
    type: stringField(item, 'type'),
    level: stringField(item, 'level') ?? (payload ? stringField(payload, 'level') : null),
    text: redact(text).slice(0, 4_000),
  };
}

function normalizeRuntimeRequestLog(value: unknown, expectedDeploymentId: string): Record<string, unknown> | null {
  const row = record(value);
  if (!row) return null;
  const deploymentId = stringField(row, 'deploymentId') ?? expectedDeploymentId;
  if (deploymentId !== expectedDeploymentId) return null;
  const rawLogs = arrayField(row, 'logs');
  const messages = rawLogs.slice(0, 20).flatMap(item => {
    const log = record(item);
    if (!log) return [];
    const message = stringField(log, 'message');
    return [{ level: stringField(log, 'level') ?? 'info', message: message ? boundedRedactedText(message, 4_000) : '', truncated: log.messageTruncated === true }];
  });
  const firstEvent = arrayField(row, 'events').map(record).find(Boolean) ?? null;
  return {
    requestId: stringField(row, 'requestId'),
    createdAt: timestamp(row.timestamp),
    deploymentId,
    requestMethod: stringField(row, 'requestMethod'),
    requestPath: boundedRedactedText(stringField(row, 'requestPath') ?? '', 2_000),
    statusCode: typeof row.statusCode === 'number' ? row.statusCode : null,
    environment: stringField(row, 'environment'),
    branch: stringField(row, 'branch'),
    domain: stringField(row, 'domain'),
    source: firstEvent ? stringField(firstEvent, 'source') : null,
    traceId: stringField(row, 'traceId'),
    logs: messages,
    logsTruncated: rawLogs.length > 20,
  };
}

function boundedRedactedText(value: string, maxChars: number): string {
  const safe = redact(value);
  return safe.length > maxChars ? `${safe.slice(0, maxChars)}…[truncated]` : safe;
}

function parseEventStream(body: string): unknown[] {
  if (!body.trim()) return [];
  try {
    const parsed = JSON.parse(body) as unknown;
    if (Array.isArray(parsed)) return parsed;
    const value = record(parsed);
    if (value) {
      for (const field of ['events', 'logs', 'data'] as const) {
        const entries = value[field];
        if (Array.isArray(entries)) return entries;
      }
      return [parsed];
    }
  } catch {}
  return body.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try { return [JSON.parse(line) as unknown]; }
      catch { return [{ text: line }]; }
    });
}

function redact(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/giu, '$1[redacted]')
    .replace(/((?:token|secret|password|private[_-]?key|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]')
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/gu, '://[redacted]@');
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}
function recordField(value: JsonRecord, key: string): JsonRecord | null {
  return record(value[key]);
}
function stringField(value: JsonRecord, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' && field.trim() ? field.trim() : null;
}
function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}
function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
function arrayField(value: JsonRecord, key: string): unknown[] {
  return Array.isArray(value[key]) ? value[key] as unknown[] : [];
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
}
function timestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value > 10_000_000_000 ? value : value * 1_000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function envMetadata(item: JsonRecord): JsonRecord {
  return { id: stringField(item, 'id'), key: stringField(item, 'key'), type: stringField(item, 'type'),
    target: stringArray(item.target), gitBranch: stringField(item, 'gitBranch'),
    customEnvironmentIds: stringArray(item.customEnvironmentIds), createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt) };
}
function safeAuditItem(value: unknown): JsonRecord {
  const item = record(value) ?? {};
  return Object.fromEntries(['id', 'uid', 'name', 'slug', 'type', 'state', 'verified', 'projectId', 'deploymentId', 'url', 'createdAt', 'updatedAt', 'alias']
    .filter(key => typeof item[key] === 'string' || typeof item[key] === 'number' || typeof item[key] === 'boolean')
    .map(key => [key, item[key]]));
}
function validateEnvInput(input: VercelEnvInput): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(input.key) || !input.target.length || input.target.some(target => !['production','preview','development'].includes(target))) {
    throw { code: 'CONFLICT', source: 'vercel', message: 'Exact variable key and target are required' };
  }
  if (input.gitBranch && (input.target.length !== 1 || input.target[0] !== 'preview')) throw { code: 'CONFLICT', source: 'vercel', message: 'Git branch scope requires preview target' };
}
