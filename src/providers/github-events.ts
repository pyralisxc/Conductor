import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrEventArguments, PrEventIntegrationBranch } from '../runtime/pr-events.js';

/** GitHub payloads are signed routing hints; reconciliation owns the current evidence. */
export async function ingestGitHubPrEvent(options: { integrationBranch?: PrEventIntegrationBranch; target: PrEventArguments; installationId: number; webhookSecret: string; reconcile: (source: string) => Promise<string> }, body: Buffer, event: string, deliveryId: string, signature: string): Promise<string> {
  if (body.length > 262144 || !/^[A-Za-z0-9-]{1,100}$/.test(deliveryId) || !/^sha256=[a-f0-9]{64}$/.test(signature)) throw new Error('Invalid provider delivery');
  const expected = createHmac('sha256', options.webhookSecret).update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) throw new Error('Invalid provider signature');
  const payload = JSON.parse(body.toString('utf8'));
  const actions: Record<string, string[]> = { pull_request: ['opened', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft', 'closed'], check_run: ['created', 'completed', 'rerequested'], check_suite: ['completed', 'rerequested'], pull_request_review: ['submitted', 'edited', 'dismissed'], pull_request_review_comment: ['created', 'edited', 'deleted'] };
  if (!actions[event]?.includes(payload.action)) return 'ignored';
  if (payload.repository?.full_name !== options.target.repository || payload.installation?.id !== options.installationId) throw new Error('Provider installation or repository mismatch');
  if (event === 'pull_request' || event === 'pull_request_review' || event === 'pull_request_review_comment') {
    if (payload.pull_request?.base?.ref !== undefined && payload.pull_request.base.ref !== (options.integrationBranch ?? 'preview')) return 'ignored';
    if (payload.pull_request?.number !== options.target.pullRequestNumber || payload.pull_request?.head?.sha !== options.target.headSha || payload.pull_request?.base?.sha !== options.target.baseSha) return 'ignored';
  } else {
    const check = payload[event];
    if (check?.head_sha !== options.target.headSha || !Array.isArray(check.pull_requests) || !check.pull_requests.some((p: { number?: number }) => p.number === options.target.pullRequestNumber)) return 'ignored';
  }
  return options.reconcile(`${options.target.repository}:${options.installationId}:${deliveryId}`);
}
