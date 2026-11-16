// Collector for the Project pane (Windows, macOS, Linux). Prints one JSON object to stdout.
//   node collect.mjs sessions <project root>   the project's sessions, their status and the Wolfram kernels
//   node collect.mjs kernels                    the Wolfram kernels and who holds them
//   node collect.mjs cluster <ssh host>         the PBS queue on that host, as qstat prints it
//   node collect.mjs open <claude:// link>      opens a session in the desktop app
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const HOME = os.homedir()
// Where the desktop app keeps its data (Electron's userData folder).
const APP_DATA = IS_WIN
  ? (process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming'))
  : IS_MAC
    ? path.join(HOME, 'Library', 'Application Support')
    : (process.env.XDG_CONFIG_HOME ?? path.join(HOME, '.config'))
const DESKTOP = path.join(APP_DATA, 'Claude', 'claude-code-sessions')
const PROJECTS = path.join(HOME, '.claude', 'projects')
const LIVE = path.join(HOME, '.claude', 'sessions')
const CACHE = path.join(os.tmpdir(), 'project-tile-cache-v4.json')
const TAIL_BYTES = 3_000_000
const STALE_MS = 3 * 86_400_000
const LONG_TOOL_MS = 90_000
const CPU_SAMPLES = path.join(os.tmpdir(), 'project-tile-cpu-v1.json')
// A kernel using more than this share of one core between two runs is computing.
const BUSY_CPU_SHARE = 0.1

// Paths compared as the file system does: Windows and macOS ignore case.
const norm = p => {
  let s = (p ?? '').replace(/[\\/]+$/, '')
  if (IS_WIN) s = s.replace(/\//g, '\\')
  return IS_WIN || IS_MAC ? s.toLowerCase() : s
}
const readJson = p => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const readdir = d => {
  try {
    return fs.readdirSync(d, { withFileTypes: true })
  } catch {
    return []
  }
}
const pad = n => String(n).padStart(2, '0')
const clock = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const ago = ms => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
const clip = (s, n) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const isAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// The app's record of each session: local_<id>.json under claude-code-sessions.
function desktopSessions() {
  const out = []
  const walk = d => {
    for (const n of readdir(d)) {
      const p = path.join(d, n.name)
      if (n.isDirectory()) walk(p)
      else if (/^local_.*\.json$/.test(n.name)) {
        const j = readJson(p)
        if (j?.sessionId) out.push(j)
      }
    }
  }
  walk(DESKTOP)
  return out
}

// Running Claude Code processes: ~/.claude/sessions/<pid>.json, keyed by pid and by the app's id.
function liveProcesses() {
  const byHost = new Map()
  const byPid = new Map()
  for (const n of readdir(LIVE)) {
    if (!/^\d+\.json$/.test(n.name)) continue
    const j = readJson(path.join(LIVE, n.name))
    if (!j?.pid || !isAlive(j.pid)) continue
    byPid.set(j.pid, j)
    if (j.hostSessionId) byHost.set(j.hostSessionId, j)
  }
  return { byHost, byPid }
}

function transcriptPath(cwd, cliId) {
  if (!cliId) return null
  // Claude Code names a project's folder after its path, every other character a dash.
  const slug = (cwd ?? '').replace(/[^A-Za-z0-9]/g, '-')
  const first = path.join(PROJECTS, slug, `${cliId}.jsonl`)
  if (fs.existsSync(first)) return first
  for (const n of readdir(PROJECTS)) {
    const p = path.join(PROJECTS, n.name, `${cliId}.jsonl`)
    if (n.isDirectory() && fs.existsSync(p)) return p
  }
  return null
}

function readTail(file) {
  const size = fs.statSync(file).size
  const n = Math.min(size, TAIL_BYTES)
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(n)
    fs.readSync(fd, buf, 0, n, size - n)
    const lines = buf.toString('utf8').split('\n')
    if (n < size) lines.shift()
    const out = []
    for (const l of lines) {
      if (!l) continue
      try {
        out.push(JSON.parse(l))
      } catch {}
    }
    return out
  } finally {
    fs.closeSync(fd)
  }
}

const blocksOf = e => {
  const c = e.message?.content
  if (typeof c === 'string') return [{ type: 'text', text: c }]
  return Array.isArray(c) ? c : []
}
const textOf = blocks =>
  blocks
    .map(b => (b.type === 'text' ? b.text : b.type === 'tool_result' ? resultText(b) : ''))
    .join('\n')
const resultText = b =>
  typeof b.content === 'string'
    ? b.content
    : Array.isArray(b.content)
      ? b.content.map(x => (x.type === 'text' ? x.text : '')).join('\n')
      : ''

// What the end of a transcript says about the session.
function readTranscript(file) {
  const entries = readTail(file)
  const uses = new Map()
  const answered = new Set()
  // Background task id -> when it was started (ms).
  const started = new Map()
  const ended = new Map()
  const files = []
  let lastOpener = -1
  let openerText = ''
  let lastAssistant = -1
  let lastText = ''
  let wrap = null
  let wrapAt = -1
  let wake = null
  let apiError = ''
  let plan = []
  let lastEntryTime = 0

  const noteEnds = (text, i) => {
    for (const m of text.matchAll(/<task-id>(\w+)<\/task-id>[\s\S]*?<status>(\w+)<\/status>(?:[\s\S]*?<summary>([\s\S]*?)<\/summary>)?/g))
      ended.set(m[1], { status: m[2], summary: m[3] ?? '', at: i })
  }
  entries.forEach((e, i) => {
    // A notification that arrives mid-turn is stored as a queued command, not a user row.
    if (e.type === 'attachment' && typeof e.attachment?.prompt === 'string') return noteEnds(e.attachment.prompt, -1)
    if (e.type === 'queue-operation' && typeof e.content === 'string') return noteEnds(e.content, -1)
    if (e.type !== 'user' && e.type !== 'assistant') return
    const t = Date.parse(e.timestamp ?? '')
    if (t) lastEntryTime = t
    const blocks = blocksOf(e)
    if (e.type === 'user') {
      const results = blocks.filter(b => b.type === 'tool_result')
      for (const r of results) {
        answered.add(r.tool_use_id)
        const rt = resultText(r)
        for (const m of rt.matchAll(/(?:running in background with ID: |moved to the background \(ID: )(\w+)/g)) started.set(m[1], t)
      }
      const text = textOf(blocks.filter(b => b.type === 'text'))
      noteEnds(text, i)
      if (results.length === 0 && !e.isMeta && text.trim()) {
        lastOpener = i
        openerText = text
        apiError = ''
      }
      return
    }
    lastAssistant = i
    apiError = e.isApiErrorMessage ? textOf(blocks) : ''
    for (const b of blocks) {
      if (b.type === 'text' && b.text?.trim()) lastText = b.text
      if (b.type !== 'tool_use') continue
      uses.set(b.id, { name: b.name, input: b.input ?? {}, at: i, time: t })
      const inp = b.input ?? {}
      if (b.name === 'mcp__ccd_turn__wrap_up') {
        wrap = inp
        wrapAt = i
      }
      if (b.name === 'ScheduleWakeup') wake = inp.stop ? null : { at: t + (inp.delaySeconds ?? 0) * 1000, setAt: t, reason: inp.reason ?? '' }
      if (b.name === 'mcp__ccd_turn__update_plan') plan = applyPlan(plan, inp)
      const fp = inp.file_path ?? inp.notebook_path
      if (fp && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name)) files.push(fp)
    }
  })

  const pending = [...uses.entries()].filter(([id]) => !answered.has(id)).map(([, u]) => u)
  const question = pending.find(u => u.name === 'AskUserQuestion')
  const planAsk = pending.find(u => u.name === 'ExitPlanMode')
  const running = pending.filter(u => u.name !== 'AskUserQuestion' && u.name !== 'ExitPlanMode').at(-1)
  const lastNote = [...ended.values()].at(-1)
  const lastNoteIsLast = lastNote && lastNote.at === lastOpener && lastOpener > lastAssistant
  // Start times of the background tasks with no completion note yet.
  const bgOpen = [...started].filter(([id]) => !ended.has(id)).map(([, at]) => at)
  const step = plan.find(p => p.status === 'in_progress')
  const stepNo = step ? plan.indexOf(step) + 1 : 0
  const recent = []
  for (const f of files.reverse()) {
    const b = path.basename(f)
    if (!recent.includes(b)) recent.push(b)
    if (recent.length === 4) break
  }

  return {
    question: question
      ? {
          text: question.input.questions?.[0]?.question ?? 'A question is waiting',
          options: (question.input.questions?.length === 1 ? question.input.questions[0].options ?? [] : []).map(o => o.label),
        }
      : null,
    isPlanWaiting: Boolean(planAsk),
    tool: running ? { name: running.name, since: running.time } : null,
    // A Wolfram tool call still waiting for its result.
    isWolframPending: pending.some(u => /^mcp__wolfram/i.test(u.name)),
    wrap: wrapAt > lastOpener ? wrap : null,
    lastText: lastAssistant > lastOpener ? lastText : '',
    isInterrupted: lastOpener >= 0 && /^\[Request interrupted/.test(openerText.trim()),
    apiError: lastAssistant >= lastOpener ? apiError : '',
    failedTask: lastNoteIsLast && /failed|killed|error/i.test(lastNote.status) ? lastNote.summary || `Background task ${lastNote.status}` : '',
    wake,
    bgOpen,
    step: step ? `Step ${stepNo}/${plan.length}: ${step.content}` : '',
    files: recent,
    lastEntryTime,
  }
}

function applyPlan(plan, inp) {
  if (Array.isArray(inp.items)) return inp.items.map(x => ({ content: String(x.content ?? ''), status: x.status }))
  const p = plan.map(x => ({ ...x }))
  if (inp.advance) {
    const i = p.findIndex(x => x.status === 'in_progress')
    if (i >= 0) p[i].status = 'completed'
    const j = p.findIndex(x => x.status === 'pending')
    if (j >= 0) p[j].status = 'in_progress'
  }
  for (const d of inp.done ?? []) if (p[d - 1]) p[d - 1].status = 'completed'
  if (inp.start && p[inp.start - 1]) {
    for (const x of p) if (x.status === 'in_progress') x.status = 'completed'
    p[inp.start - 1].status = 'in_progress'
  }
  return p
}

// Transcript readings, kept between runs while the file is unchanged.
function cachedTranscript(file, cache) {
  const st = fs.statSync(file)
  const key = `${st.size}:${st.mtimeMs}`
  if (cache[file]?.key === key) return { ...cache[file].value, mtimeMs: st.mtimeMs }
  const value = readTranscript(file)
  cache[file] = { key, value }
  return { ...value, mtimeMs: st.mtimeMs }
}

// Wake-ups and background jobs die with the process that made them: count only
// those made since the running process started.
function wakeOf(live, t, now) {
  const w = t?.wake
  if (!live || !w || w.at <= now || w.setAt < live.startedAt) return ''
  return `Wakes in ${ago(w.at - now)}${w.reason ? `: ${clip(w.reason, 120)}` : ''}`
}
const jobsOf = (live, t) => (live ? (t?.bgOpen ?? []).filter(at => at >= live.startedAt).length : 0)

function statusOf(d, live, t, now) {
  const s = d.postTurnSummary
  const lastActivity = d.lastActivityAt ?? 0
  const res = { status: 'idle', detail: '', ask: '', options: [] }
  if (live?.status === 'busy') {
    res.status = 'running'
    res.detail = t?.step || clip(t?.lastText, 160) || 'Working'
    if (t?.tool && now - t.tool.since > LONG_TOOL_MS)
      res.detail += ` · ${t.tool.name} for ${ago(now - t.tool.since)} (maybe waiting for approval)`
    return res
  }
  if (live && live.status && live.status !== 'idle') {
    res.status = 'permission'
    res.detail = `Waiting (${live.status})${t?.tool ? `: ${t.tool.name}` : ''}`
    return res
  }
  if (t?.question) return { status: 'needs-input', detail: clip(t.question.text, 240), ask: t.question.text, options: [] }
  if (t?.isPlanWaiting) return { ...res, status: 'needs-input', detail: 'A plan is waiting for approval' }
  if (d.interruptedAwaitingPerson) return { ...res, status: 'needs-input', detail: 'Interrupted, waiting for you' }
  if (t?.apiError) return { ...res, status: 'failed', detail: clip(t.apiError, 200) }
  if (t?.failedTask) return { ...res, status: 'failed', detail: clip(t.failedTask, 200) }
  if (t?.isInterrupted) return { ...res, status: 'stopped', detail: 'Stopped by you' }
  const w = t?.wrap
  const labels = w ? (w.actions ?? []).filter(a => a.label && !a.action).map(a => String(a.label)) : []
  if (w?.ask && w.blocked) return { status: 'needs-input', detail: clip(w.ask, 240), ask: w.ask, options: labels }
  if (w?.ask) return { status: 'next-step', detail: `${clip(w.recap, 200)} — ${clip(w.ask, 120)}`, ask: w.ask, options: labels }
  if (!w && s?.status_category === 'blocked' && s.needs_action)
    return { ...res, status: 'needs-input', detail: clip(s.needs_action, 240) }
  // Wake-ups and background jobs die with the process that made them: count only
  // those made since the running process started.
  const wake = wakeOf(live, t, now)
  if (wake) return { ...res, status: 'waiting', detail: wake }
  const jobs = jobsOf(live, t)
  if (jobs) return { ...res, status: 'waiting', detail: `${jobs} background job${jobs > 1 ? 's' : ''} running` }
  const recap = w?.recap ?? (s?.status_category && s.status_category !== 'blocked' ? s.status_detail : '') ?? ''
  if (w || recap) {
    res.status = 'done'
    res.detail = clip(recap || t?.lastText, 240)
  } else res.detail = clip(t?.lastText, 200)
  if (now - lastActivity > STALE_MS) res.status = 'stale'
  return res
}

function sessionsMode(root) {
  const now = Date.now()
  const cache = readJson(CACHE) ?? {}
  const fresh = {}
  const { byHost } = liveProcesses()
  const want = norm(root)
  const all = desktopSessions().filter(d => !d.isArchived && (norm(d.cwd) === want || norm(d.originCwd) === want))
  const self = process.env.PROJECT_TILE_SELF ?? ''
  let wolfram
  try {
    wolfram = wolframKernels(new Map(all.map(d => [d.sessionId, d.title])))
  } catch (err) {
    wolfram = { kernels: [], subkernels: 0, error: clip(String(err?.message ?? err), 160) }
  }
  const rows = all.map(d => {
    const live = byHost.get(d.sessionId) ?? null
    const file = transcriptPath(d.cwd, live?.sessionId ?? d.cliSessionId)
    let t = null
    if (file) {
      try {
        t = cachedTranscript(file, cache)
        fresh[file] = cache[file]
      } catch {}
    }
    // A side chat the person moved to the top level keeps its parent link, marked detached.
    const parent = d.lineageDetached ? null : (d.spawnedFrom?.sessionId ?? d.forkedFromSessionId ?? null)
    const st = statusOf(d, live, t, now)
    const uses = usesOf(d.sessionId, wolfram.kernels, jobsOf(live, t), wakeOf(live, t, now), Boolean(live && t?.isWolframPending))
    // Anything left for more than STALE_MS and using nothing is stale, whatever it was waiting for.
    if (!['running', 'permission', 'waiting'].includes(st.status) && !uses.length && now - (d.lastActivityAt ?? 0) > STALE_MS) {
      st.status = 'stale'
      st.options = []
    }
    return {
      id: d.sessionId,
      title: d.title || 'Untitled session',
      parentId: parent,
      isSideChat: !d.lineageDetached && Boolean(d.spawnedFrom?.btw || d.spawnedFrom?.sideSession),
      isSelf: Boolean(self) && (live?.sessionId === self || d.cliSessionId === self),
      lastActivityAt: d.lastActivityAt ?? 0,
      ago: ago(now - (d.lastActivityAt ?? 0)),
      ...st,
      uses,
      files: t?.files ?? [],
      group: null,
      link: `claude://claude.ai/epitaxy/${d.sessionId}`,
    }
  })
  try {
    fs.writeFileSync(CACHE, JSON.stringify(fresh))
  } catch {}
  rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return { clock: `${clock(new Date(now))}:${pad(new Date(now).getSeconds())}`, sessions: rows, kernels: wolfram }
}

// CPU time as ps prints it, in seconds: "[DD-]HH:MM:SS" (Linux) or "M:SS.ss" (macOS).
export function cpuSeconds(text) {
  const [days, rest] = text.includes('-') ? text.split('-') : ['0', text]
  const parts = rest.split(':').map(Number).reverse()
  return Number(days) * 86400 + (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600
}

// The output of `ps -axo pid=,ppid=,time=,lstart=,command=` and of `ps -axo pid=,comm=`,
// as the process table below.
export function parsePs(main, names) {
  const nameOf = new Map()
  for (const line of names.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/)
    if (m) nameOf.set(Number(m[1]), path.posix.basename(m[2]))
  }
  const procs = []
  for (const line of main.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    procs.push({ pid, ppid: Number(m[2]), cpu: cpuSeconds(m[3]), start: m[4], name: (nameOf.get(pid) ?? '').toLowerCase(), cmd: m[5] })
  }
  return procs
}

// Every process: pid, ppid, cpu (seconds), start (any stable text), name (lower case,
// without .exe) and command line.
function processTable() {
  if (IS_WIN) {
    const ps =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,KernelModeTime,UserModeTime,@{n='Start';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress"
    const raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    })
    return JSON.parse(raw).map(p => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      cpu: ((p.KernelModeTime ?? 0) + (p.UserModeTime ?? 0)) / 1e7,
      start: p.Start ?? '',
      name: (p.Name ?? '').toLowerCase().replace(/\.exe$/, ''),
      cmd: p.CommandLine ?? '',
    }))
  }
  const run = args => execFileSync('ps', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })
  return parsePs(run(['-axo', 'pid=,ppid=,time=,lstart=,command=']), run(['-axo', 'pid=,comm=']))
}

