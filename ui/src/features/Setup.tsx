import { useEffect, useState } from 'react'

import type { AgentChoice, FolderInfo, SessionSummary } from '../lib/types'
import { sessionLabel } from '../lib/workspace'

const shortPath = (path: string): string => path.replace(/^\/Users\/[^/]+/, '~')

/**
 * The pre-session chooser. A folder and an enabled agent are the two things
 * the daemon needs. In a git checkout the session can get a worktree of its
 * own, so several sessions can work on one repository side by side.
 */
export function Setup({
  agents,
  sessions,
  busy,
  recent,
  initialFolder,
  initialAgent,
  onPickFolder,
  onInspect,
  onStart,
  onResume,
}: {
  agents: AgentChoice[]
  sessions: SessionSummary[]
  busy: boolean
  /** Folders sessions were started from, newest first. */
  recent: string[]
  initialFolder: string | null
  initialAgent: string | null
  onPickFolder: () => Promise<string | null>
  onInspect: (path: string) => Promise<FolderInfo>
  onStart: (agentAlias: string, folder: string, worktree: boolean) => void
  onResume: (session: SessionSummary) => void
}) {
  const [folder, setFolder] = useState<string | null>(initialFolder)
  const [picked, setAgent] = useState<string>(initialAgent ?? '')
  // The list usually arrives after this mounts, so a pick that is not (or no
  // longer) in it falls back to the first agent instead of staying empty.
  const agent = agents.some((a) => a.alias === picked) ? picked : (agents[0]?.alias ?? '')
  const [info, setInfo] = useState<FolderInfo | null>(null)
  const [worktree, setWorktree] = useState(true)

  // Look at the folder whenever it changes; a git checkout offers a worktree.
  useEffect(() => {
    let live = true
    setInfo(null)
    if (!folder) return
    onInspect(folder).then(
      (next) => {
        if (live) setInfo(next)
      },
      () => {
        if (live) setInfo(null)
      },
    )
    return () => {
      live = false
    }
  }, [folder, onInspect])

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

  const isRepo = info !== null && info.repoRoot !== null && info.gitAvailable
  const useWorktree = isRepo && worktree
  const choices = folder && !recent.includes(folder) ? [folder, ...recent] : recent

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
        <label htmlFor="folder">Folder</label>
        {choices.length > 0 && (
          <select
            id="folder"
            value={folder ?? ''}
            onChange={(e) => setFolder(e.target.value || null)}
            aria-label="Recent folders"
          >
            {!folder && <option value="">Choose a folder…</option>}
            {choices.map((path) => (
              <option key={path} value={path}>
                {shortPath(path)}
              </option>
            ))}
          </select>
        )}
        <div className="pathbox">
          <span className="p" id={choices.length > 0 ? undefined : 'folder'}>
            {folder ? shortPath(folder) : 'No folder chosen'}
          </span>
          <button
            type="button"
            onClick={async () => {
              const chosen = await onPickFolder()
              if (chosen) setFolder(chosen)
            }}
          >
            Choose…
          </button>
        </div>
        {folder && info && (
          <p className="note">
            {info.repoRoot
              ? `Git checkout on ${info.branch ?? 'a detached HEAD'}${
                  info.isLinkedWorktree && info.project
                    ? `, itself a worktree of ${shortPath(info.project)}`
                    : ''
                }.`
              : info.gitAvailable
                ? 'Not a git checkout. The session works in the folder itself.'
                : 'git is not on this app\u2019s PATH, so a worktree cannot be made here.'}
          </p>
        )}
      </div>

      {isRepo && (
        <div className="field">
          <label className="check">
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
            Give this session its own worktree
          </label>
          <p className="note">
            Creates {shortPath(folder ?? '')}/&lt;timestamp&gt; on a new branch from{' '}
            {info?.branch ?? 'HEAD'}. The checkout itself is left as it is, and the session folder is
            kept out of git status. Other sessions in this checkout get their own.
          </p>
        </div>
      )}

      <button
        className="primary"
        type="button"
        disabled={busy || !folder || !agent}
        onClick={() => folder && onStart(agent, folder, useWorktree)}
      >
        {busy ? 'Starting…' : useWorktree ? 'Start in a new worktree' : 'Start session'}
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
                {session.workspaceDir ? sessionLabel(session.workspaceDir) : session.sessionId.slice(0, 12)}
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
