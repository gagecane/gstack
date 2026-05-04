/**
 * TypeScript types for the Agent Client Protocol (ACP) as spoken by `kiro-cli acp`.
 *
 * Sources:
 *   - Zed's open ACP schema: https://github.com/zed-industries/agent-client-protocol
 *     (schema/schema.json, `$defs` block — type shapes mechanically derived from there)
 *   - Kiro-specific extensions observed in the kiro-cli binary
 *     (prefixed `_kiro.dev/` — see docs/designs/KIRO_CLI_SCRIPTABLE_INTERFACE.md §1b, §2a-b)
 *
 * This file is the single source of truth for the wire shape. Consumers:
 *   - lib/kiro-acp-client.ts (sibling bead gsk-9p0.1 — the reusable client)
 *   - scripts/preflight-agent-sdk.ts (inlines a minimal subset today; will migrate)
 *
 * Scope & stance:
 *   - Everything is structural / interface-only — no runtime code, no zod.
 *   - We model the shapes that the investigation's live smoke test exercised
 *     and the shapes documented in §1b / §2a-b of the design doc.
 *   - Kiro extensions whose exact payload is not documented in the design doc
 *     are typed with pass-through `params` — a narrower shape can be introduced
 *     once a real consumer drives the use case.
 *   - No `_meta` field is surfaced on the public types. ACP reserves it but the
 *     spec forbids semantic assumptions, so a strict type just adds noise; client
 *     code can use bracket access or an index signature when it matters.
 *
 * Style:
 *   - All union variants use a `const` discriminator field (`type`, `sessionUpdate`,
 *     `outcome`, etc.) matching the ACP JSON-RPC wire format.
 *   - Fields that are nullable on the wire are typed as `T | null`; fields that
 *     are simply optional use `?:`. Where the schema allows both (e.g. `array | null`),
 *     we keep the explicit `| null` to preserve round-trip fidelity.
 *
 * Versioning:
 *   - Targets ACP protocol version 1 and `kiro-cli` 2.0.x / 2.1.x.
 *   - When the upstream schema moves, regenerate by re-deriving from the latest
 *     schema.json; when kiro-cli surfaces a new `_kiro.dev/*` shape, add it to the
 *     `KiroMethod` union and either tighten `KiroNotificationParams` / `KiroResponse`
 *     or leave the pass-through variant.
 */

// ---------------------------------------------------------------------------
// 1. JSON-RPC 2.0 framing
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 request id — string, number, or (discouraged) null. */
export type RequestId = string | number | null;

/** JSON-RPC 2.0 request object (has an id → expects a response). */
export interface JsonRpcRequest<Method extends string = string, Params = unknown> {
  jsonrpc: '2.0';
  id: RequestId;
  method: Method;
  params?: Params;
}

/** JSON-RPC 2.0 notification object (no id → no response expected). */
export interface JsonRpcNotification<Method extends string = string, Params = unknown> {
  jsonrpc: '2.0';
  method: Method;
  params?: Params;
}

/**
 * JSON-RPC 2.0 response object. Either `result` OR `error` is present, never both.
 * Callers should narrow via `'error' in msg` / `'result' in msg` before use.
 */
export type JsonRpcResponse<Result = unknown> =
  | { jsonrpc: '2.0'; id: RequestId; result: Result }
  | { jsonrpc: '2.0'; id: RequestId; error: JsonRpcError };

/** JSON-RPC 2.0 error object. `code` is integer; see `ErrorCode` for standards. */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Standard + ACP-reserved error codes.
 *
 * -327xx is reserved by JSON-RPC 2.0. -32000..-32099 is reserved for protocol-
 * specific errors by the ACP spec; kiro-cli layers its own Kiro-specific codes
 * (rate limiting, quota) on top — see `KiroErrorCode`.
 */
export type ErrorCode =
  | -32700 // Parse error
  | -32600 // Invalid request
  | -32601 // Method not found
  | -32602 // Invalid params
  | -32603 // Internal error
  | -32000 // Authentication required (ACP)
  | -32002 // Resource not found (ACP)
  | number;

// ---------------------------------------------------------------------------
// 2. Core ACP primitives
// ---------------------------------------------------------------------------

/** Session identifier — opaque string minted by the agent. */
export type SessionId = string;

/** Session mode identifier — opaque string. */
export type SessionModeId = string;

/** Permission option identifier — opaque string. */
export type PermissionOptionId = string;

/** Tool call identifier — opaque string. */
export type ToolCallId = string;

/** Session configuration id (e.g. "model", "mode", "thought_level"). */
export type SessionConfigId = string;

/** Session configuration value id (e.g. "claude-haiku-4.5"). */
export type SessionConfigValueId = string;

/** Group id for grouped `SessionConfigSelectOptions`. */
export type SessionConfigGroupId = string;

/** Protocol version — integer. Current wire protocol is version 1. */
export type ProtocolVersion = number;

/**
 * Implementation metadata (name/version) for client OR agent. Required by ACP
 * spec in a future version; currently sent/received best-effort.
 */
export interface Implementation {
  name: string;
  version: string;
  title?: string | null;
}

