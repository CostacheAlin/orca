import { parseAgentHookJson } from './request-body'
import { readLastExtractedFromTranscriptOnce } from './transcript-reader'

/** Fields of one Claude Code transcript row that throughput measurement reads. */
export type ClaudeTranscriptThroughputRow = {
  type: string
  uuid: string | null
  parentUuid: string | null
  timestamp: number
  messageId: string | null
  model: string | null
  outputTokens: number
}

export type ClaudeMessageThroughput = {
  messageId: string
  model: string | null
  outputTokens: number
  generationMs: number
  completedAt: number
}

// Why: the parent row can sit behind unrelated rows (attachments, hook progress); bound the walk so
// a broken chain falls back to the nearest earlier row instead of scanning to the file start.
const PARENT_ROW_LOOKBACK_LIMIT = 64

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function readTimestamp(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }
  return typeof value === 'string' ? Date.parse(value) : Number.NaN
}

export function parseClaudeTranscriptThroughputRow(
  line: string
): ClaudeTranscriptThroughputRow | null {
  let entry: unknown
  try {
    entry = parseAgentHookJson(line)
  } catch {
    return null
  }
  const record = readObject(entry)
  if (!record) {
    return null
  }
  const type = readString(record, 'type')
  const timestamp = readTimestamp(record.timestamp)
  // Why: sidechain rows belong to a subagent's own parent chain, so they are neither a sample nor a start row.
  if (!type || !Number.isFinite(timestamp) || record.isSidechain === true) {
    return null
  }
  const message = readObject(record.message)
  const outputTokens = readObject(message?.usage)?.output_tokens
  return {
    type,
    uuid: readString(record, 'uuid'),
    parentUuid: readString(record, 'parentUuid'),
    timestamp,
    messageId: message ? readString(message, 'id') : null,
    model: message ? readString(message, 'model') : null,
    outputTokens:
      typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens > 0
        ? outputTokens
        : 0
  }
}

type PendingMessage = {
  messageId: string
  model: string | null
  outputTokens: number
  completedAt: number
  parentUuid: string | null
}

export type ClaudeMessageThroughputExtractor = {
  /** Visits transcript lines newest-first; yields once the newest message's start row is known. */
  visit: (line: string) => ClaudeMessageThroughput | undefined
  /** Resolves against the nearest earlier row when the scan ended before the parent row was seen. */
  flush: () => ClaudeMessageThroughput | undefined
}

export function createClaudeMessageThroughputExtractor(): ClaudeMessageThroughputExtractor {
  let pending: PendingMessage | null = null
  let nearestEarlierRowAt: number | null = null
  let rowsPastMessage = 0

  const finish = (startedAt: number | null): ClaudeMessageThroughput | undefined => {
    if (!pending || startedAt === null) {
      return undefined
    }
    const generationMs = pending.completedAt - startedAt
    if (!(generationMs > 0)) {
      return undefined
    }
    return {
      messageId: pending.messageId,
      model: pending.model,
      outputTokens: pending.outputTokens,
      generationMs,
      completedAt: pending.completedAt
    }
  }

  return {
    visit: (line) => {
      const row = parseClaudeTranscriptThroughputRow(line)
      if (!row) {
        return undefined
      }
      if (!pending) {
        // Why: rows without usage (API-error placeholders) carry no generation to measure; keep scanning.
        if (row.type !== 'assistant' || !row.messageId || row.outputTokens <= 0) {
          return undefined
        }
        pending = {
          messageId: row.messageId,
          model: row.model,
          outputTokens: row.outputTokens,
          completedAt: row.timestamp,
          parentUuid: row.parentUuid
        }
        return undefined
      }
      if (row.type === 'assistant' && row.messageId === pending.messageId) {
        // Why: Claude Code writes one row per content block; the earliest row's parent is the message's start.
        pending.parentUuid = row.parentUuid
        pending.outputTokens = Math.max(pending.outputTokens, row.outputTokens)
        pending.model ??= row.model
        return undefined
      }
      rowsPastMessage += 1
      if (row.uuid && row.uuid === pending.parentUuid) {
        return finish(row.timestamp)
      }
      nearestEarlierRowAt ??= row.timestamp
      return rowsPastMessage >= PARENT_ROW_LOOKBACK_LIMIT ? finish(nearestEarlierRowAt) : undefined
    },
    flush: () => finish(nearestEarlierRowAt)
  }
}

/** Throughput of the newest completed assistant message in a Claude Code transcript. */
export function readLastClaudeMessageThroughput(
  transcriptPath: string
): ClaudeMessageThroughput | undefined {
  const extractor = createClaudeMessageThroughputExtractor()
  return readLastExtractedFromTranscriptOnce(transcriptPath, extractor.visit) ?? extractor.flush()
}
