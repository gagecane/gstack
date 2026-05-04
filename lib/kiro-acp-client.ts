/**
 * Minimal ACP (Agent Client Protocol) client for driving `kiro-cli acp` over
 * stdio with JSON-RPC 2.0 framing. Extracted from
 * `scripts/preflight-agent-sdk.ts` (bead gsk-9p0.1) so other callers — the
 * overlay-efficacy harness, test helpers, one-shot judge calls — don't each
 * reinvent the subprocess + framing layer.
 *
 * Scope per design doc §5 (docs/designs/KIRO_CLI_SCRIPTABLE_INTERFACE.md):
 *   - spawn kiro-cli acp as a child process
 *   - line-delimited JSON-RPC 2.0 over stdin/stdout
 *   - request-id → Promise map for `call()`
 *   - async iterator over session/update notifications (+ a drain buffer for
 *     callers that want them batched)
 *   - pluggable handlers for agent→client RPCs (session/request_permission,
 *     fs/read_text_file, fs/write_text_file, terminal/* family)
 *   - binary resolution honoring GSTACK_KIRO_CLI_BIN
 *
 * Out of scope here:
 *   - The full typed ACP schema (gsk-9p0.3 will generate it from Zed's schema
 *     + Kiro `_kiro.dev/*` extensions). Types defined here are the narrow
 *     surface this client actually needs to operate — enough to compile
 *     preflight-agent-sdk.ts and shape downstream AgentSdkResult-compatible
 *     summaries.
 *   - A richer binary resolver with install-path probing (gsk-9p0.2 will
 *     extract `browse/src/kiro-bin.ts` parallel to `browse/src/claude-bin.ts`).
 *     The implementation here matches the inline version in preflight — when
 *     kiro-bin.ts lands, callers switch over and this file's resolver goes away.
 *
 * No dependency on `@anthropic-ai/claude-agent-sdk`. Bun-native spawn + streams.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 primitives
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
}

/** Agent→client RPC call that requires a response (has both `id` and `method`). */
export interface JsonRpcServerRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

type StreamMessage =
  | JsonRpcResponse
  | JsonRpcNotification
  | JsonRpcServerRequest;

// ---------------------------------------------------------------------------
// ACP-level types (narrow surface — gsk-9p0.3 will replace with generated set)
// ---------------------------------------------------------------------------

/** Session identity returned from `session/new`. */
export interface AcpSession {
  sessionId: string;
  /** null when `session/new` did not return a current model id. */
  currentModelId: string | null;
}

/** One ACP content block (subset used in prompts and tool-call content). */
export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'audio'; mimeType: string; data: string }
  | { type: 'resource_link'; uri: string }
  | { type: 'embedded_resource'; resource: unknown };

/**
 * Metering sample carried on `_kiro.dev/metadata` notifications.
 * `value` is in Kiro credits (see `kiro-cli chat --list-models --format=json`
 * for per-model `rate_multiplier`). Unit is typically `"credit"` singular /
 * `"credits"` plural.
 */
export interface AcpMeteringSample {
  value: number;
  unit: string;
  unitPlural?: string;
}

/** Aggregated per-turn summary built from streamed notifications. */
export interface AcpRunResult {
  /** From `initialize` response `agentInfo.version`. */
  agentVersion: string | null;
  session: AcpSession;
  /** Concatenated text chunks from `session/update.agent_message_chunk`. */
  assistantChunks: string[];
  /** From `session/prompt` response. */
  stopReason: string | null;
  /** Aggregated `_kiro.dev/metadata.meteringUsage[0].value` (credits). */
  meteringCredits: number | null;
  meteringUnit: string | null;
  /** Last `_kiro.dev/metadata.turnDurationMs` seen. */
  durationMs: number | null;
  /** Last `_kiro.dev/metadata.contextUsagePercentage` seen. */
  contextUsagePercent: number | null;
}