/** Optional annotations the agent may attach to content for display hinting. */
export interface Annotations {
  audience?: Array<'assistant' | 'user'> | null;
  lastModified?: string | null;
  priority?: number | null;
}

// ---------------------------------------------------------------------------
// 3. Content blocks (shared between prompts and session/update events)
// ---------------------------------------------------------------------------

/** Plain text content block. Baseline — all agents MUST support. */
export interface TextContent {
  type: 'text';
  text: string;
  annotations?: Annotations | null;
}

/** Image content block. Requires `promptCapabilities.image`. */
export interface ImageContent {
  type: 'image';
  data: string; // base64
  mimeType: string;
  uri?: string | null;
  annotations?: Annotations | null;
}

/** Audio content block. Requires `promptCapabilities.audio`. */
export interface AudioContent {
  type: 'audio';
  data: string; // base64
  mimeType: string;
  annotations?: Annotations | null;
}

/** Link to an external/accessible resource. Baseline — all agents MUST support. */
export interface ResourceLink {
  type: 'resource_link';
  name: string;
  uri: string;
  description?: string | null;
  mimeType?: string | null;
  size?: number | null;
  title?: string | null;
  annotations?: Annotations | null;
}

/** Text-based embedded resource contents. */
export interface TextResourceContents {
  uri: string;
  text: string;
  mimeType?: string | null;
}

/** Binary (base64-encoded) embedded resource contents. */
export interface BlobResourceContents {
  uri: string;
  blob: string;
  mimeType?: string | null;
}

/** Resource payload for `EmbeddedResource` — text or binary. */
export type EmbeddedResourceResource = TextResourceContents | BlobResourceContents;

/** Inline embedded resource. Requires `promptCapabilities.embeddedContext`. */
export interface EmbeddedResource {
  type: 'resource';
  resource: EmbeddedResourceResource;
  annotations?: Annotations | null;
}

/**
 * A content block — the atomic unit of prompt and session/update content.
 *
 * Discriminated on `type`. Mirrors MCP content blocks so MCP tool output can
 * be forwarded as-is.
 */
export type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLink
  | EmbeddedResource;

// ---------------------------------------------------------------------------
// 4. Capabilities (exchanged at initialize time)
// ---------------------------------------------------------------------------

/** File system capabilities declared by the client to the agent. */
export interface FileSystemCapabilities {
  readTextFile?: boolean;
  writeTextFile?: boolean;
}

/** Client capabilities advertised in the `initialize` request. */
export interface ClientCapabilities {
  fs?: FileSystemCapabilities;
  /** Whether the client supports all `terminal/*` methods. */
  terminal?: boolean;
}

/** Which `ContentBlock` variants the agent accepts in `session/prompt`. */
export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

/** Which MCP transports the agent can connect to. */
export interface McpCapabilities {
  http?: boolean;
  sse?: boolean;
}

/** `session/close` support marker. Empty `{}` = supported. */
export interface SessionCloseCapabilities {}

/** `session/list` support marker. Empty `{}` = supported. */
export interface SessionListCapabilities {}

/** `session/resume` support marker. Empty `{}` = supported. */
export interface SessionResumeCapabilities {}

/** Optional session capabilities advertised by the agent. */
export interface SessionCapabilities {
  close?: SessionCloseCapabilities | null;
  list?: SessionListCapabilities | null;
  resume?: SessionResumeCapabilities | null;
}

/** Agent capabilities advertised in the `initialize` response. */
export interface AgentCapabilities {
  loadSession?: boolean;
  mcpCapabilities?: McpCapabilities;
  promptCapabilities?: PromptCapabilities;
  sessionCapabilities?: SessionCapabilities;
}

/** Authentication method advertised by the agent. */
export interface AuthMethodAgent {
  type?: 'agent';
  id: string;
  name: string;
  description?: string | null;
}

/** Authentication method union. Currently only `agent` is defined by ACP. */
export type AuthMethod = AuthMethodAgent;

// ---------------------------------------------------------------------------
// 5. MCP server configuration (passed into session/new and session/load)
// ---------------------------------------------------------------------------

/** Name/value env var pair. */
export interface EnvVariable {
  name: string;
  value: string;
}

/** HTTP header pair (for HTTP/SSE MCP transports). */
export interface HttpHeader {
  name: string;
  value: string;
}

/** Stdio-transport MCP server config. All agents MUST support. */
export interface McpServerStdio {
  type?: 'stdio';
  name: string;
  command: string;
  args: string[];
  env: EnvVariable[];
}

/** HTTP-transport MCP server config. Gated on `mcpCapabilities.http`. */
export interface McpServerHttp {
  type: 'http';
  name: string;
  url: string;
  headers: HttpHeader[];
}

/** SSE-transport MCP server config. Gated on `mcpCapabilities.sse`. */
export interface McpServerSse {
  type: 'sse';
  name: string;
  url: string;
  headers: HttpHeader[];
}

/** MCP server discriminated union by transport. */
export type McpServer = McpServerStdio | McpServerHttp | McpServerSse;

// ---------------------------------------------------------------------------
// 6. Session modes & config options
// ---------------------------------------------------------------------------

