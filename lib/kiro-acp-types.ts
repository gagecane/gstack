/**
 * kiro-acp-types.ts — TypeScript types for the Agent Client Protocol (ACP)
 * as spoken by `kiro-cli acp`.
 *
 * ACP is a JSON-RPC 2.0 protocol over stdio (newline-delimited JSON) that
 * connects a Client (editor / host) to an Agent (AI coding assistant).
 * Spec: https://agentclientprotocol.com/protocol/overview
 *
 * Design principles for this module:
 *
 *   1. **Types only.** Zero runtime code so this file can be imported from
 *      anywhere (including tight inner loops) without pulling in deps.
 *   2. **Protocol v1 baseline.** We model the baseline surface every ACP
 *      agent must expose: `initialize`, `session/new`, `session/prompt`,
 *      `session/cancel`, `session/update`.
 *   3. **Kiro extensions are first-class but optional.** Kiro-CLI returns
 *      richer fields (`modes`, `models`) on `session/new` and sends
 *      underscore-prefixed `_kiro.dev/*` notifications. The ACP spec
 *      reserves the underscore prefix for custom extensions, so these are
 *      valid ACP. They are modeled as optional fields or as their own
 *      notification variants so non-Kiro agents stay compatible.
 *   4. **Open-ended enums.** Where the spec lists known string values, we
 *      union them with `string` so forward-compatible values don't break
 *      type checks (e.g., `StopReason`, `ToolCallStatus`).
 *
 * Empirically verified against `kiro-cli 2.2.1` via a live `acp` session
 * (see the probe in scripts/preflight-agent-sdk.ts for the sibling check).
 */

// ============================================================================
// JSON-RPC 2.0 envelope
// ============================================================================

export type JsonRpcId = number | string;

/** A JSON-RPC 2.0 request from the Client to the Agent (or reverse). */
export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: P;
}

/** A successful JSON-RPC 2.0 response. */
export interface JsonRpcResponseOk<R = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: R;
}

/** A failing JSON-RPC 2.0 response. */
export interface JsonRpcResponseErr {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcError;
}

export type JsonRpcResponse<R = unknown> = JsonRpcResponseOk<R> | JsonRpcResponseErr;

/** A JSON-RPC 2.0 notification (one-way message). */
export interface JsonRpcNotification<P = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: P;
  /** Notifications by definition have no id. We forbid it at the type level. */
  id?: never;
}

/** JSON-RPC 2.0 error payload. */
export interface JsonRpcError<D = unknown> {
  code: number;
  message: string;
  data?: D;
}

/** Any JSON-RPC 2.0 frame that can appear on the wire in either direction. */
export type JsonRpcFrame = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ============================================================================
// ACP baseline: initialization
// ============================================================================

/** Integer protocol version. Incremented only on breaking changes. */
export type ProtocolVersion = number;

/** Implementation information ({agent,client}Info). */
export interface ImplementationInfo {
  /** Programmatic identifier. Fallback display name. */
  name: string;
  /** Human-readable title for UI. */
  title?: string;
  /** Implementation version string. */
  version?: string;
}

/** Client-side capabilities advertised during `initialize`. */
export interface ClientCapabilities {
  fs?: {
    /** Client exposes `fs/read_text_file`. */
    readTextFile?: boolean;
    /** Client exposes `fs/write_text_file`. */
    writeTextFile?: boolean;
  };
  /** Client exposes the `terminal/*` method family. */
  terminal?: boolean;
  /** Extension slot for custom capabilities. */
  _meta?: Record<string, unknown>;
}

/** Types of content the Client may include in a `session/prompt`. */
export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

/** MCP transport capabilities on the Agent side. */
export interface McpCapabilities {
  http?: boolean;
  sse?: boolean;
}

/** Forward-compatible slot for session-level capabilities. */
export interface SessionCapabilities {
  /** Agent supports `session/resume` (reconnect without replay). */
  resume?: Record<string, never>;
  /** Agent supports `session/close` (explicit tear-down). */
  close?: Record<string, never>;
  /** Other session capabilities not modeled here. */
  [key: string]: unknown;
}

/** Agent-side capabilities advertised in the `initialize` response. */
export interface AgentCapabilities {
  /** `session/load` available (conversation replay). */
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;
  mcpCapabilities?: McpCapabilities;
  sessionCapabilities?: SessionCapabilities;
  /** Extension slot. */
  _meta?: Record<string, unknown>;
}

