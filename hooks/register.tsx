import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register, ThemeKey } from 'claude-code'

import type { ClusterInfo, ClusterJob, Filter, KernelInfo, SessionRow, SessionStatus } from '../types'

const PANE = 'project'
const SESSIONS_MS = 20_000
const CLUSTER_MS = 120_000
const COLLAPSED_KEY = 'collapsed-1'
// The app's session tools, tried in this order until one answers.
const SESSION_SERVERS = ['ccd_session_mgmt', 'ccd-session-mgmt']
// Where node is looked for when the `nodePath` option is empty: an app started from the
// macOS Dock does not see the shell's PATH.
const NODE_CANDIDATES = ['node', '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']

const sessions = atom({ plugin: 'project-tile', key: 'sessions' } as const, [], { shape: 'sessions-2' })
const kernels = atom({ plugin: 'project-tile', key: 'kernels' } as const, null, { shape: 'kernels-2' })
const collapsed = atom({ plugin: 'project-tile', key: 'collapsed' } as const, [], { shape: 'collapsed-1' })
const cluster = atom({ plugin: 'project-tile', key: 'cluster' } as const, null, { shape: 'cluster-1' })
const filter = atom({ plugin: 'project-tile', key: 'filter' } as const, 'all')
const showStale = atom({ plugin: 'project-tile', key: 'showStale' } as const, false)
const expanded = atom({ plugin: 'project-tile', key: 'expanded' } as const, '')
const isResourcesOpen = atom({ plugin: 'project-tile', key: 'isResourcesOpen' } as const, false)
const paneOpen = atom({ plugin: 'project-tile', key: 'isPaneOpen' } as const, false)
const updatedAt = atom({ plugin: 'project-tile', key: 'updatedAt' } as const, '')

const LABEL: Record<SessionStatus, string> = {
  'needs-input': 'Needs input',
  permission: 'Permission',
  running: 'Running',
  'next-step': 'Next step',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  waiting: 'Waiting',
  stale: 'Stale',
  idle: 'Idle',
}
const COLOR: Record<SessionStatus, ThemeKey> = {
  'needs-input': 'error',
  permission: 'warning',
  running: 'suggestion',
  'next-step': 'claude',
  done: 'success',
  failed: 'error',
  stopped: 'warning',
  waiting: 'subtle',
  stale: 'inactive',
  idle: 'inactive',
}
const NEEDS_YOU: SessionStatus[] = ['needs-input', 'permission', 'next-step', 'failed']
// What the "need you" count and the title count: a question or an approval waiting.
const COUNTED: SessionStatus[] = ['needs-input', 'permission']
const ALERTS: SessionStatus[] = ['needs-input', 'permission', 'failed']
const BUSY: SessionStatus[] = ['running', 'waiting']
// Working, or using something: a computing Wolfram kernel, a script, a background job.
const isActive = (s: SessionRow) => BUSY.includes(s.status) || s.uses.length > 0
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Needs you' },
  { id: 'running', label: 'Running' },
  { id: 'group', label: 'By group' },
]
const JOB_STATE: Record<string, string> = {
  R: 'running',
  Q: 'queued',
  H: 'held',
  B: 'array running',
  E: 'exiting',
  F: 'finished',
  X: 'finished',
  S: 'suspended',
  W: 'waiting',
}

// Module state: starts over at each reload, which is what these need. A reload
// closes the pane, so it starts closed here too.
let isPaneOpen = false
let isSeeded = false
let lastTitle = ''
let sessionServer: string | null = null
const isBusy = { sessions: false, cluster: false }
// The plugin's options (see plugin.json), set at each load.
let nodePath = ''
let clusterHost = ''
let clusterName = 'Cluster'
// The node command that worked, once one has.
let nodeCommand: string | null = null

const textOf = (r: McpToolResult) => r.content.map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const errorText = (err: unknown) => clip(err instanceof Error ? err.message : String(err), 200)
const scriptPath = ($: EngineInterface, name: string) => `${$.plugin.root.replace(/\\/g, '/')}/scripts/${name}`