/** A mode the agent can operate in (e.g. "gpu-dev", "gastown"). */
export interface SessionMode {
  id: SessionModeId;
  name: string;
  description?: string | null;
}

/** Available modes + currently active one. */
export interface SessionModeState {
  currentModeId: SessionModeId;
  availableModes: SessionMode[];
}

/** One value a `SessionConfigSelect` option can take. */
export interface SessionConfigSelectOption {
  value: SessionConfigValueId;
  name: string;
  description?: string | null;
}

/** A group of `SessionConfigSelectOption`s under a header. */
export interface SessionConfigSelectGroup {
  group: SessionConfigGroupId;
  name: string;
  options: SessionConfigSelectOption[];
}

/** Flat OR grouped list of select options — the wire shape picks at runtime. */
export type SessionConfigSelectOptions =
  | SessionConfigSelectOption[]
  | SessionConfigSelectGroup[];

/** Payload for a single-value selector (dropdown). */
export interface SessionConfigSelect {
  currentValue: SessionConfigValueId;
  options: SessionConfigSelectOptions;
}

/**
 * UX category hint for a config option. Clients MUST handle unknown/missing
 * categories gracefully; this is purely a display hint.
 */
export type SessionConfigOptionCategory =
  | 'mode'
  | 'model'
  | 'thought_level'
  | string;

/** A session configuration option (discriminated by `type`). */
export interface SessionConfigOptionSelect extends SessionConfigSelect {
  type: 'select';
  id: SessionConfigId;
  name: string;
  description?: string | null;
  category?: SessionConfigOptionCategory | null;
}

/** Session configuration option union. Currently only `select` is defined. */
export type SessionConfigOption = SessionConfigOptionSelect;

// ---------------------------------------------------------------------------
// 7. initialize
// ---------------------------------------------------------------------------

/** Params for `initialize` (client → agent). */
export interface InitializeRequest {
  protocolVersion: ProtocolVersion;
  clientCapabilities?: ClientCapabilities;
  clientInfo?: Implementation | null;
}

/** Response to `initialize`. */
export interface InitializeResponse {
  protocolVersion: ProtocolVersion;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: Implementation | null;
  authMethods?: AuthMethod[];
}

// ---------------------------------------------------------------------------
// 8. authenticate
// ---------------------------------------------------------------------------

/** Params for `authenticate` (client → agent). */
export interface AuthenticateRequest {
  methodId: string;
}

/** Empty response; auth success is signalled by absence of an error. */
export interface AuthenticateResponse {}

// ---------------------------------------------------------------------------
// 9. session/new, session/load, session/resume, session/close, session/list
// ---------------------------------------------------------------------------

/** Params for `session/new` (client → agent). */
export interface NewSessionRequest {
  cwd: string;
  mcpServers: McpServer[];
}

/** Response from `session/new`. */
export interface NewSessionResponse {
  sessionId: SessionId;
  modes?: SessionModeState | null;
  /** Initial model list / selection — see `SessionConfigOptionCategory.model`. */
  configOptions?: SessionConfigOption[] | null;
}

/** Params for `session/load` (client → agent). */
export interface LoadSessionRequest {
  sessionId: SessionId;
  cwd: string;
  mcpServers: McpServer[];
}

/** Response from `session/load`. */
export interface LoadSessionResponse {
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
}

/** Params for `session/resume` (client → agent). */
export interface ResumeSessionRequest {
  sessionId: SessionId;
  cwd: string;
  mcpServers: McpServer[];
}

/** Response from `session/resume`. */
export interface ResumeSessionResponse {
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
}

/** Params for `session/close` (client → agent). */
export interface CloseSessionRequest {
  sessionId: SessionId;
}

/** Empty response; close success is signalled by absence of an error. */
export interface CloseSessionResponse {}

/** Metadata about a session returned by `session/list`. */
export interface SessionInfo {
  sessionId: SessionId;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null; // ISO 8601
}

/** Params for `session/list` (client → agent). */
export interface ListSessionsRequest {
  cwd?: string | null;
  cursor?: string | null;
}

/** Response from `session/list`. */
export interface ListSessionsResponse {
  sessions: SessionInfo[];
  nextCursor?: string | null;
}

// ---------------------------------------------------------------------------
// 10. session/prompt
// ---------------------------------------------------------------------------

/** Params for `session/prompt` (client → agent). */
export interface PromptRequest {
  sessionId: SessionId;
  prompt: ContentBlock[];
}

/** Reasons the agent stopped processing a turn. */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

/** Response from `session/prompt`. */
export interface PromptResponse {
  stopReason: StopReason;
}

// ---------------------------------------------------------------------------
// 11. session/cancel, session/set_mode, session/set_config_option
// ---------------------------------------------------------------------------

/** Notification to cancel the current prompt turn (client → agent). */
export interface CancelNotification {
  sessionId: SessionId;
}

/** Params for `session/set_mode` (client → agent). */
export interface SetSessionModeRequest {
  sessionId: SessionId;
  modeId: SessionModeId;
}

/** Empty response to `session/set_mode`. */
export interface SetSessionModeResponse {}

