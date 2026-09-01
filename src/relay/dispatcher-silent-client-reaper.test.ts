import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { encodeKeepAliveFrame, KEEPALIVE_SEND_MS, TIMEOUT_MS } from './protocol'

// The relay had no inbound-liveness signal at all: its writer parks forever on a half-open link, so
// an abandoned viewer kept its owner lease and left the PTYs it held paused until the process died.
describe('RelayDispatcher silent-client reaper', () => {
  let dispatcher: RelayDispatcher

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    dispatcher.dispose()
    vi.useRealTimers()
  })

  it('detaches a client that has stopped answering', () => {
    const detachListener = vi.fn()
    dispatcher = new RelayDispatcher(() => true)
    dispatcher.onClientDetached(detachListener)
    const clientId = dispatcher.attachClient(() => true)

    vi.advanceTimersByTime(TIMEOUT_MS + KEEPALIVE_SEND_MS * 2)

    // 'local', not a peer close: silence is not evidence the peer died, and a consumer that read it
    // as one would shorten the owner grace on a session that is still there.
    expect(detachListener).toHaveBeenCalledWith(clientId, 'local')
  })

  it('keeps a quiet but answering client attached', () => {
    const detachListener = vi.fn()
    dispatcher = new RelayDispatcher(() => true)
    dispatcher.onClientDetached(detachListener)
    const clientId = dispatcher.attachClient(() => true)

    // A client with nothing to say still answers the keepalive; that is the only proof required.
    for (let tick = 0; tick < 10; tick += 1) {
      vi.advanceTimersByTime(KEEPALIVE_SEND_MS)
      dispatcher.feedClient(clientId, encodeKeepAliveFrame(tick + 1, 0))
    }

    // Asserted against this client specifically: the unattached primary sink has no peer answering
    // it in this harness, so it is expected to be reaped and says nothing about the case under test.
    expect(detachListener).not.toHaveBeenCalledWith(clientId, expect.anything())
  })

  it('does not reap every client on the first tick after the host slept', () => {
    const detachListener = vi.fn()
    dispatcher = new RelayDispatcher(() => true)
    dispatcher.onClientDetached(detachListener)
    dispatcher.attachClient(() => true)

    // One tick fires far late because the process was paused, not because the peers went away.
    vi.setSystemTime(10 * 60_000)
    vi.advanceTimersByTime(KEEPALIVE_SEND_MS)

    expect(detachListener).not.toHaveBeenCalled()
  })
})
