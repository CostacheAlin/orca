import { constants, createWriteStream } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import type { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SshTarget } from '../../shared/ssh-types'
import { shellEscape } from './ssh-connection-utils'
import {
  getSystemSshBuildArgsFromOperationOptions,
  type SystemSshBuildArgsOptions
} from './system-ssh-args'
import { spawnSystemSshCommand } from './system-ssh-command'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import {
  awaitWithSystemSshAbort,
  throwIfAborted,
  waitForChannelClose
} from './system-ssh-operation-lifecycle'

type SystemSshOperationOptions = SystemSshBuildArgsOptions & {
  signal?: AbortSignal
  hostPlatform?: RemoteHostPlatform
}

type SystemSshWriteBufferOptions = SystemSshOperationOptions & {
  append?: boolean
  exclusive?: boolean
}

type SystemSshUploadFileOptions = SystemSshOperationOptions & {
  exclusive?: boolean
}

export async function downloadFileViaSystemSsh(
  target: SshTarget,
  remotePath: string,
  localPath: string,
  options?: SystemSshOperationOptions
): Promise<void> {
  throwIfAborted(options?.signal)
  const isWindows = options?.hostPlatform && isWindowsRemoteHost(options.hostPlatform)
  const command = isWindows
    ? makeWindowsReadFileCommand(remotePath)
    : `cat ${shellEscape(remotePath)}`
  const channel = spawnSystemSshCommand(target, command, {
    wrapCommand: !isWindows,
    ...getSystemSshBuildArgsFromOperationOptions(options)
  })
  const output = createWriteStream(localPath, { flags: 'wx' })
  try {
    await awaitWithSystemSshAbort(
      options?.signal,
      () => {
        channel.close()
        output.destroy()
      },
      Promise.all([
        waitForChannelClose(channel, `download ${remotePath}`),
        pipeline(channel, output)
      ])
    )
  } catch (error) {
    channel.close()
    output.destroy()
    throw error
  }
}

export async function writeBufferViaSystemSsh(
  target: SshTarget,
  remotePath: string,
  contents: Buffer,
  options?: SystemSshWriteBufferOptions
): Promise<void> {
  throwIfAborted(options?.signal)
  if (options?.hostPlatform && isWindowsRemoteHost(options.hostPlatform)) {
    await writeBufferViaSystemSshWindows(target, remotePath, contents, options)
    return
  }

  const channel = spawnSystemSshCommand(
    target,
    makePosixWriteFileCommand(remotePath, options),
    getSystemSshBuildArgsFromOperationOptions(options)
  )
  const closePromise = awaitWithSystemSshAbort(
    options?.signal,
    () => channel.close(),
    waitForChannelClose(channel, `write ${remotePath}`)
  )
  if (!options?.signal?.aborted) {
    channel.stdin.end(contents)
  }
  await closePromise
}

export async function uploadFileViaSystemSsh(
  target: SshTarget,
  localPath: string,
  remotePath: string,
  options?: SystemSshUploadFileOptions
): Promise<void> {
  throwIfAborted(options?.signal)
  const sourceStat = await lstat(localPath)
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error(`Unsupported upload source: ${localPath}`)
  }

  const handle = await open(localPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const openedStat = await handle.stat()
    if (
      !openedStat.isFile() ||
      openedStat.size !== sourceStat.size ||
      (sourceStat.ino !== 0 && openedStat.ino !== 0 && openedStat.ino !== sourceStat.ino) ||
      (sourceStat.dev !== 0 && openedStat.dev !== 0 && openedStat.dev !== sourceStat.dev)
    ) {
      throw new Error(`File changed during upload: ${localPath}`)
    }
    throwIfAborted(options?.signal)

    const isWindows = options?.hostPlatform && isWindowsRemoteHost(options.hostPlatform)
    const channel = spawnSystemSshCommand(
      target,
      isWindows
        ? makeWindowsWriteFileCommand(remotePath, options)
        : makePosixWriteFileCommand(remotePath, options),
      {
        wrapCommand: !isWindows,
        ...getSystemSshBuildArgsFromOperationOptions(options)
      }
    )
    const input = handle.createReadStream({ autoClose: false })
    try {
      await awaitWithSystemSshAbort(
        options?.signal,
        () => {
          input.destroy()
          channel.close()
        },
        Promise.all([
          waitForChannelClose(channel, `upload ${remotePath}`),
          pipeline(input, channel.stdin as Writable)
        ])
      )
    } catch (error) {
      input.destroy()
      channel.close()
      throw error
    }
  } finally {
    await handle.close()
  }
}

