import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { KernelInfo, SessionRow } from '../types'

const PANE = {
  plugin: 'project-tile',
  component: 'Pane',
  requestId: 'project',
  props: {
    title: 'Project',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'project-tile',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 5, bodyColumns: 80, scroll: { offset: 0, bodyRows: 5 }, view: {} },
} as const

const row = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
  title: 'x',
  parentId: null,
  isSideChat: false,
  isSelf: false,
  lastActivityAt: 1000,
  ago: '1m',
  status: 'done',
  detail: '',
  ask: '',
  options: [],
  uses: [],
  files: [],
  group: null,
  link: `claude://claude.ai/epitaxy/${over.id}`,
  ...over,
})

const SESSIONS: SessionRow[] = [
  row({ id: 'local_a', title: 'Paper draft', status: 'needs-input', detail: 'Which units?', lastActivityAt: 5000 }),
  row({
    id: 'local_b',
    title: 'Simulation run',
    status: 'next-step',
    detail: 'Step 40 done — Restart the job?',
    ask: 'Restart the job?',
    options: ['Yes, restart', 'Not now'],
    uses: ['Wolfram script fit.wls'],
    files: ['model.wl'],
    lastActivityAt: 4000,
  }),
  row({ id: 'local_c', title: 'Side chat of draft', parentId: 'local_a', isSideChat: true, status: 'done', detail: 'Answered', lastActivityAt: 3000 }),
  row({ id: 'local_e', title: 'Side chat of side chat', parentId: 'local_c', isSideChat: true, status: 'done', lastActivityAt: 2500 }),
  row({ id: 'local_d', title: 'Old notes', status: 'stale', lastActivityAt: 10 }),
  // A stale session whose side chats are still live.
  row({ id: 'local_f', title: 'Literature review', status: 'stale', detail: 'Old recap', ago: '4d', lastActivityAt: 100 }),
  row({ id: 'local_g', title: 'Summary', parentId: 'local_f', isSideChat: true, status: 'next-step', detail: 'Written — Send it?', ask: 'Send it?', options: ['Yes, send'], ago: '1d', lastActivityAt: 2000 }),
  row({ id: 'local_i', title: 'Numerics check', parentId: 'local_f', isSideChat: true, status: 'failed', detail: 'Exit code 4', ago: '2d', lastActivityAt: 1500 }),
]

const KERNELS: KernelInfo = {
  kernels: [
    { pid: 1, kind: 'MCP', holder: 'Paper draft', holderId: 'local_a', since: '21:05', isBusy: false },
    { pid: 2, kind: 'script fit.wls', holder: 'Simulation run', holderId: 'local_b', since: '22:10', isBusy: true },
  ],
  subkernels: 0,
  error: '',
}

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
const text = (t: string) => ({ value: { content: [{ type: 'text', text: t }], isError: false } })

type Query = { type?: string; key?: string; text?: string | RegExp }
type Mounted = { find: (q: Query) => Promise<unknown> }
// Named checks, so a failure says which element is missing or present.
const shown = async (ui: Mounted, q: Query, where: string) =>
  expect({ where, q: String(q.text ?? q.key), found: (await ui.find(q)) !== undefined }).toEqual({ where, q: String(q.text ?? q.key), found: true })
const hidden = async (ui: Mounted, q: Query, where: string) =>
  expect({ where, q: String(q.text ?? q.key), found: (await ui.find(q)) !== undefined }).toEqual({ where, q: String(q.text ?? q.key), found: false })

type On = Parameters<TestBody>[1]