// ---------------------------------------------------------------------------
// Binary resolution (inline, mirrors scripts/preflight-agent-sdk.ts)
// gsk-9p0.2 extracts this to browse/src/kiro-bin.ts alongside claude-bin.ts.
// ---------------------------------------------------------------------------

/**
 * Resolve the `kiro-cli` binary for pinning, honoring GSTACK_KIRO_CLI_BIN.
 * Returns null when nothing resolves — callers should surface a clear error.
 *
 * Override precedence:
 *   1. `env.GSTACK_KIRO_CLI_BIN` — absolute path or PATH-resolvable command
 *   2. `Bun.which('kiro-cli')`
 */
export function resolveKiroCliBinary(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const PATH = env.PATH ?? env.Path ?? '';
  const override = env.GSTACK_KIRO_CLI_BIN?.trim();
  if (override) {
    // Absolute path on POSIX or Windows: use as-is. Otherwise PATH-resolve.
    if (override.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(override)) return override;
    return Bun.which(override, { PATH }) ?? null;
  }
  return Bun.which('kiro-cli', { PATH });
}

// ---------------------------------------------------------------------------
// Pluggable agent→client RPC handler registry
// ---------------------------------------------------------------------------

/**
 * Handler for an agent→client RPC. Return the `result` payload (already
 * unwrapped — the client wraps it in `{jsonrpc,id,result}`) or throw to send
 * a JSON-RPC error back to the agent.
 */
export type AcpServerHandler = (params: unknown) => Promise<unknown> | unknown;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Options for spawning an ACP client.
 *
 * `cliArgs` is passed directly to `kiro-cli` (not including the leading
 * `acp` subcommand — the client always adds it). Typical flags:
 *   - `--trust-all-tools`            auto-approve all tool requests
 *   - `--trust-tools=fs_read,...`    trust only listed tools
 *   - `--model=<model-id>`           first-session model
 *   - `--agent=<agent-name>`         first-session agent config
 *
 * For tests or alternate agent binaries, `spawnArgs` overrides both the
 * implicit `'acp'` subcommand and `cliArgs` — the exact argv is passed
 * through to `spawn(binary, spawnArgs)`.
 */
