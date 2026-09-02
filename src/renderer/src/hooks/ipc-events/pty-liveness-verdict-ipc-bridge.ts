import { useAppStore } from '../../store'

/**
 * Records the owning host's own verdict about a PTY, independently of whether a pane is attached.
 *
 * Why not the pane's exit handler: the relay proves a PTY absent while the client is still
 * reconnecting, before any pane has remounted to hear it, and a parked or hidden pane has no
 * handler registered at all — that exit reaches the pre-handler buffer and nothing else. The
 * reconnect gate reads the store, so the verdict has to land there.
 *
 * Only `exited` is ever carried: main sets it solely on the branch where a reachable relay answered
 * for that exact id and reported it absent. A lost link, a timeout and an identity mismatch send no
 * exit at all, so absence of the field is never read as absence of the PTY
 * (docs/reference/ssh-execution-boundary.md).
 */
export function registerPtyLivenessVerdictIpcBridge(unsubs: (() => void)[]): void {
  const unsubscribe = window.api.pty?.onExit?.((payload) => {
    if (payload.livenessVerdict !== 'exited') {
      return
    }
    useAppStore.getState().markHostAttestedPtyAbsence(payload.id)
  })
  if (unsubscribe) {
    unsubs.push(unsubscribe)
  }
}