async function callSessions($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<string> {
  let last = 'the session tools are not connected'
  for (const server of sessionServer ? [sessionServer] : SESSION_SERVERS) {
    try {
      const r = await $.mcp.call(server, tool, args)
      if (r.isError) {
        last = textOf(r)
        continue
      }
      sessionServer = server
      return textOf(r)
    } catch (err) {
      last = errorText(err)
    }
  }
  throw new Error(last)
}

// Runs scripts/collect.mjs with node: the `nodePath` option, else the first of
// NODE_CANDIDATES that starts.
async function runCollector($: EngineInterface, args: string[]): Promise<unknown> {
  const self = await $.session.id()
  const tries = nodePath ? [nodePath] : nodeCommand ? [nodeCommand] : NODE_CANDIDATES
  let lastError: unknown = new Error('node not found')
  for (const node of tries) {
    let r
    try {
      r = await $.process.run([node, scriptPath($, 'collect.mjs'), ...args], {
        timeoutMs: 60_000,
        env: { PROJECT_TILE_SELF: self },
      })
    } catch (err) {
      lastError = err
      continue
    }
    nodeCommand = node
    if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n').at(-1) || `collector exited with ${r.exitCode}`)
    return JSON.parse(r.stdout)
  }
  throw new Error(`node did not start (${errorText(lastError)}); set the plugin's nodePath option`)
}

async function refreshSessions($: EngineInterface) {
  if (isBusy.sessions) return
  isBusy.sessions = true
  try {
    const root = await $.session.root()
    const out = (await runCollector($, ['sessions', root])) as { clock: string; sessions: SessionRow[]; kernels: KernelInfo }
    let rows = out.sessions
    try {
      const list = JSON.parse(await callSessions($, 'list_sessions', { limit: 200 })) as {
        sessionId: string
        group?: { name: string } | null
      }[]
      const groups = new Map(list.map(s => [s.sessionId, s.group?.name ?? null]))
      rows = rows.map(s => ({ ...s, group: groups.get(s.id) ?? s.group }))
    } catch {
      // Groups stay unknown; everything else still shows.
    }
    const before = new Map((await read($, sessions)).map(s => [s.id, s.status]))
    if (isSeeded) {
      for (const s of rows) {
        if (!s.isSelf && ALERTS.includes(s.status) && before.get(s.id) !== s.status)
          $.ui.toast(`${s.title}: ${LABEL[s.status].toLowerCase()}`, { timeoutMs: 8000 })
      }
    }
    isSeeded = true
    await update($, sessions, () => rows)
    await update($, kernels, () => out.kernels)
    await update($, updatedAt, () => out.clock)
    const title = paneTitle(rows)
    if (isPaneOpen && title !== lastTitle) {
      lastTitle = title
      await $.ui.open({ id: PANE, title, placement: 'widget' })
    }
  } catch (err) {
    $.ui.log(`project-tile: sessions refresh failed: ${errorText(err)}`, { to: 'debug' })
  } finally {
    isBusy.sessions = false
  }
}

function parseQstat(stdout: string): ClusterInfo {
  const lines = stdout.split(/\r?\n/)
  const checkedAt = new Date().toTimeString().slice(0, 5)
  if (lines[0]?.trim() === 'NOCONNECTION') return { isConnected: false, jobs: [], error: '', checkedAt }
  const arrays = new Map<string, string>()
  for (const l of lines) {
    const [, id = '', counts = ''] = l.match(/^ARRAY (\S+) (.*)$/) ?? []
    if (id) arrays.set(id, counts.trim())
  }
  const exit = lines.map(l => l.match(/^EXIT (\d+)/)).find(Boolean)
  const jobs: ClusterJob[] = []
  let isTable = false
  for (const l of lines) {
    if (/^-{5,}/.test(l)) {
      isTable = true
      continue
    }
    if (!isTable || !l.trim() || /^(ARRAY|EXIT) /.test(l)) continue
    const [id = '', , , name = '', , , , , , state = '', elapsed = ''] = l.trim().split(/\s+/)
    if (!elapsed) continue
    jobs.push({ id, name, state, elapsed, array: arrays.get(id) ?? '' })
  }
  const error = exit && exit[1] !== '0' && jobs.length === 0 ? clip(lines.filter(l => l.trim()).slice(0, 2).join(' '), 160) : ''
  return { isConnected: true, jobs, error, checkedAt }
}

// The PBS queue on the `clusterHost` option's host; nothing when the option is empty.
async function refreshCluster($: EngineInterface) {
  if (isBusy.cluster || !clusterHost) return
  isBusy.cluster = true
  try {
    const r = (await runCollector($, ['cluster', clusterHost])) as { stdout: string; error?: string }
    const info = parseQstat(r.stdout)
    await update($, cluster, () => (r.error && info.jobs.length === 0 && info.isConnected ? { ...info, error: r.error } : info))
  } catch (err) {
    await update($, cluster, () => ({ isConnected: false, jobs: [], error: errorText(err), checkedAt: '' }))
  } finally {
    isBusy.cluster = false
  }
}

const refreshAll = ($: EngineInterface) => Promise.all([refreshSessions($), refreshCluster($)])

// Opens a session in the desktop app through its claude:// link.
async function openSession($: EngineInterface, s: SessionRow) {
  try {
    await runCollector($, ['open', s.link])
  } catch (err) {
    $.ui.toast(`Could not open ${s.title}: ${errorText(err)}`, { timeoutMs: 8000 })
  }
}

// Folds or unfolds a session's side chats; kept across sessions in the store.
async function toggleFold($: EngineInterface, id: string) {
  const ids = await update($, collapsed, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))
  await $.store.set(COLLAPSED_KEY, ids)
}

