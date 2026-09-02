import type { TerminalSlice, TerminalStoreSet } from './terminal-state'

/**
 * Session-scoped record of PTY ids a reachable relay answered absent for.
 *
 * This is the renderer's only host-attested `exited` for an SSH PTY: main raises it solely on the
 * branch where the relay replied about that exact id, never on a lost link, a timeout or an
 * identity mismatch (docs/reference/ssh-execution-boundary.md). A reconnect may retire such a
 * binding; every other absence signal it holds is `unverifiable` and must not license a respawn.
 */
export function createTerminalHostAttestedPtyAbsenceActions(
  set: TerminalStoreSet
): Pick<TerminalSlice, 'markHostAttestedPtyAbsence'> {
  return {
    markHostAttestedPtyAbsence: (ptyId) => {
      set((state) =>
        state.hostAttestedAbsentPtyIds[ptyId]
          ? {}
          : { hostAttestedAbsentPtyIds: { ...state.hostAttestedAbsentPtyIds, [ptyId]: true } }
      )
    }
  }
}

/** Removes settled ids without allocating when none is recorded. */
export function omitHostAttestedAbsentPtyIds(
  records: Readonly<Record<string, true>>,
  ptyIds: Iterable<string>
): Record<string, true> {
  let next: Record<string, true> | null = null
  for (const ptyId of ptyIds) {
    if (!records[ptyId]) {
      continue
    }
    next ??= { ...records }
    delete next[ptyId]
  }
  return next ?? records
}

/**
 * True when a recorded id still names a PTY this client may reattach to.
 *
 * Why the record and not the id's shape: a relay renumbers from `pty-1` after a redeploy, so the id
 * alone cannot say which relay generation minted it. Only the host's own answer can.
 */
export function isPtyBindingStillAddressable(
  ptyId: string | null | undefined,
  hostAttestedAbsentPtyIds: Readonly<Record<string, true>> | undefined
): boolean {
  return Boolean(ptyId) && !hostAttestedAbsentPtyIds?.[ptyId as string]
}
