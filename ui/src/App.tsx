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
import * as ipc from './lib/ipc'
import {
  SETTINGS_BUSY,
  applyConfigureEcho,
  configureFailureText,
  deriveCaps,
  describeChange,
  effectiveIdentity,
  failureText,
  type Caps,
} from './lib/overrides'
import {
  applyUpdate,
  clearApproval,
  createSession,
  isBusy,
  loadHistory,
  markCancelling,
  pushNotice,
  startTurn,
  type SessionState,
} from './lib/session'
import type {
  AgentChoice,
  ApprovalDecision,
  Configured,
  ConnectionInfo,
  OverridePatch,
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
}

type PickerSpec = Pick<Picker, 'title' | 'placeholder' | 'fallback'> &
  Partial<Pick<Picker, 'actions' | 'loading' | 'note'>>

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

  const sessionRef = useRef<SessionState | null>(null)
  const draftRef = useRef('')
  draftRef.current = draft
  const pickerSeq = useRef(0)
  const configuringRef = useRef(false)
  const caps = useMemo(() => deriveCaps(info), [info])
  const capsRef = useRef<Caps>(caps)
  capsRef.current = caps

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

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await ipc.sessionList())
    } catch {
      // A daemon without the ACP listing simply shows no history.
    }
  }, [])

  /** Post a notice to one session, and only if it is still the open one. */
  const notify = useCallback(
    (sessionId: string, text: string, tone: Tone = 'info') => {
      mutate((s) => (s.sessionId === sessionId ? pushNotice(s, text, tone) : s))
    },
    [mutate],
  )

  /** Read the configured provider and model a session falls back to. */
  const loadIdentity = useCallback(
    async (target: { sessionId: string; agentAlias: string }, modelProvider?: string | null) => {
      if (!capsRef.current.identity) return
      try {
        const identity = await ipc.sessionIdentity({ agentAlias: target.agentAlias, modelProvider })
        mutate((s) => (s.sessionId === target.sessionId ? { ...s, identity } : s))
      } catch {
        // Display only: an unknown default reads as "default".
      }
    },
    [mutate],
  )

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
        mutate((current) => applyUpdate(current, update))
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
  }, [mutate, refreshSessions])

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

      // Re-attach the open session: resuming rebinds ownership to this
      // connection, which cancel needs, then reload the transcript the
      // daemon persisted while we were away.
      const open = sessionRef.current
      if (!open) return
      void (async () => {
        try {
          const reopened = await ipc.sessionOpen({
            agentAlias: open.agentAlias,
            sessionId: open.sessionId,
          })
          const rebuilt = loadHistory(
            createSession({
              sessionId: reopened.sessionId,
              agentAlias: reopened.agentAlias,
              workspaceDir: reopened.workspaceDir,
              branch: reopened.branch,
              hash: reopened.hash,
              plan: reopened.plan as never,
            }),
            reopened.messages,
          )
          install(rebuilt)
          void loadIdentity(rebuilt)
          if (reopened.state === 'running') setRecovery(reopened.sessionId)
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
  }, [install, loadIdentity])

  // ── Session actions ─────────────────────────────────────────────
  const openSession = useCallback(
    async (request: { agentAlias: string; cwd?: string; sessionId?: string }) => {
      setOpening(true)
      setError(null)
      try {
        // A session another client is actively running would have its cancel
        // ownership taken over by this resume, so confirm before stealing it.
        if (request.sessionId) {
          const live = await ipc.sessionState(request.sessionId)
          if (live.state === 'running') {
            const proceed = window.confirm(
              'That session is running right now, possibly in another client.\n\nOpen it here anyway? This window will take over its controls.',
            )
            if (!proceed) return
          }
        }

        const opened = await ipc.sessionOpen({
          agentAlias: request.agentAlias,
          cwd: request.cwd ?? null,
          sessionId: request.sessionId ?? null,
        })
        const next = loadHistory(
          createSession({
            sessionId: opened.sessionId,
            agentAlias: opened.agentAlias,
            workspaceDir: opened.workspaceDir,
            branch: opened.branch,
            hash: opened.hash,
            plan: opened.plan as never,
          }),
          opened.messages,
        )
        install(next)
        void loadIdentity(next)
        if (opened.state === 'running') setRecovery(opened.sessionId)
        await refreshSessions()
      } catch (e) {
        setError(String(e))
      } finally {
        setOpening(false)
      }
    },
    [install, loadIdentity, refreshSessions],
  )

  const send = useCallback(() => {
    const current = sessionRef.current
    const text = draftRef.current.trim()
    if (!current || !text || isBusy(current) || configuringRef.current) return
    const next = startTurn(current, text)
    install(next)
    setDraft('')
    ipc.sessionPrompt(next.sessionId, text, next.generation).catch((e) => {
      mutate((s) => pushNotice(s, String(e), 'error'))
      mutate((s) => ({ ...s, phase: 'idle' }))
    })
  }, [install, mutate])

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
    install(null)
    await refreshSessions()
  }, [install, refreshSessions])

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
    configuringRef.current = value
    setConfiguring(value)
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
        const said = describeChange(patch, result)
        if (said) notify(current.sessionId, said)
        return result
      } catch (e) {
        notify(current.sessionId, configureFailureText(e), 'error')
        return null
      } finally {
        setConfiguringFlag(false)
      }
    },
    [mutate, notify, setConfiguringFlag],
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
        fallback: (query) => ({
          id: 'model:typed',
          label: `Use model "${query}"`,
          run: () => void configure({ model: query }),
        }),
      })
      if (!listable || provider === null) return
      ipc.catalogModels(provider).then(
        (catalog) =>
          fillPicker(token, {
            loading: false,
            note:
              catalog.models.length === 0
                ? `No models listed for ${provider}. Type a model id.`
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
  }, [cancel, decide, openModelPicker, openProviderPicker, paletteOpen, picker])

  const actions = useMemo<Action[]>(
    () => [
      {
        id: 'new',
        label: 'New session',
        hint: isMac ? '⌘N' : 'Ctrl+N',
        run: () => install(null),
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
        id: 'thoughts',
        label: showThoughts ? 'Hide thinking' : 'Show thinking',
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
      cancel,
      caps,
      closeSession,
      info,
      install,
      openModelPicker,
      openProviderPicker,
      session,
      showChanges,
      showRail,
      showThoughts,
    ],
  )

  const connected = conn.kind === 'connected'
  const busy = session ? isBusy(session) : false

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
            A turn was running while this window was disconnected. Approvals raised meanwhile
            are denied by the daemon after its timeout.
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
            Wait
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
            onOpen={(summary) =>
              void openSession({
                agentAlias: summary.agentAlias ?? agents[0]?.alias ?? '',
                sessionId: summary.sessionId,
              })
            }
            onNew={() => install(null)}
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
              onPickFolder={ipc.pickFolder}
              onStart={(agentAlias, cwd) => void openSession({ agentAlias, cwd })}
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
                hold={configuring ? 'Applying session settings…' : null}
                controls={
                  <SessionControls
                    session={session}
                    caps={caps}
                    locked={busy || configuring}
                    onProvider={openProviderPicker}
                    onModel={() => openModelPicker()}
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
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}