/** Params for `session/set_config_option` (client → agent). */
export interface SetSessionConfigOptionRequest {
  sessionId: SessionId;
  configId: SessionConfigId;
  value: SessionConfigValueId;
}

/** Response from `session/set_config_option`. */
export interface SetSessionConfigOptionResponse {
  configOptions: SessionConfigOption[];
}

// ---------------------------------------------------------------------------
// 12. Tool calls (in session/update events)
// ---------------------------------------------------------------------------

/** Tool call execution status. */
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Tool category. `other` is the default when no category matches.
 * Non-exhaustive string for forward compatibility.
 */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'
  | string;

/** File path (+ optional line) a tool call is operating on. */
export interface ToolCallLocation {
  path: string;
  line?: number | null;
}

/** Standard ToolCallContent wrapper around a `ContentBlock`. */
export interface ToolCallContentContent {
  type: 'content';
  content: ContentBlock;
}

/** File-modification diff content. */
export interface Diff {
  path: string;
  newText: string;
  oldText?: string | null;
}

/** Diff ToolCallContent variant. */
export interface ToolCallContentDiff extends Diff {
  type: 'diff';
}

/** Terminal embed — references a terminal created via `terminal/create`. */
export interface ToolCallContentTerminal {
  type: 'terminal';
  terminalId: string;
}

/** Content a tool call has produced or is producing. */
export type ToolCallContent =
  | ToolCallContentContent
  | ToolCallContentDiff
  | ToolCallContentTerminal;

/**
 * Full tool call payload — fired once when a tool call begins.
 *
 * Note: the live smoke test also observed a `title` field (human-readable label)
 * on the wire. It's not in the published ACP schema, so we surface it as an
 * optional field rather than pretending it's required.
 */
export interface ToolCall {
  toolCallId: ToolCallId;
  kind: ToolKind;
  status: ToolCallStatus;
  /** Human-readable label shown to the user, e.g. "Write to file". */
  title?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
}

/**
 * Partial update to an in-flight tool call. All fields except `toolCallId`
 * are optional — only changed fields are included.
 */
export interface ToolCallUpdate {
  toolCallId: ToolCallId;
  title?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
}

// ---------------------------------------------------------------------------
// 13. Agent plan (in session/update events)
// ---------------------------------------------------------------------------

/** Priority of a plan entry. */
export type PlanEntryPriority = 'high' | 'medium' | 'low';

/** Execution status of a plan entry. */
export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';

/** A single entry in the agent's execution plan. */
export interface PlanEntry {
  content: string;
  priority: PlanEntryPriority;
  status: PlanEntryStatus;
}

/** The agent's current execution plan. Sent as a full replacement each time. */
export interface Plan {
  entries: PlanEntry[];
}

// ---------------------------------------------------------------------------
// 14. Available slash commands
// ---------------------------------------------------------------------------

/** Free-form trailing-text input for a slash command. */
export interface UnstructuredCommandInput {
  hint: string;
}

/** Command input shape. Currently only `unstructured` is defined. */
export type AvailableCommandInput = UnstructuredCommandInput;

/** Metadata for one slash command the agent advertises. */
export interface AvailableCommand {
  name: string;
  description: string;
  input?: AvailableCommandInput | null;
}

// ---------------------------------------------------------------------------
// 15. session/update — the streaming notification
// ---------------------------------------------------------------------------

/** Streamed user message content (echo of the user's turn). */
export interface SessionUpdateUserMessageChunk {
  sessionUpdate: 'user_message_chunk';
  content: ContentBlock;
}

/** Streamed assistant text. */
export interface SessionUpdateAgentMessageChunk {
  sessionUpdate: 'agent_message_chunk';
  content: ContentBlock;
}

/** Streamed extended-thinking / internal-reasoning text. */
export interface SessionUpdateAgentThoughtChunk {
  sessionUpdate: 'agent_thought_chunk';
  content: ContentBlock;
}

/** A new tool call is starting. */
export type SessionUpdateToolCall = { sessionUpdate: 'tool_call' } & ToolCall;

/** Progress / final result for an in-flight tool call. */
export type SessionUpdateToolCallUpdate = { sessionUpdate: 'tool_call_update' } & ToolCallUpdate;

/**
 * Partial tool-call input/argument streaming.
 *
 * Observed in the kiro-cli binary alongside the documented ACP variants but
 * NOT present in Zed's published schema. Typed loosely (pass-through) so
 * consumers can inspect it without the union rejecting unknown fields.
 */
export interface SessionUpdateToolCallChunk {
  sessionUpdate: 'tool_call_chunk';
  toolCallId: ToolCallId;
  [key: string]: unknown;
}

/** Current execution plan snapshot. */
export type SessionUpdatePlan = { sessionUpdate: 'plan' } & Plan;

/** Agent advertises (or re-advertises) its slash-command catalogue. */
export interface SessionUpdateAvailableCommandsUpdate {
  sessionUpdate: 'available_commands_update';
  availableCommands: AvailableCommand[];
}

/** Active session mode changed. */
export interface SessionUpdateCurrentModeUpdate {
  sessionUpdate: 'current_mode_update';
  currentModeId: SessionModeId;
}

