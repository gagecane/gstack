# kiro-cli scriptable interface — investigation notes

**Bead:** `gsk-i76`
**Parent:** `gsk-aca` — Run gstack entirely on kiro-cli
**Status:** Investigation complete. Recommendation: **replace** `claude-agent-sdk.query()` with a thin ACP (Agent Client Protocol) client over `kiro-cli acp`.

## TL;DR

`kiro-cli` exposes three distinct scriptable entry points, in order of programmatic usefulness:

1. **`kiro-cli acp`** — JSON-RPC 2.0 over stdio, implementing Zed's Agent Client Protocol (ACP) with Kiro extensions. This is the real equivalent of `claude-agent-sdk.query()`. Streams `agent_message_chunk`, `agent_thought_chunk`, `tool_call`/`tool_call_update`, `plan`, and `session/update` events. Supports session new/load, file I/O bridge, terminal bridge, permission prompts, and per-session model/mode switching. **Use this for gstack.**
2. **`kiro-cli chat --no-interactive`** — stdin prompt → stdout plain (ANSI-decorated) text. No structured events. Good for sanity checks and one-shot scripts, useless for anything that needs to observe tool calls, tokens, or costs. The `--format=json` flag is documented as applying only to `--list-models`; it does not emit JSON for chat responses.
3. **`kiro-cli mcp add|remove|list|import|status`** — manage MCP server config only; not an invocation path.

`claude-agent-sdk` is a wrapper around the Anthropic API + Claude Code's internal harness. `kiro-cli acp` exposes the same shape (system init → assistant streaming → tool calls with approval → final result with cost) over a documented open protocol. No functional gaps that block the migration. Minor gap: no typed TypeScript schema is shipped with the binary, so we'd own the types ourselves (roughly 200 lines, straightforward to derive).

Binary is `/home/canewiw/.toolbox/tools/kiro-cli/2.1.1/kiro-cli-chat` (symlinked via toolbox-exec). Tested against `kiro-cli 2.0.1` and `2.1.1`.

---

## 1. Invocation modes

```text
kiro-cli <subcommand>

  chat [INPUT]      Interactive or one-shot headless chat
  acp               Agent Client Protocol server over stdio
  mcp               Manage MCP server configuration
  agent             Manage agents (list/create/edit/validate/set-default)
  settings          Read/write settings (cli.json, mcp.json)
  mcp               MCP config: add/remove/list/import/status
  login/logout      Auth
  doctor/diagnostic Install health
  (... plus many toolbox/desktop app commands that are not relevant here)
```

### 1a. `kiro-cli chat --no-interactive` (headless)

```
kiro-cli chat [OPTIONS] [INPUT]

  INPUT                        First question (alternative: pipe via stdin)
  --no-interactive             Run without expecting further user input
  --trust-all-tools            Auto-approve every tool request
  --trust-tools=fs_read,...    Trust only listed tools
  --trust-tools=               Trust nothing (but see caveat below)
  --agent <AGENT>              Context profile to use (from ~/.kiro/agents/)
  --model <MODEL>              Model id (see `--list-models`)
  --resume                     Resume most recent session in cwd
  --resume-id <SESSION_ID>     Resume a specific session
  --list-sessions              List saved sessions for this directory
  --list-models [--format=json|json-pretty|plain]
  --delete-session <ID>
  --require-mcp-startup        Fail with exit 3 if any MCP server fails
  -w, --wrap <auto|always|never>
```

**I/O shape (observed, stdin-piped):**
- `stdout`: line starting with `> <your input>` (the prompt echo), then the raw assistant text, with ANSI color codes. No trailing newline on the final chunk. When the model calls tools, their invocation and result are written to stdout before the final answer.
- `stderr`: duplicate-agent warnings, spinner/hook progress, a trailing ` ▸ Credits: X.XX • Time: Ys` line, and a terminal cursor-restore sequence.
- Exit code: 0 on success, 3 on MCP startup failure (when `--require-mcp-startup` is set), 1 on other errors. (Not comprehensively mapped.)

**Caveat:** Passing the prompt as positional `INPUT` rather than via stdin produces **no stdout output** when stdout is not a TTY (observed with both `>file` redirect and pipe). Stdin piping is the reliable path.

