import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ApprovalCard } from './features/ApprovalCard'
import { ChangesPanel } from './features/ChangesPanel'
import { Composer } from './features/Composer'
import { Palette, type Action } from './features/Palette'
import { PlanStrip } from './features/PlanStrip'
import { SessionRail } from './features/SessionRail'
import { Setup } from './features/Setup'
import { StatusBar } from './features/StatusBar'
import { Transcript } from './features/Transcript'
import * as ipc from './lib/ipc'
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
  ConnectionInfo,
  SessionSummary,
} from './lib/types'

type ConnPhase =
  | { kind: 'connecting' }
  | { kind: 'connected'; info: ConnectionInfo }
  | { kind: 'lost' }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'failed'; message: string }

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

  const sessionRef = useRef<SessionState | null>(null)
  const draftRef = useRef('')
  draftRef.current = draft

  const mutate = useCallback((fn: (current: SessionState) => SessionState) => {
    setSession((current) => {
      if (!current) return current
      const next = fn(current)
      sessionRef.current = next
      return next
    })
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
  }, [install])

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
        if (opened.state === 'running') setRecovery(opened.sessionId)
        await refreshSessions()
      } catch (e) {
        setError(String(e))
      } finally {
        setOpening(false)
      }
    },
    [install, refreshSessions],
  )

  const send = useCallback(() => {
    const current = sessionRef.current
    const text = draftRef.current.trim()
    if (!current || !text || isBusy(current)) return
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

  // ── Keyboard ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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
  }, [cancel, decide, paletteOpen])

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
    [cancel, closeSession, info, install, session, showChanges, showRail, showThoughts],
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
        <span className="title">Zero Claw-Code</span>
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
              />
            </>
          )}
        </main>

        {showChanges && session && <ChangesPanel session={session} />}
      </div>

      <StatusBar info={info} connected={connected} session={session} />

      {paletteOpen && <Palette actions={actions} onClose={() => setPaletteOpen(false)} />}
    </div>
  )
}
