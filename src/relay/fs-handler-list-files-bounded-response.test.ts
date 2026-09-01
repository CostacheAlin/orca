/**
 * #12547: the relay used to bound `fs.listFiles` only when the client asked it to. The failing UI
 * (Quick Open / Files sidebar) is exactly a call site that does not ask, so the host serialized the
 * whole tree into one response and the request died as "Message too large" or over-capacity.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runListFilesScanMock } = vi.hoisted(() => ({
  runListFilesScanMock: vi.fn()
}))

vi.mock('./fs-list-files-fallback-chain', () => ({
  runListFilesScan: runListFilesScanMock
}))

vi.mock('@parcel/watcher', () => ({ subscribe: vi.fn() }))

import { FsHandler } from './fs-handler'
import { RelayContext } from './context'
import type { RelayDispatcher } from './dispatcher'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../shared/quick-open-listing-limits'

type ListFilesHandler = (
  params: Record<string, unknown>,
  context?: { clientId: number }
) => Promise<string[]>

function createHandler(): { listFiles: ListFilesHandler; dispose: () => void } {
  const requestHandlers = new Map<string, ListFilesHandler>()
  const dispatcher = {
    onRequest: (method: string, handler: ListFilesHandler) => requestHandlers.set(method, handler),
    onNotification: vi.fn(),
    onClientDetached: vi.fn(),
    notify: vi.fn(),
    notifyBulk: vi.fn(),
    publishProducerNotification: vi.fn(() => true),
    activeClientIds: () => [],
    producerEnvelopeBudget: () => Number.MAX_SAFE_INTEGER
  } as unknown as RelayDispatcher
  const handler = new FsHandler(dispatcher, new RelayContext(), {
    dispose: vi.fn(),
    forgetRoot: vi.fn(),
    subscribe: vi.fn()
  })
  return { listFiles: requestHandlers.get('fs.listFiles')!, dispose: () => handler.dispose() }
}

describe('fs.listFiles response bounding', () => {
  let listFiles: ListFilesHandler
  let dispose: () => void

  beforeEach(() => {
    runListFilesScanMock.mockReset()
    runListFilesScanMock.mockResolvedValue([])
    const created = createHandler()
    listFiles = created.listFiles
    dispose = created.dispose
    return () => dispose()
  })

  function scanMaxResults(): unknown {
    // runListFilesScan(rootPath, excludePathPrefixes, signal, maxResults, searchQuery)
    return runListFilesScanMock.mock.calls[0][3]
  }

  it('bounds a request that omitted maxResults', async () => {
    await listFiles({ rootPath: '/remote/root' }, { clientId: 1 })

    expect(scanMaxResults()).toBe(QUICK_OPEN_LISTING_MAX_RESULTS)
  })

  it('bounds a request whose maxResults is malformed rather than trusting it', async () => {
    await listFiles({ rootPath: '/remote/root', maxResults: 'all' }, { clientId: 1 })

    expect(scanMaxResults()).toBe(QUICK_OPEN_LISTING_MAX_RESULTS)
  })

  it('keeps a smaller client limit and clamps a larger one', async () => {
    await listFiles({ rootPath: '/remote/root', maxResults: 33 }, { clientId: 1 })
    expect(scanMaxResults()).toBe(33)

    runListFilesScanMock.mockClear()
    await listFiles(
      { rootPath: '/remote/root', maxResults: QUICK_OPEN_LISTING_MAX_RESULTS * 10 },
      { clientId: 2 }
    )
    expect(scanMaxResults()).toBe(QUICK_OPEN_LISTING_MAX_RESULTS)
  })
})
