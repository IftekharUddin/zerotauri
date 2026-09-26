import { useState } from 'react'

import type { AgentChoice, SessionSummary } from '../lib/types'

const shortPath = (path: string): string => path.replace(/^\/Users\/[^/]+/, '~')

/**
 * The pre-session chooser. A workspace and an enabled agent are the only two
 * things the daemon needs to start a coding session.
 */
export function Setup({
  agents,
  sessions,
  busy,
  onPickFolder,
  onStart,
  onResume,
}: {
  agents: AgentChoice[]
  sessions: SessionSummary[]
  busy: boolean
  onPickFolder: () => Promise<string | null>
  onStart: (agentAlias: string, cwd: string) => void
  onResume: (session: SessionSummary) => void
}) {
  const [cwd, setCwd] = useState<string | null>(null)
  const [picked, setAgent] = useState<string>('')
  // The list usually arrives after this mounts, so a pick that is not (or no
  // longer) in it falls back to the first agent instead of staying empty.
  const agent = agents.some((a) => a.alias === picked) ? picked : (agents[0]?.alias ?? '')

  if (agents.length === 0) {
    return (
      <div className="setup">
        <h1>No enabled agents</h1>
        <p>
          This daemon has no enabled agent to run a coding session. Configure one with{' '}
          <code className="inline">zeroclaw quickstart</code>, then reopen this window.
        </p>
      </div>
    )
  }

  return (
    <div className="setup">
      <h1>Start a coding session</h1>
      <p>The agent works inside the folder you choose. The daemon owns it, not this app.</p>

      <div className="field">
        <label htmlFor="agent">Agent</label>
        <select id="agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
          {agents.map((choice) => (
            <option key={choice.alias} value={choice.alias}>
              {choice.alias}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="folder">Workspace</label>
        <div className="pathbox">
          <span className="p" id="folder">
            {cwd ? shortPath(cwd) : 'No folder chosen'}
          </span>
          <button
            type="button"
            onClick={async () => {
              const picked = await onPickFolder()
              if (picked) setCwd(picked)
            }}
          >
            Choose…
          </button>
        </div>
      </div>

      <button
        className="primary"
        type="button"
        disabled={busy || !cwd || !agent}
        onClick={() => cwd && onStart(agent, cwd)}
      >
        {busy ? 'Starting…' : 'Start session'}
      </button>

      {sessions.length > 0 && (
        <div className="recent">
          <h3>Recent sessions</h3>
          {sessions.slice(0, 6).map((session) => (
            <button
              type="button"
              key={session.sessionId}
              className="item"
              style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 4 }}
              onClick={() => onResume(session)}
            >
              <span className="label">
                {session.workspaceDir ? shortPath(session.workspaceDir) : session.sessionId.slice(0, 12)}
              </span>
              <span className="meta" style={{ color: 'var(--zc-text-faint)', fontSize: 11 }}>
                {session.agentAlias ?? 'agent'} · {session.messageCount} messages
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