**Caveat:** In `--no-interactive` mode with `--trust-tools=` (empty allowlist), the CLI still executed an `fs_write` to create a file. The tool permission UI is designed for interactive approval; when non-interactive, the default is to proceed. For hard sandboxing, configure the agent's `tools` / `allowedTools` via an agent JSON config (see §4) rather than relying on `--trust-tools`.

**Session continuity:** `--list-sessions` shows `Chat SessionId: <uuid>`. Passing `--resume-id <uuid>` resumes and the model retains the full prior history. Sessions are stored per cwd (under `~/.kiro/sessions/`).

### 1b. `kiro-cli acp` (ACP server over stdio) — **the real programmatic interface**

```
kiro-cli acp [OPTIONS]

  --agent <AGENT>         First-session agent
  --model <MODEL>         First-session model id
  --trust-all-tools       Auto-approve every tool request (no permission prompts)
  --trust-tools <NAMES>   Trust only listed tools
```

Speaks JSON-RPC 2.0, line-delimited, over the child process's stdin/stdout. This is the same Agent Client Protocol Zed uses to talk to Claude Code and Gemini; Kiro has implemented it on the agent side with a few Kiro-specific extensions under the `_kiro.dev/` namespace.

Verified against a live session (see §3 for the transcript):

- `initialize` — handshake. Client sends `{protocolVersion, clientCapabilities, clientInfo}`; agent replies with `{protocolVersion, agentCapabilities: {loadSession, promptCapabilities: {image, audio, embeddedContext}, mcpCapabilities: {http, sse}, sessionCapabilities}, authMethods, agentInfo: {name, title, version}}`.
- `session/new` — create a session. Params: `{cwd, mcpServers}`. Returns `{sessionId, modes: {currentModeId, availableModes}, models: {currentModelId, availableModels}, configOptions?}`.
- `session/prompt` — send user turn. Params: `{sessionId, prompt: ContentBlock[]}` where each block is `{type: "text", text}` / `"image"` / `"audio"` / `"resource_link"` / `"embedded_resource"`. Returns `{stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"}`.
- `session/load` — resume an existing session. (agent advertises `agentCapabilities.loadSession: true`.)
- `session/cancel` — cancel the current turn.
- `session/request_permission` — **agent→client** request for tool approval, with `PermissionOption` variants `allow_once | allow_always | reject_once | reject_always`. Client responds with the chosen option or `cancelled`.
- `session/update` — **agent→client** notification carrying a streaming event. Variants observed in the binary:
  - `agent_message_chunk` — streamed assistant text (`content: {type: "text", text}`)
  - `agent_thought_chunk` — streamed reasoning / extended thinking
  - `user_message_chunk` — echoed user turn content
  - `tool_call` — new tool invocation starting (id, title, input, kind, status)
  - `tool_call_update` — progress / final result for an in-flight tool, including `ToolCallContent` of kind `Diff`, `Content`, or `Terminal`
  - `plan` — structured plan (`entries: [{content, priority, audience}]`)
  - `available_commands_update` — slash command list for this session
  - `current_mode_update` / `config_option_update` — session mode/config switches
- `fs/read_text_file` / `fs/write_text_file` — **agent→client** file I/O bridge (standard ACP). Only invoked when `clientCapabilities.fs.{readTextFile,writeTextFile}` is set. Gstack would opt in so Kiro can read/write project files through our process (enabling sandboxing, virtual filesystems, etc.).
- `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill_command`, `terminal/release` — **agent→client** terminal bridge, for shell tools.
- `tasks/list`, `tasks/get`, `tasks/cancel`, `tasks/result` — MCP task protocol (for long-running MCP ops).
- `notifications/initialized`, `notifications/cancelled`, `notifications/progress` — standard MCP/JSON-RPC notifications.

**Kiro extensions** (prefixed `_kiro.dev/`):
- `_kiro.dev/mcp/server_initialized` — notification each time an MCP server finishes initializing.
- `_kiro.dev/commands/available` — full slash-command list (e.g. `/agent`, `/model`) sent after each MCP server comes up.
- `_kiro.dev/commands/execute` / `_kiro.dev/commands/options` — execute a slash command or fetch its option list.
- `_kiro.dev/metadata` — per-session metadata update: `{contextUsagePercentage, meteringUsage: [{value, unit, unitPlural}], turnDurationMs}`. **This is where token/credit usage lives.**
- `_kiro.dev/subagent/list_update` — subagent session tracking.
- `_kiro.dev/session/terminate`, `_kiro.dev/session/list`, `_kiro.dev/session/inbox_notification` — session management.
- `_kiro.dev/settings/list` — read settings.

