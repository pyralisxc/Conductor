import type { ProviderUsageSnapshot } from '../runtime/types.js';

const DEFAULT_DUPLICATE_WINDOW_MS = 30_000;

export class ProviderUsageTracker {
  private calls = 0;
  private duplicateReads = 0;
  private requestBodyBytes = 0;
  private reportedResponseBytes = 0;
  private responsesWithUnknownBytes = 0;
  private readonly recentReads = new Map<string, number>();

  constructor(
    private readonly provider: string,
    private readonly now: () => number = () => Date.now(),
    private readonly duplicateWindowMs = DEFAULT_DUPLICATE_WINDOW_MS,
  ) {}

  wrap(rawFetch: typeof globalThis.fetch): typeof globalThis.fetch {
    return async (input, init) => await this.fetch(rawFetch, input, init);
  }

  async fetch(
    rawFetch: typeof globalThis.fetch,
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const url = input instanceof Request ? input.url : String(input);
    const startedAt = this.now();
    this.calls += 1;
    this.requestBodyBytes += knownBodyBytes(init?.body);

    if (method === 'GET' || method === 'HEAD') {
      const key = `${method} ${url}`;
      const previous = this.recentReads.get(key);
      if (previous !== undefined && startedAt - previous <= this.duplicateWindowMs) {
        this.duplicateReads += 1;
      }
      this.recentReads.set(key, startedAt);
      if (this.recentReads.size > 1_000) this.pruneRecentReads(startedAt);
    }

    const response = await rawFetch(input, init);
    const responseBytes = integerHeader(response.headers, 'content-length');
    if (responseBytes === null) this.responsesWithUnknownBytes += 1;
    else this.reportedResponseBytes += responseBytes;
    return response;
  }

  snapshot(): ProviderUsageSnapshot {
    return {
      provider: this.provider,
      calls: this.calls,
      duplicateReads: this.duplicateReads,
      requestBodyBytes: this.requestBodyBytes,
      reportedResponseBytes: this.reportedResponseBytes,
      responsesWithUnknownBytes: this.responsesWithUnknownBytes,
      observedAt: new Date(this.now()).toISOString(),
    };
  }

  private pruneRecentReads(now: number): void {
    const cutoff = now - this.duplicateWindowMs;
    for (const [key, observedAt] of this.recentReads) {
      if (observedAt < cutoff) this.recentReads.delete(key);
    }
  }
}

function knownBodyBytes(body: BodyInit | null | undefined): number {
  if (body === null || body === undefined) return 0;
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return 0;
}

function integerHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null || value.trim() === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