// Opens or closes the pane; the row above the prompt draws from `paneOpen`.
async function showPane($: EngineInterface, isOpen: boolean) {
  isPaneOpen = isOpen
  await update($, paneOpen, () => isOpen)
  if (!isOpen) return $.ui.close({ id: PANE })
  lastTitle = paneTitle(await read($, sessions))
  await $.ui.open({ id: PANE, title: lastTitle, placement: 'widget' })
  void refreshAll($)
}

// The pane's tab title, with the number of sessions waiting on the person.
function paneTitle(rows: SessionRow[]) {
  const needs = rows.filter(s => !s.isSelf && COUNTED.includes(s.status)).length
  return needs ? `Project (${needs})` : 'Project'
}

async function reply($: EngineInterface, s: SessionRow, label: string) {
  const message = s.ask
    ? `The user answered your question "${clip(s.ask, 300)}" from the Project pane: ${label}`
    : `The user's reply, from the Project pane: ${label}`
  try {
    const r = await callSessions($, 'send_message', { session_id: s.id, message })
    $.ui.toast(`Sent "${label}" to ${s.title}${/queued/.test(r) ? ' (queued)' : ''}`)
    void refreshSessions($)
  } catch (err) {
    $.ui.toast(`Could not send to ${s.title}: ${errorText(err)}`, { timeoutMs: 8000 })
  }
}

async function archive($: EngineInterface, s: SessionRow) {
  try {
    const r = await callSessions($, 'archive_session', { session_id: s.id, reason: 'Stale, archived from the Project pane' })
    $.ui.toast(clip(r || `Archived ${s.title}`, 200))
    void refreshSessions($)
  } catch (err) {
    $.ui.toast(`Could not archive ${s.title}: ${errorText(err)}`, { timeoutMs: 8000 })
  }
}

// A row's `kids` counts the side chats under a top session (0 elsewhere); `family`
// holds them when they are folded away, so the row can stand for all of them.
type Item = { kind: 'row'; row: SessionRow; depth: number; kids: number; family?: SessionRow[] } | { kind: 'head'; text: string }

// Which status a folded family shows: the first of its sessions' statuses in this order.
const RANK: SessionStatus[] = ['failed', 'permission', 'needs-input', 'next-step', 'running', 'waiting', 'stopped', 'done', 'idle', 'stale']