// The engine beneath the plugin. `node` does not start, so the plugin falls back to the
// next place node is usually found; `ran` records each collector call.
function engine(on: On, kernels: KernelInfo) {
  const sent: Record<string, unknown>[] = []
  const panes: string[] = []
  const ran: string[][] = []
  const stored: Record<string, unknown> = {}
  on('command.register', () => ({ value: { command: 'project-tile' } }))
  on('ui.open', (_, e) => {
    panes.push(`open ${e.id} ${e.placement ?? ''}`.trim())
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    panes.push(`close ${e.id}`)
    return { value: undefined }
  })
  on('clock.every', () => ({ value: undefined }))
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => {
    stored[e.key] = e.value
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'cli-self' }))
  on('session.root', () => ({ value: '/home/me/proj' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'node') throw new Error('spawn node ENOENT')
    const [node, , mode, arg] = e.argv
    ran.push([String(node), String(mode), String(arg ?? '')])
    if (mode === 'sessions') return ok(JSON.stringify({ clock: '23:30:00', sessions: SESSIONS, kernels }))
    if (mode === 'cluster') return ok(JSON.stringify({ stdout: 'NOCONNECTION\n' }))
    return ok(JSON.stringify({ opened: arg }))
  })
  on('mcp.call', (_, e) => {
    if (e.tool === 'list_sessions') return text(JSON.stringify([{ sessionId: 'local_b', group: { name: 'Research' } }]))
    sent.push({ tool: e.tool, ...e.args })
    return text('delivered (delivery: delivered; message_id: m1)')
  })
  return { sent, panes, ran, stored }
}

