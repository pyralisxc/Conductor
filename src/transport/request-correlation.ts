import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Ephemeral correlation only; never persist or log request arguments or identity secrets. */
const requestContext = new AsyncLocalStorage<{ correlationId: string }>();

export function withRequestCorrelation<T>(run: () => Promise<T>): Promise<T> {
  return requestContext.run({ correlationId: randomUUID() }, run);
}

export function traceCommitBoundary(phase: 'http-admitted' | 'http-completed' | 'claim-attempt' | 'claim-result' | 'claim-error', fields: { contentLength?: number | null; statusCode?: number; durationMs?: number; claimStatus?: string } = {}): void {
  const correlationId = requestContext.getStore()?.correlationId;
  if (!correlationId) return;
  console.info(JSON.stringify({ event: 'commit-admission', correlationId, phase, ...fields }));
}
