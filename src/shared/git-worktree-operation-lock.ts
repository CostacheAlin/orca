import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runWithGitOperationLock } from './git-operation-lock'

/** Serialize mutations that leave per-worktree state in progress (for example, rebase). */
export async function runWithGitWorktreeOperationLock<T>(
  worktreePath: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  // Async so a hung filesystem cannot freeze the main-process event loop; the
  // extra yield is harmless because reads never take this lock and the lane
  // chain serializes mutations whatever order they acquire it in.
  const key = await realpath(worktreePath).catch(() => resolve(worktreePath))
  return runWithGitOperationLock(key, signal, run)
}
