import type { DirectSshAuthority } from '../../../shared/ssh-types'
import type { RemoteWorkspaceObservedSnapshot } from '../../../shared/remote-workspace-types'
import { directSshAuthoritiesEqual } from './direct-ssh-reconnect-tokens'
import {
  waitForSnapshotWorktreePlacement,
  type RemoteWorkspaceSnapshotPlacementStore
} from './remote-workspace-snapshot-placement'

/** How long a conflicted target keeps watching the catalog for the rows it could not place. The
 *  catalog for a remote host often only fills in when the user opens the worktree, which is minutes
 *  after connect, and `conflict` has no other exit: it suppresses uploads and holds terminal
 *  authority at `unverifiable` until a reconnect or an unsolicited host push happens to arrive. */
const DEFERRED_SNAPSHOT_PLACEMENT_TIMEOUT_MS = 600_000

export type DeferredSnapshotPlacementRetryDeps = {
  store: RemoteWorkspaceSnapshotPlacementStore
  getCurrentAuthority: (targetId: string) => DirectSshAuthority | null
  getSnapshot: (targetId: string) => Promise<RemoteWorkspaceObservedSnapshot | null>
  applySnapshot: (targetId: string, snapshot: RemoteWorkspaceObservedSnapshot) => Promise<void>
}

export type DeferredSnapshotPlacementRetries = {
  /** Empty `worktreePaths` retires the target's outstanding watch instead of arming one. */
  watch: (authority: DirectSshAuthority, worktreePaths: readonly string[]) => void
  stop: () => void
}

/**
 * Re-pull once the local catalog can place the host paths an apply had to drop.
 *
 * Why a fresh pull rather than replaying the snapshot already held: that snapshot is only evidence
 * of what the host had when it was taken. The host owns execution state, so the answer acted on has
 * to be its current one — see docs/reference/ssh-execution-boundary.md. A pull that comes back
 * empty or fails is left alone: it is `unverifiable`, and moving the target off `conflict` on it
 * would re-authorise uploads and sleeping-agent resume from a picture known to be incomplete.
 */
export function createDeferredSnapshotPlacementRetries(
  deps: DeferredSnapshotPlacementRetryDeps
): DeferredSnapshotPlacementRetries {
  const watchers = new Map<string, AbortController>()
  let stopped = false

  const watch = (authority: DirectSshAuthority, worktreePaths: readonly string[]): void => {
    // Always retire the previous watch: an apply that placed everything passes no paths, and that
    // is exactly when the outstanding watch is obsolete.
    watchers.get(authority.targetId)?.abort()
    watchers.delete(authority.targetId)
    if (stopped || worktreePaths.length === 0) {
      return
    }
    const controller = new AbortController()
    watchers.set(authority.targetId, controller)
    const isCurrent = (): boolean =>
      !stopped &&
      watchers.get(authority.targetId) === controller &&
      directSshAuthoritiesEqual(deps.getCurrentAuthority(authority.targetId), authority)
    void (async () => {
      try {
        const placed = await waitForSnapshotWorktreePlacement(
          deps.store,
          authority,
          worktreePaths,
          isCurrent,
          controller.signal,
          DEFERRED_SNAPSHOT_PLACEMENT_TIMEOUT_MS
        )
        if (!placed || !isCurrent()) {
          return
        }
        const snapshot = await deps.getSnapshot(authority.targetId)
        if (!snapshot || snapshot.revision <= 0 || !isCurrent()) {
          return
        }
        await deps.applySnapshot(authority.targetId, snapshot)
      } finally {
        if (watchers.get(authority.targetId) === controller) {
          watchers.delete(authority.targetId)
        }
      }
    })()
  }

  return {
    watch,
    stop: () => {
      stopped = true
      for (const controller of watchers.values()) {
        controller.abort()
      }
      watchers.clear()
    }
  }
}
