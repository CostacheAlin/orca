import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { runWithGitOperationLock } from './git-operation-lock'

/** Serialize mutations that leave per-worktree state in progress (for example, rebase). */
export async function runWithGitWorktreeOperationLock<T>(
  worktreePath: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  const fallbackKey = resolve(worktreePath)
  // Resolve synchronously so the mutation lane is acquired before another
  // read/mutation can observe the invalidation. Staging is user-triggered and
  // this single path lookup is negligible beside the Git subprocess.
  try {
    return runWithGitOperationLock(realpathSync(worktreePath), signal, run)
  } catch {
    return runWithGitOperationLock(fallbackKey, signal, run)
  }
}
