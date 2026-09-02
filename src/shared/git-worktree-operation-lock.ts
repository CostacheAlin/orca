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
  // Async so a hung filesystem cannot freeze the main-process event loop.
  const key = await Promise.resolve()
    .then(() => realpath(worktreePath))
    .then((canonicalPath) => canonicalPath ?? fallbackKey)
    .catch(() => fallbackKey)
  return runWithGitOperationLock(key, signal, run)
}
