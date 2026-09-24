import { ConductorToolRuntime } from '../runtime/runtime.js';
import { GitHubRuntimeProvider } from '../providers/github.js';
import { GitHubAppCredentialProvider } from '../providers/github-auth.js';
import { DevelopmentIntelligenceProvider, UnavailableDevelopmentIntelligenceProvider } from '../providers/development-intelligence.js';
import type { ToolRuntimeProvider } from '../providers/runtime.js';
import { WorkspaceRuntimeProvider } from '../providers/workspace.js';
import { VercelDeploymentProvider } from '../providers/vercel.js';
import { vercelInstallationToken } from '../transport/vercel-connections.js';
import { IdempotentMutationExecutor } from '../runtime/idempotency.js';
import { RedisIdempotencyStore } from '../runtime/redis-idempotency.js';

export interface RuntimeBinding {
  id: string;
  repository?: string;
  workspace?: string;
  githubWrite?: boolean;
  vercelProject?: string;
  vercelTeamId?: string;
  vercelConnectionId?: string;
}

export interface RuntimeEnvironment extends Record<string, string | undefined> {
  CONDUCTOR_PROJECTS_JSON?: string;
  CONDUCTOR_VERCEL_BINDINGS_JSON?: string;
  GITHUB_TOKEN?: string;
  CONDUCTOR_GITHUB_APP_ID?: string;
  CONDUCTOR_GITHUB_APP_PRIVATE_KEY?: string;
  CONDUCTOR_GITHUB_ALLOWED_OWNERS?: string;
  DEVINT_MCP_URL?: string;
  DEVINT_AGENT_TOKEN?: string;
  CONDUCTOR_ENABLE_GITHUB_MUTATIONS?: string;
  CONDUCTOR_VERCEL_TOKEN?: string;
  VERCEL_TOKEN?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
}

export function createRuntimeFromEnvironment(
  environment: RuntimeEnvironment = process.env,
): ConductorToolRuntime {
  const bindings = mergeVercelBindings(
    parseRuntimeBindings(environment.CONDUCTOR_PROJECTS_JSON),
    parseVercelBindingOverlay(environment.CONDUCTOR_VERCEL_BINDINGS_JSON),
  );
  const providers: ToolRuntimeProvider[] = [environment.DEVINT_MCP_URL
    ? new DevelopmentIntelligenceProvider({
      endpoint: environment.DEVINT_MCP_URL,
      token: environment.DEVINT_AGENT_TOKEN,
    })
    : new UnavailableDevelopmentIntelligenceProvider()];
  const githubBindings = bindings.flatMap((binding) => binding.repository
    ? [{ id: binding.id, repository: binding.repository, write: binding.githubWrite }]
    : []);
  const allowedOwners = parseOwners(environment.CONDUCTOR_GITHUB_ALLOWED_OWNERS);
  const githubApp = githubAppCredentials(environment);
  let githubProvider: GitHubRuntimeProvider | undefined;
  if (githubBindings.length > 0 || allowedOwners.length > 0) {
    githubProvider = new GitHubRuntimeProvider({
      token: githubApp ? undefined : environment.GITHUB_TOKEN,
      credentials: githubApp,
      bindings: githubBindings,
      allowedOwners,
    });
    providers.push(githubProvider);
  }

  const workspaceBindings = bindings.flatMap((binding) => binding.workspace
    ? [{ id: binding.id, workspace: binding.workspace }]
    : []);
  if (workspaceBindings.length > 0) {
    providers.push(new WorkspaceRuntimeProvider({ projects: workspaceBindings }));
  }

  const vercelBindings = bindings.flatMap((binding) => binding.vercelProject
    ? [{ id: binding.id, project: binding.vercelProject, repository: binding.repository, teamId: binding.vercelTeamId, connectionId: binding.vercelConnectionId }]
    : []);
  let vercelProvider: VercelDeploymentProvider | undefined;
  if (vercelBindings.length > 0) {
    vercelProvider = new VercelDeploymentProvider({
      token: environment.CONDUCTOR_VERCEL_TOKEN ?? environment.VERCEL_TOKEN,
      tokenResolver: (binding) => binding.connectionId ? vercelInstallationToken(binding.connectionId, binding.teamId) : Promise.resolve(undefined),
      bindings: vercelBindings,
    });
    providers.push(vercelProvider);
  }

  const sourceControlMutationsEnabled = environment.CONDUCTOR_ENABLE_GITHUB_MUTATIONS === '1';
  if (!sourceControlMutationsEnabled) return new ConductorToolRuntime({ providers, projectResolver: githubProvider, pullRequestProvider: githubProvider, workItemProvider: githubProvider, workItemCandidateProvider: githubProvider, deploymentProvider: vercelProvider });
  if (!githubProvider || (!environment.GITHUB_TOKEN && !githubApp)) {
    throw new Error('GitHub mutations require an authorized owner/project and GitHub authentication');
  }
  const redisUrl = environment.UPSTASH_REDIS_REST_URL ?? environment.KV_REST_API_URL;
  const redisToken = environment.UPSTASH_REDIS_REST_TOKEN ?? environment.KV_REST_API_TOKEN;
  if (!redisUrl || !redisToken) {
    throw new Error('GitHub mutations require durable Redis idempotency state');
  }
  return new ConductorToolRuntime({
    providers,
    sourceControlMutationProvider: githubProvider,
    mutationExecutor: new IdempotentMutationExecutor({
      store: new RedisIdempotencyStore({ url: redisUrl, token: redisToken }),
    }),
    projectResolver: githubProvider,
    pullRequestProvider: githubProvider,
    workItemProvider: githubProvider,
    workItemCandidateProvider: githubProvider,
    deploymentProvider: vercelProvider,
  });
}

