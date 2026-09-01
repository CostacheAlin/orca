import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, resetRemoteRuntimeTransport } = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

// #12684: connect() classified these failures as recoverable and then latched 'disconnected' with
// nothing armed — no backoff timer, no parked retry, and a Reconnect button that returned false.
describe('recoverable connect failures on a remote runtime pane', () => {
  let resolvePaneCalls = 0

  function installUnreachableRuntime(): void {
    resolvePaneCalls = 0
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'terminal.resolvePane') {
        resolvePaneCalls += 1
      }
      throw Object.assign(new Error('Remote Orca runtime closed the connection.'), {
        code: 'remote_runtime_unavailable'
      })
    })
  }

  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('keeps retrying a recoverable connect failure instead of latching immediately', async () => {
    vi.useFakeTimers()
    try {
      installUnreachableRuntime()
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({
        url: '',
        sessionId: 'remote:env-1@@',
        callbacks: { onError }
      })

      // Loss of contact is unverifiable, not a dead terminal: automatic recovery must still be running.
      expect(resolvePaneCalls).toBe(1)
      expect(transport.getRecoveryState?.().phase).toBe('backoff')
      expect(onError).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1_000)
      expect(resolvePaneCalls).toBeGreaterThan(1)

      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves both revival paths armed once the recovery window is spent', async () => {
    vi.useFakeTimers()
    try {
      installUnreachableRuntime()
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      // Why dynamic: resetRemoteRuntimeTransport() re-registers the module graph, and the retry
      // registry only sees panes from the same instance the transport was loaded from.
      const { retryAllRemoteRuntimePtyRecoveriesNow } =
        await import('./remote-runtime-pty-recovery-state')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', sessionId: 'remote:env-1@@', callbacks: {} })
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)

      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      const callsAtCutoff = resolvePaneCalls

      // The cutoff stops self-initiated retries only; online/resume must still find a parked retry.
      expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(resolvePaneCalls).toBeGreaterThan(callsAtCutoff)

      // ...and so must the Reconnect button, which returned false before #12684.
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      expect(transport.retryRecovery?.()).toBe(true)

      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
