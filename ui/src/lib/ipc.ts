// The only channel to the daemon. Every call goes through a Tauri command;
// the webview opens no sockets and touches no files.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import type {
  AgentChoice,
  ApprovalDecision,
  ConnectionEvent,
  ConnectionInfo,
  MessageEntry,
  OpenedSession,
  PlanEntry,
  SessionSummary,
  SessionUpdate,
} from './types'

export const connect = (allowSpawn = true) =>
  invoke<ConnectionInfo>('connect', { allowSpawn })

export const connectionInfo = () => invoke<ConnectionInfo | null>('connection_info')

export const agentsList = () => invoke<AgentChoice[]>('agents_list')

export const pickFolder = () => invoke<string | null>('pick_folder')

export const daemonStopOwned = () => invoke<boolean>('daemon_stop_owned')

export const sessionList = () => invoke<SessionSummary[]>('session_list')

export const sessionOpen = (request: {
  agentAlias: string
  cwd?: string | null
  sessionId?: string | null
}) => invoke<OpenedSession>('session_open', { request })

export const sessionPrompt = (sessionId: string, prompt: string, generation: number) =>
  invoke<void>('session_prompt', { sessionId, prompt, generation })

export const sessionCancel = (sessionId: string) =>
  invoke<void>('session_cancel', { sessionId })

export const sessionApprove = (request: {
  sessionId: string
  requestId: string
  decision: ApprovalDecision
  replacement?: string | null
}) => invoke<boolean>('session_approve', { request })

export const sessionClose = (sessionId: string) => invoke<void>('session_close', { sessionId })

export const sessionState = (sessionId: string) =>
  invoke<{ state: string; plan: PlanEntry[] | null }>('session_state', { sessionId })

export const sessionMessages = (sessionId: string) =>
  invoke<MessageEntry[]>('session_messages', { sessionId })

export const gitBranch = (sessionId: string) =>
  invoke<{ branch: string | null; hash: string | null }>('git_branch', { sessionId })

export const onSessionUpdate = (handler: (update: SessionUpdate) => void) =>
  listen<SessionUpdate>('code://session-update', (event) => handler(event.payload))

export const onConnection = (handler: (event: ConnectionEvent) => void) =>
  listen<ConnectionEvent>('code://connection', (event) => handler(event.payload))
