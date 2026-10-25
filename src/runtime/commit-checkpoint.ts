import { ConductorToolError } from './errors.js';

export const COMMIT_PHASES = ['validated', 'tree-created', 'commit-created', 'ref-update-requested', 'ref-confirmed'] as const;

/** Recovery identities only. Never persist commit messages, source or credentials. */
export interface CommitCheckpoint {
  kind: 'git-commit';
  phase: typeof COMMIT_PHASES[number];
  repository: string;
  branch: string;
  expectedHeadSha: string;
  parentTreeSha?: string;
  treeSha?: string;
  candidateCommitSha?: string;
}

export interface CommitMutationProgress {
  checkpoint(value: CommitCheckpoint): Promise<void>;
}

export function assertCommitCheckpoint(value: CommitCheckpoint, previous?: CommitCheckpoint): void {
  const allowed = new Set(['kind', 'phase', 'repository', 'branch', 'expectedHeadSha', 'parentTreeSha', 'treeSha', 'candidateCommitSha']);
  const rank = COMMIT_PHASES.indexOf(value.phase);
  const invalid = value.kind !== 'git-commit' || rank < 0
    || Object.keys(value).some((key) => !allowed.has(key))
    || typeof value.repository !== 'string' || value.repository.length > 256
    || !/^[^/\s]+\/[^/\s]+$/u.test(value.repository)
    || typeof value.branch !== 'string' || value.branch.length > 255
    || !/^work\/[A-Za-z0-9._/-]+$/u.test(value.branch) || value.branch.includes('..') || value.branch.endsWith('/')
    || !/^[0-9a-f]{40}$/iu.test(value.expectedHeadSha)
    || ['parentTreeSha', 'treeSha', 'candidateCommitSha'].some((key) => {
      const sha = value[key as keyof CommitCheckpoint];
      return sha !== undefined && !/^[0-9a-f]{40}$/iu.test(sha);
    })
    || (rank >= 1 && (!value.parentTreeSha || !value.treeSha))
    || (rank >= 2 && !value.candidateCommitSha)
    || (previous && (rank < COMMIT_PHASES.indexOf(previous.phase)
      || Object.entries(previous).some(([key, entry]) => key !== 'phase' && value[key as keyof CommitCheckpoint] !== entry)));
  if (invalid) throw new ConductorToolError({ code: 'CONFLICT', message: 'Invalid or non-monotonic commit checkpoint', source: 'idempotency' });
}
