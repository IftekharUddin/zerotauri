// Session settings remembered across daemon restarts.
//
// The daemon keeps a session's overrides in memory only, so a resumed or
// rehydrated session comes back on the agent's defaults, and plan mode comes
// back off. This app remembers what the daemon last confirmed for each
// session and sends it again when the session is reopened. Only confirmed
// values are stored, never a requested patch, so a re-apply is always a
// combination the daemon accepted once. A goal run is never stored; goal
// mode is.

import { MODES, type Mode, type PlanSupport } from './modes.ts'
import type { OverridePatch, SessionOverrides } from './types.ts'

/** The storage this module needs. The app passes `localStorage`; tests pass a map. */
export interface Store {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  keys(): string[]
}

export interface SavedSettings {
  model: string | null
  modelProvider: string | null
  temperature: number | null
  thinkingLevel: string | null
  thinkingDisplay: string | null
  mode: Mode
  savedAt: number
}

export type SettingsChange = Partial<Omit<SavedSettings, 'savedAt'>>

const PREFIX = 'zerotauri:session:v1:'

/** Saved settings older than this are dropped at startup. */
export const SETTINGS_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

/** Scoped by endpoint, so two config directories never share a session's settings. */
export const settingsKey = (endpoint: string, sessionId: string): string =>
  `${PREFIX}${endpoint}:${sessionId}`

const EMPTY: SavedSettings = {
  model: null,
  modelProvider: null,
  temperature: null,
  thinkingLevel: null,
  thinkingDisplay: null,
  mode: 'build',
  savedAt: 0,
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null

function normalize(value: unknown): SavedSettings | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const mode = (MODES as readonly unknown[]).includes(record.mode) ? (record.mode as Mode) : 'build'
  return {
    model: text(record.model),
    modelProvider: text(record.modelProvider),
    temperature: typeof record.temperature === 'number' ? record.temperature : null,
    thinkingLevel: text(record.thinkingLevel),
    thinkingDisplay: text(record.thinkingDisplay),
    mode,
    savedAt: typeof record.savedAt === 'number' ? record.savedAt : 0,
  }
}

const isDefault = (s: SavedSettings): boolean =>
  s.model === null &&
  s.modelProvider === null &&
  s.temperature === null &&
  s.thinkingLevel === null &&
  s.thinkingDisplay === null &&
  s.mode === 'build'

export function loadSettings(
  store: Store | null,
  endpoint: string,
  sessionId: string,
): SavedSettings | null {
  if (!store) return null
  try {
    const raw = store.getItem(settingsKey(endpoint, sessionId))
    return raw ? normalize(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

/** Merge a change into what is stored. Settings back at every default are removed. */
export function updateSettings(
  store: Store | null,
  endpoint: string,
  sessionId: string,
  change: SettingsChange,
  now: number = Date.now(),
): SavedSettings | null {
  if (!store) return null
  const next: SavedSettings = {
    ...(loadSettings(store, endpoint, sessionId) ?? EMPTY),
    ...change,
    savedAt: now,
  }
  try {
    if (isDefault(next)) {
      store.removeItem(settingsKey(endpoint, sessionId))
      return null
    }
    store.setItem(settingsKey(endpoint, sessionId), JSON.stringify(next))
  } catch {
    // Storage can be full or unavailable; the session still works, it just
    // will not be restored after a daemon restart.
  }
  return next
}

export function forgetSettings(store: Store | null, endpoint: string, sessionId: string): void {
  try {
    store?.removeItem(settingsKey(endpoint, sessionId))
  } catch {
    // Nothing to forget.
  }
}

/** Drop settings nobody has touched in a long while. Returns how many went. */
export function pruneSettings(
  store: Store | null,
  now: number = Date.now(),
  maxAgeMs: number = SETTINGS_MAX_AGE_MS,
): number {
  if (!store) return 0
  let removed = 0
  try {
    for (const key of store.keys()) {
      if (!key.startsWith(PREFIX)) continue
      let saved: SavedSettings | null = null
      try {
        const raw = store.getItem(key)
        saved = raw ? normalize(JSON.parse(raw)) : null
      } catch {
        saved = null
      }
      if (!saved || now - saved.savedAt > maxAgeMs) {
        store.removeItem(key)
        removed += 1
      }
    }
  } catch {
    // Best effort.
  }
  return removed
}

/** The stored subset of a confirmed echo. Mode is tracked by the app, not echoed. */
export function settingsFromOverrides(o: SessionOverrides): SettingsChange {
  return {
    model: o.model,
    modelProvider: o.modelProvider,
    temperature: o.temperature,
    thinkingLevel: o.thinkingLevel,
    thinkingDisplay: o.thinkingDisplay,
  }
}

export interface ReapplyPlan {
  /** One configure patch, or `null` when nothing needs sending. */
  patch: OverridePatch | null
  mode: Mode
}

/**
 * What to send to put a reopened session back the way it was. Thinking
 * fields go only to a daemon with thinking controls; elsewhere they would be
 * dropped and look like a daemon that forgot them. Plan mode is not
 * attempted where this daemon is known not to enforce it.
 */
export function reapplyPlan(
  saved: SavedSettings,
  daemon: { thinking: boolean; planSupport: PlanSupport },
): ReapplyPlan {
  const patch: OverridePatch = {}
  if (saved.modelProvider) patch.modelProvider = saved.modelProvider
  if (saved.model) patch.model = saved.model
  if (saved.temperature !== null) patch.temperature = saved.temperature
  if (daemon.thinking && saved.thinkingLevel) patch.thinkingLevel = saved.thinkingLevel
  if (daemon.thinking && saved.thinkingDisplay) patch.thinkingDisplay = saved.thinkingDisplay
  const mode = saved.mode === 'plan' && daemon.planSupport === 'unsupported' ? 'build' : saved.mode
  return { patch: Object.keys(patch).length > 0 ? patch : null, mode }
}

/** True when the daemon already holds every value the patch would set. */
export function patchMatches(patch: OverridePatch, overrides: SessionOverrides): boolean {
  return (Object.keys(patch) as (keyof SessionOverrides)[]).every(
    (key) => patch[key] === overrides[key],
  )
}

/** The transcript line recorded after a re-apply. */
export function describeRestore(patch: OverridePatch): string {
  const parts: string[] = []
  if (patch.modelProvider) parts.push(`provider ${patch.modelProvider}`)
  if (patch.model) parts.push(`model ${patch.model}`)
  if (patch.temperature != null) parts.push(`temperature ${patch.temperature}`)
  if (patch.thinkingLevel) parts.push(`effort ${patch.thinkingLevel}`)
  if (patch.thinkingDisplay) parts.push(`thinking display ${patch.thinkingDisplay}`)
  return `Restored this session's settings: ${parts.join(', ')}.`
}

/** `localStorage` behind the `Store` interface, or `null` where it is unavailable. */
export function browserStore(): Store | null {
  try {
    const storage = globalThis.localStorage
    if (!storage) return null
    return {
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => storage.setItem(key, value),
      removeItem: (key) => storage.removeItem(key),
      keys: () => {
        const keys: string[] = []
        for (let i = 0; i < storage.length; i += 1) {
          const key = storage.key(i)
          if (key !== null) keys.push(key)
        }
        return keys
      },
    }
  } catch {
    return null
  }
}

/** The settings a live session holds now, in stored form. Used across a reconnect. */
export function savedFromState(
  overrides: SessionOverrides,
  mode: Mode,
  now: number = Date.now(),
): SavedSettings {
  return { ...EMPTY, ...settingsFromOverrides(overrides), mode, savedAt: now }
}
