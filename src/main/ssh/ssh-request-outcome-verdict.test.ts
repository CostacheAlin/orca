import { describe, expect, it } from 'vitest'
import {
  createSshDisposalError,
  isSshRequestOutcomeUnverifiable,
  SSH_MUX_REQUEST_TIMEOUT_CODE
} from './ssh-channel-multiplexer'

// docs/reference/ssh-execution-boundary.md: the vocabulary is live / unverifiable / exited, and
// loss of contact is never evidence of absence. These three call sites phrase the verdict to a
// user, so collapsing "unverifiable" into "could not be reached" is a user-visible lie.
describe('SSH request outcome verdict', () => {
  it('treats a response deadline as unverifiable', () => {
    const timedOut = Object.assign(new Error('Request "x" timed out after 30000ms'), {
      code: SSH_MUX_REQUEST_TIMEOUT_CODE
    })
    expect(isSshRequestOutcomeUnverifiable(timedOut)).toBe(true)
  })

  it('treats a mid-flight link loss as unverifiable, not as absence', () => {
    // The regression this exists for: declaring the link lost at 20s made a wedged link surface
    // CONNECTION_LOST where it used to surface a timeout, silently downgrading the honest
    // "may still be running on the remote host" to "could not be reached".
    expect(isSshRequestOutcomeUnverifiable(createSshDisposalError('connection_lost'))).toBe(true)
  })

  it('does not claim unverifiable for a request that never reached the wire', () => {
    // A disposed mux rejects before framing anything, so the peer provably never saw it.
    const undispatched = Object.assign(createSshDisposalError('connection_lost'), {
      sshRequestUndispatched: true
    })
    expect(isSshRequestOutcomeUnverifiable(undispatched)).toBe(false)
  })

  it('does not claim unverifiable for an ordinary failure', () => {
    expect(isSshRequestOutcomeUnverifiable(new Error('boom'))).toBe(false)
    expect(isSshRequestOutcomeUnverifiable(undefined)).toBe(false)
  })
})