/** Params for `initialize` (Client → Agent). */
export interface InitializeParams {
  protocolVersion: ProtocolVersion;
  clientCapabilities?: ClientCapabilities;
  clientInfo?: ImplementationInfo;
  _meta?: Record<string, unknown>;
}

/** Result of `initialize` (Agent → Client). */
export interface InitializeResult {
  protocolVersion: ProtocolVersion;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: ImplementationInfo;
  authMethods?: AuthMethod[];
  _meta?: Record<string, unknown>;
}

/** Auth method descriptor returned in `initialize`. */
export interface AuthMethod {
  id: string;
  name?: string;
  description?: string;
}

// ============================================================================
// ACP baseline: MCP server configuration for sessions
// ============================================================================

export interface McpEnvVariable {
  name: string;
  value: string;
}

export interface McpHttpHeader {
  name: string;
  value: string;
}

/** stdio MCP server — the mandatory baseline transport. */
export interface McpServerStdio {
  /** Absent `type` means stdio; the spec lets stdio be untagged. */
  type?: 'stdio';
  name: string;
  command: string;
  args: string[];
  env?: McpEnvVariable[];
}

export interface McpServerHttp {
  type: 'http';
  name: string;
  url: string;
  headers: McpHttpHeader[];
}

export interface McpServerSse {
  type: 'sse';
  name: string;
  url: string;
  headers: McpHttpHeader[];
}

export type McpServer = McpServerStdio | McpServerHttp | McpServerSse;

// ============================================================================
// ACP baseline: sessions
// ============================================================================

/** Opaque session identifier returned by the Agent. */
export type SessionId = string;

/** Params for `session/new` (Client → Agent). */
export interface SessionNewParams {
  /** Absolute path to the working directory for this session. */
  cwd: string;
  mcpServers: McpServer[];
  _meta?: Record<string, unknown>;
}

/** Result of `session/new` (Agent → Client). Baseline: sessionId only. */
export interface SessionNewResultBase {
  sessionId: SessionId;
  _meta?: Record<string, unknown>;
}

/**
 * Result of `session/new` as returned by Kiro-CLI.
 *
 * Kiro extends the baseline with `modes` (agents available in the session)
 * and `models` (LLMs the user can select). Both fields are optional so this
 * type is assignable from a baseline ACP agent's response as well.
 */
export interface SessionNewResult extends SessionNewResultBase {
  modes?: SessionModes;
  models?: SessionModels;
}

/** Params for `session/load`. */
export interface SessionLoadParams {
  sessionId: SessionId;
  cwd: string;
  mcpServers: McpServer[];
}

/** Params for `session/resume`. */
export interface SessionResumeParams {
  sessionId: SessionId;
  cwd: string;
  mcpServers: McpServer[];
}

/** Params for `session/close`. */
export interface SessionCloseParams {
  sessionId: SessionId;
}

/** Params for `session/cancel` (notification). */
export interface SessionCancelParams {
  sessionId: SessionId;
}

/** Params for `session/set_mode`. */
export interface SessionSetModeParams {
  sessionId: SessionId;
  modeId: string;
}