/** Session config options (the whole set) changed. */
export interface SessionUpdateConfigOptionUpdate {
  sessionUpdate: 'config_option_update';
  configOptions: SessionConfigOption[];
}

/** Session metadata (title, last-updated) changed — all fields optional. */
export interface SessionUpdateSessionInfoUpdate {
  sessionUpdate: 'session_info_update';
  title?: string | null;
  updatedAt?: string | null;
}

/**
 * Discriminated union of `session/update` event payloads.
 *
 * Discriminant: `sessionUpdate`. Narrow with a `switch` on that field.
 */
export type SessionUpdate =
  | SessionUpdateUserMessageChunk
  | SessionUpdateAgentMessageChunk
  | SessionUpdateAgentThoughtChunk
  | SessionUpdateToolCall
  | SessionUpdateToolCallUpdate
  | SessionUpdateToolCallChunk
  | SessionUpdatePlan
  | SessionUpdateAvailableCommandsUpdate
  | SessionUpdateCurrentModeUpdate
  | SessionUpdateConfigOptionUpdate
  | SessionUpdateSessionInfoUpdate;

/** Params for `session/update` (agent → client, notification). */
export interface SessionNotificationParams {
  sessionId: SessionId;
  update: SessionUpdate;
}

// ---------------------------------------------------------------------------
// 16. Permission prompts (agent → client request)
// ---------------------------------------------------------------------------

/** Type hint for a permission option — drives icon/UX. */
export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

/** One choice presented to the user for a permission prompt. */
export interface PermissionOption {
  optionId: PermissionOptionId;
  name: string;
  kind: PermissionOptionKind;
}

/** Agent-side request for user authorization on a tool call. */
export interface RequestPermissionRequest {
  sessionId: SessionId;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
}

/** User selected one of the offered options. */
export interface SelectedPermissionOutcome {
  outcome: 'selected';
  optionId: PermissionOptionId;
}

/** Prompt turn was cancelled before the user responded. */
export interface CancelledPermissionOutcome {
  outcome: 'cancelled';
}

/** Discriminated union of permission-request outcomes. */
export type RequestPermissionOutcome =
  | SelectedPermissionOutcome
  | CancelledPermissionOutcome;

/** Response to `session/request_permission`. */
export interface RequestPermissionResponse {
  outcome: RequestPermissionOutcome;
}

// ---------------------------------------------------------------------------
// 17. fs/* bridge (agent → client requests)
// ---------------------------------------------------------------------------

/** Agent asks client to read a text file. */
export interface ReadTextFileRequest {
  sessionId: SessionId;
  path: string;
  line?: number | null; // 1-based
  limit?: number | null;
}

/** Response: the (possibly partial) file contents. */
export interface ReadTextFileResponse {
  content: string;
}

/** Agent asks client to write a text file. */
export interface WriteTextFileRequest {
  sessionId: SessionId;
  path: string;
  content: string;
}

/** Empty response; success signalled by absence of an error. */
export interface WriteTextFileResponse {}

// ---------------------------------------------------------------------------
// 18. terminal/* bridge (agent → client requests)
// ---------------------------------------------------------------------------

/** Agent asks client to spawn a terminal running a command. */
export interface CreateTerminalRequest {
  sessionId: SessionId;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: EnvVariable[];
  /** Byte ceiling for retained output; truncation happens at char boundaries. */
  outputByteLimit?: number | null;
}

/** Opaque id for subsequent `terminal/*` calls. */
export interface CreateTerminalResponse {
  terminalId: string;
}

/** Agent asks for the current terminal buffer + exit status (if any). */
export interface TerminalOutputRequest {
  sessionId: SessionId;
  terminalId: string;
}

/** Process exit info — separate from output-capture truncation. */
export interface TerminalExitStatus {
  exitCode?: number | null;
  signal?: string | null;
}

/** Response: the retained output + truncation flag + optional exit status. */
export interface TerminalOutputResponse {
  output: string;
  truncated: boolean;
  exitStatus?: TerminalExitStatus | null;
}

/** Agent asks client to wait for the terminal's command to exit. */
export interface WaitForTerminalExitRequest {
  sessionId: SessionId;
  terminalId: string;
}

/** Exit code + signal. Both may be null (e.g. detached/cancelled). */
export interface WaitForTerminalExitResponse {
  exitCode?: number | null;
  signal?: string | null;
}

/** Agent asks client to kill the command (keeps terminal id valid). */
export interface KillTerminalRequest {
  sessionId: SessionId;
  terminalId: string;
}

/** Empty response. */
export interface KillTerminalResponse {}

/** Agent asks client to free the terminal (kills command if still running). */
export interface ReleaseTerminalRequest {
  sessionId: SessionId;
  terminalId: string;
}

/** Empty response. */
export interface ReleaseTerminalResponse {}

// ---------------------------------------------------------------------------
// 19. Kiro extensions (_kiro.dev/*)
//
// These are NOT part of the upstream ACP schema — they're Kiro-specific methods
// and notifications surfaced by `kiro-cli acp`. Field shapes are from the
// design doc §1b / §2a-b and the strings table of the 2.1.1 binary. Where a
// payload isn't fully documented, we expose a pass-through `params` interface
// so consumers can inspect without round-trip loss.
// ---------------------------------------------------------------------------