Error model is standard JSON-RPC: method-not-found, invalid-params, internal-error, plus Kiro error codes for `AuthenticationRequired`, `ResourceNotFound`, etc.

### 1c. Model listing (the one JSON output that exists today)

```
kiro-cli chat --list-models --format=json
```

Returns `{models: [{model_name, description, model_id, context_window_tokens, rate_multiplier, rate_unit}, ...], default_model}`. Tested working.

### 1d. MCP

```
kiro-cli mcp {add|remove|list|import|status}
```

Pure config management. Not an invocation path.

### 1e. Agent config

```
kiro-cli agent {list|create|edit|validate|migrate|set-default}
```

Agents are JSON files at `~/.kiro/agents/<name>.json` (global) or `.kiro/agents/<name>.json` (workspace). Shape:

```jsonc
{
  "name": "example",
  "description": "...",
  "prompt": null,                 // system prompt (string | null)
  "mcpServers": {},                // per-agent MCP server overrides
  "tools": ["read", "write", "shell", "aws", "introspect", "knowledge",
            "thinking", "todo", "delegate", "grep", "glob",
            "@mcp_server/tool_name", "@mcp_server"],
  "toolAliases": {},
  "allowedTools": [],              // auto-approved subset of `tools`
  "resources": [],                 // file://, skill://
  "hooks": {},
  "toolsSettings": {},
  "includeMcpJson": true,
  "model": null                    // per-agent default model
}
```

This is where the hard permission boundary lives. `--trust-all-tools` on the CLI is a session-level override; `tools` / `allowedTools` in the agent config is the source of truth.

---

## 2. Mapping claude-agent-sdk concepts to kiro-cli

