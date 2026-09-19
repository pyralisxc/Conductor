import { normalizeToolError } from '../runtime/errors.js';
import type {
  CapabilityAvailability,
  PreflightCheck,
  ProjectReference,
} from '../runtime/types.js';
import type { ProjectPreflightProvider } from './runtime.js';

/**
 * Truthful placeholder used until a deployed Development Intelligence API
 * adapter is configured. It never converts missing integration into evidence.
 */
export class UnavailableDevelopmentIntelligenceProvider implements ProjectPreflightProvider {
  readonly id = 'development-intelligence';

  async getCapabilities(): Promise<CapabilityAvailability[]> {
    return [{
      capability: 'development-intelligence.read',
      available: false,
      provider: this.id,
      access: 'read',
      auth: 'unknown',
      health: 'unavailable',
      diagnostics: [{
        level: 'warning',
        source: this.id,
        code: 'TOOL_UNAVAILABLE',
        message: 'No deployed Development Intelligence adapter is configured',
      }],
    }];
  }

  async preflightProject(_project: ProjectReference): Promise<PreflightCheck[]> {
    const error = normalizeToolError({
      code: 'TOOL_UNAVAILABLE',
      message: 'No deployed Development Intelligence adapter is configured',
    }, 'TOOL_UNAVAILABLE', this.id);
    return [{
      check: 'development-intelligence.read',
      status: 'unavailable',
      provider: this.id,
      summary: error.message,
      error,
      diagnostics: error.diagnostics,
    }];
  }
}
