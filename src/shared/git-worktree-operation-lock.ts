import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runWithGitOperationLock } from './git-operation-lock'

/** Serialize mutations that leave per-worktree state in progress (for example, rebase). */
export async function runWithGitWorktreeOperationLock<T>(
  worktreePath: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  const fallbackKey = resolve(worktreePath)
  let key = fallbackKey
  try {
    const canonicalPath = await realpath(worktreePath)
    if (canonicalPath) {
      key = canonicalPath
    }
  } catch {
    // A missing or temporarily unreachable worktree still gets serialized.
  }
  return runWithGitOperationLock(key, signal, run)
}
