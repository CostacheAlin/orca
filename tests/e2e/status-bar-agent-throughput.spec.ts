import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor } from './helpers/terminal'
import type { ActivePaneHookDescriptor } from './helpers/terminal-pane-identity'

const BASE = Date.parse('2026-09-02T14:12:22.409Z')

function transcriptRow(record: Record<string, unknown>, offsetMs: number): string {
  return JSON.stringify({ ...record, timestamp: new Date(BASE + offsetMs).toISOString() })
}

function assistantRow(args: {
  uuid: string
  parentUuid: string
  messageId: string
  outputTokens: number
  offsetMs: number
}): string {
  return transcriptRow(
    {
      type: 'assistant',
      uuid: args.uuid,
      parentUuid: args.parentUuid,
      message: {
        id: args.messageId,
        model: 'claude-e2e',
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 10, output_tokens: args.outputTokens }
      }
    },
    args.offsetMs
  )
}

async function postClaudeHook(
  app: ElectronApplication,
  descriptor: ActivePaneHookDescriptor,
  payload: Record<string, unknown>
): Promise<void> {
  const endpoint = await readHookEndpoint(app)
  const [tabId] = descriptor.paneKey.split(':')
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify({
      paneKey: descriptor.paneKey,
      tabId,
      worktreeId: descriptor.worktreeId,
      env: endpoint.env,
      version: endpoint.version,
      payload
    })
  })
  expect(response.status).toBe(204)
}

test('shows tokens per second for the focused pane once a Claude message completes', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)

  // Why: the readout is opt-in; the store enables it (setup) and the DOM proves it (assertion).
  await orcaPage.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    if (!store.getState().statusBarItems.includes('throughput')) {
      store.getState().toggleStatusBarItem('throughput')
    }
  })

  const transcriptDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-throughput-'))
  const transcriptPath = path.join(transcriptDir, 'session.jsonl')
  const lines = [
    transcriptRow(
      { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'go' } },
      0
    ),
    assistantRow({
      uuid: 'a1',
      parentUuid: 'u1',
      messageId: 'msg_1',
      outputTokens: 2497,
      offsetMs: 36_473
    })
  ]
  writeFileSync(transcriptPath, `${lines.join('\n')}\n`)
  const session = {
    session_id: 'e2e-throughput-session',
    transcript_path: transcriptPath,
    cwd: transcriptDir
  }

  await postClaudeHook(electronApp, descriptor, {
    ...session,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'go'
  })
  await postClaudeHook(electronApp, descriptor, {
    ...session,
    hook_event_name: 'Stop',
    last_assistant_message: 'done'
  })

  const firstReadout = orcaPage.getByLabel('Agent throughput, 68 tok/s')
  await expect(firstReadout).toBeVisible()
  await expect(firstReadout).toHaveText('68 tok/s')
  const proofPath = process.env.ORCA_THROUGHPUT_PROOF_PATH
  if (proofPath) {
    await orcaPage.screenshot({ path: proofPath })
  }

  lines.push(
    transcriptRow(
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }
      },
      40_000
    ),
    assistantRow({
      uuid: 'a2',
      parentUuid: 'u2',
      messageId: 'msg_2',
      outputTokens: 200,
      offsetMs: 45_000
    })
  )
  writeFileSync(transcriptPath, `${lines.join('\n')}\n`)
  await postClaudeHook(electronApp, descriptor, {
    ...session,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'again'
  })
  await postClaudeHook(electronApp, descriptor, {
    ...session,
    hook_event_name: 'Stop',
    last_assistant_message: 'done again'
  })

  const secondReadout = orcaPage.getByLabel('Agent throughput, 40 tok/s')
  await expect(secondReadout).toBeVisible()
  await expect(secondReadout).toHaveText('40 tok/s')
})