function githubAppCredentials(environment: RuntimeEnvironment): GitHubAppCredentialProvider | undefined {
  const appId = environment.CONDUCTOR_GITHUB_APP_ID?.trim();
  const privateKey = environment.CONDUCTOR_GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId && !privateKey) return undefined;
  if (!appId || !privateKey) {
    throw new Error('CONDUCTOR_GITHUB_APP_ID and CONDUCTOR_GITHUB_APP_PRIVATE_KEY must be configured together');
  }
  return new GitHubAppCredentialProvider({ appId, privateKey });
}

export function parseOwners(value?: string): string[] {
  if (!value?.trim()) return [];
  const owners = value.split(',').map((owner) => owner.trim()).filter(Boolean);
  const unique = new Map<string, string>();
  for (const owner of owners) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
      throw new Error(`Invalid GitHub owner in CONDUCTOR_GITHUB_ALLOWED_OWNERS: ${owner}`);
    }
    if (!unique.has(owner.toLowerCase())) unique.set(owner.toLowerCase(), owner);
  }
  return [...unique.values()];
}

export function parseRuntimeBindings(value?: string): RuntimeBinding[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error('CONDUCTOR_PROJECTS_JSON must be a JSON array');
  }
  const ids = new Set<string>();
  return parsed.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error(`Runtime binding at index ${index} must be an object`);
    }
    const project = candidate as Record<string, unknown>;
    if (typeof project.id !== 'string' || project.id.trim() === '') {
      throw new Error(`Runtime binding at index ${index} must have a non-empty id`);
    }
    if (ids.has(project.id)) throw new Error(`Duplicate runtime binding id: ${project.id}`);
    ids.add(project.id);
    if (project.repository !== undefined && typeof project.repository !== 'string') {
      throw new Error(`Runtime binding ${project.id} repository must be a string`);
    }
    if (project.workspace !== undefined && typeof project.workspace !== 'string') {
      throw new Error(`Runtime binding ${project.id} workspace must be a string`);
    }
    if (project.githubWrite !== undefined && typeof project.githubWrite !== 'boolean') {
      throw new Error(`Runtime binding ${project.id} githubWrite must be a boolean`);
    }
    if (project.vercelProject !== undefined && typeof project.vercelProject !== 'string') {
      throw new Error(`Runtime binding ${project.id} vercelProject must be a string`);
    }
    if (project.vercelTeamId !== undefined && typeof project.vercelTeamId !== 'string') {
      throw new Error(`Runtime binding ${project.id} vercelTeamId must be a string`);
    }
    if (project.vercelConnectionId !== undefined && (typeof project.vercelConnectionId !== 'string' || !/^icfg_[\w-]+$/u.test(project.vercelConnectionId))) {
      throw new Error(`Runtime binding ${project.id} vercelConnectionId must be a Vercel installation ID`);
    }
    return {
      id: project.id,
      repository: project.repository,
      workspace: project.workspace,
      githubWrite: project.githubWrite,
      ...(typeof project.vercelProject === 'string' ? { vercelProject: project.vercelProject } : {}),
      ...(typeof project.vercelTeamId === 'string' ? { vercelTeamId: project.vercelTeamId } : {}),
      ...(typeof project.vercelConnectionId === 'string' ? { vercelConnectionId: project.vercelConnectionId } : {}),
    } as RuntimeBinding;
  });
}

