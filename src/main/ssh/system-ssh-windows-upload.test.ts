/**
 * #16432: the Windows relay upload sent the whole bundle as one ~1.9MB JSON string into
 * `[Console]::In.ReadToEnd()`. Windows PowerShell 5.1 cannot read stdin that large over a non-pty
 * ssh exec, so the remote blocks forever — and `waitForChannelClose()` had no timeout, so the UI
 * sat at "Connecting…" with no error. Both halves are covered here: the payload is no longer one
 * frame, and a remote that never closes now fails instead of hanging.
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnSystemSshCommandMock } = vi.hoisted(() => ({
  spawnSystemSshCommandMock: vi.fn()
}))

vi.mock('./system-ssh-command', () => ({
  spawnSystemSshCommand: spawnSystemSshCommandMock
}))

import { uploadDirectoryViaSystemSsh } from './system-ssh-file-transfer'
import { WINDOWS_STDIN_WRITE_CHUNK_BYTES } from './system-ssh-file-binary-transfer'
import { waitForChannelClose } from './system-ssh-operation-lifecycle'
import type { SshTarget } from '../../shared/ssh-types'

type FakeChannel = EventEmitter & {
  stdin: Writable
  stderr: PassThrough
  close: () => void
  written: Buffer
}

const target = { id: 'win-1', host: 'win.example', username: 'dev' } as unknown as SshTarget

/** Recover the script from `powershell.exe ... -EncodedCommand <base64 utf-16le>`. */
function decodePowerShellCommand(command: string): string {
  const encoded = /-EncodedCommand (\S+)/.exec(command)?.[1]
  return encoded === undefined ? command : Buffer.from(encoded, 'base64').toString('utf16le')
}

function createFakeChannel(onEnd: (channel: FakeChannel) => void): FakeChannel {
  const channel = new EventEmitter() as FakeChannel
  channel.written = Buffer.alloc(0)
  channel.stderr = new PassThrough()
  channel.stdin = new Writable({
    write(chunk, _encoding, callback) {
      channel.written = Buffer.concat([channel.written, Buffer.from(chunk)])
      callback()
    },
    final(callback) {
      callback()
      onEnd(channel)
    }
  })
  channel.close = () => channel.emit('close', null, 'SIGTERM')
  return channel
}

describe('Windows relay upload payload framing', () => {
  let localDir: string
  const commands: { script: string; stdin: Buffer }[] = []

  beforeEach(() => {
    commands.length = 0
    localDir = mkdtempSync(join(tmpdir(), 'orca-win-upload-'))
    spawnSystemSshCommandMock.mockReset()
    spawnSystemSshCommandMock.mockImplementation((_target: SshTarget, command: string) =>
      createFakeChannel((channel) => {
        commands.push({ script: decodePowerShellCommand(command), stdin: channel.written })
        setImmediate(() => channel.emit('close', 0, null))
      })
    )
  })

  afterEach(async () => {
    await rm(localDir, { recursive: true, force: true })
  })

  it('never pushes a whole artifact bundle into one PowerShell stdin', async () => {
    mkdirSync(join(localDir, 'node'), { recursive: true })
    // Comfortably past the ~50KB point at which the reporter measured PowerShell 5.1 wedging.
    writeFileSync(join(localDir, 'node', 'relay.js'), Buffer.alloc(600 * 1024, 0x61))
    writeFileSync(join(localDir, 'index.js'), Buffer.alloc(300 * 1024, 0x62))

    await uploadDirectoryViaSystemSsh(target, localDir, 'C:\\Users\\dev\\.orca-remote', {
      hostPlatform: { os: 'win32', pathSeparator: '\\' } as never
    })

    const largest = Math.max(...commands.map((command) => command.stdin.length))
    expect(largest).toBeLessThanOrEqual(WINDOWS_STDIN_WRITE_CHUNK_BYTES)
    // The base64 + JSON envelope is gone entirely: nothing reads the bundle as one string.
    expect(commands.some((command) => command.script.includes('FromBase64String'))).toBe(false)
    expect(
      commands.filter((command) => command.script.includes('[Console]::In.ReadToEnd()'))
    ).toHaveLength(1)
  })

  it('writes every byte of every artifact across the chunked writes', async () => {
    const contents = Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES * 2 + 17, 0x63)
    writeFileSync(join(localDir, 'relay.js'), contents)

    await uploadDirectoryViaSystemSsh(target, localDir, 'C:\\Users\\dev\\.orca-remote', {
      hostPlatform: { os: 'win32', pathSeparator: '\\' } as never
    })

    const fileWrites = commands.filter((command) => command.script.includes('OpenStandardInput()'))
    expect(fileWrites).toHaveLength(3)
    expect(Buffer.concat(fileWrites.map((command) => command.stdin)).equals(contents)).toBe(true)
    // Only the first write creates the file; the rest must extend it or the artifact is truncated.
    expect(fileWrites.map((command) => /FileMode\]::(\w+)/.exec(command.script)?.[1])).toEqual([
      'Create',
      'Append',
      'Append'
    ])
  })
})

describe('waitForChannelClose bounding', () => {
  it('fails a remote that accepts stdin and never closes, instead of waiting forever', async () => {
    vi.useFakeTimers()
    try {
      const channel = createFakeChannel(() => {})
      const settled = vi.fn()
      const promise = waitForChannelClose(channel as never, 'windows relay upload', 1_000)
      promise.then(settled, settled)

      await vi.advanceTimersByTimeAsync(999)
      expect(settled).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2)
      await expect(promise).rejects.toThrow(/timed out after 1000ms with no response/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves an unbounded wait unbounded when no timeout is asked for', async () => {
    vi.useFakeTimers()
    try {
      const channel = createFakeChannel(() => {})
      const settled = vi.fn()
      void waitForChannelClose(channel as never, 'posix write').then(settled, settled)

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(settled).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
