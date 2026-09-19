import { randomUUID } from 'node:crypto';
import {
  supportsProjectPreflight,
  type ToolRuntimeProvider,
} from '../providers/runtime.js';
import { normalizeToolError } from './errors.js';
import {
  TOOL_RUNTIME_CONTRACT_VERSION,
  type CapabilityAvailability,
  type CapabilityReport,
  type ExecutionReceipt,
  type PreflightCheck,
  type PreflightCheckId,
  type ProjectPreflight,
  type ProjectReference,
  type ProviderHealth,
  type ToolDefinition,
  type ToolDiagnostic,
  type ToolOperationName,
} from './types.js';

const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'capabilities',
    description: 'Report the operations and development capabilities currently available.',
    mutates: false,
  },
  {
    name: 'preflight_project',
    description: 'Verify development access, execution surfaces, tests, and intelligence for a project.',
    mutates: false,
  },
];

const REQUIRED_PREFLIGHT_CHECKS: readonly PreflightCheckId[] = [
  'repository.access',
  'github.read',
  'github.write',
  'workspace.access',
  'shell.execute',
  'tests.run',
  'development-intelligence.read',
];

export interface ConductorToolRuntimeOptions {
  providers?: ToolRuntimeProvider[];
  now?: () => Date;
  createOperationId?: () => string;
}

export class ConductorToolRuntime {
  private readonly providers: ToolRuntimeProvider[];
  private readonly now: () => Date;
  private readonly createOperationId: () => string;

  constructor(options: ConductorToolRuntimeOptions = {}) {
    this.providers = options.providers ?? [];
    this.now = options.now ?? (() => new Date());
    this.createOperationId =
      options.createOperationId ?? (() => randomUUID());
  }

  async capabilities(): Promise<ExecutionReceipt<CapabilityReport>> {
    return this.executeRead(
      'capabilities',
      { kind: 'runtime', id: 'conductor' },
      async () => {
        const capabilities: CapabilityAvailability[] = [];
        const providers: ProviderHealth[] = [];
        const diagnostics: ToolDiagnostic[] = [];

        for (const provider of this.providers) {
          try {
            const reported = await provider.getCapabilities();
            capabilities.push(...reported);
            const health = reported.some((capability) => capability.health === 'ready')
              ? reported.some((capability) => capability.health !== 'ready')
                ? 'degraded'
                : 'ready'
              : reported.some((capability) => capability.health === 'degraded')
                ? 'degraded'
                : 'unavailable';
            providers.push({ provider: provider.id, health });
          } catch (error) {
            const normalized = normalizeToolError(
              error,
              'TOOL_UNAVAILABLE',
              provider.id,
            );
            providers.push({
              provider: provider.id,
              health:
                normalized.code === 'TRANSIENT' ? 'degraded' : 'unavailable',
              error: normalized,
            });
            diagnostics.push(...normalized.diagnostics);
          }
        }

        capabilities.sort((left, right) =>
          left.capability.localeCompare(right.capability),
        );
        providers.sort((left, right) =>
          left.provider.localeCompare(right.provider),
        );

        return {
          result: {
            contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
            operations: [...TOOL_DEFINITIONS],
            capabilities,
            providers,
          },
          diagnostics,
        };
      },
    );
  }

  async preflightProject(
    project: ProjectReference,
  ): Promise<ExecutionReceipt<ProjectPreflight>> {
    return this.executeRead(
      'preflight_project',
      { kind: 'project', id: project.id, ref: project.ref },
      async () => {
        const checks = new Map<PreflightCheckId, PreflightCheck>();
        const diagnostics: ToolDiagnostic[] = [];

        for (const provider of this.providers) {
          if (!supportsProjectPreflight(provider)) continue;

          try {
            const providerChecks = await provider.preflightProject(project);
            for (const check of providerChecks) {
              const existing = checks.get(check.check);
              if (existing) {
                const error = normalizeToolError(
                  {
                    code: 'CONFLICT',
                    message: `Preflight check ${check.check} was reported by both ${existing.provider} and ${provider.id}`,
                  },
                  'CONFLICT',
                  'conductor',
                );
                checks.set(check.check, {
                  check: check.check,
                  status: 'blocked',
                  provider: 'conductor',
                  summary: error.message,
                  error,
                  diagnostics: error.diagnostics,
                });
                diagnostics.push(...error.diagnostics);
                continue;
              }
              checks.set(check.check, check);
            }
          } catch (error) {
            const normalized = normalizeToolError(
              error,
              'TOOL_UNAVAILABLE',
              provider.id,
            );
            diagnostics.push(...normalized.diagnostics);
          }
        }

        for (const check of REQUIRED_PREFLIGHT_CHECKS) {
          if (!checks.has(check)) {
            const error = normalizeToolError(
              {
                code: 'TOOL_UNAVAILABLE',
                message: `No provider is configured for ${check}`,
              },
              'TOOL_UNAVAILABLE',
              'conductor',
            );
            checks.set(check, {
              check,
              status: 'unavailable',
              provider: 'conductor',
              summary: error.message,
              error,
              diagnostics: error.diagnostics,
            });
          }
        }

        const orderedChecks = REQUIRED_PREFLIGHT_CHECKS.map(
          (check) => checks.get(check)!,
        );
        const status = orderedChecks.some((check) => check.status === 'blocked')
          ? 'blocked'
          : orderedChecks.some((check) => check.status !== 'ready')
            ? 'degraded'
            : 'ready';

        return {
          result: {
            contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
            project,
            status,
            checks: orderedChecks,
          },
          diagnostics,
        };
      },
    );
  }

  private async executeRead<Result>(
    operation: ToolOperationName,
    target: { kind: 'runtime' | 'project'; id: string; ref?: string },
    read: () => Promise<{
      result: Result;
      diagnostics?: ToolDiagnostic[];
    }>,
  ): Promise<ExecutionReceipt<Result>> {
    const operationId = this.createOperationId();
    const startedAt = this.now().toISOString();

    try {
      const outcome = await read();
      return {
        contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
        operationId,
        operation,
        target,
        status: 'succeeded',
        startedAt,
        finishedAt: this.now().toISOString(),
        result: outcome.result,
        diagnostics: outcome.diagnostics ?? [],
      };
    } catch (error) {
      const normalized = normalizeToolError(error, 'TOOL_UNAVAILABLE');
      return {
        contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
        operationId,
        operation,
        target,
        status: 'failed',
        startedAt,
        finishedAt: this.now().toISOString(),
        error: normalized,
        diagnostics: normalized.diagnostics,
      };
    }
  }
}
