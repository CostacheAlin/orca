import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createClaudeMessageThroughputExtractor,
  parseClaudeTranscriptThroughputRow,
  readLastClaudeMessageThroughput
} from './agent-hook-listener/claude-transcript-throughput'

const BASE = Date.parse('2026-09-02T14:12:22.409Z')

function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString()
}

function assistantRow(args: {
  uuid: string
  parentUuid: string | null
  messageId: string
  offsetMs: number
  outputTokens?: number
  block?: string
  isSidechain?: boolean
}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: args.uuid,
    parentUuid: args.parentUuid,
    timestamp: at(args.offsetMs),
    isSidechain: args.isSidechain ?? false,
    message: {
      id: args.messageId,
      model: 'claude-fable-5-1',
      role: 'assistant',
      content: [{ type: args.block ?? 'text', text: 'hi' }],
      ...(args.outputTokens === undefined
        ? {}
        : { usage: { input_tokens: 101, output_tokens: args.outputTokens } })
    }
  })
}

function plainRow(type: string, uuid: string, parentUuid: string | null, offsetMs: number): string {
  return JSON.stringify({ type, uuid, parentUuid, timestamp: at(offsetMs) })
}

const tmpDirs: string[] = []

function writeTranscript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-claude-throughput-'))
  tmpDirs.push(dir)
  const transcriptPath = join(dir, 'transcript.jsonl')
  writeFileSync(transcriptPath, `${lines.join('\n')}\n`)
  return transcriptPath
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('claude transcript throughput', () => {
  it('measures the newest message from its parent row to its last content-block row', () => {
    const transcriptPath = writeTranscript([
      plainRow('user', 'u1', null, 0),
      plainRow('attachment', 'att1', 'u1', 10),
      assistantRow({
        uuid: 'a1',
        parentUuid: 'att1',
        messageId: 'msg_1',
        offsetMs: 32_000,
        outputTokens: 2497,
        block: 'thinking'
      }),
      assistantRow({
        uuid: 'a2',
        parentUuid: 'a1',
        messageId: 'msg_1',
        offsetMs: 36_483,
        outputTokens: 2497
      }),
      plainRow('system', 's1', 'a2', 36_760)
    ])

    expect(readLastClaudeMessageThroughput(transcriptPath)).toEqual({
      messageId: 'msg_1',
      model: 'claude-fable-5-1',
      outputTokens: 2497,
      generationMs: 36_473,
      completedAt: BASE + 36_483
    })
  })

  it('skips sidechain rows and usage-less rows when picking the newest message', () => {
    const transcriptPath = writeTranscript([
      plainRow('user', 'u1', null, 0),
      assistantRow({
        uuid: 'a1',
        parentUuid: 'u1',
        messageId: 'msg_1',
        offsetMs: 4_000,
        outputTokens: 120
      }),
      plainRow('user', 'u2', 'a1', 5_000),
      assistantRow({ uuid: 'a2', parentUuid: 'u2', messageId: 'msg_err', offsetMs: 6_000 }),
      assistantRow({
        uuid: 'side',
        parentUuid: 'elsewhere',
        messageId: 'msg_side',
        offsetMs: 7_000,
        outputTokens: 999,
        isSidechain: true
      })
    ])

    expect(readLastClaudeMessageThroughput(transcriptPath)).toMatchObject({
      messageId: 'msg_1',
      outputTokens: 120,
      generationMs: 4_000
    })
  })

  it('falls back to the nearest earlier row when the parent row never appears', () => {
    const transcriptPath = writeTranscript([
      plainRow('progress', 'p1', null, 1_000),
      assistantRow({
        uuid: 'a1',
        parentUuid: 'missing',
        messageId: 'msg_1',
        offsetMs: 3_500,
        outputTokens: 50
      })
    ])

    expect(readLastClaudeMessageThroughput(transcriptPath)).toMatchObject({
      messageId: 'msg_1',
      generationMs: 2_500
    })
  })

  it('bounds the parent search and uses the nearest earlier row past the limit', () => {
    const filler = Array.from({ length: 70 }, (_, index) =>
      plainRow('progress', `p${index}`, 'u1', 100 + index)
    )
    const transcriptPath = writeTranscript([
      plainRow('user', 'u1', null, 0),
      ...filler,
      assistantRow({
        uuid: 'a1',
        parentUuid: 'u1',
        messageId: 'msg_1',
        offsetMs: 2_000,
        outputTokens: 40
      })
    ])

    expect(readLastClaudeMessageThroughput(transcriptPath)).toMatchObject({
      messageId: 'msg_1',
      generationMs: 2_000 - 169
    })
  })

  it('returns undefined without a measurable message', () => {
    expect(readLastClaudeMessageThroughput(join(tmpdir(), 'orca-missing-transcript.jsonl'))).toBe(
      undefined
    )
    const noUsage = writeTranscript([
      plainRow('user', 'u1', null, 0),
      assistantRow({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', offsetMs: 500 })
    ])
    expect(readLastClaudeMessageThroughput(noUsage)).toBe(undefined)
    const sameInstant = writeTranscript([
      plainRow('user', 'u1', null, 0),
      assistantRow({
        uuid: 'a1',
        parentUuid: 'u1',
        messageId: 'msg_1',
        offsetMs: 0,
        outputTokens: 5
      })
    ])
    expect(readLastClaudeMessageThroughput(sameInstant)).toBe(undefined)
    expect(createClaudeMessageThroughputExtractor().flush()).toBe(undefined)
  })

  it('parses rows defensively', () => {
    expect(parseClaudeTranscriptThroughputRow('not json')).toBe(null)
    expect(parseClaudeTranscriptThroughputRow(JSON.stringify({ type: 'user' }))).toBe(null)
    expect(
      parseClaudeTranscriptThroughputRow(
        JSON.stringify({
          type: 'assistant',
          timestamp: at(1_500),
          message: { id: 'msg_1', usage: { output_tokens: 'many' } }
        })
      )
    ).toEqual({
      type: 'assistant',
      uuid: null,
      parentUuid: null,
      timestamp: BASE + 1_500,
      messageId: 'msg_1',
      model: null,
      outputTokens: 0
    })
  })
})
