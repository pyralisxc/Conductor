import type {
  NormalizedToolError,
  ToolDiagnostic,
  ToolErrorCode,
} from './types.js';

export class ConductorToolError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly source?: string;
  readonly diagnostics: ToolDiagnostic[];

  constructor(input: {
    code: ToolErrorCode;
    message: string;
    retryable?: boolean;
    source?: string;
    diagnostics?: ToolDiagnostic[];
  }) {
    super(input.message);
    this.name = 'ConductorToolError';
    this.code = input.code;
    this.retryable = input.retryable ?? input.code === 'TRANSIENT';
    this.source = input.source;
    this.diagnostics = input.diagnostics ?? [];
  }
}

interface ErrorLike {
  message?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  exitCode?: unknown;
  source?: unknown;
}

function errorLike(error: unknown): ErrorLike {
  return typeof error === 'object' && error !== null ? error : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function normalizeToolError(
  error: unknown,
  fallback: ToolErrorCode = 'TOOL_UNAVAILABLE',
  source?: string,
): NormalizedToolError {
  if (error instanceof ConductorToolError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      source: error.source ?? source,
      diagnostics: error.diagnostics,
    };
  }

  const candidate = errorLike(error);
  const rawCode = stringValue(candidate.code);
  const status = numberValue(candidate.status) ?? numberValue(candidate.statusCode);
  const exitCode = numberValue(candidate.exitCode);
  const message =
    error instanceof Error
      ? error.message
      : stringValue(candidate.message) ?? 'Tool operation failed';

  let code = fallback;
  if (
    status === 401 ||
    rawCode === 'UNAUTHENTICATED' ||
    rawCode === 'AUTH_REQUIRED'
  ) {
    code = 'AUTH_REQUIRED';
  }
  else if (
    status === 403 ||
    rawCode === 'EACCES' ||
    rawCode === 'EPERM' ||
    rawCode === 'PERMISSION_DENIED'
  ) {
    code = 'PERMISSION_DENIED';
  } else if (status === 404 || rawCode === 'ENOENT' || rawCode === 'NOT_FOUND') {
    code = 'NOT_FOUND';
  } else if (status === 409 || rawCode === 'EEXIST' || rawCode === 'CONFLICT') {
    code = 'CONFLICT';
  } else if (
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    rawCode === 'ETIMEDOUT' ||
    rawCode === 'ECONNRESET' ||
    rawCode === 'ECONNREFUSED' ||
    rawCode === 'TRANSIENT'
  ) {
    code = 'TRANSIENT';
  } else if (exitCode !== undefined || rawCode === 'COMMAND_FAILED') {
    code = 'COMMAND_FAILED';
  } else if (rawCode === 'TOOL_UNAVAILABLE') {
    code = 'TOOL_UNAVAILABLE';
  }

  const diagnostic: ToolDiagnostic = {
    level: 'error',
    code,
    message,
    source: stringValue(candidate.source) ?? source,
  };

  if (exitCode !== undefined) {
    diagnostic.details = { exitCode };
  }

  return {
    code,
    message,
    retryable: code === 'TRANSIENT',
    source: diagnostic.source,
    diagnostics: [diagnostic],
  };
}