// The Wolfram kernels, the session holding each and whether it is computing. CPU
// use is measured between two runs (the previous sample is kept in CPU_SAMPLES).
function wolframKernels(titles) {
  const now = Date.now()
  const procs = processTable()
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const { byPid: live } = liveProcesses()
  const before = readJson(CPU_SAMPLES) ?? {}
  const after = {}
  // Seconds of CPU per second since the last run, or null on a first sample.
  const cpuShare = p => {
    const key = `${p.pid}:${p.start}`
    after[key] = { cpu: p.cpu, at: now }
    const prev = before[key]
    return prev && now > prev.at ? (p.cpu - prev.cpu) / ((now - prev.at) / 1000) : null
  }
  const isKernel = p => /^(wolfram|wolframkernel|mathkernel)$/.test(p.name)
  const isSubkernel = p => /-subkernel/i.test(p.cmd)
  const kernels = []
  let subkernels = 0
  for (const p of procs) {
    if (!isKernel(p)) continue
    if (isSubkernel(p)) {
      subkernels++
      continue
    }
    const parent = byPid.get(p.ppid)
    if (parent && isKernel(parent) && !isSubkernel(parent)) continue
    let holder = 'not started by Claude'
    let holderId = ''
    let script = ''
    let cur = parent
    for (let hops = 0; cur && hops < 12; hops++) {
      if (cur.name === 'wolframscript' && !script) {
        const m = cur.cmd.match(/-(?:file|script|f)\s+("([^"]+)"|(\S+))/i)
        script = m ? path.basename(m[2] ?? m[3]) : 'wolframscript'
      }
      const l = live.get(cur.pid)
      if (l) {
        holderId = l.hostSessionId ?? ''
        holder = titles.get(l.hostSessionId) ?? l.name ?? l.sessionId
        break
      }
      // The desktop app itself (and, on macOS, its helper processes).
      if (/^claude( helper.*)?$/.test(cur.name) && !/claude-code|--resume|--output-format/i.test(cur.cmd)) {
        holder = 'Claude desktop app'
        break
      }
      cur = byPid.get(cur.ppid)
    }
    const kind = /StartMCPServer/i.test(p.cmd) ? 'MCP' : script ? `script ${script}` : 'kernel'
    const share = cpuShare(p)
    const start = p.start ? new Date(p.start) : null
    kernels.push({
      pid: p.pid,
      kind,
      holder,
      holderId,
      since: start && !Number.isNaN(start.getTime()) ? clock(start) : '',
      isBusy: share !== null && share > BUSY_CPU_SHARE,
    })
  }
  try {
    fs.writeFileSync(CPU_SAMPLES, JSON.stringify(after))
  } catch {}
  return { kernels, subkernels, error: '' }
}

