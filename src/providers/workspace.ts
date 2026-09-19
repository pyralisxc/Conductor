import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { normalizeToolError } from '../runtime/errors.js';
import type {
  CapabilityAvailability,
  PreflightCheck,
  ProjectReference,
} from '../runtime/types.js';
import type { ProjectPreflightProvider } from './runtime.js';

export interface WorkspaceProjectConfiguration {
  id: string;
  workspace: string;
}

export interface WorkspaceRuntimeProviderOptions {
  projects: WorkspaceProjectConfiguration[];
  commandTimeoutMs?: number;
}

export class WorkspaceRuntimeProvider implements ProjectPreflightProvider {
  readonly id = 'workspace';
  private readonly projects: ReadonlyMap<string, WorkspaceProjectConfiguration>;
  private readonly commandTimeoutMs: number;

  constructor(options: WorkspaceRuntimeProviderOptions) {
    this.projects = new Map(options.projects.map((project) => [project.id, {
      ...project,
      workspace: resolve(project.workspace),
    }]));
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
  }

  async getCapabilities(): Promise<CapabilityAvailability[]> {
    const configured = this.projects.size > 0;
    return [
      capability('workspace.read', 'read', configured),
      capability('workspace.write', 'write', configured),
      capability('shell.execute', 'execute', configured),
      capability('tests.run', 'execute', configured),
      capability('git.diff', 'execute', configured),
    ];
  }

  async preflightProject(project: ProjectReference): Promise<PreflightCheck[]> {
    const configured = this.projects.get(project.id);
    if (!configured) {
      return unavailableChecks('NOT_FOUND', `Project ${project.id} has no configured workspace`);
    }
    if (project.workspace && resolve(project.workspace) !== configured.workspace) {
      return unavailableChecks('CONFLICT', 'Requested workspace does not match the configured project workspace');
    }

    const workspaceAccess = await this.workspaceAccess(configured.workspace);
    if (workspaceAccess.status !== 'ready') {
      return [
        workspaceAccess,
        blockedBy('shell.execute', workspaceAccess),
        blockedBy('tests.run', workspaceAccess),
      ];
    }

    const shell = await this.shellAccess(configured.workspace);
    const tests = await this.testAccess(configured.workspace);
    return [workspaceAccess, shell, tests];
  }

  private async workspaceAccess(workspace: string): Promise<PreflightCheck> {
    try {
      await access(workspace, constants.R_OK | constants.W_OK);
      return ready('workspace.access', `Workspace is readable and writable: ${workspace}`);
    } catch (error) {
      return failed('workspace.access', normalizeToolError(error, 'PERMISSION_DENIED', this.id));
    }
  }

  private async shellAccess(workspace: string): Promise<PreflightCheck> {
    try {
      await runProbe(process.execPath, ['-e', 'process.exit(0)'], workspace, this.commandTimeoutMs);
      return ready('shell.execute', `Node shell execution is available in ${workspace}`);
    } catch (error) {
      return failed('shell.execute', normalizeToolError(error, 'COMMAND_FAILED', this.id));
    }
  }

  private async testAccess(workspace: string): Promise<PreflightCheck> {
    try {
      const raw = await readFile(resolve(workspace, 'package.json'), 'utf8');
      const manifest = JSON.parse(raw) as { scripts?: Record<string, string> };
      const test = manifest.scripts?.test;
      if (!test) {
        return failed('tests.run', normalizeToolError({
          code: 'TOOL_UNAVAILABLE',
          message: 'No package.json test script is configured',
        }, 'TOOL_UNAVAILABLE', this.id));
      }
      return ready('tests.run', 'The project exposes a package.json test script');
    } catch (error) {
      return failed('tests.run', normalizeToolError(error, 'TOOL_UNAVAILABLE', this.id));
    }
  }
}

function capability(
  name: CapabilityAvailability['capability'],
  access: CapabilityAvailability['access'],
  configured: boolean,
): CapabilityAvailability {
  return {
    capability: name,
    available: configured,
    provider: 'workspace',
    access,
    auth: 'not-applicable',
    health: configured ? 'ready' : 'unavailable',
    diagnostics: configured ? [] : [{
      level: 'warning',
      source: 'workspace',
      code: 'TOOL_UNAVAILABLE',
      message: 'No project workspaces are configured',
    }],
  };
}

function ready(id: PreflightCheck['check'], summary: string): PreflightCheck {
  return { check: id, status: 'ready', provider: 'workspace', summary, diagnostics: [] };
}

function failed(
  id: PreflightCheck['check'],
  error: ReturnType<typeof normalizeToolError>,
): PreflightCheck {
  return {
    check: id,
    status: error.code === 'TOOL_UNAVAILABLE' ? 'unavailable' : 'blocked',
    provider: 'workspace',
    summary: error.message,
    error,
    diagnostics: error.diagnostics,
  };
}

function blockedBy(
  id: PreflightCheck['check'],
  dependency: PreflightCheck,
): PreflightCheck {
  const error = normalizeToolError({
    code: dependency.error?.code ?? 'TOOL_UNAVAILABLE',
    message: `${id} cannot be checked because workspace access failed`,
  }, 'TOOL_UNAVAILABLE', 'workspace');
  return failed(id, error);
}

function unavailableChecks(
  code: 'NOT_FOUND' | 'CONFLICT',
  message: string,
): PreflightCheck[] {
  const error = normalizeToolError({ code, message }, code, 'workspace');
  return (['workspace.access', 'shell.execute', 'tests.run'] as const).map((id) => failed(id, error));
}

function runProbe(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject({ code: 'TRANSIENT', message: `Shell probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0) resolvePromise();
      else reject({ exitCode, message: `Shell probe exited with code ${exitCode}` });
    });
  });
}
