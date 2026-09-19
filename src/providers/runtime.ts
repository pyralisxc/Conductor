import type {
  CapabilityAvailability,
  PreflightCheck,
  ProjectReference,
} from '../runtime/types.js';

export interface RuntimeCapabilityProvider {
  readonly id: string;
  getCapabilities(): Promise<CapabilityAvailability[]>;
}

export interface ProjectPreflightProvider extends RuntimeCapabilityProvider {
  preflightProject(project: ProjectReference): Promise<PreflightCheck[]>;
}

export type ToolRuntimeProvider =
  | RuntimeCapabilityProvider
  | ProjectPreflightProvider;

export function supportsProjectPreflight(
  provider: ToolRuntimeProvider,
): provider is ProjectPreflightProvider {
  return 'preflightProject' in provider;
}
