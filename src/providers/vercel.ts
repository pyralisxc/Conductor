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
  VercelProjectInput, VercelDeploymentInput, VercelGitDeploymentInput, VercelEnvInput, VercelEnvEditInput, VercelEnvRemoveInput, VercelRuntimeLogsInput, VercelVcrRepositoryInput, VercelVcrCreateInput,
  RuntimeOperationName,
} from '../runtime/types.js';
import type { VercelOperationsProvider, OperationPreflightProvider } from './runtime.js';

interface VercelProjectBinding {
  id: string;
  project: string;
  repository?: string;
  teamId?: string;
  connectionId?: string;
}

interface VercelDeploymentProviderOptions {
  token?: string;
  tokenResolver?: (binding: VercelProjectBinding) => Promise<string | undefined>;
  bindings: VercelProjectBinding[];
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

type JsonRecord = Record<string, unknown>;

export class VercelDeploymentProvider implements VercelOperationsProvider, OperationPreflightProvider {
  readonly id = 'vercel';
  private readonly token?: string;
  private readonly tokenResolver?: (binding: VercelProjectBinding) => Promise<string | undefined>;
  private readonly bindings: ReadonlyMap<string, VercelProjectBinding>;
  private readonly apiBaseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => Date;

  constructor(options: VercelDeploymentProviderOptions) {
    this.token = options.token?.trim() || undefined;
    this.tokenResolver = options.tokenResolver;
    this.bindings = new Map(options.bindings.map(binding => [binding.id, { ...binding }]));
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.vercel.com').replace(/\/$/u, '');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getCapabilities(): Promise<CapabilityAvailability[]> {
    const configured = this.bindings.size > 0;
    const authenticated = Boolean(this.token) || Boolean(this.tokenResolver && (await Promise.all(
      [...this.bindings.values()].filter(binding => binding.connectionId).map(binding => this.tokenResolver!(binding).catch(() => undefined)),
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
    const explicit = this.bindings.get(project.id);
    if (!explicit && !isDeploymentRead(operation)) {
      const error = normalizeToolError({
        code: 'NOT_FOUND',
        source: 'vercel',
        message: `No Vercel deployment binding is configured for ${project.id}`,
      }, 'NOT_FOUND', 'vercel');
      return [{ provider: 'vercel', status: 'blocked', summary: error.message, error, diagnostics: error.diagnostics }];
    }
    try {
      const { binding, data: resolved } = explicit
        ? await this.boundProject(project)
        : await this.readProject(project);
      const environmentOperation = operation === 'deployment.env.list' || operation.startsWith('deployment.env.');
      const vcrOperation = operation === 'deployment.vcr.get' || operation === 'deployment.vcr.create';
      if (environmentOperation) {
        // Project read access does not imply access to project environment variables.
        await this.listEnvironment({ project });
      }
      return [{
        provider: 'vercel',
        status: operation === 'deployment.runtime-logs' && binding.connectionId
          ? 'unavailable'
          : operation === 'deployment.status' || operation === 'deployment.logs' || operation === 'deployment.audit' || operation === 'deployment.env.list' ? 'ready' : 'degraded',
        summary: `Vercel project ${resolved.name} (${resolved.id}) is ${explicit ? 'bound' : 'uniquely linked for read access'} for ${operation}`,
        diagnostics: [{ level: 'info', source: 'vercel', message: operation === 'deployment.runtime-logs'
          ? binding.connectionId
            ? 'Vercel Integration API installation tokens do not authorize the documented runtime-log endpoint through any installable integration scope; deployment.logs remains available. Use an explicitly configured direct Vercel access-token binding for deployment.runtime-logs.'
            : 'Project read verified with a direct Vercel access token; runtime-log endpoint access is unverified until an exact deployment read succeeds.'
          : environmentOperation
            ? operation === 'deployment.env.list'
              ? 'Environment metadata read verified.'
              : 'Environment metadata read verified; write permission cannot be proven without a mutation.'
            : vcrOperation
              ? 'Vercel project binding is verified. VCR repository permission is proven only by the exact repository read or create operation.'
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
    const { binding, data: project } = await this.readProject(input.project);
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
    const { binding, data: project } = await this.readProject(input.project);
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

  // Discovery is confined to one already configured installation and team. It
  // never creates a write binding and never falls back to a server-wide token.
  private async readProject(project: ProjectReference): Promise<{ binding: VercelProjectBinding; id: string; data: JsonRecord }> {
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

  private async exactDeployment(project: ProjectReference, deploymentId: string, readOnly = false) {
    if (!/^dpl_[A-Za-z0-9]+$/u.test(deploymentId)) throw { code: 'CONFLICT', source: 'vercel', message: 'An exact deployment ID is required' };
    const bound = readOnly ? await this.readProject(project) : await this.boundProject(project);
    const detail = await this.getJson(`/v13/deployments/${encodeURIComponent(deploymentId)}`, scopeQuery(bound.binding), bound.binding);
    if (stringField(detail, 'projectId') !== bound.id) {
      throw { code: 'PERMISSION_DENIED', source: 'vercel', message: 'Deployment is outside the bound project' };
    }
    return { ...bound, detail };
  }

  private requireProductionApproval(reference?: string): void {
    if (!reference || !/^owner-approved:[A-Za-z0-9._:/-]{8,180}$/u.test(reference)) {
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
    const bound = await this.boundProject(input.project);
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
    if (stringField(bound.detail, 'readyState') !== 'READY') throw { code: 'CONFLICT', source: 'vercel', message: 'Target deployment must be READY' };
    if (mode === 'rollback' && stringField(bound.detail, 'target') !== 'production') throw { code: 'CONFLICT', source: 'vercel', message: 'Rollback target must be a prior production deployment' };
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

  async listEnvironment(input: VercelProjectInput): Promise<Record<string, unknown>> {
    const bound = await this.readProject(input.project);
    const payload = await this.getJson(`/v10/projects/${encodeURIComponent(bound.id)}/env`, { ...scopeQuery(bound.binding), decrypt: 'false' }, bound.binding);
    const raw = arrayField(payload, 'envs');
    return { provider: 'vercel', projectId: bound.id, variables: raw.slice(0, 200).map(item => envMetadata(record(item) ?? {})), truncated: raw.length > 200, observedAt: this.now().toISOString() };
  }

  async getVcrRepository(input: VercelVcrRepositoryInput): Promise<Record<string, unknown>> {
    assertVcrRepositoryName(input.name);
    const bound = await this.readProject(input.project);
    return await this.readVcrRepository(bound, input.name);
  }

  async createVcrRepository(input: VercelVcrCreateInput): Promise<Record<string, unknown>> {
    assertVcrRepositoryName(input.name);
    const bound = await this.boundProject(input.project);
    try {
      const existing = await this.readVcrRepository(bound, input.name);
      return { ...existing, created: false, verified: true };
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }

    await this.request('/v1/vcr/repository', scopeQuery(bound.binding), bound.binding, {
      method: 'POST',
      body: { projectId: bound.id, name: input.name },
    });
    const verified = await this.readVcrRepository(bound, input.name);
    return { ...verified, created: true, verified: true };
  }

  private async readVcrRepository(
    bound: { binding: VercelProjectBinding; id: string; data: JsonRecord },
    name: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.request(
      `/v1/vcr/repository/${encodeURIComponent(name)}`,
      { ...scopeQuery(bound.binding), projectId: bound.id },
      bound.binding,
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
    const bound = await this.boundProject(project);
    const listed = await this.listEnvironment({ project });
    const variables = listed.variables as Record<string, unknown>[];
    const variable = variables.find(item => item.id === envId && item.key === key);
    if (!variable) throw { code: 'NOT_FOUND', source: 'vercel', message: 'Exact variable ID and key do not match the bound project' };
    return { ...bound, variable };
  }

  async upsertEnvironment(input: VercelEnvInput): Promise<Record<string, unknown>> {
    validateEnvInput(input);
    if (input.target.includes('production')) this.requireProductionApproval(input.approvalReference);
    const bound = await this.boundProject(input.project);
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
    const bound = await this.exactDeployment(input.project, input.deploymentId, true);
    if (bound.binding.connectionId) {
      throw {
        code: 'TOOL_UNAVAILABLE',
        source: 'vercel',
        message: 'Vercel Integration API installation tokens do not authorize the runtime-log endpoint; deployment.logs remains available. Configure an explicit direct Vercel access-token binding to use deployment.runtime-logs.',
      };
    }
    const limit = clamp(input.limit ?? 50, 1, 100);
    const response = await this.request(
      `/v1/projects/${encodeURIComponent(bound.id)}/deployments/${encodeURIComponent(input.deploymentId)}/runtime-logs`,
      { ...scopeQuery(bound.binding), limit: String(limit) },
      bound.binding,
    );
    const entries = parseEventStream(await response.text());
    return { provider: 'vercel', projectId: bound.id, deploymentId: input.deploymentId, entries: entries.slice(0, limit).map(normalizeLogEntry).filter(Boolean), truncated: entries.length > limit, observedAt: this.now().toISOString() };
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
      ? { status: 'available', data: arrayField(outcomes[index].value as JsonRecord, field).slice(0, 50).map(item => field === 'deployments' ? normalizeDeployment(item) : field === 'envs' ? envMetadata(record(item) ?? {}) : safeAuditItem(item)) }
      : { status: 'unavailable', reason: 'Vercel API did not provide this read for the bound project' };
    const vars = outcomes[4]?.status === 'fulfilled' ? { status: 'available', data: (outcomes[4].value as JsonRecord).variables } : { status: 'unavailable' };
    const team = outcomes[6]?.status === 'fulfilled' ? outcomes[6].value as JsonRecord : null;
    const teamPlan = team ? stringField(recordField(team, 'billing') ?? {}, 'plan') : null;
    return {
      provider: 'vercel', projectId: bound.id, observedAt: this.now().toISOString(),
      team: team ? { status: 'available', id: stringField(team, 'id') ?? bound.binding.teamId, name: stringField(team, 'name'), slug: stringField(team, 'slug'), plan: teamPlan } : { status: 'unavailable' },
      projectInventory: section(5, 'projects'),
      project: { id: bound.id, name: stringField(bound.data, 'name'), productionBranch: stringField(recordField(bound.data, 'link') ?? {}, 'productionBranch'), framework: stringField(bound.data, 'framework'), rootDirectory: stringField(bound.data, 'rootDirectory'), deploymentProtection: safeAuditItem(recordField(bound.data, 'ssoProtection') ?? {}) },
      domains: section(0, 'domains'), customEnvironments: section(1, 'environments'), aliases: section(2, 'aliases'), deployments: section(3, 'deployments'), variables: vars,
      usageAndBilling: { status: teamPlan ? 'partial' : 'unavailable', plan: teamPlan, reason: 'Spend, usage, limits and budget require a verified supported API and are unavailable here' },
    };
  }

  private binding(project: ProjectReference): VercelProjectBinding {
    const binding = this.bindings.get(project.id);
    if (!binding) throw { code: 'NOT_FOUND', source: 'vercel', message: `No Vercel deployment binding is configured for ${project.id}` };
    return binding;
  }

  private async tokenValue(binding: VercelProjectBinding): Promise<string> {
    const token = binding.connectionId && this.tokenResolver ? await this.tokenResolver(binding) : this.token;
    if (!token) throw { code: 'AUTH_REQUIRED', source: 'vercel', message: 'Vercel deployment access requires an active account connection or CONDUCTOR_VERCEL_TOKEN' };
    return token;
  }

  private async getProject(binding: VercelProjectBinding): Promise<JsonRecord> {
    return await this.getJson(
      `/v9/projects/${encodeURIComponent(binding.project)}`,
      scopeQuery(binding), binding,
    );
  }

  private async getJson(path: string, query: Record<string, string>, binding: VercelProjectBinding): Promise<JsonRecord> {
    const response = await this.request(path, query, binding);
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      throw { code: 'COMMAND_FAILED', source: 'vercel', message: `Vercel returned a non-JSON response for ${path}` };
    }
    return body as JsonRecord;
  }

  private async request(path: string, query: Record<string, string>, binding: VercelProjectBinding, options?: { method: 'POST' | 'PATCH' | 'DELETE'; body?: object }): Promise<Response> {
    const token = await this.tokenValue(binding);
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
    || operation === 'deployment.runtime-logs' || operation === 'deployment.env.list' || operation === 'deployment.vcr.get';
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
  };
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
