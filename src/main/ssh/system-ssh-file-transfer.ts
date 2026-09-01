import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join as pathJoin } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { SshTarget } from '../../shared/ssh-types'
import { shellEscape, wrapRemoteCommandForPosixShell } from './ssh-connection-utils'
import { findSystemSsh } from './system-ssh-binary'
import {
  buildSshArgs,
  getSystemSshBuildArgsFromOperationOptions,
  type SystemSshBuildArgsOptions
} from './system-ssh-args'
import { spawnSystemSshCommand } from './system-ssh-command'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand } from './ssh-remote-powershell'
import {
  awaitWithSystemSshAbort,
  killProcess,
  throwIfAborted,
  waitForChannelClose,
  waitForProcess,
  type ProcessResult
} from './system-ssh-operation-lifecycle'
import {
  WINDOWS_STDIN_WRITE_CHUNK_BYTES,
  WINDOWS_STDIN_WRITE_TIMEOUT_MS,
  writeBufferViaSystemSsh
} from './system-ssh-file-binary-transfer'

type SystemSshOperationOptions = SystemSshBuildArgsOptions & {
  signal?: AbortSignal
  hostPlatform?: RemoteHostPlatform
}

export async function uploadDirectoryViaSystemSsh(
  target: SshTarget,
  localDir: string,
  remoteDir: string,
  options?: SystemSshOperationOptions
): Promise<void> {
  throwIfAborted(options?.signal)
  if (options?.hostPlatform && isWindowsRemoteHost(options.hostPlatform)) {
    await uploadDirectoryViaSystemSshWindows(target, localDir, remoteDir, options)
    return
  }

  const sshPath = findSystemSsh()
  if (!sshPath) {
    throw new Error('No system ssh binary found. Install OpenSSH to use system SSH transport.')
  }

  const tarCreate = spawn('tar', ['-czf', '-', '-C', localDir, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const remoteCommand = `mkdir -p ${shellEscape(remoteDir)} && tar -xzf - -C ${shellEscape(remoteDir)}`
  const sshExtract = spawn(
    sshPath,
    [...buildSshArgs(target, options), wrapRemoteCommandForPosixShell(remoteCommand)],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }
  )

  let tarResult: ProcessResult | null = null
  let sshResult: ProcessResult | null = null
  try {
    ;[tarResult, sshResult] = await awaitWithSystemSshAbort(
      options?.signal,
      () => {
        killProcess(tarCreate)
        killProcess(sshExtract)
      },
      Promise.all([
        waitForProcess(tarCreate, 'local tar relay upload'),
        waitForProcess(sshExtract, 'system ssh relay upload'),
        pipeline(tarCreate.stdout!, sshExtract.stdin!)
      ]).then(([tar, ssh]) => [tar, ssh] as const)
    )
  } catch (err) {
    killProcess(tarCreate)
    killProcess(sshExtract)
    throw err
  }

  if (tarResult?.stderr.trim()) {
    console.warn(`[ssh-system] ${tarResult.label} stderr: ${tarResult.stderr.trim()}`)
  }
  if (sshResult?.stderr.trim()) {
    console.warn(`[ssh-system] ${sshResult.label} stderr: ${sshResult.stderr.trim()}`)
  }
}

export async function writeFileViaSystemSsh(
  target: SshTarget,
  remotePath: string,
  contents: string,
  options?: SystemSshOperationOptions
): Promise<void> {
  throwIfAborted(options?.signal)
  await writeBufferViaSystemSsh(target, remotePath, Buffer.from(contents, 'utf-8'), options)
}

async function uploadDirectoryViaSystemSshWindows(
  target: SshTarget,
  localDir: string,
  remoteDir: string,
  options: SystemSshOperationOptions
): Promise<void> {
  const hostPlatform = options.hostPlatform
  if (!hostPlatform) {
    throw new Error('Windows system SSH upload requires a remote host platform')
  }
  const plan = await collectWindowsUploadPlan(localDir, remoteDir, hostPlatform, options.signal)
  await createWindowsUploadDirectories(target, plan.directories, options)
  for (const file of plan.files) {
    throwIfAborted(options.signal)
    await uploadWindowsFileInChunks(target, file, options)
  }
}

type WindowsUploadPlan = {
  directories: string[]
  files: { localPath: string; remotePath: string; size: number }[]
}

/**
 * #16432: this used to base64 every artifact into one JSON array and push the whole ~1.9MB string
 * into `[Console]::In.ReadToEnd()`. Base64 inflates the payload 1.33x, ReadToEnd materializes the
 * whole bundle as a single PowerShell string, and Windows PowerShell 5.1 cannot read stdin that
 * large over a non-pty ssh exec — it blocks forever instead of failing. Nothing about a directory
 * upload requires one frame: the plan carries paths and sizes only, and the bytes go per file.
 */
async function collectWindowsUploadPlan(
  localDir: string,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  signal: AbortSignal | undefined,
  plan: WindowsUploadPlan = { directories: [], files: [] }
): Promise<WindowsUploadPlan> {
  plan.directories.push(remoteDir)
  const dirEntries = await readdir(localDir, { withFileTypes: true })
  for (const entry of dirEntries) {
    throwIfAborted(signal)
    const localPath = pathJoin(localDir, entry.name)
    const remotePath = joinRemotePath(hostPlatform, remoteDir, entry.name)
    const statResult = await lstat(localPath)
    if (statResult.isSymbolicLink() || (!statResult.isFile() && !statResult.isDirectory())) {
      continue
    }
    if (statResult.isDirectory()) {
      await collectWindowsUploadPlan(localPath, remotePath, hostPlatform, signal, plan)
      continue
    }
    plan.files.push({ localPath, remotePath, size: statResult.size })
  }
  return plan
}

// Why the JSON envelope survives here: a path list is metadata, so this payload stays in the
// hundreds of bytes even for a deep tree. Batched anyway, so a pathological tree cannot walk back
// into the same stdin size that wedges PowerShell.
async function createWindowsUploadDirectories(
  target: SshTarget,
  directories: readonly string[],
  options: SystemSshOperationOptions
): Promise<void> {
  let batch: string[] = []
  let batchBytes = 0
  const flush = async (): Promise<void> => {
    if (batch.length === 0) {
      return
    }
    const payload = JSON.stringify(batch)
    batch = []
    batchBytes = 0
    throwIfAborted(options.signal)
    const channel = spawnSystemSshCommand(target, makeWindowsCreateDirectoriesCommand(), {
      wrapCommand: false,
      ...getSystemSshBuildArgsFromOperationOptions(options)
    })
    const closePromise = awaitWithSystemSshAbort(
      options.signal,
      () => channel.close(),
      waitForChannelClose(channel, 'windows relay upload mkdir', WINDOWS_STDIN_WRITE_TIMEOUT_MS)
    )
    if (!options.signal?.aborted) {
      channel.stdin.end(payload)
    }
    await closePromise
  }
  for (const directory of directories) {
    const entryBytes = Buffer.byteLength(directory) + 4
    if (batch.length > 0 && batchBytes + entryBytes > WINDOWS_STDIN_WRITE_CHUNK_BYTES) {
      await flush()
    }
    batch.push(directory)
    batchBytes += entryBytes
  }
  await flush()
}

async function uploadWindowsFileInChunks(
  target: SshTarget,
  file: { localPath: string; remotePath: string; size: number },
  options: SystemSshOperationOptions
): Promise<void> {
  const handle = await open(file.localPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const openedStat = await handle.stat()
    if (!openedStat.isFile() || openedStat.size !== file.size) {
      throw new Error(`File changed during upload: ${file.localPath}`)
    }
    const buffer = Buffer.allocUnsafe(WINDOWS_STDIN_WRITE_CHUNK_BYTES)
    let offset = 0
    while (offset < openedStat.size) {
      throwIfAborted(options.signal)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (bytesRead === 0) {
        throw new Error(`File truncated during upload: ${file.localPath}`)
      }
      await writeBufferViaSystemSsh(target, file.remotePath, buffer.subarray(0, bytesRead), {
        ...options,
        append: offset > 0
      })
      offset += bytesRead
    }
    if (offset === 0) {
      // An empty artifact still has to exist on the host.
      await writeBufferViaSystemSsh(target, file.remotePath, Buffer.alloc(0), options)
    }
  } finally {
    await handle.close()
  }
}

function makeWindowsCreateDirectoriesCommand(): string {
  return powerShellCommand(
    [
      '$ErrorActionPreference = "Stop"',
      '$json = [Console]::In.ReadToEnd()',
      'if ([string]::IsNullOrWhiteSpace($json)) { return }',
      'foreach ($path in @($json | ConvertFrom-Json)) {',
      '  $null = [System.IO.Directory]::CreateDirectory([string]$path)',
      '}'
    ].join('; ')
  )
}