/** One meter value inside `_kiro.dev/metadata.meteringUsage`. */
export interface KiroMeteringUsage {
  value: number;
  unit: string;
  unitPlural?: string;
}

/**
 * Per-turn metadata from kiro-cli. Emitted after each assistant turn finishes.
 *
 * **This is how downstream cost accounting works.** `_kiro.dev/metadata`
 * replaces `claude-agent-sdk`'s `SDKResultMessage.total_cost_usd` — accumulate
 * `meteringUsage[].value` across turns, keeping in mind the unit is Kiro credits,
 * not USD.
 */
export interface KiroMetadataNotification {
  sessionId: SessionId;
  contextUsagePercentage?: number;
  turnDurationMs?: number;
  meteringUsage?: KiroMeteringUsage[];
}

/** `_kiro.dev/commands/available` — slash command list sent after MCP init. */
export interface KiroCommandsAvailableNotification {
  sessionId: SessionId;
  commands: AvailableCommand[];
}

/** `_kiro.dev/mcp/server_initialized` — one MCP server finished coming up. */
export interface KiroMcpServerInitializedNotification {
  sessionId: SessionId;
  serverName: string;
}

/** `_kiro.dev/mcp/server_init_failure` — an MCP server failed to initialize. */
export interface KiroMcpServerInitFailureNotification {
  sessionId: SessionId;
  serverName: string;
  /** Human-readable failure description. */
  reason?: string;
}

/** `_kiro.dev/mcp/oauth_request` — an MCP server needs OAuth from the user. */
export interface KiroMcpOauthRequestNotification {
  sessionId: SessionId;
  serverName: string;
  oauthUrl: string;
}

/**
 * Execution status for a subagent in `_kiro.dev/subagent/list_update`.
 *
 * Extracted from the binary's SubagentInfo variants — kiro-cli models subagents
 * with an explicit state machine.
 */
export type KiroSubagentStatus =
  | 'working'
  | 'awaitingInstruction'
  | 'terminated'
  | 'started'
  | 'completed'
  | 'failed'
  | string;

/** One subagent's current state. */
export interface KiroSubagentInfo {
  sessionId: SessionId;
  sessionName?: string;
  agentName?: string;
  initialQuery?: string;
  status: KiroSubagentStatus;
  group?: string;
  dependsOn?: string[];
}

/** `_kiro.dev/subagent/list_update` — full subagent roster snapshot. */
export interface KiroSubagentListUpdateNotification {
  sessionId: SessionId;
  subagents: KiroSubagentInfo[];
  pendingStages?: unknown[];
}

/** `_kiro.dev/session/inbox_notification` — cross-session mail/nudge. */
export interface KiroSessionInboxNotification {
  sessionId: SessionId;
  message?: string;
  escalation?: boolean;
  [key: string]: unknown;
}

/**
 * `_kiro.dev/session/update` — Kiro's persistence / session-state update.
 *
 * Distinct from ACP's `session/update` (which streams per-turn events). This
 * one fires when the agent persists session-level state (title, context
 * summary, tool-use snapshot). Typed as pass-through because the payload is
 * internal and not promised stable.
 */
export interface KiroSessionPersistNotification {
  sessionId: SessionId;
  [key: string]: unknown;
}

/** `_kiro.dev/error/rate_limit` — rate-limit hit mid-turn. */
export interface KiroRateLimitNotification {
  sessionId: SessionId;
  message?: string;
}

/** `_kiro.dev/compaction/status` — conversation compaction progress. */
export interface KiroCompactionStatusNotification {
  sessionId: SessionId;
  status?: string;
  [key: string]: unknown;
}

/** `_kiro.dev/clear/status` — /clear was issued, context usage re-baselined. */
export interface KiroClearStatusNotification {
  sessionId: SessionId;
  [key: string]: unknown;
}

/** `_kiro.dev/agent/switched` — active agent changed mid-session. */
export interface KiroAgentSwitchedNotification {
  sessionId: SessionId;
  previousAgentName?: string;
  agentName?: string;
  [key: string]: unknown;
}

/** `_kiro.dev/agent/not_found` — requested agent doesn't exist. */
export interface KiroAgentNotFoundNotification {
  sessionId: SessionId;
  requestedAgent?: string;
  fallbackAgent?: string;
}

/** `_kiro.dev/agent/config_error` — agent config failed to load. */
export interface KiroAgentConfigErrorNotification {
  sessionId: SessionId;
  agentName?: string;
  message?: string;
}

/** `_kiro.dev/model/not_found` — requested model id not available. */
export interface KiroModelNotFoundNotification {
  sessionId: SessionId;
  requestedModel?: string;
  fallbackModel?: string;
}

// --- Kiro request/response methods (client → agent) ---

