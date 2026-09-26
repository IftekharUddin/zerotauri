// Shapes crossing the Tauri IPC boundary. These mirror the Rust command
// signatures in `src/commands/`; the daemon's own wire types are mirrored on
// the Rust side and never reach the webview raw, except `session/update`
// payloads, which are forwarded verbatim so an unknown event from a newer
// daemon is ignored rather than fatal.

export interface ConnectionInfo {
  endpoint: string
  configDir: string
  serverVersion: string
  serverPid: number
  protocolVersion: number
  startedByApp: boolean
  missingMethods: string[]
}

export type ConnectionEvent =
  | { status: 'connected'; info: ConnectionInfo; resumed: boolean }
  | { status: 'lost' }
  | { status: 'reconnecting'; attempt: number }
  | { status: 'failed'; message: string }

export interface AgentChoice {
  alias: string
  enabled: boolean
}

export interface SessionSummary {
  sessionId: string
  agentAlias: string | null
  workspaceDir: string | null
  lastActivity: string
  messageCount: number
  name: string | null
}

export type MessageKind = 'message' | 'tool_call' | 'tool_result'

export interface MessageEntry {
  role: string
  content: string
  kind: MessageKind
  tool_call_id?: string | null
  tool_name?: string | null
  tool_input?: unknown
  tool_output?: string | null
}

export interface OpenedSession {
  sessionId: string
  agentAlias: string
  workspaceDir: string
  messageCount: number
  messages: MessageEntry[]
  branch: string | null
  hash: string | null
  state: string
  plan: PlanEntry[] | null
}

export interface PlanEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | string
  priority?: string
  activeForm?: string
}

/** The `session/update` variants this app renders. Any other `type` is ignored. */
export type SessionUpdate =
  | { type: 'agent_message_chunk'; session_id: string; text: string }
  | { type: 'agent_thought_chunk'; session_id: string; text: string }
  | { type: 'tool_call'; session_id: string; tool_call_id: string; name: string; raw_input: unknown }
  | { type: 'tool_result'; session_id: string; tool_call_id: string; name: string; raw_output: string }
  | {
      type: 'approval_request'
      session_id: string
      request_id: string
      tool_name: string
      arguments_summary: string
      timeout_secs: number
    }
  | { type: 'context_usage'; session_id: string; input_tokens?: number; max_context_tokens?: number }
  | { type: 'plan'; session_id: string; entries: PlanEntry[] }
  | {
      type: 'turn_complete'
      session_id: string
      outcome: 'completed' | 'cancelled' | 'failed'
      content: string
      client_turn_generation?: number
      message_count?: number
    }
  | { type: 'history_trimmed'; session_id: string; dropped_messages: number; kept_turns: number; reason: string }
  | { type: string; session_id: string }

export type ApprovalDecision = 'allow_once' | 'allow_always' | 'reject' | 'reject_with_edit'

/**
 * Session settings kept by the daemon for one live session. `null` is unset,
 * which means the agent's configured value applies. `mode` and the thinking
 * fields exist only on daemons that support them; others never echo them.
 */
export interface SessionOverrides {
  model: string | null
  modelProvider: string | null
  temperature: number | null
  mode: string | null
  thinkingLevel: string | null
  thinkingDisplay: string | null
}

/** A `session/configure` request names only the fields it changes. */
export type OverridePatch = Partial<SessionOverrides>

/** What the session's model accepts for reasoning depth and display. */
export interface ThinkingOptions {
  modelProvider: string
  model: string
  levels: string[]
  displays: string[]
  currentLevel: string | null
  /** `session`, `profile`, or `model_default`. */
  levelSource: string | null
  currentDisplay: string | null
  /** `session`, `alias`, `profile`, or `model_default`. */
  displaySource: string | null
}

export interface Configured {
  sessionId: string
  /** The merged set the daemon kept. */
  overrides: SessionOverrides
  thinkingOptions: ThinkingOptions | null
  /** Wire names of requested fields the daemon ignored as unknown. */
  droppedFields: string[]
}

export interface SessionSettings {
  overrides: SessionOverrides
  thinkingOptions: ThinkingOptions | null
}

export interface ModelCatalog {
  modelProvider: string
  models: string[]
  local: boolean
  live: boolean
}

/** The provider and model a session runs on, as far as the app can tell. */
export interface Identity {
  provider: string | null
  model: string | null
}

/** The structured error the session-settings commands reject with. */
export interface RpcFailure {
  code: number
  message: string
  userMessage: string
}
