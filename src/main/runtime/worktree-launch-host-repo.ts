import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'

export type LaunchHostRepo = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>

export type WorktreeLaunchHostResolution<T extends LaunchHostRepo> =
  | { kind: 'resolved'; repo: T | null; connectionId: string | null }
  | { kind: 'ambiguous' }

/**
 * Pick the repo row that owns a worktree's execution, and read the SSH connection off the
 * resolved host rather than off whichever row an id-only lookup happened to return.
 *
 * The same repo id can exist on local, SSH and runtime hosts at once — `setResolvedRepoGitUsername`
 * already refuses id-only lookups for that reason. A host-blind `getRepo(id)` can hand a remote
 * worktree the local row, whose `connectionId` reads `null`, and the PTY then spawns on the client
 * with the remote cwd (#11163). Conflicting rows with nothing to disambiguate them resolve
 * `ambiguous`, never "local".
 */
export function resolveWorktreeLaunchHost<T extends LaunchHostRepo>(
  repos: readonly T[],
  worktree: { repoId: string; hostId?: ExecutionHostId | null }
): WorktreeLaunchHostResolution<T> {
  const rows = repos.filter((repo) => repo.id === worktree.repoId)
  const worktreeHostId = normalizeExecutionHostId(worktree.hostId)
  if (worktreeHostId) {
    // The worktree names its own host, which outranks the repo fallback.
    const match = rows.find((repo) => getRepoExecutionHostId(repo) === worktreeHostId)
    return {
      kind: 'resolved',
      repo: match ?? (rows.length === 1 ? (rows[0] ?? null) : null),
      connectionId: getSshTargetIdForExecutionHost(worktreeHostId)
    }
  }
  if (rows.length === 0) {
    return { kind: 'resolved', repo: null, connectionId: null }
  }
  const hostIds = new Set<ExecutionHostId>(rows.map((repo) => getRepoExecutionHostId(repo)))
  if (hostIds.size > 1) {
    return { kind: 'ambiguous' }
  }
  const hostId = [...hostIds][0] ?? LOCAL_EXECUTION_HOST_ID
  return {
    kind: 'resolved',
    repo: rows[0] ?? null,
    connectionId: getSshTargetIdForExecutionHost(hostId)
  }
}