/** Agent mode descriptor. Kiro surfaces agents (dispatch personas) here. */
export interface AgentMode {
  id: string;
  name: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

/** Kiro-extension: mode set returned in `session/new`. */
export interface SessionModes {
  currentModeId?: string;
  availableModes: AgentMode[];
}

/** Kiro-extension: LLM model descriptor. */
export interface AgentModel {
  modelId: string;
  name?: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

/** Kiro-extension: model set returned in `session/new`. */
export interface SessionModels {
  currentModelId?: string;
  availableModels: AgentModel[];
}

// ============================================================================
// ACP baseline: content blocks (messages, tool calls, resources)
// ============================================================================

export interface ContentBlockText {
  type: 'text';
  text: string;
  _meta?: Record<string, unknown>;
}

export interface ContentBlockImage {
  type: 'image';
  /** Base64-encoded image bytes. */
  data: string;
  mimeType: string;
  _meta?: Record<string, unknown>;
}

export interface ContentBlockAudio {
  type: 'audio';
  /** Base64-encoded audio bytes. */
  data: string;
  mimeType: string;
  _meta?: Record<string, unknown>;
}

/** Embedded resource content (requires embeddedContext capability). */
export interface ContentBlockResource {
  type: 'resource';
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    /** Base64 for non-text resources. */
    blob?: string;
  };
  _meta?: Record<string, unknown>;
}

/** Link to a resource by URI (no embedded bytes). */
export interface ContentBlockResourceLink {
  type: 'resource_link';
  uri: string;
  name?: string;
  mimeType?: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

export type ContentBlock =
  | ContentBlockText
  | ContentBlockImage
  | ContentBlockAudio
  | ContentBlockResource
  | ContentBlockResourceLink;

// ============================================================================
// ACP baseline: prompt turn
// ============================================================================

/** Params for `session/prompt`. */
export interface SessionPromptParams {
  sessionId: SessionId;
  prompt: ContentBlock[];
}

/**
 * Reason a prompt turn stopped.
 *
 * Spec-enumerated values; `string` fallback keeps forward-compat if the
 * spec adds new reasons.
 */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | (string & {});

/** Result of `session/prompt`. */
export interface SessionPromptResult {
  stopReason: StopReason;
  _meta?: Record<string, unknown>;
}

// ============================================================================
// ACP baseline: session/update notification family
// ============================================================================

/** Discriminator values for `session/update` payloads. */
export type SessionUpdateKind =
  | 'user_message_chunk'
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'available_commands_update'
  | 'current_mode_update'
  | (string & {});

export interface SessionUpdateMessageChunk {
  sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk';
  content: ContentBlock;
}

export interface SessionUpdateToolCall {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title?: string;
  kind?: ToolCallKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
}

export interface SessionUpdateToolCallUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  title?: string;
  kind?: ToolCallKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawOutput?: unknown;
}

export interface SessionUpdatePlan {
  sessionUpdate: 'plan';
  entries: PlanEntry[];
}

export interface SessionUpdateAvailableCommands {
  sessionUpdate: 'available_commands_update';
  commands: AvailableCommand[];
}

export interface SessionUpdateCurrentMode {
  sessionUpdate: 'current_mode_update';
  currentModeId: string;
}

/**
 * Discriminated union over `sessionUpdate`. The spec is extensible, so we
 * also allow arbitrary string discriminators via a generic fallback.
 */
export type SessionUpdatePayload =
  | SessionUpdateMessageChunk
  | SessionUpdateToolCall
  | SessionUpdateToolCallUpdate
  | SessionUpdatePlan
  | SessionUpdateAvailableCommands
  | SessionUpdateCurrentMode
  | { sessionUpdate: string; [key: string]: unknown };

/** Params for the `session/update` notification. */
export interface SessionUpdateParams {
  sessionId: SessionId;
  update: SessionUpdatePayload;
}

// Tool call support types (subset — enough for type safety on updates).

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | (string & {});

export type ToolCallKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'other'
  | (string & {});

export interface ToolCallContent {
  type: 'content' | 'diff' | (string & {});
  content?: ContentBlock;
  /** For `type: 'diff'`. */
  path?: string;
  oldText?: string | null;
  newText?: string;
}

export interface ToolCallLocation {
  path: string;
  line?: number;
  /** 1-based per ACP spec. */
  column?: number;
}

export interface PlanEntry {
  content: string;
  priority?: 'low' | 'medium' | 'high' | (string & {});
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled' | (string & {});
}

export interface AvailableCommand {
  name: string;
  description?: string;
  input?: unknown;
  meta?: Record<string, unknown>;
}

// ============================================================================
// ACP baseline: client-exposed methods (Agent → Client requests)
// ============================================================================

/** `session/request_permission` — Agent asks the Client to approve a tool call. */
export interface SessionRequestPermissionParams {
  sessionId: SessionId;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: ToolCallKind;
  };
  options: PermissionOption[];
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | (string & {});
}

export interface SessionRequestPermissionResult {
  outcome:
    | { outcome: 'selected'; optionId: string }
    | { outcome: 'cancelled' };
}

/** `fs/read_text_file` — Agent asks the Client to read a file. */
export interface FsReadTextFileParams {
  sessionId: SessionId;
  path: string;
  line?: number;
  limit?: number;
}

export interface FsReadTextFileResult {
  content: string;
}

/** `fs/write_text_file` — Agent asks the Client to write a file. */
export interface FsWriteTextFileParams {
  sessionId: SessionId;
  path: string;
  content: string;
}

