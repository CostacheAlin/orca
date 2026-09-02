import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor } from './helpers/terminal'
import type { ActivePaneHookDescriptor } from './helpers/terminal-pane-identity'

const BASE = Date.parse('2026-09-02T14:12:22.409Z')

function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString()
}

function claudeRow(record: Record<string, unknown>, offsetMs: number): string {
  return JSON.stringify({ ...record, timestamp: at(offsetMs) })
}

function claudeAssistantRow(args: {
  uuid: string
  parentUuid: string
  messageId: string
  outputTokens: number
  offsetMs: number
}): string {
  return claudeRow(
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

function codexRow(type: string, payload: Record<string, unknown>, offsetMs: number): string {
  return JSON.stringify({ timestamp: at(offsetMs), type, payload })
}

function codexTokenCount(offsetMs: number, outputTokens: number, totalOutput: number): string {
  return codexRow(
    'event_msg',
    {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 1000,
          output_tokens: totalOutput,
          total_tokens: 1000 + totalOutput
        },
        last_token_usage: {
          input_tokens: 500,
          output_tokens: outputTokens,
          total_tokens: 500 + outputTokens
        }
      }
    },
    offsetMs
  )
}

async function postHook(
  app: ElectronApplication,
  source: 'claude' | 'codex',
  descriptor: ActivePaneHookDescriptor,
  payload: Record<string, unknown>
): Promise<void> {
  const endpoint = await readHookEndpoint(app)
  const [tabId] = descriptor.paneKey.split(':')
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/${source}`, {
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

async function prepareFocusedPane(orcaPage: Page): Promise<ActivePaneHookDescriptor> {
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
  return descriptor
}

function createTranscriptDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-throughput-'))
}

test('shows tokens per second for the focused pane once a Claude message completes', async ({
  electronApp,
  orcaPage
}) => {
  const descriptor = await prepareFocusedPane(orcaPage)
  const transcriptDir = createTranscriptDir()
  const transcriptPath = path.join(transcriptDir, 'session.jsonl')
  const lines = [
    claudeRow(
      { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'go' } },
      0
    ),
    claudeAssistantRow({
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

  await postHook(electronApp, 'claude', descriptor, {
    ...session,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'go'
  })
  await postHook(electronApp, 'claude', descriptor, {
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
    claudeRow(
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }
      },
      40_000
    ),
    claudeAssistantRow({
      uuid: 'a2',
      parentUuid: 'u2',
      messageId: 'msg_2',
      outputTokens: 200,
      offsetMs: 45_000
    })
  )
  writeFileSync(transcriptPath, `${lines.join('\n')}\n`)
  await postHook(electronApp, 'claude', descriptor, {
    ...session,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'again'
  })
  await postHook(electronApp, 'claude', descriptor, {
    ...session,
    hook_event_name: 'Stop',
    last_assistant_message: 'done again'
  })

  const secondReadout = orcaPage.getByLabel('Agent throughput, 40 tok/s')
  await expect(secondReadout).toBeVisible()
  await expect(secondReadout).toHaveText('40 tok/s')
})

test('shows tokens per second for a Codex pane from its rollout', async ({
  electronApp,
  orcaPage
}) => {
  const descriptor = await prepareFocusedPane(orcaPage)
  const rolloutDir = createTranscriptDir()
  const rolloutPath = path.join(rolloutDir, 'rollout.jsonl')
  // Why: mirrors a real rollout — the call's rows, then the tool output, then its token_count.
  writeFileSync(
    rolloutPath,
    `${[
      codexRow(
        'response_item',
        { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' },
        0
      ),
      codexTokenCount(0, 184, 184),
      codexRow('response_item', { type: 'reasoning', summary: [] }, 22_087),
      codexRow('response_item', { type: 'custom_tool_call', name: 'exec', input: 'ls' }, 29_293),
      codexRow(
        'response_item',
        { type: 'custom_tool_call_output', call_id: 'c2', output: 'files' },
        32_443
      ),
      codexTokenCount(32_444, 696, 880),
      codexRow('event_msg', { type: 'task_complete', last_agent_message: 'done' }, 32_450)
    ].join('\n')}\n`
  )
  const session = {
    session_id: 'e2e-codex-throughput-session',
    transcript_path: rolloutPath,
    cwd: rolloutDir,
    model: 'gpt-5.5'
  }

  await postHook(electronApp, 'codex', descriptor, {
    ...session,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'list files'
  })
  await postHook(electronApp, 'codex', descriptor, {
    ...session,
    hook_event_name: 'Stop',
    last_assistant_message: 'done'
  })

  const readout = orcaPage.getByLabel('Agent throughput, 24 tok/s')
  await expect(readout).toBeVisible()
  await expect(readout).toHaveText('24 tok/s')
})
