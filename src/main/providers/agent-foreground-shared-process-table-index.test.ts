import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('child_process', () => ({ execFile: execFileMock }))

import {
  collectProcessTreeDescendants,
  getProcessTableIndex,
  getProcessTableSnapshot,
  parseProcessTableRows,
  resetProcessTableSnapshotForTests,
  type ProcessTableRow
} from '../../shared/process-table-snapshot'
import { resolveAgentForegroundProcess } from './agent-foreground-process'

/**
 * The shape this change replaced: every pane rebuilt a parent map over the
 * whole table and linearly scanned it for its own root. Kept as the oracle so
 * the new index has to return byte-identical rows, in the same order.
 */
function collectDescendantsPerCall(
  rows: readonly ProcessTableRow[],
  rootPid: number
): (ProcessTableRow & { depth: number })[] {
  const childrenByParent = new Map<number, ProcessTableRow[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row)
    childrenByParent.set(row.ppid, children)
  }
  const descendants: (ProcessTableRow & { depth: number })[] = []
  const stack = (childrenByParent.get(rootPid) ?? []).map((row) => ({
    row,
    depth: 1
  }))
  while (stack.length > 0) {
    const { row, depth } = stack.pop()!
    descendants.push({ ...row, depth })
    for (const child of childrenByParent.get(row.pid) ?? []) {
      stack.push({ row: child, depth: depth + 1 })
    }
  }
  return descendants
}

/** Counts every whole-table traversal, however it is spelled. */
const WHOLE_TABLE_WALKS = new Set<string | symbol>([
  Symbol.iterator,
  'find',
  'some',
  'filter',
  'map',
  'forEach',
  'reduce'
])

function countingTable(rows: ProcessTableRow[]): {
  rows: ProcessTableRow[]
  walks: () => number
} {
  let walks = 0
  const proxy = new Proxy(rows, {
    get(target, property, receiver) {
      if (WHOLE_TABLE_WALKS.has(property)) {
        walks += 1
      }
      return Reflect.get(target, property, receiver) as unknown
    }
  })
  return { rows: proxy, walks: () => walks }
}

/** 15 shell panes, each with an agent child, plus unrelated system processes. */
function buildFleetTable(paneCount: number): string {
  const lines = ['1 0 Ss /sbin/launchd', '50 1 Ss /usr/libexec/loginwindow']
  for (let pane = 0; pane < paneCount; pane += 1) {
    const shellPid = 1000 + pane * 10
    lines.push(`${shellPid} 1 Ss /bin/zsh`)
    lines.push(`${shellPid + 1} ${shellPid} S+ node /Users/dev/.local/bin/claude`)
    lines.push(`${shellPid + 2} ${shellPid + 1} S+ /usr/bin/rg --files`)
  }
  for (let filler = 0; filler < 200; filler += 1) {
    lines.push(`${90000 + filler} 1 S /usr/sbin/filler${filler}`)
  }
  return lines.join('\n')
}

const PANE_COUNT = 15
const PANE_PIDS = Array.from({ length: PANE_COUNT }, (_, pane) => 1000 + pane * 10)

describe('shared process-table index across agent panes', () => {
  it('walks one capture once for a whole fleet instead of once per pane', () => {
    const parsed = parseProcessTableRows(buildFleetTable(PANE_COUNT))

    const perCall = countingTable(parsed.slice())
    for (const shellPid of PANE_PIDS) {
      perCall.rows.find((row) => row.pid === shellPid)
      collectDescendantsPerCall(perCall.rows, shellPid)
    }

    const shared = countingTable(parsed.slice())
    for (const shellPid of PANE_PIDS) {
      const index = getProcessTableIndex(shared.rows)
      index.byPid.get(shellPid)
      collectProcessTreeDescendants(index, shellPid)
    }

    // Two walks per pane before (the `find` plus the parent-map build), one for
    // the whole capture after, no matter how many panes share it.
    expect(perCall.walks()).toBe(PANE_COUNT * 2)
    expect(shared.walks()).toBe(1)
  })

  it('returns the same descendants, in the same order, as the per-call walk', () => {
    const rows = parseProcessTableRows(
      [
        buildFleetTable(3),
        // An orphan and a repeated pid: malformed shapes a real table can carry.
        // (A ppid cycle hangs both walks identically and is out of scope here.)
        '7000 6999 S orphaned-child',
        '1001 1000 S duplicate-pid-row'
      ].join('\n')
    )
    const index = getProcessTableIndex(rows)

    for (const rootPid of [...PANE_PIDS.slice(0, 3), 1, 1001, 6999, 424242]) {
      expect(collectProcessTreeDescendants(index, rootPid)).toEqual(
        collectDescendantsPerCall(rows, rootPid)
      )
    }
  })
})

describe('agent foreground resolution over a shared capture', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
  })

  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('answers every pane identically off a single ps capture', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: unknown) => {
        ;(callback as (err: unknown, out: { stdout: string; stderr: string }) => void)(null, {
          stdout: buildFleetTable(PANE_COUNT),
          stderr: ''
        })
      }
    )

    const resolved = await Promise.all(
      PANE_PIDS.map((shellPid) => resolveAgentForegroundProcess(shellPid, 'zsh'))
    )

    expect(resolved).toEqual(Array.from({ length: PANE_COUNT }, () => 'claude'))
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  // Red/green for the wiring itself: poison the capture's shared index and the
  // resolver must see the poisoned view. A resolver that rebuilt its own parent
  // map per pane would still answer 'claude' here.
  it('resolves off the capture-scoped index rather than rebuilding one per pane', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: unknown) => {
        ;(callback as (err: unknown, out: { stdout: string; stderr: string }) => void)(null, {
          stdout: buildFleetTable(1),
          stderr: ''
        })
      }
    )

    const rows = await getProcessTableSnapshot()
    const index = getProcessTableIndex(rows)
    expect(await resolveAgentForegroundProcess(1000, 'zsh')).toBe('claude')
    ;(index.childrenByPpid as Map<number, ProcessTableRow[]>).delete(1000)

    expect(await resolveAgentForegroundProcess(1000, 'zsh')).toBe('zsh')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })
})
