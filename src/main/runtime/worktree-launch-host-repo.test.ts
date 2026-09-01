import { describe, expect, it } from 'vitest'
import { resolveWorktreeLaunchHost } from './worktree-launch-host-repo'

// Why (#11163): the terminal launch scope read
// `store.getRepo(worktree.repoId)?.connectionId ?? null` — one spelling of one arbitrarily chosen
// row instead of the worktree's execution host. A remote worktree then spawns its PTY on the
// client with the remote cwd (`DaemonProtocolError: Working directory "…" does not exist`).
describe('resolveWorktreeLaunchHost', () => {
  const localRow = { id: 'shared', path: '/local/repo' }
  const sshRow = { id: 'shared', path: '/remote/repo', connectionId: 'ssh-b' }

  it('reports ambiguous when duplicate repo rows disagree about the owning host', () => {
    expect(resolveWorktreeLaunchHost([localRow, sshRow], { repoId: 'shared' })).toEqual({
      kind: 'ambiguous'
    })
  })

  it('resolves the row for the host the worktree names', () => {
    expect(
      resolveWorktreeLaunchHost([localRow, sshRow], { repoId: 'shared', hostId: 'ssh:ssh-b' })
    ).toEqual({ kind: 'resolved', repo: sshRow, connectionId: 'ssh-b' })
    expect(
      resolveWorktreeLaunchHost([localRow, sshRow], { repoId: 'shared', hostId: 'local' })
    ).toEqual({ kind: 'resolved', repo: localRow, connectionId: null })
  })

  it('never hands a runtime-owned worktree a client SSH connection', () => {
    const clientOwnedRow = { id: 'r', path: '/p', connectionId: 'ssh-client' }
    expect(
      resolveWorktreeLaunchHost([clientOwnedRow], { repoId: 'r', hostId: 'runtime:env-a' })
    ).toEqual({ kind: 'resolved', repo: clientOwnedRow, connectionId: null })
    // Two rows and no match: nothing names the owner, so the row is not evidence either.
    expect(
      resolveWorktreeLaunchHost([clientOwnedRow, { id: 'r', path: '/q' }], {
        repoId: 'r',
        hostId: 'runtime:env-a'
      })
    ).toEqual({ kind: 'resolved', repo: null, connectionId: null })
  })

  it('leaves a single unambiguous row alone', () => {
    expect(resolveWorktreeLaunchHost([sshRow], { repoId: 'shared' })).toEqual({
      kind: 'resolved',
      repo: sshRow,
      connectionId: 'ssh-b'
    })
    expect(resolveWorktreeLaunchHost([localRow], { repoId: 'shared' })).toEqual({
      kind: 'resolved',
      repo: localRow,
      connectionId: null
    })
    expect(resolveWorktreeLaunchHost([], { repoId: 'shared' })).toEqual({
      kind: 'resolved',
      repo: null,
      connectionId: null
    })
  })
})