/** Additional exact Vercel routing, kept separate from legacy runtime configuration. */
export function parseVercelBindingOverlay(value?: string): RuntimeBinding[] {
  if (!value) return [];
  const raw: unknown = JSON.parse(value);
  if (!Array.isArray(raw)) throw new Error('CONDUCTOR_VERCEL_BINDINGS_JSON must be a JSON array');
  const permitted = new Set(['id', 'repository', 'vercelProject', 'vercelConnectionId', 'vercelTeamId']);
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Vercel binding at index ${index} must be an object`);
    const fields = entry as Record<string, unknown>;
    if (Object.keys(fields).some(key => !permitted.has(key))) throw new Error(`Vercel binding at index ${index} contains an unsupported field`);
    if (typeof fields.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(fields.repository)) throw new Error(`Vercel binding at index ${index} requires an exact repository`);
    if (typeof fields.vercelProject !== 'string' || !/^prj_[A-Za-z0-9]+$/u.test(fields.vercelProject)) throw new Error(`Vercel binding at index ${index} requires an exact project ID`);
    if (typeof fields.vercelConnectionId !== 'string' || !/^icfg_[A-Za-z0-9]+$/u.test(fields.vercelConnectionId)) throw new Error(`Vercel binding at index ${index} requires an exact installation ID`);
    if (fields.vercelTeamId !== undefined && (typeof fields.vercelTeamId !== 'string' || !/^team_[A-Za-z0-9]+$/u.test(fields.vercelTeamId))) throw new Error(`Vercel binding at index ${index} has an invalid team ID`);
  }
  return parseRuntimeBindings(value);
}

export function mergeVercelBindings(base: RuntimeBinding[], overlay: RuntimeBinding[]): RuntimeBinding[] {
  const result = base.map(binding => ({ ...binding }));
  for (const extra of overlay) {
    const index = result.findIndex(binding => binding.id.toLowerCase() === extra.id.toLowerCase());
    if (index >= 0) {
      const existing = result[index]!;
      if (existing.repository?.toLowerCase() !== extra.repository?.toLowerCase() || existing.vercelProject) {
        throw new Error(`Vercel overlay conflicts with runtime binding ${extra.id}`);
      }
      result[index] = { ...existing, vercelProject: extra.vercelProject, vercelConnectionId: extra.vercelConnectionId, vercelTeamId: extra.vercelTeamId };
    } else {
      if (result.some(binding => binding.repository?.toLowerCase() === extra.repository?.toLowerCase())) {
        throw new Error(`Vercel overlay repository is already bound under another identity: ${extra.repository}`);
      }
      result.push(extra);
    }
  }
  return result;
}
