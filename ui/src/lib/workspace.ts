// Where a session works.
//
// A session started in a git checkout gets a worktree of its own at
// <folder>/<timestamp>, so the folder the user picked is the project and the
// timestamped folder is the session's. Both are read back from the path
// alone, since a path is all the daemon reports for a session.

import type { Store } from './prefs.ts'

const SESSION_DIR = /^\d{8}-\d{6}(-\d+)?$/

/** True for a folder this app made for one session. */
export const isSessionDirName = (name: string): boolean => SESSION_DIR.test(name)

const segmentsOf = (path: string): string[] => path.split(/[\\/]+/).filter(Boolean)
const separatorOf = (path: string): string =>
  path.includes('\\') && !path.includes('/') ? '\\' : '/'

/** Index of the session folder in a path, or -1 when there is none. */
function sessionIndex(segments: string[]): number {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (isSessionDirName(segments[i] ?? '')) return i
  }
  return -1
}

/** The folder a session was started from: its worktree's parent, or the folder itself. */
export function projectOf(workspaceDir: string): string {
  const segments = segmentsOf(workspaceDir)
  const at = sessionIndex(segments)
  if (at <= 0) return workspaceDir
  const lead = workspaceDir.startsWith('/') ? '/' : ''
  return lead + segments.slice(0, at).join(separatorOf(workspaceDir))
}

/** What the rail calls a session: `repo/20260926-171201` for a worktree, else the folder name. */
export function sessionLabel(workspaceDir: string | null): string {
  if (!workspaceDir) return ''
  const segments = segmentsOf(workspaceDir)
  const at = sessionIndex(segments)
  if (at > 0) return `${segments[at - 1]}/${segments[at]}`
  return segments[segments.length - 1] ?? workspaceDir
}

const RECENT_KEY = 'zerotauri:prefs:v1:recent-folders'
export const RECENT_MAX = 8

/** Folders sessions were started from, newest first. */
export function loadRecentFolders(store: Store | null): string[] {
  if (!store) return []
  try {
    const raw = store.getItem(RECENT_KEY)
    const value: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(value)) return []
    return value.filter((v): v is string => typeof v === 'string' && v !== '').slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

/** Put a folder first in the recent list and return the list. */
export function rememberFolder(store: Store | null, folder: string): string[] {
  const next = [folder, ...loadRecentFolders(store).filter((f) => f !== folder)].slice(0, RECENT_MAX)
  try {
    store?.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // The list is a convenience; the session starts either way.
  }
  return next
}
