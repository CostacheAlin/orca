import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess,
  recognizeAgentProcessFromCommandLine
} from '../../shared/agent-process-recognition'
import { getFirstCommandToken } from '../../shared/command-token-scanner'
import { resolveOuterWrapperForegroundProcess } from '../../shared/foreground-wrapper-agent'
import type { ForegroundProcessEvidence } from '../../shared/foreground-process-evidence'
import type {
  PosixFence,
  RemoteForegroundEvidence,
  WindowsFence
} from '../../shared/foreground-process-evidence'
import {
  buildProcessTableIndex,
  getStrictProcessTableSnapshot,
  lookupProcessTableIndex,
  scoreForegroundCandidateRow,
  type ProcessTableIndex,
  type ProcessTableIndexStats,
  type ProcessTableRow
} from '../../shared/process-table-snapshot'

export type BatchedForegroundProcessRequest = {
  rootPid: number
  fallbackProcess?: string | null
}

export type BatchedForegroundProcessResult = {
  available: boolean
  processName: string | null
  reason?: string
}

export type RemoteForegroundEvidenceOptions = {
  ptyId: string
  ptyIncarnationId: string
  authorityGeneration: string
  observationEpoch: number
  capturedAgeMs: number
  platform?: NodeJS.Platform
}

/** Resolve a host-stamped, fenced observation from one complete process-table capture. */
export function resolveRemoteForegroundEvidence(
  request: BatchedForegroundProcessRequest,
  options: RemoteForegroundEvidenceOptions,
  rows: readonly ProcessTableRow[]
): RemoteForegroundEvidence {
  const metadata = {
    authorityGeneration: options.authorityGeneration,
    observationEpoch: options.observationEpoch,
    capturedAgeMs: options.capturedAgeMs,
    ptyId: options.ptyId,
    ptyIncarnationId: options.ptyIncarnationId
  }
  if (!options.ptyIncarnationId || !options.ptyId || rows.length === 0) {
    return { ...metadata, verdict: 'unverifiable', reason: 'process_table_unreadable' }
  }
  if (options.platform === 'win32') {
    // Why SSH-to-Windows is always unverifiable: POSIX has a real foreground primitive
    // (the controlling terminal's foreground process group, tpgid/pgid), so the host can
    // read which process is in front. Windows has no equivalent. Local Windows approximates
    // it by reading the native process table and walking descendants of the PTY root pid
    // (windows-foreground-process-rows.ts), but the relay has neither piece: it does not
    // import windows-process-table, its getForegroundProcessName is POSIX-shaped
    // (/proc, pgrep, lsof), and relay hosts run stock node-pty, so no ConPTY job/console
    // association is available. Returning a descendant name without a creation-time and
    // session fence would be a guess. Lifting this requires teaching the relay the Windows
    // process table plus a measured creation-time/session fence - a separate change.
    const fence: WindowsFence = {
      platform: 'windows',
      rootProcessId: request.rootPid,
      rootCreationTime: 'unavailable',
      sessionId: 'unavailable'
    }
    void fence
    return { ...metadata, verdict: 'unverifiable', reason: 'windows_ssh_foreground_unavailable' }
  }
  const root = rows.find((row) => row.pid === request.rootPid)
  if (!root || root.pgid === undefined || root.tpgid === undefined) {
    return { ...metadata, verdict: 'unverifiable', reason: 'anchor_missing' }
  }
  if (!root.tty || root.tty === '?' || root.tpgid <= 0 || !root.startTime) {
    return { ...metadata, verdict: 'unverifiable', reason: 'fence_incomplete' }
  }
  const index = buildProcessTableIndex(rows)
  const resolved = resolveAgentForegroundProcessesFromIndex(index, [request])[0]
  if (!resolved?.available) {
    return {
      ...metadata,
      verdict: 'unverifiable',
      reason: resolved?.reason ?? 'capture_incomplete'
    }
  }
  const descendants = collectDescendantRows(index, root.pid)
  // A child that owns another terminal/session is outside this PTY's
  // authority. Do not silently treat it as an idle shell.
  if (descendants.some((row) => row.tty !== undefined && row.tty !== '?' && row.tty !== root.tty)) {
    return { ...metadata, verdict: 'unverifiable', reason: 'tty_boundary' }
  }
  // Multiplexers can make a descendant appear foreground while the user is
  // actually interacting with another session. This relay has no measured
  // multiplexer/session fence, so remain conservative for the whole subtree.
  if ([root, ...descendants].some((row) => /(?:^|\s)(?:tmux|screen)(?:\s|$)/i.test(row.command))) {
    return { ...metadata, verdict: 'unverifiable', reason: 'multiplexer_boundary' }
  }
  if (
    descendants.some((row) => row.pgid === root.tpgid && (row.tty === undefined || row.tty === '?'))
  ) {
    return { ...metadata, verdict: 'unverifiable', reason: 'fence_incomplete' }
  }
  const foreground = descendants.filter((row) => row.pgid === root.tpgid && row.tty === root.tty)
  const recognized = foreground
    .map((row) => ({ row, name: recognizeAgentProcessFromCommandLine(row.command) }))
    .filter(
      (
        entry
      ): entry is {
        row: ProcessTableRow
        name: NonNullable<ReturnType<typeof recognizeAgentProcessFromCommandLine>>
      } => Boolean(entry.name)
    )
  if (recognized.length > 1) {
    return { ...metadata, verdict: 'unverifiable', reason: 'ambiguous_foreground_group' }
  }
  const candidate = recognized[0]
  const fence: PosixFence = {
    platform: 'posix',
    shellPid: root.pid,
    shellStartTime: root.startTime,
    tty: root.tty,
    foregroundPgid: root.tpgid,
    ...(candidate?.row.startTime
      ? { process: { pid: candidate.row.pid, startTime: candidate.row.startTime } }
      : {})
  }
  if (candidate && !candidate.row.startTime) {
    return { ...metadata, verdict: 'unverifiable', reason: 'candidate_start_time_missing' }
  }
  return {
    ...metadata,
    verdict: 'live',
    processName: candidate?.name.processName ?? null,
    fence
  }
}

