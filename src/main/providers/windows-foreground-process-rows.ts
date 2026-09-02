import { collectProcessTreeDescendants } from '../../shared/process-table-snapshot'
import {
  readWindowsProcessTable,
  readWindowsProcessTableFresh,
  resetWindowsProcessTableForTests,
  type WindowsProcessRow as NativeWindowsProcessRow
} from '../windows/windows-process-table'

export type WindowsProcessRow = {
  pid: number
  ppid: number
  name: string
  command: string
}

export type WindowsProcessCandidate = WindowsProcessRow & { depth: number }

function toProcessRow(row: NativeWindowsProcessRow): WindowsProcessRow {
  return {
    pid: row.pid,
    ppid: row.ppid,
    name: row.name,
    // Why fall back to the image name: a process that denied a query handle has
    // no command line, and callers match on `command` first.
    command: row.command || row.name
  }
}

type WindowsProcessTableIndex = {
  rows: readonly WindowsProcessRow[]
  byPid: ReadonlyMap<number, WindowsProcessRow>
  childrenByPpid: ReadonlyMap<number, readonly WindowsProcessRow[]>
}

const windowsProcessTableIndexes = new WeakMap<
  readonly NativeWindowsProcessRow[],
  WindowsProcessTableIndex
>()

/**
 * Project and index one native capture once, keyed weakly by the capture so the
 * index dies with it. Every agent pane inspects on its own cadence but shares
 * the TTL-cached table underneath, and each used to re-allocate the whole
 * projection plus a parent map before finding its own root.
 *
 * Rows are shared, so treat them as read-only.
 */
function indexWindowsProcessTable(
  native: readonly NativeWindowsProcessRow[]
): WindowsProcessTableIndex {
  const cached = windowsProcessTableIndexes.get(native)
  if (cached) {
    return cached
  }
  const rows: WindowsProcessRow[] = []
  const byPid = new Map<number, WindowsProcessRow>()
  const childrenByPpid = new Map<number, WindowsProcessRow[]>()
  for (const nativeRow of native) {
    const row = toProcessRow(nativeRow)
    rows.push(row)
    // Preserve rows.find() semantics if a malformed table repeats a pid.
    if (!byPid.has(row.pid)) {
      byPid.set(row.pid, row)
    }
    const children = childrenByPpid.get(row.ppid) ?? []
    children.push(row)
    childrenByPpid.set(row.ppid, children)
  }
  const index: WindowsProcessTableIndex = { rows, byPid, childrenByPpid }
  windowsProcessTableIndexes.set(native, index)
  return index
}

/**
 * Rows from a scan that starts after this call.
 *
 * PID-identity checks in teardown must not reuse a cached row — it can predate
 * the very recycle it is meant to detect. Rejects when the table is unreadable,
 * so "unavailable" stays distinguishable from "nothing is running".
 */
export async function queryWindowsProcessRowsFresh(): Promise<readonly WindowsProcessRow[]> {
  return indexWindowsProcessTable(await readWindowsProcessTableFresh()).rows
}

export async function queryWindowsProcessDescendants(
  rootPid: number,
  options: { fresh?: boolean } = {}
): Promise<WindowsProcessCandidate[] | null> {
  return (await queryWindowsPaneProcessInventory(rootPid, options))?.candidates ?? null
}

export type WindowsPaneProcessInventory = {
  candidates: WindowsProcessCandidate[]
  /**
   * Full-table row for `anchorPid`. From the whole snapshot, not the ppid
   * projection: a pane-job member whose creator exited is orphaned out of the
   * descendant walk yet can still hold a recycled anchor pid.
   */
  anchorRow: WindowsProcessRow | null
}

export async function queryWindowsPaneProcessInventory(
  rootPid: number,
  options: { fresh?: boolean; anchorPid?: number } = {}
): Promise<WindowsPaneProcessInventory | null> {
  let index: WindowsProcessTableIndex
  try {
    index = indexWindowsProcessTable(
      options.fresh === true
        ? await readWindowsProcessTableFresh()
        : await readWindowsProcessTable()
    )
  } catch {
    return null
  }
  // Why: a snapshot that omitted the PTY root may be stale or permission-
  // filtered; only an observed root can authoritatively have no descendants.
  if (!index.byPid.has(rootPid)) {
    return null
  }
  return {
    candidates: collectProcessTreeDescendants(index, rootPid).sort((a, b) => b.depth - a.depth),
    anchorRow: options.anchorPid !== undefined ? (index.byPid.get(options.anchorPid) ?? null) : null
  }
}

/** Test-only: clear the shared snapshot so one case's rows never serve the next. */
export function resetWindowsProcessRowsSnapshotForTests(): void {
  resetWindowsProcessTableForTests()
}