// The session a folded family's row speaks for: the most important status, the newest on a tie.
function leadOf(top: SessionRow, family: readonly SessionRow[]): SessionRow {
  const rank = (s: SessionRow) => RANK.indexOf(s.status)
  return [top, ...family].reduce((a, b) => (rank(b) < rank(a) || (rank(b) === rank(a) && b.lastActivityAt > a.lastActivityAt) ? b : a))
}

// Sessions with their side chats under them, families ordered by their newest message.
function families(rows: SessionRow[]): { row: SessionRow; depth: number }[] {
  const ids = new Set(rows.map(r => r.id))
  const kids = new Map<string, SessionRow[]>()
  const tops: SessionRow[] = []
  for (const r of rows) {
    if (r.parentId && r.parentId !== r.id && ids.has(r.parentId)) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r])
    else tops.push(r)
  }
  const newest = (r: SessionRow, depth = 0): number =>
    depth > 6 ? r.lastActivityAt : Math.max(r.lastActivityAt, ...(kids.get(r.id) ?? []).map(k => newest(k, depth + 1)))
  const out: { row: SessionRow; depth: number }[] = []
  // Side chats of side chats are listed at one level under their top session, newest first.
  const below = (r: SessionRow, depth = 0): SessionRow[] =>
    depth > 6 ? [] : (kids.get(r.id) ?? []).flatMap(k => [k, ...below(k, depth + 1)])
  for (const t of tops.sort((a, b) => newest(b) - newest(a))) {
    out.push({ row: t, depth: 0 })
    for (const k of below(t).sort((a, b) => b.lastActivityAt - a.lastActivityAt)) out.push({ row: k, depth: 1 })
  }
  return out
}

function arrange(rows: SessionRow[], f: Filter, isStaleShown: boolean, folded: readonly string[]): { items: Item[]; staleCount: number } {
  const byRecency = (list: SessionRow[]) => [...list].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  const flat = (list: SessionRow[]): Item[] => byRecency(list).map(row => ({ kind: 'row', row, depth: 0, kids: 0 }))
  if (f === 'needs') return { items: flat(rows.filter(r => !r.isSelf && NEEDS_YOU.includes(r.status))), staleCount: 0 }
  if (f === 'running') return { items: flat(rows.filter(isActive)), staleCount: 0 }
  // Each top session with its side chats, the whole family judged before any folding.
  const all = families(rows)
  const kidsOf = new Map<string, SessionRow[]>()
  let head = ''
  for (const { row, depth } of all) {
    if (depth === 0) head = row.id
    else kidsOf.set(head, [...(kidsOf.get(head) ?? []), row])
  }
  // A family is stale when every session in it is.
  const isStaleFamily = (id: string) => [id, ...(kidsOf.get(id) ?? []).map(k => k.id)].every(x => rows.find(r => r.id === x)?.status === 'stale')
  head = ''
  const fam = all
    .filter(({ row, depth }) => {
      if (depth === 0) head = row.id
      return depth === 0 || !folded.includes(head)
    })
    .map(x => {
      const kids = x.depth === 0 ? (kidsOf.get(x.row.id) ?? []) : []
      return { ...x, kids: kids.length, ...(folded.includes(x.row.id) && kids.length ? { family: kids } : {}) }
    })
  const staleIds = new Set<string>()
  head = ''
  for (const { row, depth } of fam) {
    if (depth === 0) head = row.id
    if (isStaleFamily(head)) staleIds.add(row.id)
  }
  const live = fam.filter(x => !staleIds.has(x.row.id))
  const stale = fam.filter(x => staleIds.has(x.row.id))
  if (f === 'group') {
    const byId = new Map(rows.map(r => [r.id, r]))
    const groupOf = (r: SessionRow): string => r.group ?? (r.parentId && byId.get(r.parentId) ? groupOf(byId.get(r.parentId)!) : 'No group')
    const order: string[] = []
    const members = new Map<string, { row: SessionRow; depth: number; kids: number; family?: SessionRow[] }[]>()
    for (const x of [...live, ...(isStaleShown ? stale : [])]) {
      const g = groupOf(x.row)
      if (!members.has(g)) order.push(g)
      members.set(g, [...(members.get(g) ?? []), x])
    }
    order.sort((a, b) => (a === 'No group' ? 1 : b === 'No group' ? -1 : 0))
    const items: Item[] = []
    for (const g of order) {
      items.push({ kind: 'head', text: g })
      for (const x of members.get(g) ?? []) items.push({ kind: 'row', ...x })
    }
    return { items, staleCount: isStaleShown ? 0 : stale.length }
  }
  const items: Item[] = live.map(x => ({ kind: 'row', ...x }))
  if (isStaleShown) items.push({ kind: 'head', text: 'Stale' }, ...stale.map(x => ({ kind: 'row' as const, ...x })))
  return { items, staleCount: isStaleShown ? 0 : stale.length }
}

