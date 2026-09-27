// Sessions this window has open but is not showing.
//
// The daemon keeps every session it was asked to open, and keeps streaming
// to this connection for all of them. One session is in front; the others
// are parked here, receive their own events, and come back exactly as they
// were, so switching never loses text, an approval, or a goal in progress.

import { applyUpdate, type SessionState } from './session.ts'
import type { SessionUpdate } from './types.ts'

export type Parked = ReadonlyMap<string, SessionState>

export const NO_PARKED: Parked = new Map()

/** Apply an event to the parked session it belongs to. Others pass through untouched. */
export function routeParked(parked: Parked, update: SessionUpdate): Parked {
  const current = parked.get(update.session_id)
  if (!current) return parked
  const next = applyUpdate(current, update)
  if (next === current) return parked
  const out = new Map(parked)
  out.set(update.session_id, next)
  return out
}

/** Set a session aside. A session already parked under that id is replaced. */
export function park(parked: Parked, session: SessionState): Parked {
  const out = new Map(parked)
  out.set(session.sessionId, session)
  return out
}

/** Take a parked session out, to bring it to the front. */
export function unpark(parked: Parked, sessionId: string): { parked: Parked; session: SessionState } | null {
  const session = parked.get(sessionId)
  if (!session) return null
  const out = new Map(parked)
  out.delete(sessionId)
  return { parked: out, session }
}

export function without(parked: Parked, sessionId: string): Parked {
  if (!parked.has(sessionId)) return parked
  const out = new Map(parked)
  out.delete(sessionId)
  return out
}

/** Change one parked session in place. Unknown ids are ignored. */
export function updateParked(
  parked: Parked,
  sessionId: string,
  fn: (session: SessionState) => SessionState,
): Parked {
  const current = parked.get(sessionId)
  if (!current) return parked
  const next = fn(current)
  if (next === current) return parked
  const out = new Map(parked)
  out.set(sessionId, next)
  return out
}

export interface LiveMark {
  /** A turn is running, or a goal is between turns. */
  busy: boolean
  /** The daemon is waiting for a tool approval nobody can see. */
  approval: boolean
}

/** What the rail should say about each session this window has open. */
export function liveMarks(front: SessionState | null, parked: Parked): Map<string, LiveMark> {
  const marks = new Map<string, LiveMark>()
  const mark = (s: SessionState) =>
    marks.set(s.sessionId, {
      busy: s.phase !== 'idle' || s.goal !== null,
      approval: s.pendingApproval !== null,
    })
  for (const s of parked.values()) mark(s)
  if (front) mark(front)
  return marks
}