// What a session is using now: its computing kernels, its scripts, its jobs. The
// Wolfram tool may compute in a kernel the desktop app holds for all sessions
// (no holderId): a busy one counts for the sessions whose Wolfram call is pending.
function usesOf(id, kernels, jobs, wake, isWolframPending) {
  const mine = kernels.filter(k => k.holderId === id)
  const uses = []
  const isOwnBusy = mine.some(k => k.kind === 'MCP' && k.isBusy)
  const isSharedBusy = isWolframPending && kernels.some(k => !k.holderId && k.isBusy)
  if (isOwnBusy || isSharedBusy) uses.push('Wolfram computing')
  for (const k of mine.filter(k => k.kind.startsWith('script'))) uses.push(`Wolfram ${k.kind}`)
  if (jobs) uses.push(`${jobs} background job${jobs > 1 ? 's' : ''}`)
  if (wake) uses.push(wake)
  return uses
}

// The PBS queue on an ssh host. On Windows ssh runs in WSL, which has the ControlMaster
// connection sharing that Windows' own OpenSSH lacks.
function clusterMode(host) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'qstat.sh')
  const wsl = p => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`)
  const [cmd, args] = IS_WIN ? ['wsl', ['-e', 'bash', wsl(script), host]] : ['bash', [script, host]]
  try {
    return { stdout: execFileSync(cmd, args, { encoding: 'utf8', timeout: 40_000, windowsHide: true }) }
  } catch (err) {
    return { stdout: String(err.stdout ?? ''), error: clip(String(err.message ?? err), 160) }
  }
}

// Opens a claude:// link with whatever the system registered for it: the desktop app.
function openMode(link) {
  if (!/^claude:\/\/[\w./-]+$/.test(link ?? '')) return { error: 'not a claude:// link' }
  const [cmd, args] = IS_WIN ? ['explorer.exe', [link]] : IS_MAC ? ['open', [link]] : ['xdg-open', [link]]
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  return { opened: link }
}

// Run as a script only, so a test can import the parsers above.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [mode, arg] = process.argv.slice(2)
  const out =
    mode === 'kernels'
      ? wolframKernels(new Map(desktopSessions().map(d => [d.sessionId, d.title])))
      : mode === 'cluster'
        ? clusterMode(arg ?? '')
        : mode === 'open'
          ? openMode(arg)
          : sessionsMode(arg ?? process.cwd())
  process.stdout.write(JSON.stringify(out))
}