export const register: Register = (on, options) => {
  nodePath = typeof options.nodePath === 'string' ? options.nodePath.trim() : ''
  clusterHost = typeof options.clusterHost === 'string' ? options.clusterHost.trim() : ''
  clusterName = typeof options.clusterName === 'string' && options.clusterName.trim() ? options.clusterName.trim() : 'Cluster'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A refused command must not stop the timers below.
    await $.command
      .register({ name: 'project-tile', description: 'Open the Project pane: the sessions of this project and their status' })
      .catch((err: unknown) => $.ui.log(`project-tile: /project-tile not registered: ${errorText(err)}`, { to: 'debug' }))
    // The pane starts closed: the row above the prompt shows the counts and opens it.
    await update($, paneOpen, () => false)
    const folded = await $.store.get(COLLAPSED_KEY)
    if (Array.isArray(folded)) await update($, collapsed, () => folded.filter((x): x is string => typeof x === 'string'))
    void refreshSessions($)
    $.clock.every(SESSIONS_MS, () => void refreshSessions($))
    // The cluster is only shown in the pane.
    $.clock.every(CLUSTER_MS, () => void (isPaneOpen && refreshCluster($)))
    return started
  })

  on('command.run', { command: 'project-tile' }, async $ => {
    await showPane($, true)
    return { text: 'Project pane opened.' }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) {
      isPaneOpen = false
      await update($, paneOpen, () => false)
    }
    return closed
  })

  // One row above the prompt: the counts, and a button that opens or closes the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = await read($, sessions)
    const isOpen = await read($, paneOpen)
    const needs = rows.filter(s => !s.isSelf && COUNTED.includes(s.status)).length
    const busy = rows.filter(isActive).length
    const failed = rows.filter(s => !s.isSelf && s.status === 'failed').length
    const nextSteps = rows.filter(s => !s.isSelf && s.status === 'next-step').length
    return (
      <Box flexDirection="row" gap={1}>
        <Button key="project-toggle" plain label={isOpen ? 'Project ▾' : 'Project ▸'} onPress={() => void showPane($, !isOpen)} />
        <Text color={needs ? 'error' : 'subtle'} size="footnote">{`● ${needs} need you`}</Text>
        <Text color={nextSteps ? 'claude' : 'subtle'} size="footnote">{`● ${nextSteps} next step${nextSteps === 1 ? '' : 's'}`}</Text>
        <Text color={busy ? 'suggestion' : 'subtle'} size="footnote">{`● ${busy} running`}</Text>
        {failed ? <Text color="error" size="footnote">{`● ${failed} failed`}</Text> : null}
      </Box>
    )
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) void refreshSessions($)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = await read($, sessions)
    const f = await read($, filter)
    const isStaleShown = await read($, showStale)
    const k = await read($, kernels)
    const c = clusterHost ? await read($, cluster) : null
    const at = await read($, updatedAt)
    const open = await read($, expanded)
    const isResOpen = await read($, isResourcesOpen)
    const folded = await read($, collapsed)
    const needs = rows.filter(s => !s.isSelf && COUNTED.includes(s.status)).length
    const busy = rows.filter(isActive).length
    const counts = (
      <Box key="counts" flexDirection="row" gap={1}>
        <Text color={needs ? 'error' : 'subtle'} size="footnote">{`● ${needs} need you`}</Text>
        <Text color={busy ? 'suggestion' : 'subtle'} size="footnote">{`● ${busy} running`}</Text>
      </Box>
    )

    // A widget in a corner of the chat: a glance, since clicks may not reach it.
    if (e.props.placement === 'widget' && (e.props.anchoredEdges?.length ?? 0) > 0) {
      const top = rows.filter(s => !s.isSelf && COUNTED.includes(s.status)).slice(0, 3)
      return (
        <Box flexDirection="column">
          {counts}
          {top.map(s => (
            <Text size="footnote" wrap="truncate-end">{`${LABEL[s.status]} · ${s.title}`}</Text>
          ))}
        </Box>
      )
    }

    const { items, staleCount } = arrange(rows, f, isStaleShown, folded)
    const subtitle = (s: SessionRow) =>
      s.status === 'needs-input' && s.ask ? `Asks: ${s.ask}` : s.status === 'permission' ? `Waiting to approve: ${s.detail}` : s.detail
    const rowView = (s: SessionRow, depth: number, kids: number, family?: SessionRow[]) => {
      const isOpen = open === s.id
      const isFolded = folded.includes(s.id)
      const name = `${depth ? '↳ ' : ''}${s.title}${s.isSelf ? ' (here)' : ''}`
      // Folded, the row speaks for the family: the most important status (`lead`),
      // the newest time and everything the family is using.
      const members = [s, ...(family ?? [])]
      const lead = family ? leadOf(s, family) : s
      const newest = members.reduce((a, b) => (b.lastActivityAt > a.lastActivityAt ? b : a))
      const uses = [...new Set(members.flatMap(m => m.uses))]
      const status = lead.status
      const note = lead === s ? subtitle(s) : subtitle(lead) ? `↳ ${lead.title}: ${subtitle(lead)}` : ''
      return (
        <Box key={`item-${s.id}`} flexDirection="column" paddingLeft={depth * 2} marginBottom="xs">
          <Box flexDirection="row" gap={1} alignItems="center">
            {kids ? (
              <Box flexShrink={0}>
                <Button key={`fold-${s.id}`} plain label={isFolded ? '▸' : '▾'} onPress={() => void toggleFold($, s.id)} />
              </Box>
            ) : null}
            <Box flexShrink={0}>
              <Text color={COLOR[status]} size="footnote" weight="semibold">{`${kids ? '' : '● '}${LABEL[status]}`}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Button key={`open-${s.id}`} plain label={clip(name, 70)} onPress={() => void openSession($, s)} />
            </Box>
            <Box flexShrink={0}>
              <Text dimColor size="footnote">{isFolded && kids ? `${newest.ago} · ${kids} side chat${kids === 1 ? '' : 's'}` : s.ago}</Text>
            </Box>
            <Box flexShrink={0}>
              <Button key={`row-${s.id}`} plain dimColor label={isOpen ? '⋯ ▴' : '⋯'} onPress={() => update($, expanded, v => (v === s.id ? '' : s.id))} />
            </Box>
          </Box>
          {uses.length ? (
            <Text color="suggestion" size="footnote" wrap="truncate-end">
              {`⚙ ${uses.join(' · ')}`}
            </Text>
          ) : null}
          {isOpen ? (
            <Box flexDirection="column">
              {note ? <Text dimColor size="footnote">{note}</Text> : null}
              {s.files.length ? <Text dimColor size="footnote">{`Files: ${s.files.join(', ')}`}</Text> : null}
            </Box>
          ) : note ? (
            <Text dimColor size="footnote" wrap="truncate-end">
              {note}
            </Text>
          ) : null}
          {lead.options.length && !lead.isSelf ? (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {lead.options.map(o => (
                <Button key={`reply-${lead.id}-${o}`} label={o} onPress={() => void reply($, lead, o)} />
              ))}
            </Box>
          ) : null}
          {isOpen && status === 'stale' && !s.isSelf ? (
            <Box flexDirection="row">
              <Button key={`archive-${s.id}`} label="Archive" onPress={() => void archive($, s)} />
            </Box>
          ) : null}
        </Box>
      )
    }

    // The resources line: Wolfram kernels when any run, the cluster when one is set.
    const nKernels = k?.kernels.length ?? 0
    const nComputing = k?.kernels.filter(x => x.isBusy || x.kind.startsWith('script')).length ?? 0
    const hasWolfram = nKernels > 0 || Boolean(k?.error)
    const clusterLine = !c
      ? `${clusterName} …`
      : !c.isConnected
        ? `${clusterName} not connected`
        : `${clusterName} ${c.jobs.length} job${c.jobs.length === 1 ? '' : 's'}`
    const resources = !hasWolfram && !clusterHost ? null : (
      <Box key="resources-box" flexDirection="column" marginTop="sm">
        <Button key="resources" plain onPress={() => update($, isResourcesOpen, v => !v)}>
          {hasWolfram ? (
            <Text color={nComputing ? 'suggestion' : 'subtle'} size="footnote">
              {`Wolfram ${nKernels} kernel${nKernels === 1 ? '' : 's'}${nComputing ? ` (${nComputing} computing)` : ''}`}
            </Text>
          ) : null}
          {hasWolfram && clusterHost ? <Text color="subtle" size="footnote">{' · '}</Text> : null}
          {clusterHost ? (
            <Text color={c && !c.isConnected ? 'warning' : 'subtle'} size="footnote">
              {clusterLine}
            </Text>
          ) : null}
          <Text dimColor size="footnote">{isResOpen ? ' ▾' : ' ▸'}</Text>
        </Button>
        {isResOpen ? (
          <Box flexDirection="column" paddingLeft={2}>
            {k?.error ? <Text color="error" size="footnote">{k.error}</Text> : null}
            {(k?.kernels ?? []).map(x => (
              <Text dimColor size="footnote" wrap="truncate-end">{`${x.kind} · ${x.holder} · ${x.since}${x.isBusy ? ' · computing' : ''}`}</Text>
            ))}
            {k?.subkernels ? <Text dimColor size="footnote">{`+${k.subkernels} subkernels`}</Text> : null}
            {c && !c.isConnected ? (
              <Text dimColor size="footnote">{c.error || `No password-free ssh to ${clusterHost}: open a shared connection (ssh -fN ${clusterHost}) or add a key`}</Text>
            ) : null}
            {c?.isConnected && c.error ? <Text color="error" size="footnote">{c.error}</Text> : null}
            {(c?.jobs ?? []).map(j => (
              <Text dimColor size="footnote" wrap="truncate-end">
                {`${j.id} ${j.name} · ${JOB_STATE[j.state] ?? j.state} · ${j.elapsed}${j.array ? ` · ${j.array}` : ''}`}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" marginBottom="xs">
          {counts}
          <Button key="refresh" plain onPress={() => void refreshAll($)}>
            <Text dimColor size="footnote">{at ? `↻ ${at.slice(0, 5)}` : '↻'}</Text>
          </Button>
        </Box>
        <Box flexDirection="row" gap={2} marginBottom="sm" flexWrap="wrap">
          {FILTERS.map(x => (
            <Button key={`filter-${x.id}`} plain dimColor={x.id !== f} label={x.label} onPress={() => update($, filter, () => x.id)} />
          ))}
        </Box>
        {items.length === 0 ? <Text dimColor size="footnote">{at ? 'Nothing here' : 'Reading the sessions…'}</Text> : null}
        {items.map(it =>
          it.kind === 'head' ? (
            <Text weight="semibold" color="subtle" size="footnote">
              {it.text}
            </Text>
          ) : (
            rowView(it.row, it.depth, it.kids, it.family)
          ),
        )}
        {staleCount ? (
          <Button key="show-stale" plain onPress={() => update($, showStale, () => true)}>
            <Text dimColor size="footnote">{`Show ${staleCount} stale ▸`}</Text>
          </Button>
        ) : isStaleShown && f !== 'needs' && f !== 'running' ? (
          <Button key="hide-stale" plain onPress={() => update($, showStale, () => false)}>
            <Text dimColor size="footnote">Hide stale ▾</Text>
          </Button>
        ) : null}
        {resources}
      </Box>
    )
  })
}
