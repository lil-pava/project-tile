export type SessionStatus =
  | 'needs-input'
  | 'permission'
  | 'running'
  | 'next-step'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'waiting'
  | 'stale'
  | 'idle'

export type SessionRow = {
  /** The app's session id (`local_...`). */
  id: string
  title: string
  /** The session it was started or forked from, when that is in this project. */
  parentId: string | null
  isSideChat: boolean
  isSelf: boolean
  lastActivityAt: number
  ago: string
  status: SessionStatus
  /** The recap, the question or what the session is doing. */
  detail: string
  /** The question the reply buttons answer. */
  ask: string
  /** Reply labels from the session's next-step box. */
  options: string[]
  /** What it is using now: computing Wolfram kernels, scripts, background jobs, a wake-up. */
  uses: string[]
  /** Files the session edited last, newest first. */
  files: string[]
  /** The sidebar group, from the app. */
  group: string | null
  /** The app's link that opens the session (`claude://...`). */
  link: string
}

export type Kernel = {
  pid: number
  kind: string
  holder: string
  /** The app's id of the session holding it; '' when none. */
  holderId: string
  since: string
  /** Using CPU since the previous check. */
  isBusy: boolean
}

export type KernelInfo = {
  kernels: Kernel[]
  subkernels: number
  error: string
}

export type ClusterJob = { id: string; name: string; state: string; elapsed: string; array: string }

export type ClusterInfo = {
  isConnected: boolean
  jobs: ClusterJob[]
  error: string
  checkedAt: string
}

export type Filter = 'all' | 'needs' | 'running' | 'group'

declare module 'claude-code' {
  interface PluginState {
    'project-tile': {
      sessions: Shaped<SessionRow[]>
      kernels: Shaped<KernelInfo | null>
      cluster: Shaped<ClusterInfo | null>
      filter: Filter
      showStale: boolean
      /** The session whose row is opened to show its full text and files; '' for none. */
      expanded: string
      isResourcesOpen: boolean
      /** Sessions whose side chats are folded away. */
      collapsed: Shaped<string[]>
      /** Whether the Project pane is open, for the row above the prompt. */
      isPaneOpen: boolean
      updatedAt: string
    }
  }
}