| `claude-agent-sdk` concept | `kiro-cli acp` equivalent | Notes |
| --- | --- | --- |
| `query({ prompt, options })` | `initialize` → `session/new` → `session/prompt` | A reusable ACP client amortizes the handshake across many queries. |
| `SDKMessage` union | JSON-RPC messages + `session/update` notifications | Shapes line up 1:1 for the common cases; see §2a. |
| `SDKSystemMessage{subtype:'init', claude_code_version, model}` | `initialize` response (`agentInfo.version`, model from `session/new` `models.currentModelId`) | Kiro reports its own version, not `claude_code_version`. Gstack's eval harness would record `agentInfo.version` instead. |
| `SDKAssistantMessage` with `content: [{type:'text'|'tool_use'|...}]` | Sequence of `session/update` with `agent_message_chunk` (text) and `tool_call` (tool_use) | Streaming is chunked at finer granularity than the SDK's per-turn `SDKAssistantMessage`. We'd re-assemble if we want SDK-shaped turns. |
| `SDKResultMessage{subtype, total_cost_usd, num_turns}` | `session/prompt` response `{stopReason}` + accumulated `_kiro.dev/metadata.meteringUsage` | Cost unit is Kiro credits (with a per-model `rate_multiplier` visible in `--list-models`), not USD. `num_turns` is not directly exposed; count `session/update` turn boundaries client-side. |
| `SDKRateLimitEvent`, 429, result-message rate-limit | `error` JSON-RPC response with Kiro error codes (`TooManyRequestsException`, `ServiceQuotaExceededError`, `ConversationLimitExceeded`, `MonthlyRequestCountOverage`, `RequestLimitExceeded`, `ModelTemporarilyUnavailable`) | The error taxonomy is richer than Anthropic's. The three-shape detection logic in `agent-sdk-runner.ts` collapses to a single "is this an RPC error with a throttling code" check. |
| `options.systemPrompt` (string or `{type:'preset', preset:'claude_code', append}`) | Agent config `.prompt` field (via `--agent` or embedded in first `session/new`) | No built-in "inherit Kiro Code preset and append" mode. For overlay-efficacy parity we'd need to construct the full system prompt string and send as a custom agent — or adopt a different measurement methodology (e.g. mode overlays via `session/set_mode`). |
| `options.tools` / `allowedTools` / `disallowedTools` | Agent config `tools` / `allowedTools` + `--trust-tools` CLI flag | Kiro tool names are the built-in set (`read`, `write`, `shell`, `aws`, `introspect`, `knowledge`, `thinking`, `todo`, `delegate`, `grep`, `glob`) plus `@server/tool` MCP tools. Claude Code tool names (`Read`, `Grep`, `Bash`, `AskUserQuestion`, …) do not exist. Any test that asserts on `AskUserQuestion` specifically is not portable — Kiro has no equivalent gating primitive; use `session/request_permission` for approval flows instead. |
| `options.permissionMode: 'bypassPermissions' \| 'default' \| 'acceptEdits'` | `--trust-all-tools` (bypass) or implement `session/request_permission` handler (default) | No `acceptEdits` analog; edits are handled via `fs/write_text_file` which the client can gate per-request. |
| `options.canUseTool` callback | Implement `session/request_permission` RPC handler on the client side | Equivalent surface: per tool-call the agent asks, client replies with an option id. |
| `options.settingSources: []` (disable inherited settings) | Launch `kiro-cli acp` with explicit `--agent` (a test-only agent) and an empty `mcpServers:[]` in `session/new` | No single "don't inherit global config" flag; you control inheritance by choosing a minimal agent. |
| `options.pathToClaudeCodeExecutable` (binary pinning) | Resolve `kiro-cli` via `Bun.which('kiro-cli')` + env override (`GSTACK_KIRO_CLI_BIN`) | Mirror `scripts/resolve-claude-binary.ts` for kiro-cli. Binary pinning matters for repro; toolbox is the stable install point. |
| `resume` / session continuation | `session/load` or `--resume-id <uuid>` + `kiro-cli chat --list-sessions` | Session state is on disk under `~/.kiro/sessions/`. Sessions are keyed by cwd + uuid. |
| Max turns (`options.maxTurns`) | No direct equivalent; `stopReason: "max_turn_requests"` surfaces when hit | Not exposed as a per-call cap today. If we need it we'd enforce client-side by cancelling after N `agent_message_chunk → end_turn` cycles. File as a gap. |
| `streaming=true` / async iterator over events | JSON-RPC notifications on stdout; write a small Bun async iterator wrapper | Trivial wrapper (~40 lines) produces the same ergonomics as `for await (const ev of q)`. |
| Mid-stream image/audio input | `prompt: [{type:"image", mimeType, data}]` in `session/prompt` (agent advertises `promptCapabilities.image: true`) | Audio is advertised `false` currently. Embedded context is `false`. |

### 2a. Event stream shape — concrete example

Input:
```json
{"jsonrpc":"2.0","id":3,"method":"session/prompt",
 "params":{"sessionId":"<id>",
           "prompt":[{"type":"text","text":"Reply with exactly the four letters: PONG"}]}}
```

Observed stream (edited for brevity):
```jsonc
// notification: slash commands list (sent on every prompt start)
{"jsonrpc":"2.0","method":"_kiro.dev/commands/available",
 "params":{"sessionId":"<id>","commands":[...]}}

// notification: assistant text chunk
{"jsonrpc":"2.0","method":"session/update",
 "params":{"sessionId":"<id>",
           "update":{"sessionUpdate":"agent_message_chunk",
                     "content":{"type":"text","text":"PONG"}}}}

// notification: per-turn metadata (context %, credits used, duration)
{"jsonrpc":"2.0","method":"_kiro.dev/metadata",
 "params":{"sessionId":"<id>",
           "contextUsagePercentage":25.018999099731445,
           "meteringUsage":[{"value":0.06332372683250416,
                             "unit":"credit","unitPlural":"credits"}],
           "turnDurationMs":2096}}

// response: final result for id=3
{"jsonrpc":"2.0","result":{"stopReason":"end_turn"},"id":3}
```

**Streaming contract:** `agent_message_chunk` is delivered in small segments (like SSE deltas), not whole assistant turns. For tool-using turns we'd also see interleaved `tool_call` (start) / `tool_call_update` (progress / final result, with status `pending|in_progress|completed|failed`). A `session/prompt` response with `stopReason` marks the end of that turn.

### 2b. Tool-permission surface — concrete example

When a tool requires approval, agent emits (pseudo-schema, extracted from the binary):

