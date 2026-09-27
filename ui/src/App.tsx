import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ApprovalCard } from './features/ApprovalCard'
import { ChangesPanel } from './features/ChangesPanel'
import { Composer } from './features/Composer'
import { Palette, type Action } from './features/Palette'
import { PlanStrip } from './features/PlanStrip'
import { SessionControls } from './features/SessionControls'
import { SessionRail } from './features/SessionRail'
import { Setup } from './features/Setup'
import { StatusBar } from './features/StatusBar'
import { Transcript } from './features/Transcript'
import { GOAL_MAX_TURNS, formatGoalLimit, parseGoalLimit, type GoalLimit } from './lib/goal'
import * as ipc from './lib/ipc'
import {
  MODE_BUSY,
  PLAN_UNSUPPORTED,
  modeChangeNeedsDaemon,
  modeNotice,
  nextMode,
  parseMode,
  wireMode,
  type Mode,
  type PlanSupport,
} from './lib/modes'
import {
  MODEL_ID_HINT,
  PROVIDER_REF_HINT,
  SETTINGS_BUSY,
  applyConfigureEcho,
  applyThinking,
  configureFailureText,
  deriveCaps,
  describeChange,
  displayAdjustable,
  effectiveIdentity,
  effortAdjustable,
  effortUnavailable,
  failureText,
  isProviderRef,
  isSaneModelId,
  sourceWords,
  type Caps,
} from './lib/overrides'
import {
  browserStore,
  describeRestore,
  forgetSettings,
  loadGoalLimit,
  loadSettings,
  patchMatches,
  pruneSettings,
  reapplyPlan,
  saveGoalLimit,
  savedFromState,
  settingsFromOverrides,
  updateSettings,
  type SavedSettings,
  type SettingsChange,
} from './lib/prefs'
import {
  NO_PARKED,
  liveMarks,
  park,
  routeParked,
  unpark,
  updateParked,
  without,
  type Parked,
} from './lib/roster'
import { helpText, parseInput, statusText } from './lib/slash'
import { loadRecentFolders, projectOf, rememberFolder } from './lib/workspace'
import {
  applyUpdate,
  beginGoal,
  clearApproval,
  continueGoal,
  createSession,
  isBusy,
  loadHistory,
  markCancelling,
  pushNotice,
  startTurn,
  stopGoal,
  withGoalLimit,
  withMode,
  type SessionState,
} from './lib/session'
import type {
  AgentChoice,
  ApprovalDecision,
  Configured,
  ConnectionInfo,
  OverridePatch,
  SessionSettings,
  SessionSummary,
} from './lib/types'

type ConnPhase =
  | { kind: 'connecting' }
  | { kind: 'connected'; info: ConnectionInfo }
  | { kind: 'lost' }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'failed'; message: string }

/** The palette reused as a picker. `token` lets a late fetch find its picker. */
interface Picker {
  token: number
  title: string
  placeholder: string
  actions: Action[]
  loading: boolean
  note: string | null
  fallback?: (query: string) => Action | null
  selectedId?: string
}

type PickerSpec = Pick<Picker, 'title' | 'placeholder' | 'fallback'> &
  Partial<Pick<Picker, 'actions' | 'loading' | 'note' | 'selectedId'>>

type Tone = 'info' | 'warn' | 'error'

const isMac = navigator.platform.toLowerCase().includes('mac')
const modKey = (event: KeyboardEvent) => (isMac ? event.metaKey : event.ctrlKey)
const shortPath = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