function collectDescendantRows(index: ProcessTableIndex, rootPid: number): ProcessTableRow[] {
  const result: ProcessTableRow[] = []
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length) {
    const pid = queue.shift()!
    for (const child of index.childrenByPpid.get(pid) ?? []) {
      if (seen.has(child.pid)) {
        continue
      }
      seen.add(child.pid)
      result.push(child)
      queue.push(child.pid)
    }
  }
  return result
}

export type BatchedForegroundProcessOptions = {
  rows?: readonly ProcessTableRow[]
  readRows?: () => Promise<readonly ProcessTableRow[]>
  stats?: ProcessTableIndexStats
}

export async function resolveAgentForegroundProcessesBatch(
  requests: readonly BatchedForegroundProcessRequest[],
  options: BatchedForegroundProcessOptions = {}
): Promise<BatchedForegroundProcessResult[]> {
  let rows = options.rows
  if (!rows) {
    if (options.stats) {
      options.stats.captures = (options.stats.captures ?? 0) + 1
    }
    rows = await (options.readRows?.() ?? getStrictProcessTableSnapshot())
  }
  const index = buildProcessTableIndex(rows, options.stats)
  return resolveAgentForegroundProcessesFromIndex(index, requests)
}

export function resolveAgentForegroundProcessesFromIndex(
  index: ProcessTableIndex,
  requests: readonly BatchedForegroundProcessRequest[]
): BatchedForegroundProcessResult[] {
  const uniqueRoots = new Set<number>()
  for (const request of requests) {
    uniqueRoots.add(request.rootPid)
  }
  const rootsByPid = new Set(uniqueRoots)
  const depthByPid = new Map<number, number>()
  const rowsByOwner = new Map<number, (ProcessTableRow & { depth: number })[]>()
  const queue: { row: ProcessTableRow; owner: number; depth: number }[] = []
  for (const rootPid of uniqueRoots) {
    const root = lookupProcessTableIndex(index, (value) => value.byPid.get(rootPid))
    if (root) {
      depthByPid.set(root.pid, 0)
      queue.push({ row: root, owner: root.pid, depth: 0 })
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    const owned = rowsByOwner.get(current.owner) ?? []
    if (current.depth > 0) {
      owned.push({ ...current.row, depth: current.depth })
    }
    rowsByOwner.set(current.owner, owned)
    const children = lookupProcessTableIndex(
      index,
      (value) => value.childrenByPpid.get(current.row.pid) ?? []
    )
    for (const child of children) {
      const childOwner = rootsByPid.has(child.pid) ? child.pid : current.owner
      const childDepth = rootsByPid.has(child.pid) ? 0 : current.depth + 1
      const priorDepth = depthByPid.get(child.pid)
      if (priorDepth !== undefined && priorDepth <= childDepth) {
        continue
      }
      depthByPid.set(child.pid, childDepth)
      queue.push({ row: child, owner: childOwner, depth: childDepth })
    }
  }

  return requests.map((request) => {
    const root = lookupProcessTableIndex(index, (value) => value.byPid.get(request.rootPid))
    if (!root) {
      return {
        available: false,
        processName: request.fallbackProcess ?? null,
        reason: 'root_missing'
      }
    }
    if (root.pgid === undefined || root.tpgid === undefined) {
      return {
        available: false,
        processName: request.fallbackProcess ?? null,
        reason: 'correlation_unavailable'
      }
    }
    if (root.tpgid === 0 || root.tpgid === -1) {
      return {
        available: false,
        processName: request.fallbackProcess ?? null,
        reason: 'no_controlling_tty'
      }
    }
    const allCandidates = rowsByOwner.get(root.pid) ?? []
    const foregroundCandidates = allCandidates.filter((row) => row.pgid === root.tpgid)
    const fallbackProcess = request.fallbackProcess
    const wrapperFallback =
      typeof fallbackProcess === 'string' && isAgentForegroundWrapperProcess(fallbackProcess)
    const candidates = wrapperFallback
      ? foregroundCandidates.filter((candidate) =>
          isExpectedAgentProcess(getFirstCommandToken(candidate.command), fallbackProcess)
        )
      : foregroundCandidates
    if (wrapperFallback && candidates.length !== 1) {
      return { available: true, processName: null }
    }
    let bestCandidate: (ProcessTableRow & { depth: number }) | null = null
    let bestName: ReturnType<typeof recognizeAgentProcessFromCommandLine> = null
    for (const candidate of candidates) {
      const recognized = recognizeAgentProcessFromCommandLine(candidate.command)
      if (
        recognized &&
        (bestCandidate === null ||
          scoreForegroundCandidateRow(candidate) > scoreForegroundCandidateRow(bestCandidate))
      ) {
        bestCandidate = candidate
        bestName = recognized
      }
    }
    if (bestCandidate && bestName) {
      return {
        available: true,
        processName: resolveOuterWrapperForegroundProcess(bestName, bestCandidate, allCandidates)
      }
    }
    return { available: true, processName: null }
  })
}

export function toForegroundProcessEvidence(
  result: BatchedForegroundProcessResult,
  metadata: { authorityGeneration: string; observationEpoch: number; capturedAgeMs: number }
): ForegroundProcessEvidence {
  return result.available
    ? { ...metadata, verdict: 'live', processName: result.processName }
    : {
        ...metadata,
        verdict: 'unverifiable',
        reason: result.reason ?? 'correlation_unavailable'
      }
}