```jsonc
// agent -> client RPC call (expects response)
{"jsonrpc":"2.0","id":<N>,"method":"session/request_permission",
 "params":{"sessionId":"<id>",
           "toolCall":{"toolCallId":"<id>","title":"Write to file",
                       "input":{...},"kind":"file_write"},
           "options":[
             {"optionId":"allow_once","name":"Allow once","kind":"allow_once"},
             {"optionId":"allow_always","name":"Always allow","kind":"allow_always"},
             {"optionId":"reject_once","name":"Reject once","kind":"reject_once"},
             {"optionId":"reject_always","name":"Always reject","kind":"reject_always"}]}}
```

Client must respond with either `{"result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}` or `{"result":{"outcome":{"outcome":"cancelled"}}}`. This is the direct analog of `canUseTool` — a single RPC handler per client.

---

## 3. Proof-of-life transcript

Ran `kiro-cli acp --trust-all-tools --model=claude-haiku-4.5` and drove it with a minimal Python client (~60 lines). Full initialize + session/new + session/prompt cycle completes in under 15 s. Prompt "Reply with exactly the four letters: PONG" produced one `agent_message_chunk` with `"PONG"` and a final `stopReason: end_turn`. Metering credits: 0.063. Test file: intentionally not committed — reproducible from the description above.

```text
>>> initialize
<<< id=1 result.protocolVersion=1
    agentCapabilities.loadSession=true
    promptCapabilities.image=true, audio=false, embeddedContext=false
    mcpCapabilities.http=true, sse=false
    agentInfo.version=2.0.1

>>> session/new cwd=/tmp mcpServers=[]
(agent streams _kiro.dev/mcp/server_initialized for each user-configured MCP)
<<< id=2 result.sessionId=d1cf288c-...
    result.modes.currentModeId=gpu-dev
    result.modes.availableModes=[{id:"gastown",...}, ...]  // global agent list

>>> session/prompt prompt=[{type:text, text:"Reply with exactly ... PONG"}]
<<< session/update agent_message_chunk "PONG"
<<< _kiro.dev/metadata contextUsagePercentage=25.0 credits=0.063
<<< id=3 result.stopReason=end_turn
```

---

## 4. Identified gaps vs claude-agent-sdk

Only three real gaps; none block the migration.

1. **No `maxTurns` cap per call.** SDK cuts off agent loops at a configurable turn budget. Kiro exposes `stopReason: "max_turn_requests"` only when the agent itself hits its internal limit. Gstack enforces `maxTurns:5` in the overlay-efficacy harness; we'd enforce this client-side by counting `session/update` turn boundaries and calling `session/cancel` when the cap is reached. ~10 lines of client code.
2. **No "inherit Claude Code preset system prompt and append" primitive.** SDK offers `systemPrompt: {type:'preset', preset:'claude_code', append}`. Kiro's model is per-agent system prompt only. For overlay-efficacy, either (a) migrate to measuring Kiro's built-in "modes" system (`session/update current_mode_update`, `availableModes`), which is the philosophically closer test because modes are Kiro's user-facing overlay mechanism, or (b) build the full system prompt string ourselves. I'd pick (a) — modes are the correct measurement target for Kiro-first gstack.
3. **No typed TypeScript schema shipped with the binary.** `claude-agent-sdk` exports all types from `@anthropic-ai/claude-agent-sdk`. We'd author them ourselves — ~200 lines, mechanically derived from the `struct ... with N elements` debug symbols in the binary (§6), or better, generated from the [ACP schema](https://github.com/zed-industries/agent-client-protocol) plus a small extension file for the `_kiro.dev/*` methods.