export default function App() {
  const [conn, setConn] = useState<ConnPhase>({ kind: 'connecting' })
  const [info, setInfo] = useState<ConnectionInfo | null>(null)
  const [agents, setAgents] = useState<AgentChoice[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [session, setSession] = useState<SessionState | null>(null)
  const [draft, setDraft] = useState('')
  const [showThoughts, setShowThoughts] = useState(false)
  const [showRail, setShowRail] = useState(true)
  const [showChanges, setShowChanges] = useState(true)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [opening, setOpening] = useState(false)
  const [approving, setApproving] = useState(false)
  const [recovery, setRecovery] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picker, setPicker] = useState<Picker | null>(null)
  const [configuring, setConfiguring] = useState(false)
  const [planSupport, setPlanSupport] = useState<PlanSupport>('unknown')

  const sessionRef = useRef<SessionState | null>(null)
  const draftRef = useRef('')
  draftRef.current = draft
  const pickerSeq = useRef(0)
  // A depth, not a flag: two restores can overlap when sessions are switched
  // quickly, and the first one ending must not unblock sending for the second.
  const configuringRef = useRef(false)
  const configuringDepth = useRef(0)
  const caps = useMemo(() => deriveCaps(info), [info])
  const capsRef = useRef<Caps>(caps)
  capsRef.current = caps
  const planSupportRef = useRef<PlanSupport>('unknown')
  const infoRef = useRef(info)
  infoRef.current = info
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const store = useMemo(() => browserStore(), [])
  const [recent, setRecent] = useState<string[]>(() => loadRecentFolders(store))
  // What the chooser starts with: the front session's project and agent
  // when a session is parked, else the most recent folder.
  const [setupFolder, setSetupFolder] = useState<string | null>(null)
  const [setupAgent, setSetupAgent] = useState<string | null>(null)
  // App-wide, not per session: how many turns a goal may run on its own.
  const [goalLimit, setGoalLimitState] = useState<GoalLimit>(() => loadGoalLimit(store))
  const goalLimitRef = useRef(goalLimit)
  goalLimitRef.current = goalLimit
  // Assigned once `restoreSettings` exists; opening and reconnecting call it.
  const restoreRef = useRef<
    (target: SessionState, saved: SavedSettings | null, running: boolean) => Promise<void>
  >(async () => {})

  // Changes apply to the ref first, then publish to React. Every write goes
  // through here or `install`, so the ref is always the latest state and a
  // callback can read it straight after a change instead of after a render.
  const mutate = useCallback((fn: (current: SessionState) => SessionState) => {
    const current = sessionRef.current
    if (!current) return
    const next = fn(current)
    if (next === current) return
    sessionRef.current = next
    setSession(next)
  }, [])

  const install = useCallback((next: SessionState | null) => {
    sessionRef.current = next
    setSession(next)
  }, [])

  // Sessions opened here but not in front. They stay live on the daemon and
  // keep receiving their events; see lib/roster.ts.
  const [parked, setParkedState] = useState<Parked>(NO_PARKED)
  const parkedRef = useRef<Parked>(NO_PARKED)
  const setParked = useCallback((next: Parked) => {
    parkedRef.current = next
    setParkedState(next)
  }, [])

  /** Change one open session, in front or parked. Unknown ids are ignored. */
  const mutateAny = useCallback(
    (sessionId: string, fn: (session: SessionState) => SessionState) => {
      if (sessionRef.current?.sessionId === sessionId) mutate(fn)
      else setParked(updateParked(parkedRef.current, sessionId, fn))
    },
    [mutate, setParked],
  )

  /** Set the front session aside, still live, and show the chooser. */
  const parkFront = useCallback(() => {
    const current = sessionRef.current
    if (current) {
      setParked(park(parkedRef.current, current))
      setSetupFolder(projectOf(current.workspaceDir))
      setSetupAgent(current.agentAlias)
    }
    install(null)
  }, [install, setParked])

  // Assigned once `reloadTranscript` exists; the update listener calls it.
  const reloadRef = useRef<(sessionId: string) => Promise<void>>(async () => {})

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await ipc.sessionList())
    } catch {
      // A daemon without the ACP listing simply shows no history.
    }
  }, [])

  /** Post a notice to one open session, in front or parked. */
  const notify = useCallback(
    (sessionId: string, text: string, tone: Tone = 'info') => {
      mutateAny(sessionId, (s) => pushNotice(s, text, tone))
    },
    [mutateAny],
  )

  /**
   * Replace a session's transcript with what the daemon has persisted. Used
   * when a turn that was already running when the session was opened here
   * ends: what streamed here was only the tail of it.
   */
  const reloadTranscript = useCallback(
    async (sessionId: string) => {
      try {
        const messages = await ipc.sessionMessages(sessionId)
        mutateAny(sessionId, (s) => loadHistory(s, messages))
      } catch {
        // What streamed here stays on screen.
      }
      setRecovery((r) => (r === sessionId ? null : r))
    },
    [mutateAny],
  )
  reloadRef.current = reloadTranscript

  /** Remember what the daemon confirmed, so a reopened session can get it back. */
  const persist = useCallback(
    (sessionId: string, change: SettingsChange) => {
      const endpoint = infoRef.current?.endpoint
      if (endpoint) updateSettings(store, endpoint, sessionId, change)
    },
    [store],
  )

  useEffect(() => {
    pruneSettings(store)
  }, [store])

  /** Read the configured provider and model a session falls back to. */
  const loadIdentity = useCallback(
    async (target: { sessionId: string; agentAlias: string }, modelProvider?: string | null) => {
      if (!capsRef.current.identity) return
      try {
        const identity = await ipc.sessionIdentity({ agentAlias: target.agentAlias, modelProvider })
        mutateAny(target.sessionId, (s) => ({ ...s, identity }))
      } catch {
        // Display only: an unknown default reads as "default".
      }
    },
    [mutateAny],
  )

  const updatePlanSupport = useCallback((value: PlanSupport) => {
    planSupportRef.current = value
    setPlanSupport(value)
  }, [])

  // What was learned about plan mode belongs to one daemon process.
  useEffect(() => {
    updatePlanSupport('unknown')
  }, [info?.endpoint, info?.serverPid, updatePlanSupport])

  // ── Connection lifecycle ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const boot = async () => {
      try {
        const existing = await ipc.connectionInfo()
        const connected = existing ?? (await ipc.connect(true))
        if (cancelled) return
        setInfo(connected)
        setConn({ kind: 'connected', info: connected })
      } catch (e) {
        if (!cancelled) setConn({ kind: 'failed', message: String(e) })
      }
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (conn.kind !== 'connected') return
    void (async () => {
      try {
        setAgents(await ipc.agentsList())
      } catch (e) {
        setError(String(e))
      }
      await refreshSessions()
    })()
  }, [conn.kind, refreshSessions])

  // ── Streamed updates ────────────────────────────────────────────
  // Registration is async, so a listener can outlive the effect that made it
  // while its unlisten is still in flight. The `active` guard makes a stale
  // listener inert immediately; without it a re-registration can apply the
  // same chunk twice and corrupt the transcript.
  useEffect(() => {
    let active = true
    let stop: (() => void) | undefined
    void ipc
      .onSessionUpdate((update) => {
        if (!active) return
        const front = sessionRef.current
        if (front && front.sessionId === update.session_id) {
          const adopted = front.adoptedTurn
          mutate((current) => applyUpdate(current, update))
          // The turn ran partly before this window watched it, so what
          // streamed here is a fragment; the daemon has the whole turn now.
          if (adopted && update.type === 'turn_complete') void reloadRef.current(update.session_id)
        } else {
          setParked(routeParked(parkedRef.current, update))
        }
        if (update.type === 'turn_complete') void refreshSessions()
      })
      .then((un) => {
        stop = un
        if (!active) un()
      })
    return () => {
      active = false
      stop?.()
    }
  }, [mutate, refreshSessions, setParked])

  // ── Connection events, including reconnect recovery ─────────────
  useEffect(() => {
    let active = true
    let stop: (() => void) | undefined
    void ipc
      .onConnection((event) => {
        if (!active) return
      if (event.status === 'lost') {
        setConn({ kind: 'lost' })
        return
      }
      if (event.status === 'reconnecting') {
        setConn({ kind: 'reconnecting', attempt: event.attempt })
        return
      }
      if (event.status === 'failed') {
        setConn({ kind: 'failed', message: event.message })
        return
      }

      setInfo(event.info)
      setConn({ kind: 'connected', info: event.info })
      if (!event.resumed) return

      // Parked sessions had their events bound to the old connection, and
      // the daemon cancelled their turns when it dropped. They are set aside
      // rather than shown stale; the rail reopens them.
      const setAside = parkedRef.current.size
      if (setAside > 0) setParked(NO_PARKED)

      // Re-attach the open session: resuming rebinds ownership to this
      // connection, which cancel needs, then reload the transcript the
      // daemon persisted while we were away.
      const open = sessionRef.current
      if (!open) {
        if (setAside > 0) {
          setError(
            `${setAside} open session${setAside === 1 ? ' was' : 's were'} set aside when the connection dropped. Reopen them from the rail.`,
          )
        }
        return
      }
      void (async () => {
        try {
          const reopened = await ipc.sessionOpen({
            agentAlias: open.agentAlias,
            sessionId: open.sessionId,
          })
          const running = reopened.state === 'running'
          const rebuilt = loadHistory(
            createSession({
              sessionId: reopened.sessionId,
              agentAlias: reopened.agentAlias,
              workspaceDir: reopened.workspaceDir,
              branch: reopened.branch,
              hash: reopened.hash,
              plan: reopened.plan as never,
              running,
            }),
            reopened.messages,
          )
          install(rebuilt)
          if (open.goal) {
            notify(rebuilt.sessionId, 'Goal stopped: the connection to the daemon dropped during the run.', 'warn')
          }
          if (setAside > 0) {
            notify(
              rebuilt.sessionId,
              `${setAside} other open session${setAside === 1 ? ' was' : 's were'} set aside when the connection dropped; the daemon cancelled any turn running there. Reopen them from the rail.`,
              'warn',
            )
          }
          if (running) setRecovery(reopened.sessionId)
          // The daemon may have restarted and forgotten everything, so send
          // what this window last had confirmed.
          void restoreRef.current(rebuilt, savedFromState(open.overrides, open.mode), running)
        } catch (e) {
          setError(String(e))
        }
      })()
      })
      .then((un) => {
        stop = un
        if (!active) un()
      })
    return () => {
      active = false
      stop?.()
    }
  }, [install, notify, setParked])

  // ── Session actions ─────────────────────────────────────────────
  const openSession = useCallback(
    async (request: {
      agentAlias: string
      cwd?: string
      sessionId?: string
    }): Promise<string | null> => {
      setOpening(true)
      setError(null)
      try {
        // A session this window already has open comes back exactly as it
        // was, and the one in front takes its place in the background.
        if (request.sessionId) {
          const kept = unpark(parkedRef.current, request.sessionId)
          if (kept) {
            const front = sessionRef.current
            setParked(
              front && front.sessionId !== kept.session.sessionId
                ? park(kept.parked, front)
                : kept.parked,
            )
            install(kept.session)
            return kept.session.sessionId
          }
        }

        // A session another client is actively running would have its cancel
        // ownership taken over by this resume, so confirm before stealing it.
        if (request.sessionId) {
          const live = await ipc.sessionState(request.sessionId)
          if (live.state === 'running') {
            const proceed = window.confirm(
              'That session is running right now, possibly in another client.\n\nOpen it here anyway? This window will take over its controls.',
            )
            if (!proceed) return null
          }
        }

        const opened = await ipc.sessionOpen({
          agentAlias: request.agentAlias,
          cwd: request.cwd ?? null,
          sessionId: request.sessionId ?? null,
        })
        const running = opened.state === 'running'
        const next = loadHistory(
          createSession({
            sessionId: opened.sessionId,
            agentAlias: opened.agentAlias,
            workspaceDir: opened.workspaceDir,
            branch: opened.branch,
            hash: opened.hash,
            plan: opened.plan as never,
            running,
          }),
          opened.messages,
        )
        const endpoint = infoRef.current?.endpoint
        const stored =
          request.sessionId && endpoint ? loadSettings(store, endpoint, opened.sessionId) : null
        // Plan mode is a restriction and comes back on its own. Goal mode
        // arms an autonomous loop on the next message, so a session last used
        // that way opens in build mode and says so; Shift+Tab goes back.
        const saved = stored?.mode === 'goal' ? { ...stored, mode: 'build' as const } : stored
        const front = sessionRef.current
        if (front && front.sessionId !== next.sessionId) setParked(park(parkedRef.current, front))
        install(next)
        if (stored?.mode === 'goal') {
          notify(
            next.sessionId,
            'This session was last in goal mode. It opens in build mode; press Shift+Tab to go back to goal.',
          )
        }
        if (running) setRecovery(opened.sessionId)
        void restoreRef.current(next, saved, running)
        await refreshSessions()
        return next.sessionId
      } catch (e) {
        setError(String(e))
        return null
      } finally {
        setOpening(false)
      }
    },
    [install, notify, refreshSessions, setParked, store],
  )

  /**
   * Start a session from a project folder. In a git checkout the session can
   * get a worktree of its own at <folder>/<timestamp> on a new branch, so
   * several sessions can work on one repository without touching each
   * other's files. `auto` takes a worktree when the folder is a checkout.
   */
  const startSession = useCallback(
    async (agentAlias: string, folder: string, worktree: boolean | 'auto') => {
      setOpening(true)
      setError(null)
      try {
        let wanted = worktree === true
        if (worktree === 'auto') {
          const info = await ipc.inspectFolder(folder)
          wanted = info.repoRoot !== null && info.gitAvailable
        }
        const prepared = await ipc.prepareWorkspace({ folder, worktree: wanted })
        setRecent(rememberFolder(store, prepared.project))
        const sessionId = await openSession({ agentAlias, cwd: prepared.cwd })
        if (sessionId && prepared.worktree) {
          notify(
            sessionId,
            `Working in a worktree of ${shortPath(prepared.project)}: ${shortPath(prepared.worktree.path)}, on branch ${prepared.worktree.branch} from ${prepared.worktree.base}. The checkout itself is untouched.`,
          )
        }
      } catch (e) {
        setError(failureText(e))
      } finally {
        setOpening(false)
      }
    },
    [notify, openSession, store],
  )

  /**
   * Start a turn locally and send it. What is sent can differ from what the
   * transcript shows: a goal sends its preamble but shows the objective.
   */
  const submit = useCallback(
    (next: SessionState, sent: string, fromDraft: boolean) => {
      install(next)
      if (fromDraft) setDraft('')
      ipc.sessionPrompt(next.sessionId, sent, next.generation).catch((e) => {
        mutate((s) => {
          if (s.sessionId !== next.sessionId) return s
          const failed: SessionState = { ...pushNotice(s, String(e), 'error'), phase: 'idle' }
          return stopGoal(failed, 'Goal stopped: the prompt could not be sent.')
        })
      })
    },
    [install, mutate],
  )

  const cancel = useCallback(() => {
    const current = sessionRef.current
    if (!current || !isBusy(current)) return
    mutate(markCancelling)
    ipc.sessionCancel(current.sessionId).catch((e) => {
      mutate((s) => pushNotice(s, String(e), 'error'))
    })
  }, [mutate])

  const decide = useCallback(
    (decision: ApprovalDecision) => {
      const current = sessionRef.current
      const approval = current?.pendingApproval
      if (!current || !approval) return
      setApproving(true)
      ipc
        .sessionApprove({
          sessionId: current.sessionId,
          requestId: approval.requestId,
          decision,
        })
        .then((acknowledged) => {
          mutate(clearApproval)
          if (!acknowledged) {
            mutate((s) =>
              pushNotice(s, 'The daemon had already resolved that request.', 'warn'),
            )
          }
        })
        .catch((e) => mutate((s) => pushNotice(s, String(e), 'error')))
        .finally(() => setApproving(false))
    },
    [mutate],
  )

  const closeSession = useCallback(async () => {
    const current = sessionRef.current
    if (!current) return
    try {
      await ipc.sessionClose(current.sessionId)
    } catch {
      // Closing a session the daemon already dropped is not an error here.
    }
    setParked(without(parkedRef.current, current.sessionId))
    install(null)
    await refreshSessions()
  }, [install, refreshSessions, setParked])

  // ── Session settings ────────────────────────────────────────────
  const openPicker = useCallback((spec: PickerSpec): number => {
    pickerSeq.current += 1
    const token = pickerSeq.current
    setPicker({ actions: [], loading: false, note: null, ...spec, token })
    return token
  }, [])

  // A list fetched after the picker opened lands only if that picker is
  // still the one on screen.
  const fillPicker = useCallback((token: number, patch: Partial<Picker>) => {
    setPicker((open) => (open && open.token === token ? { ...open, ...patch } : open))
  }, [])

  const setConfiguringFlag = useCallback((value: boolean) => {
    configuringDepth.current = Math.max(0, configuringDepth.current + (value ? 1 : -1))
    const active = configuringDepth.current > 0
    configuringRef.current = active
    setConfiguring(active)
  }, [])

  /**
   * Send one settings patch. Refused locally while a turn runs, so a change
   * never lands halfway through one, and sending waits until the daemon
   * confirms, so a prompt never runs under settings the UI only assumed.
   */
  const configure = useCallback(
    async (patch: OverridePatch, reset?: string[]): Promise<Configured | null> => {
      const current = sessionRef.current
      if (!current) return null
      if (isBusy(current)) {
        notify(current.sessionId, SETTINGS_BUSY, 'warn')
        return null
      }
      if (configuringRef.current) return null
      setConfiguringFlag(true)
      try {
        const result = await ipc.sessionConfigure({
          sessionId: current.sessionId,
          overrides: patch,
          reset,
        })
        mutate((s) => applyConfigureEcho(s, patch, result))
        persist(current.sessionId, settingsFromOverrides(result.overrides))
        const said = describeChange(patch, result, reset)
        if (said) notify(current.sessionId, said)
        return result
      } catch (e) {
        notify(current.sessionId, configureFailureText(e), 'error')
        return null
      } finally {
        setConfiguringFlag(false)
      }
    },
    [mutate, notify, persist, setConfiguringFlag],
  )

  /** Settings pickers open only on an idle session the daemon can configure. */
  const settingsTarget = useCallback((): SessionState | null => {
    const current = sessionRef.current
    if (!current || !capsRef.current.configure) return null
    if (isBusy(current)) {
      notify(current.sessionId, SETTINGS_BUSY, 'warn')
      return null
    }
    return current
  }, [notify])

  const openModelPicker = useCallback(
    (forProvider?: string) => {
      const current = settingsTarget()
      if (!current) return
      const identity = effectiveIdentity(current)
      const provider = forProvider ?? identity.provider
      const listable = provider !== null && capsRef.current.catalog
      const token = openPicker({
        title: provider ? `Model for ${provider}` : 'Model',
        placeholder: 'Search models, or type a model id',
        loading: listable,
        note: provider ? null : 'The provider for this session is not known, so there is no list. Type a model id.',
        // The daemon does not check a model id against the catalogue, and the
        // catalogue can lag a provider, so a typed id is always offered.
        fallback: (query) =>
          isSaneModelId(query)
            ? {
                id: 'model:typed',
                label: `Use model "${query}"`,
                run: () => void configure({ model: query }),
              }
            : null,
      })
      if (!listable || provider === null) return
      ipc.catalogModels(provider).then(
        (catalog) =>
          fillPicker(token, {
            loading: false,
            selectedId: identity.model && provider === identity.provider ? `model:${identity.model}` : undefined,
            note:
              catalog.models.length === 0
                ? `No models listed for ${provider}. Type a model id.`
                : catalog.truncated
                  ? `Showing the first ${catalog.models.length} of a longer list. Type an id for any other.`
                  : null,
            actions: catalog.models.map((model) => ({
              id: `model:${model}`,
              label: model,
              hint:
                model === identity.model && provider === identity.provider ? 'current' : undefined,
              run: () => void configure({ model }),
            })),
          }),
        (e) => fillPicker(token, { loading: false, note: `Could not list models: ${failureText(e)}` }),
      )
    },
    [configure, fillPicker, openPicker, settingsTarget],
  )

  const chooseProvider = useCallback(
    async (reference: string) => {
      const current = sessionRef.current
      if (!current) return
      const result = await configure({ modelProvider: reference })
      if (!result || result.overrides.model !== null) return
      // The daemon falls back to the new provider's configured model. Show it,
      // then offer that provider's list, as zerocode does.
      await loadIdentity(current, reference)
      openModelPicker(reference)
    },
    [configure, loadIdentity, openModelPicker],
  )

  const openProviderPicker = useCallback(() => {
    const current = settingsTarget()
    if (!current || !capsRef.current.providers) return
    const active = effectiveIdentity(current).provider
    const token = openPicker({
      title: 'Provider',
      placeholder: 'Search configured providers',
      loading: true,
    })
    ipc.modelProviders().then(
      (references) =>
        fillPicker(token, {
          loading: false,
          selectedId: active ? `provider:${active}` : undefined,
          note: references.length === 0 ? 'This daemon has no configured providers.' : null,
          actions: references.map((reference) => ({
            id: `provider:${reference}`,
            label: reference,
            hint: reference === active ? 'current' : undefined,
            run: () => void chooseProvider(reference),
          })),
        }),
      (e) => fillPicker(token, { loading: false, note: `Could not list providers: ${failureText(e)}` }),
    )
  }, [chooseProvider, fillPicker, openPicker, settingsTarget])

  /**
   * Switch mode. Only a change between plan and anything else reaches the
   * daemon, and the mode changes here only once the daemon confirms it, so
   * the UI never claims a restriction the daemon is not enforcing.
   */
  const setMode = useCallback(
    async (next: Mode): Promise<boolean> => {
      const current = sessionRef.current
      if (!current) return false
      if (current.mode === next) return true
      if (isBusy(current)) {
        notify(current.sessionId, MODE_BUSY, 'warn')
        return false
      }
      if (configuringRef.current) return false
      const sessionId = current.sessionId
      const enter = (s: SessionState) =>
        s.sessionId === sessionId
          ? pushNotice(withMode(s, next), modeNotice(next, goalLimitRef.current))
          : s

      if (!modeChangeNeedsDaemon(current.mode, next)) {
        mutate(enter)
        persist(sessionId, { mode: next })
        return true
      }
      if (next === 'plan' && (!capsRef.current.configure || planSupportRef.current === 'unsupported')) {
        // Without session/configure there is no way to ask, so plan leaves
        // the cycle rather than stopping it at this step every time.
        updatePlanSupport('unsupported')
        notify(sessionId, PLAN_UNSUPPORTED, 'warn')
        return false
      }

      const requested = { mode: wireMode(next) }
      setConfiguringFlag(true)
      try {
        const result = await ipc.sessionConfigure({ sessionId, overrides: requested })
        mutate((s) => applyConfigureEcho(s, requested, result))
        persist(sessionId, settingsFromOverrides(result.overrides))
        // A daemon without plan mode drops the field instead of refusing it.
        if (result.droppedFields.includes('mode')) {
          updatePlanSupport('unsupported')
          if (next === 'plan') {
            notify(sessionId, PLAN_UNSUPPORTED, 'warn')
            return false
          }
        } else if (result.overrides.mode !== requested.mode) {
          // The daemon answered with some other mode. Whatever it is running,
          // the UI must not claim a restriction the daemon did not confirm.
          notify(
            sessionId,
            `The daemon left this session in ${result.overrides.mode ?? 'its current'} mode instead of ${requested.mode}. Nothing changed here.`,
            'warn',
          )
          return false
        } else {
          updatePlanSupport('supported')
        }
        mutate(enter)
        persist(sessionId, { mode: next })
        return true
      } catch (e) {
        notify(sessionId, configureFailureText(e), 'error')
        return false
      } finally {
        setConfiguringFlag(false)
      }
    },
    [mutate, notify, persist, setConfiguringFlag, updatePlanSupport],
  )

  const cycleMode = useCallback(() => {
    const current = sessionRef.current
    if (current) void setMode(nextMode(current.mode, planSupportRef.current))
  }, [setMode])

  /**
   * Put a reopened session back the way it was: one configure with the saved
   * overrides, then the mode. A live reattach on a daemon that can report
   * its overrides skips the configure when they are already in place, since
   * a model override otherwise rebuilds the session's provider for nothing.
   */
  const restoreSettings = useCallback(
    async (target: SessionState, saved: SavedSettings | null, running: boolean) => {
      const sessionId = target.sessionId
      const isOpen = () => sessionRef.current?.sessionId === sessionId
      const plan = saved
        ? reapplyPlan(saved, {
            thinking: capsRef.current.thinkingOptions,
            planSupport: planSupportRef.current,
          })
        : null

      const patch = plan?.patch && capsRef.current.configure ? plan.patch : null
      const readsThinking = capsRef.current.thinkingOptions
      if (patch || readsThinking) {
        setConfiguringFlag(true)
        try {
          // Where the daemon can report a session's settings, read them first:
          // they are the truth, and they may already hold what was saved.
          let live: SessionSettings | null = null
          if (readsThinking) {
            live = await ipc.sessionThinkingOptions(sessionId).catch(() => null)
            const report = live
            if (report) {
              mutate((s) => {
                if (s.sessionId !== sessionId) return s
                const withOverrides = { ...s, overrides: { ...report.overrides } }
                return report.thinkingOptions
                  ? applyThinking(withOverrides, report.thinkingOptions)
                  : withOverrides
              })
            }
          }
          if (patch && !(live && patchMatches(patch, live.overrides))) {
            const result = await ipc.sessionConfigure({ sessionId, overrides: patch })
            mutate((s) => applyConfigureEcho(s, patch, result))
            persist(sessionId, settingsFromOverrides(result.overrides))
            notify(sessionId, describeRestore(patch, result.droppedFields), result.droppedFields.length ? 'warn' : 'info')
          }
        } catch (e) {
          notify(sessionId, `Could not restore this session's saved settings. ${configureFailureText(e)}`, 'warn')
        } finally {
          setConfiguringFlag(false)
        }
      }

      if (!isOpen()) return
      // A thinking report already named the provider and model.
      if (!sessionRef.current?.thinking) {
        await loadIdentity(target, sessionRef.current?.overrides.modelProvider ?? null)
      }

      if (!plan || !isOpen()) return
      if (plan.mode === 'goal') {
        mutate((s) =>
          s.sessionId === sessionId
            ? pushNotice(withMode(s, 'goal'), 'Goal mode restored. Your next message becomes the objective.')
            : s,
        )
      } else if (plan.mode === 'plan') {
        if (running) {
          notify(
            sessionId,
            'This session was in plan mode, but a turn is still running, so it is in build mode for now. Switch back with Shift+Tab once the turn ends.',
            'warn',
          )
        } else {
          await setMode('plan')
        }
      }
    },
    [loadIdentity, mutate, notify, persist, setConfiguringFlag, setMode],
  )
  restoreRef.current = restoreSettings

  const openEffortPicker = useCallback(() => {
    const current = settingsTarget()
    if (!current) return
    const thinking = current.thinking
    if (!thinking || !effortAdjustable(current)) {
      notify(current.sessionId, effortUnavailable(current, capsRef.current), 'warn')
      return
    }
    const actions: Action[] = thinking.levels.map((level) => ({
      id: `effort:${level}`,
      label: level,
      hint:
        level === thinking.currentLevel ? `current, ${sourceWords(thinking.levelSource)}` : undefined,
      run: () => void configure({ thinkingLevel: level }),
    }))
    if (current.overrides.thinkingLevel) {
      actions.push({
        id: 'effort:default',
        label: 'Go back to the default',
        hint: 'profile or model',
        run: () => void configure({}, ['thinking_level']),
      })
    }
    openPicker({
      title: `Reasoning effort for ${thinking.model || 'this model'}`,
      placeholder: 'Search levels',
      actions,
      selectedId: thinking.currentLevel ? `effort:${thinking.currentLevel}` : undefined,
    })
  }, [configure, notify, openPicker, settingsTarget])

  const openDisplayPicker = useCallback(() => {
    const current = settingsTarget()
    if (!current) return
    const thinking = current.thinking
    if (!thinking || !displayAdjustable(current)) {
      notify(
        current.sessionId,
        `The model ${thinking?.model || 'in use'} has no thinking display this daemon can change.`,
        'warn',
      )
      return
    }
    const actions: Action[] = thinking.displays.map((display) => ({
      id: `display:${display}`,
      label: display,
      hint:
        display === thinking.currentDisplay
          ? `current, ${sourceWords(thinking.displaySource)}`
          : undefined,
      run: () => void configure({ thinkingDisplay: display }),
    }))
    if (current.overrides.thinkingDisplay) {
      actions.push({
        id: 'display:default',
        label: 'Go back to the default',
        run: () => void configure({}, ['thinking_display']),
      })
    }
    openPicker({
      title: `Thinking display for ${thinking.model || 'this model'}`,
      placeholder: 'Search display kinds',
      actions,
      selectedId: thinking.currentDisplay ? `display:${thinking.currentDisplay}` : undefined,
    })
  }, [configure, notify, openPicker, settingsTarget])

  /**
   * `/effort <level>` and `/display <kind>`. Checked against what the
   * session's model accepts, so a typo is caught before the round trip.
   */
  const setThinkingByName = useCallback(
    (field: 'level' | 'display', arg: string): boolean => {
      const current = sessionRef.current
      if (!current) return false
      const thinking = current.thinking
      const adjustable = field === 'level' ? effortAdjustable(current) : displayAdjustable(current)
      if (!thinking || !adjustable) {
        notify(
          current.sessionId,
          field === 'level'
            ? effortUnavailable(current, capsRef.current)
            : `The model ${thinking?.model || 'in use'} has no thinking display this daemon can change.`,
          'warn',
        )
        return false
      }
      const value = arg.trim().toLowerCase()
      if (value === 'default' || value === 'reset') {
        void configure({}, [field === 'level' ? 'thinking_level' : 'thinking_display'])
        return true
      }
      const accepted = field === 'level' ? thinking.levels : thinking.displays
      if (!accepted.includes(value)) {
        notify(
          current.sessionId,
          `${thinking.model || 'This model'} accepts ${accepted.join(', ')}, or default.`,
          'warn',
        )
        return false
      }
      void configure(field === 'level' ? { thinkingLevel: value } : { thinkingDisplay: value })
      return true
    },
    [configure, notify],
  )

  const openAgent = useCallback(
    (alias: string) => {
      const current = sessionRef.current
      if (!current) return
      const agent = agentsRef.current.find((a) => a.alias.toLowerCase() === alias.toLowerCase())
      if (!agent) {
        notify(current.sessionId, `No enabled agent is called ${alias}.`, 'warn')
        return
      }
      // A session keeps its agent for life, so another agent means another
      // session, in the same project and, in a checkout, its own worktree.
      // This one stays open in the background.
      void startSession(agent.alias, projectOf(current.workspaceDir), 'auto')
    },
    [notify, startSession],
  )

  const openAgentPicker = useCallback(() => {
    const current = sessionRef.current
    if (!current) return
    openPicker({
      title: `Agent for a new session in ${shortPath(current.workspaceDir)}`,
      placeholder: 'Search enabled agents',
      note: agentsRef.current.length === 0 ? 'This daemon has no enabled agents.' : null,
      actions: agentsRef.current.map((agent) => ({
        id: `agent:${agent.alias}`,
        label: agent.alias,
        hint: agent.alias === current.agentAlias ? 'this session' : undefined,
        run: () => openAgent(agent.alias),
      })),
    })
  }, [openAgent, openPicker])

  /** `/goal <objective>`: switch to goal mode and start it in one step. */
  const startGoalWith = useCallback(
    async (objective: string) => {
      if (!(await setMode('goal'))) return
      const current = sessionRef.current
      if (!current || current.mode !== 'goal') return
      if (isBusy(current) || current.goal) {
        notify(current.sessionId, 'A goal is already running.', 'warn')
        return
      }
      const step = beginGoal(current, objective, goalLimitRef.current)
      submit(step.state, step.sent, false)
    },
    [notify, setMode, submit],
  )

  const forgetSaved = useCallback(() => {
    const current = sessionRef.current
    const endpoint = infoRef.current?.endpoint
    if (!current || !endpoint) return
    forgetSettings(store, endpoint, current.sessionId)
    notify(
      current.sessionId,
      "Forgot this session's saved settings. The daemon keeps its current ones until it restarts or drops the session.",
    )
  }, [notify, store])

  /** Set the goal turn limit for later goals and for the one running now. */
  const setGoalLimit = useCallback(
    (limit: GoalLimit) => {
      setGoalLimitState(limit)
      saveGoalLimit(store, limit)
      const current = sessionRef.current
      if (!current) return
      mutate((s) => withGoalLimit(s, limit))
      notify(
        current.sessionId,
        limit === null
          ? 'Goal turn limit removed. A goal now runs until the agent reports done or blocked, or you stop it. Watch the turn count in the mode pill.'
          : `Goal turn limit set to ${formatGoalLimit(limit)}.`,
        limit === null ? 'warn' : 'info',
      )
    },
    [mutate, notify, store],
  )

  const toggleGoalLimit = useCallback(() => {
    setGoalLimit(goalLimitRef.current === null ? GOAL_MAX_TURNS : null)
  }, [setGoalLimit])

  /**
   * Run a slash command. Returns false when it could not run as typed, so
   * the draft is kept for fixing. Commands do their own busy checks, which
   * is what lets /cancel and /status work while a turn runs.
   */
  const runCommand = useCallback(
    (name: string, arg: string): boolean => {
      const current = sessionRef.current
      if (!current) return false
      const id = current.sessionId
      switch (name) {
        case 'help':
          notify(id, helpText())
          return true
        case 'status':
          notify(id, statusText(current, infoRef.current, planSupportRef.current, goalLimitRef.current))
          return true
        case 'mode': {
          const mode = parseMode(arg)
          if (!mode) {
            notify(id, 'Usage: /mode build, /mode plan, or /mode goal.', 'warn')
            return false
          }
          void setMode(mode)
          return true
        }
        case 'build':
        case 'plan':
          void setMode(name)
          return true
        case 'goal':
          if (arg) void startGoalWith(arg)
          else void setMode('goal')
          return true
        case 'model':
          if (!arg) {
            openModelPicker()
            return true
          }
          if (!isSaneModelId(arg)) {
            notify(id, MODEL_ID_HINT, 'warn')
            return false
          }
          void configure({ model: arg })
          return true
        case 'effort':
          if (!arg) {
            openEffortPicker()
            return true
          }
          return setThinkingByName('level', arg)
        case 'display':
          if (!arg) {
            openDisplayPicker()
            return true
          }
          return setThinkingByName('display', arg)
        case 'provider':
          if (!arg) {
            openProviderPicker()
            return true
          }
          if (!isProviderRef(arg)) {
            notify(id, PROVIDER_REF_HINT, 'warn')
            return false
          }
          void chooseProvider(arg)
          return true
        case 'agent':
          if (arg) openAgent(arg)
          else openAgentPicker()
          return true
        case 'new':
          parkFront()
          return true
        case 'close':
          void closeSession()
          return true
        case 'cancel':
          if (isBusy(current)) cancel()
          else notify(id, 'Nothing is running.')
          return true
        case 'clear':
          mutate((s) => ({ ...s, entries: [] }))
          return true
        case 'thoughts':
          setShowThoughts((v) => !v)
          return true
        case 'sessions':
          setShowRail((v) => !v)
          return true
        case 'changes':
          setShowChanges((v) => !v)
          return true
        case 'limit': {
          if (!arg) {
            notify(
              id,
              `Goal turn limit: ${formatGoalLimit(goalLimitRef.current)}. Use /limit none, or /limit <turns> from 1 to 10000.`,
            )
            return true
          }
          const limit = parseGoalLimit(arg)
          if (limit === undefined) {
            notify(id, 'Usage: /limit none, or /limit <turns> from 1 to 10000.', 'warn')
            return false
          }
          setGoalLimit(limit)
          return true
        }
        case 'forget':
          forgetSaved()
          return true
        default:
          return false
      }
    },
    [
      cancel,
      chooseProvider,
      closeSession,
      configure,
      forgetSaved,
      mutate,
      notify,
      openAgent,
      openAgentPicker,
      openDisplayPicker,
      openEffortPicker,
      openModelPicker,
      openProviderPicker,
      parkFront,
      setGoalLimit,
      setMode,
      setThinkingByName,
      startGoalWith,
    ],
  )

  const send = useCallback(() => {
    const current = sessionRef.current
    const raw = draftRef.current.trim()
    if (!current || !raw) return
    const parsed = parseInput(raw)
    if (parsed.kind === 'unknown') {
      notify(
        current.sessionId,
        `There is no /${parsed.name} command. Type /help for the list, or start with // to send a leading slash.`,
        'warn',
      )
      return
    }
    if (parsed.kind === 'command') {
      if (runCommand(parsed.name, parsed.arg)) setDraft('')
      return
    }
    // A one-message depth is read by the daemon, so it is sent as typed, and
    // only to a daemon that reads it: elsewhere the model would get the prefix.
    let body = parsed.kind === 'text' ? parsed.text : parsed.rest
    let prefix = ''
    if (parsed.kind === 'inline-effort') {
      // Gated on the thinking report, not on the capability list: a daemon
      // that never answered session/thinking-options would hand the prefix
      // to the model as text.
      const report = current.thinking
      if (!report || !effortAdjustable(current)) {
        notify(
          current.sessionId,
          `${effortUnavailable(current, capsRef.current)} Nothing was sent; remove the /effort: prefix to send the message as it is.`,
          'warn',
        )
        return
      }
      if (!report.levels.includes(parsed.level)) {
        notify(
          current.sessionId,
          `${report.model || 'This model'} accepts /effort:${report.levels.join(', /effort:')}. Nothing was sent.`,
          'warn',
        )
        return
      }
      if (!body) {
        notify(current.sessionId, 'Add a message after /effort:<level>.', 'warn')
        return
      }
      prefix = `/effort:${parsed.level} `
      body = parsed.rest
    }
    if (isBusy(current) || configuringRef.current) return
    // A goal between turns is about to send its own continuation.
    if (current.goal) return
    if (current.mode === 'goal') {
      const step = beginGoal(current, body, goalLimitRef.current)
      submit(step.state, prefix + step.sent, true)
      return
    }
    const typed = parsed.kind === 'inline-effort' ? parsed.text : body
    submit(startTurn(current, typed), typed, true)
  }, [notify, runCommand, submit])

  // Drive the goal loop: a completed turn that asked to continue is followed
  // by the next one as soon as the session is idle and connected.
  const goalNext = session?.goal?.next ?? null
  const phase = session?.phase ?? null
  useEffect(() => {
    if (goalNext !== 'continue' || phase !== 'idle' || conn.kind !== 'connected' || configuring) {
      return
    }
    const current = sessionRef.current
    const step = current ? continueGoal(current) : null
    if (step) submit(step.state, step.sent, false)
  }, [configuring, conn.kind, goalNext, phase, submit])

  // ── Keyboard ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A picker owns the keyboard until it closes.
      if (picker) return
      if (modKey(event) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      if (paletteOpen) return

      if (modKey(event) && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        setShowRail((v) => !v)
        return
      }
      if (modKey(event) && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        setShowChanges((v) => !v)
        return
      }
      if (modKey(event) && !event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        parkFront()
        return
      }
      // Shift is part of these because Option+letter types a character in a
      // macOS text field and Cmd+M is the system's Minimize.
      if (modKey(event) && event.shiftKey && event.code === 'KeyM') {
        event.preventDefault()
        openModelPicker()
        return
      }
      if (modKey(event) && event.shiftKey && event.code === 'KeyP') {
        event.preventDefault()
        openProviderPicker()
        return
      }
      if (modKey(event) && event.shiftKey && event.code === 'KeyE') {
        event.preventDefault()
        openEffortPicker()
        return
      }

      const current = sessionRef.current
      const approval = current?.pendingApproval
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT'

      if (approval && !typing) {
        if (event.key === 'Enter') {
          event.preventDefault()
          decide('allow_once')
          return
        }
        if (event.key.toLowerCase() === 'a') {
          event.preventDefault()
          decide('allow_always')
          return
        }
        if (event.key.toLowerCase() === 'r') {
          event.preventDefault()
          decide('reject')
          return
        }
      }

      if (event.key === 'Escape' && current && isBusy(current)) {
        event.preventDefault()
        cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    cancel,
    decide,
    openEffortPicker,
    openModelPicker,
    openProviderPicker,
    paletteOpen,
    parkFront,
    picker,
  ])

  const actions = useMemo<Action[]>(
    () => [
      {
        id: 'new',
        label: 'New session',
        hint: isMac ? '⌘N' : 'Ctrl+N',
        run: parkFront,
      },
      {
        id: 'cancel',
        label: 'Stop the current turn',
        hint: 'Esc',
        enabled: !!session && isBusy(session),
        run: cancel,
      },
      {
        id: 'close',
        label: 'Close this session',
        enabled: !!session,
        run: () => void closeSession(),
      },
      {
        id: 'mode-cycle',
        label: 'Cycle mode (build, plan, goal)',
        hint: 'Shift+Tab',
        enabled: !!session,
        run: cycleMode,
      },
      {
        id: 'mode-build',
        label: 'Switch to build mode',
        enabled: !!session && session.mode !== 'build',
        run: () => void setMode('build'),
      },
      {
        id: 'mode-plan',
        label: 'Switch to plan mode (read-only)',
        enabled:
          !!session && session.mode !== 'plan' && caps.configure && planSupport !== 'unsupported',
        run: () => void setMode('plan'),
      },
      {
        id: 'mode-goal',
        label: 'Switch to goal mode',
        enabled: !!session && session.mode !== 'goal',
        run: () => void setMode('goal'),
      },
      {
        id: 'goal-stop',
        label: 'Stop the goal after this turn',
        enabled: !!session?.goal,
        run: () => mutate((s) => stopGoal(s, 'Goal stopped. The current turn still finishes.')),
      },
      {
        id: 'goal-limit',
        label:
          goalLimit === null
            ? `Goal turn limit: none. Set it back to ${GOAL_MAX_TURNS} turns`
            : `Goal turn limit: ${formatGoalLimit(goalLimit)}. Remove the limit`,
        enabled: !!session,
        run: toggleGoalLimit,
      },
      {
        id: 'model',
        label: 'Change model…',
        hint: isMac ? '⇧⌘M' : 'Ctrl+Shift+M',
        enabled: !!session && caps.configure,
        run: () => openModelPicker(),
      },
      {
        id: 'provider',
        label: 'Change provider…',
        hint: isMac ? '⇧⌘P' : 'Ctrl+Shift+P',
        enabled: !!session && caps.configure && caps.providers,
        run: openProviderPicker,
      },
      {
        id: 'forget-settings',
        label: "Forget this session's saved settings",
        enabled: !!session,
        run: forgetSaved,
      },
      {
        id: 'effort',
        label: 'Change reasoning effort…',
        hint: isMac ? '⇧⌘E' : 'Ctrl+Shift+E',
        enabled: !!session && effortAdjustable(session),
        run: openEffortPicker,
      },
      {
        id: 'display',
        label: 'Change thinking display…',
        enabled: !!session && displayAdjustable(session),
        run: openDisplayPicker,
      },
      {
        id: 'agent',
        label: 'New session with another agent…',
        enabled: !!session && agents.length > 0,
        run: openAgentPicker,
      },
      {
        id: 'thoughts',
        label: showThoughts ? 'Hide thoughts' : 'Show thoughts',
        run: () => setShowThoughts((v) => !v),
      },
      {
        id: 'rail',
        label: showRail ? 'Hide the session rail' : 'Show the session rail',
        hint: isMac ? '⌘B' : 'Ctrl+B',
        run: () => setShowRail((v) => !v),
      },
      {
        id: 'changes',
        label: showChanges ? 'Hide changes' : 'Show changes',
        hint: isMac ? '⌘J' : 'Ctrl+J',
        run: () => setShowChanges((v) => !v),
      },
      {
        id: 'reconnect',
        label: 'Reconnect to the daemon',
        run: () => {
          setConn({ kind: 'connecting' })
          ipc
            .connect(true)
            .then((next) => {
              setInfo(next)
              setConn({ kind: 'connected', info: next })
            })
            .catch((e) => setConn({ kind: 'failed', message: String(e) }))
        },
      },
      {
        id: 'stop-daemon',
        label: 'Stop the daemon this app started',
        enabled: info?.startedByApp === true,
        run: () => {
          void ipc.daemonStopOwned().catch((e) => setError(String(e)))
        },
      },
    ],
    [
      agents.length,
      cancel,
      caps,
      closeSession,
      cycleMode,
      forgetSaved,
      goalLimit,
      info,
      mutate,
      openAgentPicker,
      openDisplayPicker,
      openEffortPicker,
      openModelPicker,
      openProviderPicker,
      parkFront,
      planSupport,
      session,
      setMode,
      showChanges,
      showRail,
      showThoughts,
      toggleGoalLimit,
    ],
  )

  const connected = conn.kind === 'connected'
  const busy = session ? isBusy(session) : false
  const marks = useMemo(() => liveMarks(session, parked), [session, parked])
  const placeholder = !session
    ? undefined
    : session.goal
      ? session.goal.max === null
        ? `Goal turn ${session.goal.turn} is running, with no turn limit. Esc stops the turn and the goal.`
        : `Goal turn ${session.goal.turn} of ${session.goal.max} is running. Esc stops the turn and the goal.`
      : session.mode === 'goal'
        ? `Describe the objective. ${session.agentAlias} keeps working until it reports done or blocked.`
        : session.mode === 'plan'
          ? `Ask ${session.agentAlias} to investigate or propose a plan. Nothing will be changed.`
          : undefined

  return (
    <div className="app">
      <header className="titlebar">
        <button
          className="ghost"
          type="button"
          onClick={() => setShowRail((v) => !v)}
          aria-label="Toggle sessions"
          aria-pressed={showRail}
        >
          ☰
        </button>
        <span className="title">ZeroTauri</span>
        {session && (
          <span className="chip" title={session.workspaceDir}>
            <span className="path">{shortPath(session.workspaceDir)}</span>
            {session.branch && (
              <span className="branch">
                {session.branch}
                {session.hash ? ` ${session.hash}` : ''}
              </span>
            )}
          </span>
        )}
        <span className="spacer" />
        <button className="ghost" type="button" onClick={() => setShowChanges((v) => !v)} aria-pressed={showChanges}>
          Changes
        </button>
        <button className="ghost" type="button" onClick={() => setPaletteOpen(true)}>
          {isMac ? '⌘K' : 'Ctrl+K'}
        </button>
      </header>

      {conn.kind === 'lost' && (
        <div className="banner warn">
          <span>Lost the daemon connection. Sessions are safe; retrying…</span>
        </div>
      )}
      {conn.kind === 'reconnecting' && (
        <div className="banner warn">
          <span>Reconnecting to the daemon (attempt {conn.attempt})…</span>
        </div>
      )}
      {conn.kind === 'failed' && (
        <div className="banner error">
          <span>{conn.message}</span>
          <span className="spacer" />
          <button
            type="button"
            onClick={() => {
              setConn({ kind: 'connecting' })
              ipc
                .connect(true)
                .then((next) => {
                  setInfo(next)
                  setConn({ kind: 'connected', info: next })
                })
                .catch((e) => setConn({ kind: 'failed', message: String(e) }))
            }}
          >
            Retry
          </button>
        </div>
      )}
      {recovery && (
        <div className="banner warn">
          <span>
            A turn was already running when this window opened this session. Anything it
            asked before now was never shown here, and the daemon denies an unanswered
            approval after its timeout. The transcript fills in when the turn ends.
          </span>
          <span className="spacer" />
          <button
            type="button"
            onClick={() => {
              cancel()
              setRecovery(null)
            }}
          >
            Stop it
          </button>
          <button type="button" className="ghost" onClick={() => setRecovery(null)}>
            Keep going
          </button>
        </div>
      )}
      {error && (
        <div className="banner error">
          <span>{error}</span>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="body">
        {showRail && (
          <SessionRail
            sessions={sessions}
            activeId={session?.sessionId ?? null}
            marks={marks}
            onOpen={(summary) =>
              void openSession({
                agentAlias: summary.agentAlias ?? agents[0]?.alias ?? '',
                sessionId: summary.sessionId,
              })
            }
            onNew={parkFront}
          />
        )}

        <main className="center">
          {conn.kind === 'connecting' && (
            <div className="setup">
              <h1>Looking for a ZeroClaw daemon…</h1>
              <p>
                Attaching to a running daemon, or starting one. A daemon started here also
                brings up the gateway, channels, and cron from your config, and shuts down
                shortly after this app disconnects.
              </p>
            </div>
          )}

          {connected && !session && (
            <Setup
              agents={agents}
              sessions={sessions}
              busy={opening}
              recent={recent}
              initialFolder={setupFolder ?? recent[0] ?? null}
              initialAgent={setupAgent}
              onPickFolder={ipc.pickFolder}
              onInspect={ipc.inspectFolder}
              onStart={(agentAlias, folder, worktree) => void startSession(agentAlias, folder, worktree)}
              onResume={(summary) =>
                void openSession({
                  agentAlias: summary.agentAlias ?? agents[0]?.alias ?? '',
                  sessionId: summary.sessionId,
                })
              }
            />
          )}

          {session && (
            <>
              <Transcript session={session} showThoughts={showThoughts} />
              <div style={{ padding: '0 22px' }}>
                <PlanStrip plan={session.plan} />
                {session.pendingApproval && (
                  <ApprovalCard
                    approval={session.pendingApproval}
                    busy={approving}
                    onDecide={decide}
                  />
                )}
              </div>
              <Composer
                value={draft}
                onChange={setDraft}
                onSubmit={send}
                onCancel={cancel}
                busy={busy}
                disabled={!connected}
                showThoughts={showThoughts}
                onToggleThoughts={() => setShowThoughts((v) => !v)}
                agentAlias={session.agentAlias}
                hold={configuring ? 'Updating session settings…' : null}
                onCycleMode={cycleMode}
                placeholder={placeholder}
                controls={
                  <SessionControls
                    session={session}
                    caps={caps}
                    planSupport={planSupport}
                    goalLimit={goalLimit}
                    locked={busy || configuring}
                    onCycleMode={cycleMode}
                    onToggleGoalLimit={toggleGoalLimit}
                    onProvider={openProviderPicker}
                    onModel={() => openModelPicker()}
                    onEffort={openEffortPicker}
                    onDisplay={openDisplayPicker}
                  />
                }
              />
            </>
          )}
        </main>

        {showChanges && session && <ChangesPanel session={session} />}
      </div>

      <StatusBar info={info} connected={connected} session={session} />

      {paletteOpen && <Palette actions={actions} onClose={() => setPaletteOpen(false)} />}
      {picker && (
        <Palette
          key={picker.token}
          title={picker.title}
          placeholder={picker.placeholder}
          actions={picker.actions}
          loading={picker.loading}
          note={picker.note}
          fallback={picker.fallback}
          selectedId={picker.selectedId}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}