export interface AcpClientOptions {
  /** Absolute path or PATH-resolvable command. Pass result of `resolveKiroCliBinary()`. */
  binary: string;
  /** Extra CLI args appended after the implicit `'acp'` subcommand. Default: []. */
  cliArgs?: string[];
  /** Full argv override. When set, `cliArgs` and the implicit `'acp'` are ignored. */
  spawnArgs?: string[];
  /** Per-RPC timeout in milliseconds. Default: 30_000. */
  callTimeoutMs?: number;
  /** Time allowed for graceful `stdin.end()` → exit before SIGTERM. Default: 3_000. */
  closeTimeoutMs?: number;
  /** Optional env override for the child. Default: inherit `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Default per-RPC timeout. Matches preflight-agent-sdk.ts. */
export const ACP_RPC_TIMEOUT_MS = 30_000;

/** Default close-phase timeout before SIGTERM. Matches preflight-agent-sdk.ts. */
export const ACP_CLOSE_TIMEOUT_MS = 3_000;

/**
 * Thin ACP client speaking line-delimited JSON-RPC 2.0 with `kiro-cli acp`.
 *
 * Usage:
 * ```ts
 * const binary = resolveKiroCliBinary();
 * if (!binary) throw new Error('kiro-cli not found');
 * const client = new AcpClient({ binary, cliArgs: ['--trust-all-tools', '--model=claude-haiku-4.5'] });
 * try {
 *   await client.call('initialize', { protocolVersion: 1, clientCapabilities: {...}, clientInfo: {...} });
 *   const { sessionId } = await client.call('session/new', { cwd: process.cwd(), mcpServers: [] }) as any;
 *   const { stopReason } = await client.call('session/prompt', { sessionId, prompt: [{type:'text', text:'hi'}] }) as any;
 *   for (const n of client.drainNotifications()) {
 *     // handle agent_message_chunk / _kiro.dev/metadata / ...
 *   }
 * } finally {
 *   await client.close();
 * }
 * ```
 */
export class AcpClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly callTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private nextId = 1;
  private stdoutBuf = '';
  private readonly pending = new Map<number, {
    resolve: (r: JsonRpcResponse) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly notificationBuf: JsonRpcNotification[] = [];
  /** Resolver for the next pending `notifications()` iterator slot, if any. */
  private iteratorResolver: ((n: JsonRpcNotification | null) => void) | null = null;
  private readonly stderrChunks: string[] = [];
  private readonly handlers = new Map<string, AcpServerHandler>();
  private exited = false;
  private exitError: Error | null = null;

  constructor(options: AcpClientOptions) {
    const { binary, cliArgs = [], spawnArgs, callTimeoutMs, closeTimeoutMs, env } = options;
    this.callTimeoutMs = callTimeoutMs ?? ACP_RPC_TIMEOUT_MS;
    this.closeTimeoutMs = closeTimeoutMs ?? ACP_CLOSE_TIMEOUT_MS;

    const args = spawnArgs ?? ['acp', ...cliArgs];
    this.proc = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ?? process.env,
    });
    this.proc.stdout.setEncoding('utf-8');
    this.proc.stderr.setEncoding('utf-8');
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk: string) => {
      this.stderrChunks.push(chunk);
    });
    // Swallow EPIPE from stdin writes after the child exits — 'exit' / 'error'
    // handlers below surface a more useful error to callers.
    this.proc.stdin.on('error', () => {});
    const failAll = (err: Error) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      // Unblock any pending notification iterator slot.
      if (this.iteratorResolver) {
        const r = this.iteratorResolver;
        this.iteratorResolver = null;
        r(null);
      }
    };
    this.proc.on('error', (err) => {
      this.exited = true;
      // Spawn-time error (ENOENT, EACCES, …) is more specific than the
      // generic 'exited with code=null' 'exit' will emit next — keep it.
      this.exitError = err;
      failAll(err);
    });
    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      if (!this.exitError) {
        const stderrTail = this.stderrText.trim().slice(-200);
        const suffix = stderrTail ? `; stderr: ${stderrTail}` : '';
        this.exitError = new Error(
          `kiro-cli acp exited (code=${code}, signal=${signal})${suffix}`,
        );
      }
      failAll(this.exitError);
    });
  }

  // ------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------

  /** Send a JSON-RPC request and await the matching response by id. */
  async call(method: string, params: unknown): Promise<unknown> {
    if (this.exited) throw this.exitError ?? new Error('kiro-cli acp already exited');
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const payload = JSON.stringify(req) + '\n';
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP call timed out after ${this.callTimeoutMs}ms: ${method}`));
      }, this.callTimeoutMs);
      this.pending.set(id, {
        resolve: (resp) => {
          if (resp.error) {
            reject(new Error(`ACP error ${resp.error.code}: ${resp.error.message}`));
            return;
          }
          resolve(resp.result);
        },
        reject,
        timer,
      });
      this.proc.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Register a handler for an agent→client RPC method. The handler receives
   * the raw `params` and returns the `result` payload (or throws to send a
   * JSON-RPC error back to the agent).
   *
   * Typical registrations:
   *   - `session/request_permission`  → return `{outcome: {outcome:'selected', optionId:'allow_once'}}`
   *   - `fs/read_text_file`           → return `{content: '...'}`
   *   - `fs/write_text_file`          → return `{}` after writing
   *   - `terminal/create` / `terminal/output` / `terminal/wait_for_exit` / …
   *
   * Unregistered methods receive a JSON-RPC -32601 (method not found) error.
   */
  onRequest(method: string, handler: AcpServerHandler): void {
    this.handlers.set(method, handler);
  }

  /** Drain and clear the notification buffer. */
  drainNotifications(): JsonRpcNotification[] {
    const copy = this.notificationBuf.slice();
    this.notificationBuf.length = 0;
    return copy;
  }

  /**
   * Async iterator over agent→client notifications. Yields notifications as
   * they arrive; terminates when the child exits. Callers that just want a
   * batch at the end of a turn should prefer `drainNotifications()` instead.
   */
  async *notifications(): AsyncGenerator<JsonRpcNotification, void, void> {
    while (true) {
      // Drain any already-buffered notifications first.
      if (this.notificationBuf.length > 0) {
        const n = this.notificationBuf.shift()!;
        yield n;
        continue;
      }
      // If the child has exited and the buffer is empty, we're done.
      if (this.exited) return;
      // Otherwise, wait for the next push (or exit).
      const next = await new Promise<JsonRpcNotification | null>((resolve) => {
        this.iteratorResolver = resolve;
      });
      if (next === null) return;
      yield next;
    }
  }

  get stderrText(): string {
    return this.stderrChunks.join('');
  }

  /** True once the child process has exited. */
  get hasExited(): boolean {
    return this.exited;
  }

  /**
   * Gracefully close the client. End stdin and wait up to `closeTimeoutMs`
   * for the child to exit; SIGTERM if it doesn't. Safe to call multiple times.
   */
  async close(): Promise<void> {
    if (this.exited) return;
    this.proc.stdin.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.proc.kill('SIGTERM');
        resolve();
      }, this.closeTimeoutMs);
      this.proc.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    // JSON-RPC over stdio is line-delimited here — kiro-cli writes one
    // message per line (verified in the design doc's live smoke test).
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg: StreamMessage;
      try {
        msg = JSON.parse(line) as StreamMessage;
      } catch {
        // Ignore non-JSON noise (defensive — should not happen in practice).
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: StreamMessage): void {
    // Classify: response to our request, agent→client request, or notification.
    const hasId = 'id' in msg && msg.id !== undefined;
    const hasResult = 'result' in msg;
    const hasError = 'error' in msg;
    const hasMethod = 'method' in msg && typeof (msg as { method: string }).method === 'string';

    if (hasId && (hasResult || hasError)) {
      // Response to one of our requests.
      const resp = msg as JsonRpcResponse;
      const p = this.pending.get(resp.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(resp.id);
        p.resolve(resp);
      }
      return;
    }

    if (hasId && hasMethod) {
      // Agent→client RPC request — must respond.
      this.handleServerRequest(msg as JsonRpcServerRequest);
      return;
    }

    if (hasMethod) {
      // Notification.
      const notif = msg as JsonRpcNotification;
      if (this.iteratorResolver) {
        const r = this.iteratorResolver;
        this.iteratorResolver = null;
        r(notif);
      } else {
        this.notificationBuf.push(notif);
      }
      return;
    }

    // Otherwise: malformed — drop silently (defensive).
  }

  private handleServerRequest(req: JsonRpcServerRequest): void {
    const handler = this.handlers.get(req.method);
    if (!handler) {
      this.sendServerResponse(req.id, {
        error: {
          code: -32601,
          message: `Method not found: ${req.method}`,
        },
      });
      return;
    }
    // Handler may be sync or async; normalize.
    Promise.resolve()
      .then(() => handler(req.params))
      .then((result) => {
        this.sendServerResponse(req.id, { result });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.sendServerResponse(req.id, {
          error: { code: -32000, message },
        });
      });
  }

  private sendServerResponse(
    id: number,
    body: { result: unknown } | { error: { code: number; message: string; data?: unknown } },
  ): void {
    if (this.exited) return;
    const resp: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      ...('result' in body ? { result: body.result } : { error: body.error }),
    };
    try {
      this.proc.stdin.write(JSON.stringify(resp) + '\n');
    } catch {
      // EPIPE after exit — 'exit' handler already surfaced the real error.
    }
  }
}
