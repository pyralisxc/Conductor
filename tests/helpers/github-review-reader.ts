import { GitHubRuntimeProvider } from '../../src/providers/github.js';
import type { GitHubCredential } from '../../src/connections/github/app-installation.js';
export const reviewTarget = { repository: 'owner/repo', pullRequestNumber: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
export const reviewRow = (id = 1, patch: Record<string, unknown> = {}) => ({ id, user: { id, login: `reviewer-${id}` }, state: 'APPROVED', commit_id: reviewTarget.headSha, submitted_at: '2026-10-21T00:00:00Z', body: 'PRIVATE REVIEW TEXT', ...patch });
export const commentRow = (id = 1, patch: Record<string, unknown> = {}) => ({ id, user: { id, login: `commenter-${id}` }, pull_request_review_id: 1, commit_id: reviewTarget.headSha, updated_at: '2026-10-21T00:00:00Z', body: 'PRIVATE COMMENT TEXT', html_url: 'https://malicious.example/SECRET', ...patch });
export function reviewReaderFixture() {
  const data = { reviews: [reviewRow()], comments: [commentRow()], head: reviewTarget.headSha, base: reviewTarget.baseSha, baseRef: 'preview', defaultBranch: 'main', metadataRepository: 'owner/repo', number: 7, repository: 'owner/repo' };
  const paths: string[] = [];
  let beforeFetch: (() => void | Promise<void>) | undefined;
  const credential: GitHubCredential = { kind: 'app-installation', token: 'test-token', identity: { kind: 'app', installationId: 123 }, repository: 'owner/repo', permissions: { pull_requests: 'read' } };
  const provider = new GitHubRuntimeProvider({ credentials: { async getIdentity() { return { kind: 'app' }; }, async getCredential() { return credential; } },
    bindings: [{ id: 'owner/repo', repository: 'owner/repo', write: false }],
    fetch: async (input, init) => {
      const url = new URL(String(input)); paths.push(url.pathname + url.search); await beforeFetch?.();
      if ((init?.headers as Record<string, string>).Authorization !== 'Bearer test-token') throw new Error('Unexpected test authorization');
      if (url.pathname === '/repos/owner/repo') return new Response(JSON.stringify({ full_name: data.metadataRepository, default_branch: data.defaultBranch }), { status: 200 });
      const page = Number(url.searchParams.get('page') ?? 1);
      const collection = url.pathname.endsWith('/reviews') ? data.reviews : url.pathname.endsWith('/comments') ? data.comments : undefined;
      return new Response(JSON.stringify(collection ? collection.slice((page - 1) * 50, page * 50) : { number: data.number, head: { sha: data.head }, base: { sha: data.base, ref: data.baseRef, repo: { full_name: data.repository } } }), { status: 200 });
    },
  });
  return { provider, data, paths, credential, beforeFetch(fn?: () => void | Promise<void>) { beforeFetch = fn; }, read: (authorize: () => Promise<unknown> = async () => {}, branch: 'preview' | 'vercel-preview' = 'preview') => provider.getPullRequestReviewState(reviewTarget, 123, authorize, branch) };
}