Non-gaps (things that looked like gaps but aren't on closer look):
- Rate limits — Kiro's error taxonomy is richer and has dedicated codes; simpler to detect than the SDK's three-shape union.
- Cost reporting — `_kiro.dev/metadata.meteringUsage` is per-turn; accumulate client-side.
- Binary pinning — toolbox path is stable and the binary is a real program on disk (no bundled binary extraction like `@anthropic-ai/claude-agent-sdk`).
- Session continuation — directly supported via `session/load` and `--resume-id`.
- File I/O bridging — standard ACP, supported.

---

## 5. Recommendation

**Replace, don't shim.** Write a small Bun module `lib/kiro-acp-client.ts` that:

1. Spawns `kiro-cli acp --trust-all-tools --model=<model>` (or with a per-test agent config).
2. Implements JSON-RPC 2.0 framing over the subprocess's stdin/stdout with a request-id → Promise map for responses.
3. Exposes an async iterator over `session/update` notifications plus a typed response.
4. Handles `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, and the `terminal/*` family with pluggable client handlers.
5. Produces an `AgentSdkResult`-shaped summary (same field names: `events`, `assistantTurns`, `toolCalls`, `output`, `exitReason`, `turnsUsed`, `durationMs`, `firstResponseMs`, `maxInterTurnMs`, `costUsd`, `model`, `sdkClaudeCodeVersion` → rename `agentVersion`, `resolvedBinaryPath`, `browseErrors`) so `toSkillTestResult` and downstream consumers don't have to change.

Rough size: ~350 lines of TypeScript for the client, ~200 lines of types, ~100 lines of permission/fs/terminal handlers.

This replaces:

- `scripts/preflight-agent-sdk.ts` (rewrite as `preflight-kiro-acp.ts` — essentially the same 5 checks against the ACP client)
- `test/helpers/agent-sdk-runner.ts` (rewrite around `kiro-acp-client.ts`)
- `test/helpers/llm-judge.ts` (for one-shot judge calls, use the ACP client with `tools:[]` and a single `session/prompt` — simpler than `@anthropic-ai/sdk.messages.create`)
- `test/helpers/benchmark-judge.ts`, `test/helpers/touchfiles.ts` (same)
- `test/agent-sdk-runner.test.ts`, `test/skill-llm-eval.test.ts` (rewrite asserts against the new shapes)

And lets us drop both `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/sdk` from runtime `dependencies` (check `package.json`). The `claude` binary is no longer needed at runtime for these paths.

**Why not shim `@anthropic-ai/claude-agent-sdk`?** The SDK's surface is wide (permissions modes, settingSources, hooks, customTools, etc.) and every new field requires an adapter. The ACP protocol is narrower, well-documented by Zed, and semantically cleaner; writing a small purpose-built client is less code overall than a faithful SDK shim and produces better errors. Shim-first was my initial instinct; after seeing the ACP surface live, replace-first wins.

### Follow-on beads implied by this investigation

- **`gsk-jfm`** (Prototype kiro-cli SDK shim in scripts/preflight-agent-sdk.ts): retitle to "Prototype kiro-cli ACP client" and implement as described above.
- **`gsk-097`** (Audit tests that spawn claude/codex/gemini binaries): the 7 files listed in §5 are the concrete delete-or-rewrite targets.
- **New bead:** "Add kiro-cli binary resolver `browse/src/kiro-bin.ts`" parallel to `claude-bin.ts`, with `GSTACK_KIRO_CLI_BIN` override.
- **New bead:** "Generate ACP TypeScript types from Zed's schema + Kiro extensions" — spec-driven, ~200 lines of generated code, one-shot.
- **New bead (optional):** "Migrate overlay-efficacy harness from systemPrompt append to Kiro modes" — philosophical, not blocking, may warrant its own design doc.

---

## 6. Reproduction appendix

**Binary location:**
```
/home/canewiw/.toolbox/bin/kiro-cli
  → /home/canewiw/.toolbox/tools/toolbox/1.1.4911.0/toolbox-exec  (wrapper)
  → /home/canewiw/.toolbox/tools/kiro-cli/2.1.1/kiro-cli-chat     (actual binary)
```

**Static-analysis hooks used during this investigation** (Rust binary, `strings` cleanly recovers JSON-RPC method names, struct field lists, and variant names):
- `strings kiro-cli-chat | grep -E "session/|_kiro\.dev/|tasks/"` → method inventory
- `strings kiro-cli-chat | grep -E "struct .* with [0-9]+ elements"` → field lists per struct
- `strings kiro-cli-chat | grep -iE "variant index 0 <= i < [0-9]+"` → enum arities

**Live ACP session test** (full script, Python 3 stdlib only): see notes on this bead. The test loops `initialize → session/new → session/prompt`, keys responses by JSON-RPC id (not line order, because notifications interleave), waits up to 30 s per RPC. Reproducible by anyone with `kiro-cli` logged in.

**Model for smoke tests:** `claude-haiku-4.5` (rate_multiplier 0.4, cheapest non-experimental). A full PONG cycle costs ~0.06 credits.
