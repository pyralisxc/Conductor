import { ConductorToolRuntime } from '../runtime/runtime.js';
import { GitHubRuntimeProvider } from '../providers/github.js';
import { UnavailableDevelopmentIntelligenceProvider } from '../providers/development-intelligence.js';
import type { ToolRuntimeProvider } from '../providers/runtime.js';
import { WorkspaceRuntimeProvider } from '../providers/workspace.js';

export interface ConfiguredProject {
  id: string;
  repository?: string;
  workspace?: string;
}

export interface RuntimeEnvironment extends Record<string, string | undefined> {
  CONDUCTOR_PROJECTS_JSON?: string;
  GITHUB_TOKEN?: string;
}

export function createRuntimeFromEnvironment(
  environment: RuntimeEnvironment = process.env,
): ConductorToolRuntime {
  const projects = parseProjects(environment.CONDUCTOR_PROJECTS_JSON);
  const providers: ToolRuntimeProvider[] = [
    new UnavailableDevelopmentIntelligenceProvider(),
  ];
  const githubProjects = projects.flatMap((project) => project.repository
    ? [{ id: project.id, repository: project.repository }]
    : []);
  if (githubProjects.length > 0) {
    providers.push(new GitHubRuntimeProvider({
      token: environment.GITHUB_TOKEN,
      projects: githubProjects,
    }));
  }

  const workspaceProjects = projects.flatMap((project) => project.workspace
    ? [{ id: project.id, workspace: project.workspace }]
    : []);
  if (workspaceProjects.length > 0) {
    providers.push(new WorkspaceRuntimeProvider({ projects: workspaceProjects }));
  }

  return new ConductorToolRuntime({ providers });
}

export function parseProjects(value?: string): ConfiguredProject[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error('CONDUCTOR_PROJECTS_JSON must be a JSON array');
  }
  const ids = new Set<string>();
  return parsed.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error(`Project at index ${index} must be an object`);
    }
    const project = candidate as Record<string, unknown>;
    if (typeof project.id !== 'string' || project.id.trim() === '') {
      throw new Error(`Project at index ${index} must have a non-empty id`);
    }
    if (ids.has(project.id)) throw new Error(`Duplicate project id: ${project.id}`);
    ids.add(project.id);
    if (project.repository !== undefined && typeof project.repository !== 'string') {
      throw new Error(`Project ${project.id} repository must be a string`);
    }
    if (project.workspace !== undefined && typeof project.workspace !== 'string') {
      throw new Error(`Project ${project.id} workspace must be a string`);
    }
    return {
      id: project.id,
      repository: project.repository,
      workspace: project.workspace,
    } as ConfiguredProject;
  });
}
