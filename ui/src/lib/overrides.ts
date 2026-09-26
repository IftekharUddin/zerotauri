// Per-session settings: what the daemon offers, what it kept, and what the
// session is actually running on.
//
// The daemon is the authority on overrides, and it reports them only in the
// echo of a `session/configure`. It never reports a session's effective model
// on daemons without thinking controls, so the default is read from config
// (`identity`) and an override, when present, wins over it.

import type { SessionState } from './session.ts'
import type {
  Configured,
  ConnectionInfo,
  Identity,
  OverridePatch,
  RpcFailure,
  SessionOverrides,
} from './types.ts'

export const NO_OVERRIDES: SessionOverrides = {
  model: null,
  modelProvider: null,
  temperature: null,
  mode: null,
  thinkingLevel: null,
  thinkingDisplay: null,
}

export const UNKNOWN_IDENTITY: Identity = { provider: null, model: null }

/** JSON-RPC codes the settings flow words differently. */
export const RPC = {
  sessionBusy: -32002,
  methodNotFound: -32601,
  invalidParams: -32602,
} as const

/** Which settings calls the connected daemon advertises. */
export interface Caps {
  configure: boolean
  catalog: boolean
  providers: boolean
  identity: boolean
  thinkingOptions: boolean
}

export function deriveCaps(info: ConnectionInfo | null): Caps {
  const missing = new Set(info?.missingMethods ?? [])
  const has = (method: string) => info !== null && !missing.has(method)
  return {
    configure: has('session/configure'),
    catalog: has('config/catalog-models'),
    providers: has('quickstart/state'),
    identity: has('config/list'),
    thinkingOptions: has('session/thinking-options'),
  }
}

/** The provider and model the session runs on, as far as the app knows. */
export function effectiveIdentity(state: Pick<SessionState, 'overrides' | 'identity'>): Identity {
  return {
    provider: state.overrides.modelProvider ?? state.identity.provider,
    model: state.overrides.model ?? state.identity.model,
  }
}

/**
 * Fold a configure echo into the session. The echo is the merged set the
 * daemon kept, so it replaces the local copy outright. A provider switch
 * leaves the model unknown until the new provider's default is read, because
 * the daemon clears a model override when the provider changes without one.
 */
export function applyConfigureEcho(
  state: SessionState,
  requested: OverridePatch,
  result: Configured,
): SessionState {
  if (result.sessionId !== state.sessionId) return state
  const before = effectiveIdentity(state)
  let identity = state.identity
  if (requested.modelProvider != null && requested.modelProvider !== before.provider) {
    identity = { provider: requested.modelProvider, model: null }
  }
  return { ...state, overrides: { ...result.overrides }, identity }
}

/** A one-line transcript record of what a configure changed, if anything. */
export function describeChange(requested: OverridePatch, result: Configured): string | null {
  const kept = result.overrides
  if (requested.modelProvider != null) {
    const provider = kept.modelProvider ?? requested.modelProvider
    return kept.model
      ? `Provider set to ${provider}, model ${kept.model}.`
      : `Provider set to ${provider}, on its configured model.`
  }
  if (requested.model != null) return `Model set to ${kept.model ?? requested.model}.`
  return null
}

export function isRpcFailure(error: unknown): error is RpcFailure {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as Partial<RpcFailure>
  return typeof candidate.code === 'number' && typeof candidate.message === 'string'
}

/** Plain text for any rejection from an IPC call. */
export function failureText(error: unknown): string {
  if (isRpcFailure(error)) return error.userMessage || error.message
  return String(error)
}

/**
 * Text for a refused settings change. A refused value keeps the daemon's own
 * words, because they name the values it would accept.
 */
export function configureFailureText(error: unknown): string {
  if (!isRpcFailure(error)) return `Could not change the session settings: ${String(error)}`
  if (error.code === RPC.invalidParams) return `The daemon refused that setting: ${error.message}`
  if (error.code === RPC.sessionBusy) return `The daemon refused the change: ${error.message}`
  return `Could not change the session settings: ${error.userMessage || error.message}`
}

export const SETTINGS_BUSY =
  'A turn is running. Wait for it to finish, or stop it, before changing session settings.'