test(
  'the pane lists the sessions with their status and answers from a button',
  { options: { clusterHost: 'me@login.example.org', clusterName: 'HPC' } },
  async ($, on) => {
    const { sent, panes, ran, stored } = engine(on, KERNELS)

    await $.session.start({ cwd: '/home/me/proj', surface: 'desktop', isInteractive: true })
    // The pane starts closed.
    expect(panes).toEqual([])

    // The row above the prompt shows the counts and opens and closes the pane.
    for (const surface of ['desktop', 'terminal'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      await shown(band, { type: 'Text', text: '● 1 need you' }, `${surface} band`)
      await shown(band, { type: 'Text', text: '● 2 next steps' }, `${surface} band`)
      // The simulation is idle but its Wolfram script counts as running.
      await shown(band, { type: 'Text', text: '● 1 running' }, `${surface} band`)
      await shown(band, { key: 'project-toggle', text: 'Project ▸' }, `${surface} band closed`)
      await band.press({ key: 'project-toggle' })
      await shown(band, { key: 'project-toggle', text: 'Project ▾' }, `${surface} band open`)
      await band.press({ key: 'project-toggle' })
      await shown(band, { key: 'project-toggle', text: 'Project ▸' }, `${surface} band closed again`)
      await band.unmount()
    }
    expect(panes).toEqual(['open project widget', 'close project', 'open project widget', 'close project'])
    // node was found in the second place tried.
    expect(ran[0]?.slice(0, 2)).toEqual(['/opt/homebrew/bin/node', 'sessions'])
    // Opening the pane asked for the cluster's queue.
    expect(ran.some(([, mode, arg]) => mode === 'cluster' && arg === 'me@login.example.org')).toBe(true)

    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'refresh' })
      await shown(ui, { type: 'Text', text: '● 1 need you' }, surface)
      // A session with side chats has a fold toggle in place of its dot.
      await shown(ui, { type: 'Text', text: 'Needs input' }, surface)
      await shown(ui, { key: 'fold-local_a', text: '▾' }, surface)
      await hidden(ui, { key: 'fold-local_b' }, surface)
      await shown(ui, { key: 'open-local_c', text: '↳ Side chat of draft' }, surface)
      await shown(ui, { key: 'open-local_e', text: '↳ Side chat of side chat' }, surface)
      await shown(ui, { type: 'Text', text: 'Which units?' }, surface)
      await shown(ui, { type: 'Text', text: '⚙ Wolfram script fit.wls' }, surface)
      // Files show once the row is opened.
      await hidden(ui, { type: 'Text', text: 'Files: model.wl' }, surface)
      await ui.press({ key: 'row-local_b' })
      await shown(ui, { type: 'Text', text: 'Files: model.wl' }, `${surface} opened`)
      await ui.press({ key: 'row-local_b' })
      // Stale sessions wait behind a button.
      await hidden(ui, { key: 'open-local_d' }, surface)
      await shown(ui, { key: 'show-stale' }, surface)
      await shown(ui, { type: 'Text', text: 'Wolfram 2 kernels (1 computing)' }, surface)
      await shown(ui, { type: 'Text', text: 'HPC not connected' }, surface)
      await hidden(ui, { type: 'Text', text: /fit\.wls · Simulation run/ }, surface)
      await ui.press({ key: 'resources' })
      await shown(ui, { type: 'Text', text: 'script fit.wls · Simulation run · 22:10 · computing' }, `${surface} resources`)
      await shown(ui, { type: 'Text', text: /ssh -fN me@login\.example\.org/ }, `${surface} resources`)
      await ui.press({ key: 'resources' })
      await ui.unmount()
    }

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

    // Folding hides the side chats and counts them; it is kept in the store.
    await ui.press({ key: 'fold-local_a' })
    await hidden(ui, { key: 'open-local_c' }, 'folded')
    await hidden(ui, { key: 'open-local_e' }, 'folded')
    await shown(ui, { type: 'Text', text: '1m · 2 side chats' }, 'folded')
    expect(stored['collapsed-1']).toEqual(['local_a'])
    await ui.press({ key: 'fold-local_a' })
    await shown(ui, { key: 'open-local_c' }, 'unfolded')
    expect(stored['collapsed-1']).toEqual([])

    // A stale session with live side chats stays in the list, folded or not.
    await shown(ui, { key: 'open-local_f' }, 'live family')
    await shown(ui, { key: 'reply-local_g-Yes, send' }, 'live family unfolded')
    await ui.press({ key: 'fold-local_f' })
    await shown(ui, { key: 'open-local_f' }, 'live family folded')
    // Folded, its row shows the family's most important status, its newest time and who it is.
    await shown(ui, { type: 'Text', text: 'Failed' }, 'folded family status')
    await shown(ui, { type: 'Text', text: '1d · 2 side chats' }, 'folded family time')
    await shown(ui, { type: 'Text', text: '↳ Numerics check: Exit code 4' }, 'folded family note')
    await hidden(ui, { key: 'open-local_g' }, 'folded family')
    await ui.press({ key: 'fold-local_f' })
    await shown(ui, { type: 'Text', text: 'Stale' }, 'unfolded family shows its own status')

    // A title opens its session through the app's link.
    await ui.press({ key: 'open-local_b' })
    expect(ran.filter(([, mode]) => mode === 'open')).toEqual([['/opt/homebrew/bin/node', 'open', 'claude://claude.ai/epitaxy/local_b']])

    await ui.press({ key: 'reply-local_b-Yes, restart' })
    expect(sent).toEqual([
      {
        tool: 'send_message',
        session_id: 'local_b',
        message: 'The user answered your question "Restart the job?" from the Project pane: Yes, restart',
      },
    ])

    await ui.press({ key: 'filter-running' })
    await shown(ui, { key: 'open-local_b' }, 'running filter')
    await hidden(ui, { key: 'open-local_a' }, 'running filter')

    await ui.press({ key: 'filter-needs' })
    await shown(ui, { key: 'open-local_a' }, 'needs filter')
    await hidden(ui, { key: 'open-local_c' }, 'needs filter')

    await ui.press({ key: 'filter-group' })
    await shown(ui, { type: 'Text', text: 'Research' }, 'group filter')
    await shown(ui, { type: 'Text', text: 'No group' }, 'group filter')
    await ui.unmount()

    // In a corner of the chat the widget shows a glance.
    const corner = await $.ui.mount({
      ...PANE,
      surface: 'desktop',
      props: { ...PANE.props, placement: 'widget', anchoredEdges: ['bottom', 'right'] },
    })
    await shown(corner, { type: 'Text', text: 'Needs input · Paper draft' }, 'corner')
    await hidden(corner, { key: 'open-local_a' }, 'corner')
    await corner.unmount()
  },
)

test('with no cluster set and no Wolfram kernel the pane has no resources line', async ($, on) => {
  const { ran } = engine(on, { kernels: [], subkernels: 0, error: '' })
  await $.session.start({ cwd: '/home/me/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await shown(ui, { type: 'Text', text: '● 1 need you' }, 'no resources')
  await hidden(ui, { key: 'resources' }, 'no resources')
  expect(ran.some(([, mode]) => mode === 'cluster')).toBe(false)
  await ui.unmount()
})