/**
 * `_kiro.dev/commands/execute` — invoke a slash command programmatically.
 *
 * The design doc lists this as a Kiro extension; the binary confirms it. The
 * wire shape mirrors an MCP/LSP ExecuteCommand: command name + optional args.
 * We type `arguments` / `result` as pass-through because the shape depends on
 * the command being executed.
 */
export interface KiroExecuteCommandRequest {
  sessionId: SessionId;
  command: string;
  arguments?: unknown[];
  [key: string]: unknown;
}

/** Response to `_kiro.dev/commands/execute`. Shape varies by command. */
export interface KiroExecuteCommandResponse {
  success: boolean;
  message?: string;
  result?: unknown;
  [key: string]: unknown;
}

/** `_kiro.dev/commands/options` — fetch option list for a slash command. */
export interface KiroCommandOptionsRequest {
  sessionId: SessionId;
  command: string;
  [key: string]: unknown;
}

/** Response to `_kiro.dev/commands/options`. */
export interface KiroCommandOptionsResponse {
  options: Array<{
    value?: string;
    label?: string;
    description?: string;
    [key: string]: unknown;
  }>;
  hasMore?: boolean;
  nextCursor?: string;
  [key: string]: unknown;
}

/** `_kiro.dev/session/list` — Kiro's richer session listing (vs ACP session/list). */
export interface KiroSessionListRequest {
  cwd?: string | null;
  [key: string]: unknown;
}

/** Response to `_kiro.dev/session/list`. */
export interface KiroSessionListResponse {
  sessions: Array<{
    sessionId: SessionId;
    title?: string | null;
    updatedAt?: string | null;
    messageCount?: number;
    [key: string]: unknown;
  }>;
  hasMore?: boolean;
  nextCursor?: string;
}

/** `_kiro.dev/session/terminate` — terminate a specific session id. */
export interface KiroSessionTerminateRequest {
  sessionId: SessionId;
}

/** Empty response to `_kiro.dev/session/terminate`. */
export interface KiroSessionTerminateResponse {}

/** `_kiro.dev/settings/list` — read the active Kiro settings snapshot. */
export interface KiroSettingsListRequest {
  [key: string]: unknown;
}

/**
 * Response to `_kiro.dev/settings/list`. A flat map of settings keys to values;
 * the key namespace is Kiro's (e.g. `chat.defaultModel`, `telemetry.enabled`).
 */