/**
 * #16432: Windows PowerShell 5.1 stops draining a redirected stdin over a non-pty ssh exec somewhere
 * between 50KB and 1MB depending on the host's `DefaultShell`, and it hangs rather than failing. One
 * write is therefore split into appends that stay an order of magnitude under the low end of that
 * measured range, instead of one write sized by the payload.
 */
export const WINDOWS_STDIN_WRITE_CHUNK_BYTES = 32 * 1024

/** No Windows stdin write should ever outlive this; a wedged PowerShell never closes on its own. */
export const WINDOWS_STDIN_WRITE_TIMEOUT_MS = 60_000

async function writeBufferViaSystemSshWindows(
  target: SshTarget,
  remotePath: string,
  contents: Buffer,
  options: SystemSshWriteBufferOptions
): Promise<void> {
  throwIfAborted(options.signal)
  // An empty write still has to run: it is what creates (or truncates) the file.
  for (let offset = 0; offset === 0 || offset < contents.length;) {
    const end = Math.min(offset + WINDOWS_STDIN_WRITE_CHUNK_BYTES, contents.length)
    await writeWindowsChunkViaSystemSsh(
      target,
      remotePath,
      contents.subarray(offset, end),
      // Only the first chunk carries the caller's create/truncate/exclusive mode; the rest extend it.
      offset === 0 ? options : { ...options, append: true, exclusive: false },
      offset
    )
    offset = end
    if (offset >= contents.length) {
      break
    }
  }
}

async function writeWindowsChunkViaSystemSsh(
  target: SshTarget,
  remotePath: string,
  chunk: Buffer,
  options: SystemSshWriteBufferOptions,
  offset: number
): Promise<void> {
  throwIfAborted(options.signal)
  const channel = spawnSystemSshCommand(target, makeWindowsWriteFileCommand(remotePath, options), {
    wrapCommand: false,
    ...getSystemSshBuildArgsFromOperationOptions(options)
  })
  const closePromise = awaitWithSystemSshAbort(
    options.signal,
    () => channel.close(),
    waitForChannelClose(
      channel,
      `write ${remotePath} at offset ${offset}`,
      WINDOWS_STDIN_WRITE_TIMEOUT_MS
    )
  )
  if (!options.signal?.aborted) {
    channel.stdin.end(chunk)
  }
  await closePromise
}

function makeWindowsWriteFileCommand(
  remotePath: string,
  options?: { append?: boolean; exclusive?: boolean }
): string {
  const fileMode = options?.append ? 'Append' : options?.exclusive ? 'CreateNew' : 'Create'
  return powerShellCommand(
    [
      '$ErrorActionPreference = "Stop"',
      `$path = ${powerShellLiteral(remotePath)}`,
      '$parent = [System.IO.Path]::GetDirectoryName($path)',
      'if ($parent) { $null = [System.IO.Directory]::CreateDirectory($parent) }',
      '$inputStream = [Console]::OpenStandardInput()',
      `$outputStream = [System.IO.File]::Open($path, [System.IO.FileMode]::${fileMode}, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)`,
      'try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }'
    ].join('; ')
  )
}

function makePosixWriteFileCommand(
  remotePath: string,
  options?: { append?: boolean; exclusive?: boolean }
): string {
  const redirection = options?.append ? '>>' : '>'
  const noclobber = !options?.append && options?.exclusive ? 'set -C; ' : ''
  return `${noclobber}cat ${redirection} ${shellEscape(remotePath)}`
}

function makeWindowsReadFileCommand(remotePath: string): string {
  return powerShellCommand(
    [
      '$ErrorActionPreference = "Stop"',
      `$path = ${powerShellLiteral(remotePath)}`,
      '$src = [System.IO.File]::OpenRead($path)',
      '$dst = [Console]::OpenStandardOutput()',
      'try { $src.CopyTo($dst) } finally { $src.Dispose() }'
    ].join('; ')
  )
}
