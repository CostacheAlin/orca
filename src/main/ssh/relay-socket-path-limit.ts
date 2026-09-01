/**
 * Keeps the remote relay's Unix socket path inside `sockaddr_un.sun_path`.
 *
 * The default endpoint is `$HOME/.orca-remote/relay-<fullVersion>/relay-<id>.sock`,
 * whose fixed suffix already costs ~66 bytes. A managed-hosting `$HOME` such as
 * `/var/www/<uuid>` pushes the whole path past the kernel cap and libuv reports only
 * `listen EINVAL`, so the relay never starts (#10726). When that happens the socket
 * moves to a fixed-length base whose length no longer depends on `$HOME`.
 *
 * Windows relays bind named pipes (`\\.\pipe\...`), which have no `sun_path` limit.
 */
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

/**
 * `sizeof(sun_path)` per remote OS, including the terminating NUL: 108 on Linux,
 * 104 on macOS/BSD. Compared against byte length, not character count — a non-ASCII
 * `$HOME` costs more bytes than characters.
 */
const SUN_PATH_SIZE: Record<'linux' | 'darwin', number> = { linux: 108, darwin: 104 }

export function remoteUnixSocketPathByteLimit(host: RemoteHostPlatform): number | null {
  if (isWindowsRemoteHost(host)) {
    return null
  }
  return SUN_PATH_SIZE[host.os === 'darwin' ? 'darwin' : 'linux'] - 1
}

export function remoteSocketPathFitsLimit(host: RemoteHostPlatform, sockPath: string): boolean {
  const limit = remoteUnixSocketPathByteLimit(host)
  return limit === null || Buffer.byteLength(sockPath, 'utf8') <= limit
}

/** Fixed-length, per-uid base. `/tmp` is the only POSIX directory whose length is not user-dependent. */
export const SHORT_RELAY_SOCKET_DIR_PREFIX = '/tmp/.orca-relay-'

export function shortRelaySocketDirForUid(uid: string): string {
  return `${SHORT_RELAY_SOCKET_DIR_PREFIX}${uid}`
}

/**
 * The whole hashed socket name is kept — shortening happens by replacing the
 * variable-length directory, never by truncating the hash, so two targets on one
 * host can never land on the same socket.
 */
export function shortRelaySocketPath(shortDir: string, sockName: string): string {
  return `${shortDir}/${sockName}`
}

const SHORT_DIR_MARKER = 'ORCA-RELAY-SHORT-SOCKET-DIR'

/**
 * Create (or adopt) the per-uid short socket directory and print it.
 *
 * `ls -ldn` reports the directory entry itself, so an attacker-planted symlink or a
 * directory owned by another user fails the owner check instead of being reused.
 */
export function resolveShortRelaySocketDirCommand(): string {
  return [
    'uid=$(id -u) || exit 1',
    `dir="${SHORT_RELAY_SOCKET_DIR_PREFIX}$uid"`,
    'umask 077',
    'mkdir -p "$dir" 2>/dev/null',
    'chmod 700 "$dir" 2>/dev/null',
    'owner=$(ls -ldn "$dir" 2>/dev/null | awk \'NR==1{print $3}\')',
    '[ -d "$dir" ] && [ "$owner" = "$uid" ] || exit 1',
    `printf '%s %s\\n' '${SHORT_DIR_MARKER}' "$dir"`
  ].join('\n')
}

/** Tolerates login-shell banner noise ahead of the marker line. */
export function parseShortRelaySocketDir(output: string): string | null {
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(`${SHORT_DIR_MARKER} `)) {
      continue
    }
    const dir = trimmed.slice(SHORT_DIR_MARKER.length + 1).trim()
    if (dir.startsWith(`${SHORT_RELAY_SOCKET_DIR_PREFIX}`) && !/[\r\n]/.test(dir)) {
      return dir
    }
  }
  return null
}