export interface KiroSettingsListResponse {
  settings: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 20. Method name unions (wire-level method strings)
// ---------------------------------------------------------------------------

/** Standard ACP methods the CLIENT sends to the AGENT. */
export type AcpClientToAgentMethod =
  | 'initialize'
  | 'authenticate'
  | 'session/new'
  | 'session/load'
  | 'session/resume'
  | 'session/close'
  | 'session/list'
  | 'session/prompt'
  | 'session/cancel'
  | 'session/set_mode'
  | 'session/set_config_option';

/** Standard ACP methods the AGENT sends to the CLIENT. */
export type AcpAgentToClientMethod =
  | 'session/update' // notification
  | 'session/request_permission' // request
  | 'fs/read_text_file'
  | 'fs/write_text_file'
  | 'terminal/create'
  | 'terminal/output'
  | 'terminal/wait_for_exit'
  | 'terminal/kill'
  | 'terminal/release';

/** Kiro-specific notification methods (agent → client). */
export type KiroNotificationMethod =
  | '_kiro.dev/metadata'
  | '_kiro.dev/mcp/server_initialized'
  | '_kiro.dev/mcp/server_init_failure'
  | '_kiro.dev/mcp/oauth_request'
  | '_kiro.dev/commands/available'
  | '_kiro.dev/subagent/list_update'
  | '_kiro.dev/session/update'
  | '_kiro.dev/session/inbox_notification'
  | '_kiro.dev/error/rate_limit'
  | '_kiro.dev/compaction/status'
  | '_kiro.dev/clear/status'
  | '_kiro.dev/agent/switched'
  | '_kiro.dev/agent/not_found'
  | '_kiro.dev/agent/config_error'
  | '_kiro.dev/model/not_found';

/** Kiro-specific request methods (client → agent). */
export type KiroRequestMethod =
  | '_kiro.dev/commands/execute'
  | '_kiro.dev/commands/options'
  | '_kiro.dev/session/list'
  | '_kiro.dev/session/terminate'
  | '_kiro.dev/settings/list';

/** All methods that can appear on the wire, standard + Kiro extension. */
export type KiroAcpMethod =
  | AcpClientToAgentMethod
  | AcpAgentToClientMethod
  | KiroNotificationMethod
  | KiroRequestMethod;

// ---------------------------------------------------------------------------
// 21. Typed envelope helpers (for client authors)
// ---------------------------------------------------------------------------

/**
 * Map of standard ACP client→agent requests to their (params, result) pair.
 * Useful for a typed `call<M extends keyof ...>(method, params): Promise<result>`
 * signature in the client module.
 */
export interface AcpClientRequests {
  initialize: { params: InitializeRequest; result: InitializeResponse };
  authenticate: { params: AuthenticateRequest; result: AuthenticateResponse };
  'session/new': { params: NewSessionRequest; result: NewSessionResponse };
  'session/load': { params: LoadSessionRequest; result: LoadSessionResponse };
  'session/resume': { params: ResumeSessionRequest; result: ResumeSessionResponse };
  'session/close': { params: CloseSessionRequest; result: CloseSessionResponse };
  'session/list': { params: ListSessionsRequest; result: ListSessionsResponse };
  'session/prompt': { params: PromptRequest; result: PromptResponse };
  'session/set_mode': {
    params: SetSessionModeRequest;
    result: SetSessionModeResponse;
  };
  'session/set_config_option': {
    params: SetSessionConfigOptionRequest;
    result: SetSessionConfigOptionResponse;
  };
}

/** Client→agent notifications (no response expected). */
export interface AcpClientNotifications {
  'session/cancel': { params: CancelNotification };
}

/**
 * Map of agent→client requests (the client must handle these) to their
 * (params, result) pair. The client library surfaces a handler registration
 * API keyed on these.
 */
export interface AcpAgentToClientRequests {
  'session/request_permission': {
    params: RequestPermissionRequest;
    result: RequestPermissionResponse;
  };
  'fs/read_text_file': {
    params: ReadTextFileRequest;
    result: ReadTextFileResponse;
  };
  'fs/write_text_file': {
    params: WriteTextFileRequest;
    result: WriteTextFileResponse;
  };
  'terminal/create': {
    params: CreateTerminalRequest;
    result: CreateTerminalResponse;
  };
  'terminal/output': {
    params: TerminalOutputRequest;
    result: TerminalOutputResponse;
  };
  'terminal/wait_for_exit': {
    params: WaitForTerminalExitRequest;
    result: WaitForTerminalExitResponse;
  };
  'terminal/kill': { params: KillTerminalRequest; result: KillTerminalResponse };
  'terminal/release': {
    params: ReleaseTerminalRequest;
    result: ReleaseTerminalResponse;
  };
}

/** Agent→client notifications (the client only consumes; no response). */
export interface AcpAgentToClientNotifications {
  'session/update': { params: SessionNotificationParams };
}

/** Kiro extension notifications (agent → client). */
export interface KiroNotifications {
  '_kiro.dev/metadata': { params: KiroMetadataNotification };
  '_kiro.dev/mcp/server_initialized': {
    params: KiroMcpServerInitializedNotification;
  };
  '_kiro.dev/mcp/server_init_failure': {
    params: KiroMcpServerInitFailureNotification;
  };
  '_kiro.dev/mcp/oauth_request': { params: KiroMcpOauthRequestNotification };
  '_kiro.dev/commands/available': { params: KiroCommandsAvailableNotification };
  '_kiro.dev/subagent/list_update': {
    params: KiroSubagentListUpdateNotification;
  };
  '_kiro.dev/session/update': { params: KiroSessionPersistNotification };
  '_kiro.dev/session/inbox_notification': { params: KiroSessionInboxNotification };
  '_kiro.dev/error/rate_limit': { params: KiroRateLimitNotification };
  '_kiro.dev/compaction/status': { params: KiroCompactionStatusNotification };
  '_kiro.dev/clear/status': { params: KiroClearStatusNotification };
  '_kiro.dev/agent/switched': { params: KiroAgentSwitchedNotification };
  '_kiro.dev/agent/not_found': { params: KiroAgentNotFoundNotification };
  '_kiro.dev/agent/config_error': { params: KiroAgentConfigErrorNotification };
  '_kiro.dev/model/not_found': { params: KiroModelNotFoundNotification };
}

/** Kiro extension requests (client → agent). */
export interface KiroRequests {
  '_kiro.dev/commands/execute': {
    params: KiroExecuteCommandRequest;
    result: KiroExecuteCommandResponse;
  };
  '_kiro.dev/commands/options': {
    params: KiroCommandOptionsRequest;
    result: KiroCommandOptionsResponse;
  };
  '_kiro.dev/session/list': {
    params: KiroSessionListRequest;
    result: KiroSessionListResponse;
  };
  '_kiro.dev/session/terminate': {
    params: KiroSessionTerminateRequest;
    result: KiroSessionTerminateResponse;
  };
  '_kiro.dev/settings/list': {
    params: KiroSettingsListRequest;
    result: KiroSettingsListResponse;
  };
}

/**
 * Tagged notification union — useful when iterating a buffered stream. Each
 * variant has `method` + strongly-typed `params`. Mirrors the discriminator
 * pattern in `SessionUpdate` at the RPC level.
 */
export type TaggedNotification =
  | {
      [M in keyof AcpAgentToClientNotifications]: {
        method: M;
        params: AcpAgentToClientNotifications[M]['params'];
      };
    }[keyof AcpAgentToClientNotifications]
  | {
      [M in keyof KiroNotifications]: {
        method: M;
        params: KiroNotifications[M]['params'];
      };
    }[keyof KiroNotifications];

/** Tagged agent→client request union (for client handler dispatch). */
export type TaggedAgentToClientRequest = {
  [M in keyof AcpAgentToClientRequests]: {
    method: M;
    params: AcpAgentToClientRequests[M]['params'];
  };
}[keyof AcpAgentToClientRequests];