export type FsWriteTextFileResult = Record<string, never>;

// Terminal family (subset; included for type-completeness of client-side handlers).

export interface TerminalCreateParams {
  sessionId: SessionId;
  command: string;
  args?: string[];
  env?: McpEnvVariable[];
  cwd?: string;
}

export interface TerminalCreateResult {
  terminalId: string;
}

// ============================================================================
// Kiro-CLI extensions (underscore-prefixed per ACP extensibility rules)
// ============================================================================

/**
 * Notifications Kiro-CLI sends in addition to baseline ACP. All names start
 * with `_kiro.dev/` per the ACP extensibility rule that custom methods must
 * be prefixed with `_`.
 */
export type KiroExtensionMethod =
  | '_kiro.dev/metadata'
  | '_kiro.dev/mcp/server_initialized'
  | '_kiro.dev/commands/available'
  | '_kiro.dev/subagent/list_update';

/** `_kiro.dev/metadata` — per-turn telemetry (context %, credits, duration). */
export interface KiroMetadataParams {
  sessionId: SessionId;
  contextUsagePercentage?: number;
  meteringUsage?: Array<{
    value: number;
    unit: string;
    unitPlural?: string;
  }>;
  turnDurationMs?: number;
  [key: string]: unknown;
}

/** `_kiro.dev/mcp/server_initialized` — fires as each MCP server handshakes. */
export interface KiroMcpServerInitializedParams {
  sessionId: SessionId;
  serverName: string;
  [key: string]: unknown;
}

/** `_kiro.dev/commands/available` — slash commands available in the session. */
export interface KiroAvailableCommandsParams {
  sessionId: SessionId;
  commands: AvailableCommand[];
}

/** `_kiro.dev/subagent/list_update` — subagent fleet state. */
export interface KiroSubagentListUpdateParams {
  subagents: unknown[];
  pendingStages: unknown[];
  [key: string]: unknown;
}

// ============================================================================
// Convenience discriminated unions for the incoming-notification surface.
// ============================================================================

/** All notifications a Client may receive from the Agent. */
export type IncomingNotification =
  | (JsonRpcNotification<SessionUpdateParams> & { method: 'session/update' })
  | (JsonRpcNotification<KiroMetadataParams> & { method: '_kiro.dev/metadata' })
  | (JsonRpcNotification<KiroMcpServerInitializedParams> & {
      method: '_kiro.dev/mcp/server_initialized';
    })
  | (JsonRpcNotification<KiroAvailableCommandsParams> & {
      method: '_kiro.dev/commands/available';
    })
  | (JsonRpcNotification<KiroSubagentListUpdateParams> & {
      method: '_kiro.dev/subagent/list_update';
    })
  | JsonRpcNotification;

/** All requests an Agent may send back to the Client. */
export type IncomingRequest =
  | (JsonRpcRequest<SessionRequestPermissionParams> & { method: 'session/request_permission' })
  | (JsonRpcRequest<FsReadTextFileParams> & { method: 'fs/read_text_file' })
  | (JsonRpcRequest<FsWriteTextFileParams> & { method: 'fs/write_text_file' })
  | JsonRpcRequest;

// ============================================================================
// Type guards (tiny, no-dep helpers callers often need)
// ============================================================================

/** True if `frame` is a JSON-RPC response (ok or error). */
export function isJsonRpcResponse(frame: JsonRpcFrame): frame is JsonRpcResponse {
  return (
    frame !== null &&
    typeof frame === 'object' &&
    'id' in frame &&
    ('result' in frame || 'error' in frame)
  );
}

/** True if `frame` is a JSON-RPC notification (has method, no id). */
export function isJsonRpcNotification(frame: JsonRpcFrame): frame is JsonRpcNotification {
  return (
    frame !== null &&
    typeof frame === 'object' &&
    'method' in frame &&
    !('id' in frame)
  );
}

/** True if `frame` is a JSON-RPC request from the other side (has method + id). */
export function isJsonRpcRequest(frame: JsonRpcFrame): frame is JsonRpcRequest {
  return (
    frame !== null &&
    typeof frame === 'object' &&
    'method' in frame &&
    'id' in frame
  );
}

/** True if `method` names a Kiro-CLI extension notification. */
export function isKiroExtensionMethod(method: string): method is KiroExtensionMethod {
  return method.startsWith('_kiro.dev/');
}
