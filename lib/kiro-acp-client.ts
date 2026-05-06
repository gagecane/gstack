/**
 * kiro-acp-client.ts — Programmatic ACP client for `kiro-cli acp` sessions.
 *
 * Spawns `kiro-cli acp` (or an override binary) as a subprocess and drives
 * its Agent Client Protocol surface over newline-delimited JSON on stdio.
 *
 * Responsibilities:
 *   1. Spawn the agent subprocess with the right trust/verbosity flags.
 *   2. Frame outgoing messages (NDJSON) and correlate responses by id.
 *   3. Parse incoming NDJSON, route responses to awaiting promises, and
 *      emit notifications as typed events.
 *   4. Expose the baseline ACP surface (`initialize`, `newSession`,
 *      `prompt`, `cancel`, `loadSession`, `setMode`, `close`) plus a
 *      generic `sendRequest` / `sendNotification` escape hatch.
 *   5. Clean up reliably — close stdin, await exit, kill if it hangs.
 *
 * Non-goals (intentional for this first extraction):
 *   • No automatic retry / reconnect. Callers decide the lifecycle policy.
 *   • No built-in handler for `session/request_permission` or `fs/*` —
 *     callers register handlers via `onRequest()`. The ACP spec requires
 *     the Client to respond, so callers MUST wire these up if they
 *     advertise the matching capabilities during `initialize`.
 *   • No cancellation timeout enforcement. Callers that need one should
 *     race `client.prompt()` against their own AbortSignal.
 *
 * Binary resolution piggybacks on `browse/src/kiro-bin.ts` so the same
 * GSTACK_KIRO_BIN / GSTACK_KIRO_BIN_ARGS overrides apply everywhere.
 * Callers can also pass `command`/`argsPrefix` explicitly (the test suite
 * does this to drive a stub subprocess without kiro-cli installed).
 */

import { EventEmitter } from 'events';
import { spawn, type ChildProcessByStdio, type SpawnOptionsWithStdioTuple } from 'child_process';
import type { Writable, Readable } from 'stream';

import { resolveKiroCliCommand, type KiroCommand } from '../browse/src/kiro-bin';

import type {
  AgentCapabilities,
  ClientCapabilities,
  ImplementationInfo,
  IncomingNotification,
  IncomingRequest,
  InitializeParams,
  InitializeResult,
  JsonRpcError,
  JsonRpcFrame,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  KiroAvailableCommandsParams,
  KiroMcpServerInitializedParams,
  KiroMetadataParams,
  KiroSubagentListUpdateParams,
  McpServer,
  ProtocolVersion,
  SessionCancelParams,
  SessionCloseParams,
  SessionId,
  SessionLoadParams,
  SessionNewParams,
  SessionNewResult,
  SessionPromptParams,
  SessionPromptResult,
  SessionResumeParams,
  SessionSetModeParams,
  SessionUpdateParams,
} from './kiro-acp-types';
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
} from './kiro-acp-types';

// ============================================================================
// Public types
// ============================================================================

export interface KiroAcpClientOptions {
  /** Working directory to set on the spawned process. Defaults to `process.cwd()`. */
  spawnCwd?: string;
  /** Environment for the spawned process. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Pre-resolved command + args (mainly for tests). */
  command?: string;
  /** Args to prepend before ACP flags. Defaults to the value from `resolveKiroCliCommand`. */
  argsPrefix?: string[];
  /** Pass `--trust-all-tools`. Defaults to `true` — programmatic sessions don't have a user to prompt. */
  trustAllTools?: boolean;
  /** Pass `--trust-tools <list>` instead of `--trust-all-tools`. */
  trustTools?: string[];
  /** `--agent <id>` for the initial session. */
  agent?: string;
  /** `--model <id>` for the initial session. */
  model?: string;
  /** Add `-v` flags. 1 = `-v`, 2 = `-vv`, etc. */
  verbose?: number;
  /**
   * Extra args to append (after all standard flags, before `acp`).
   * Lets callers pass flags the client doesn't model yet without monkey-patching.
   */
  extraArgs?: string[];
  /**
   * How to route the agent's stderr. Default: inherit from the parent
   * process so errors surface to whoever is driving the client.
   */
  stderr?: 'inherit' | 'pipe' | 'ignore';
  /**
   * Default timeout (ms) for requests awaiting a response. `0` disables.
   * Individual `sendRequest()` calls may override this.
   */
  requestTimeoutMs?: number;
  /**
   * Milliseconds to wait after closing stdin before sending SIGKILL during
   * `close()`. Defaults to 2000.
   */
  shutdownGraceMs?: number;
}

/** Identifier for a handler function registered via `onRequest()`. */
export type RequestHandler<P = unknown, R = unknown> = (
  params: P,
  request: IncomingRequest,
) => Promise<R> | R;

/** Errors the client produces for structured callers to catch. */
export class AcpError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AcpError';
  }
}

export class AcpProtocolError extends AcpError {
  constructor(public readonly error: JsonRpcError, public readonly method?: string) {
    super(
      `ACP ${method ? `${method} ` : ''}request failed: ${error.message} (code ${error.code})`,
    );
    this.name = 'AcpProtocolError';
  }
}

export class AcpTransportError extends AcpError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'AcpTransportError';
  }
}

export class AcpTimeoutError extends AcpError {
  constructor(method: string, timeoutMs: number) {
    super(`ACP ${method} request timed out after ${timeoutMs}ms`);
    this.name = 'AcpTimeoutError';
  }
}

// ============================================================================
// Typed event surface
// ============================================================================

/**
 * Events the client emits. Declared as a type map so TypeScript can infer
 * listener signatures for callers that use `client.on('session/update', ...)`.
 */
export interface KiroAcpClientEvents {
  /** A parsed JSON-RPC notification the client couldn't dispatch to a typed event. */
  notification: (notification: JsonRpcNotification) => void;
  /** `session/update` notifications (prompt-turn streaming updates). */
  'session/update': (params: SessionUpdateParams) => void;
  /** Kiro extension: context usage / credit / timing telemetry. */
  'kiro/metadata': (params: KiroMetadataParams) => void;
  /** Kiro extension: an MCP server finished its handshake. */
  'kiro/mcp/server_initialized': (params: KiroMcpServerInitializedParams) => void;
  /** Kiro extension: session-scoped slash commands list refreshed. */
  'kiro/commands/available': (params: KiroAvailableCommandsParams) => void;
  /** Kiro extension: subagent fleet state changed. */
  'kiro/subagent/list_update': (params: KiroSubagentListUpdateParams) => void;
  /** Subprocess exited. Fired once per lifecycle. */
  exit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  /** A transport-level error (parse failure, spawn failure, stdin write error). */
  error: (err: AcpError) => void;
  /** Raw frame dispatch, for debugging. Fired after typed events. */
  frame: (frame: JsonRpcFrame) => void;
}

// ============================================================================
// Pending-request bookkeeping
// ============================================================================

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  method: string;
  timeout?: ReturnType<typeof setTimeout>;
}

// ============================================================================
// Default client capabilities
// ============================================================================

/**
 * Baseline capabilities we advertise during `initialize`. Conservative: we
 * don't claim `fs/*` or `terminal` unless the caller explicitly enables
 * them via the `capabilities` argument to `initialize()`.
 */
export const DEFAULT_CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

export const DEFAULT_CLIENT_INFO: ImplementationInfo = {
  name: 'gstack-kiro-acp-client',
  title: 'gstack kiro-acp-client',
  version: '1',
};

/** Protocol version we advertise. Kiro-CLI 2.2.1 speaks v1. */
export const CLIENT_PROTOCOL_VERSION: ProtocolVersion = 1;

// ============================================================================
// The client
// ============================================================================

/**
 * EventEmitter-based ACP client.
 *
 * Lifecycle:
 *   const client = new KiroAcpClient({ ... });
 *   await client.start();
 *   const init = await client.initialize();
 *   const { sessionId } = await client.newSession({ cwd: '/path', mcpServers: [] });
 *   const result = await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] });
 *   await client.close();
 */
export class KiroAcpClient extends EventEmitter {
  private proc: ChildProcessByStdio<Writable, Readable, Readable | null> | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private buffer = '';
  private requestHandlers = new Map<string, RequestHandler>();
  private readonly requestTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private starting: Promise<void> | null = null;
  private exited = false;
  private spawnInfo: { command: string; args: string[] } | null = null;

  constructor(private readonly options: KiroAcpClientOptions = {}) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 0;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 2000;
  }

  // -- Typed emit/on overrides for ergonomics -------------------------------

  override emit<K extends keyof KiroAcpClientEvents>(
    event: K,
    ...args: Parameters<KiroAcpClientEvents[K]>
  ): boolean;
  override emit(event: string, ...args: unknown[]): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof KiroAcpClientEvents>(
    event: K,
    listener: KiroAcpClientEvents[K],
  ): this;
  override on(event: string, listener: (...args: unknown[]) => void): this;
  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  override once<K extends keyof KiroAcpClientEvents>(
    event: K,
    listener: KiroAcpClientEvents[K],
  ): this;
  override once(event: string, listener: (...args: unknown[]) => void): this;
  override once(event: string, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }

  // -- Spawn / shutdown -----------------------------------------------------

  /** Details of the spawned command — useful in logs and tests. */
  get spawnedCommand(): { command: string; args: string[] } | null {
    return this.spawnInfo;
  }

  /**
   * Spawn the `kiro-cli acp` subprocess and wire up stdio. Safe to call
   * multiple times — subsequent calls return the same promise.
   */
  async start(): Promise<void> {
    if (this.proc) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async doStart(): Promise<void> {
    const { command, args } = this.resolveSpawn();
    this.spawnInfo = { command, args };

    const stderrMode = this.options.stderr ?? 'inherit';
    const stdio: SpawnOptionsWithStdioTuple<'pipe', 'pipe', typeof stderrMode>['stdio'] = [
      'pipe',
      'pipe',
      stderrMode,
    ];

    const proc = spawn(command, args, {
      cwd: this.options.spawnCwd,
      env: this.options.env,
      stdio,
    }) as ChildProcessByStdio<Writable, Readable, Readable | null>;

    this.proc = proc;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdoutChunk(chunk));
    proc.stdout.on('error', (err) =>
      this.emit('error', new AcpTransportError('stdout error', err)),
    );
    proc.on('error', (err) => {
      this.emit('error', new AcpTransportError(`spawn failed: ${err.message}`, err));
    });
    proc.on('exit', (code, signal) => {
      this.exited = true;
      // Fail all pending requests; the subprocess will never respond.
      const pending = [...this.pending.values()];
      this.pending.clear();
      for (const p of pending) {
        if (p.timeout) clearTimeout(p.timeout);
        p.reject(
          new AcpTransportError(
            `kiro-cli acp exited before responding to ${p.method} (code=${code}, signal=${signal})`,
          ),
        );
      }
      this.emit('exit', { code, signal });
    });
  }

  /**
   * Gracefully stop the subprocess. Closes stdin, waits up to
   * `shutdownGraceMs` for a clean exit, then SIGKILLs.
   */
  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc || this.exited) {
      this.proc = null;
      return;
    }
    try {
      proc.stdin.end();
    } catch {
      /* stdin may already be closed */
    }
    await new Promise<void>((resolve) => {
      const onExit = () => resolve();
      proc.once('exit', onExit);
      const timer = setTimeout(() => {
        proc.off('exit', onExit);
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, this.shutdownGraceMs);
      // Unref the timer so it doesn't block Node from exiting.
      timer.unref?.();
    });
    this.proc = null;
  }

  private resolveSpawn(): { command: string; args: string[] } {
    const preResolved = this.options.command
      ? ({ command: this.options.command, argsPrefix: this.options.argsPrefix ?? [] } as KiroCommand)
      : resolveKiroCliCommand(this.options.env ?? process.env);

    if (!preResolved) {
      throw new AcpTransportError(
        'kiro-cli not found on PATH; set GSTACK_KIRO_BIN or pass options.command',
      );
    }

    const args: string[] = [...preResolved.argsPrefix];
    // Verbosity flags go before the subcommand (matches `kiro-cli -v acp`).
    const v = this.options.verbose ?? 0;
    for (let i = 0; i < v; i++) args.push('-v');

    args.push('acp');

    if (this.options.agent) args.push('--agent', this.options.agent);
    if (this.options.model) args.push('--model', this.options.model);
    const trustAll = this.options.trustAllTools ?? true;
    if (this.options.trustTools && this.options.trustTools.length > 0) {
      args.push('--trust-tools', this.options.trustTools.join(','));
    } else if (trustAll) {
      args.push('--trust-all-tools');
    }
    if (this.options.extraArgs) args.push(...this.options.extraArgs);

    return { command: preResolved.command, args };
  }

  // -- Stdout parsing -------------------------------------------------------

  private onStdoutChunk(chunk: string): void {
    this.buffer += chunk;
    // NDJSON: one JSON object per line, `\n`-terminated. We also tolerate
    // `\r\n` just in case the agent ever runs on Windows with CRLF line
    // endings (kiro-cli 2.2.1 does not, but the client is cheap to harden).
    let nlIdx: number;
    while ((nlIdx = this.buffer.indexOf('\n')) >= 0) {
      const rawLine = this.buffer.slice(0, nlIdx);
      this.buffer = this.buffer.slice(nlIdx + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(line) as JsonRpcFrame;
    } catch (err) {
      this.emit(
        'error',
        new AcpTransportError(
          `failed to parse JSON-RPC frame: ${(err as Error).message}: ${line.slice(0, 256)}`,
          err,
        ),
      );
      return;
    }
    this.dispatchFrame(frame);
    this.emit('frame', frame);
  }

  private dispatchFrame(frame: JsonRpcFrame): void {
    if (isJsonRpcResponse(frame)) {
      this.handleResponse(frame);
      return;
    }
    if (isJsonRpcRequest(frame)) {
      void this.handleIncomingRequest(frame);
      return;
    }
    if (isJsonRpcNotification(frame)) {
      this.handleNotification(frame);
      return;
    }
    this.emit(
      'error',
      new AcpTransportError(`unrecognized JSON-RPC frame shape: ${JSON.stringify(frame).slice(0, 256)}`),
    );
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      // Spurious response (late arrival after timeout / cancellation).
      // Stay quiet — emit as a raw frame, not an error.
      return;
    }
    this.pending.delete(response.id);
    if (pending.timeout) clearTimeout(pending.timeout);
    if ('error' in response) {
      pending.reject(new AcpProtocolError(response.error, pending.method));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    // Kiro extensions
    if (notification.method === '_kiro.dev/metadata') {
      this.emit('kiro/metadata', notification.params as KiroMetadataParams);
    } else if (notification.method === '_kiro.dev/mcp/server_initialized') {
      this.emit(
        'kiro/mcp/server_initialized',
        notification.params as KiroMcpServerInitializedParams,
      );
    } else if (notification.method === '_kiro.dev/commands/available') {
      this.emit(
        'kiro/commands/available',
        notification.params as KiroAvailableCommandsParams,
      );
    } else if (notification.method === '_kiro.dev/subagent/list_update') {
      this.emit(
        'kiro/subagent/list_update',
        notification.params as KiroSubagentListUpdateParams,
      );
    } else if (notification.method === 'session/update') {
      this.emit('session/update', notification.params as SessionUpdateParams);
    }
    // Always emit the generic event so subscribers can see every frame.
    this.emit('notification', notification);
  }

  private async handleIncomingRequest(request: JsonRpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(request.method);
    if (!handler) {
      // Per JSON-RPC 2.0, unhandled methods return Method not found (-32601).
      // The ACP spec allows Clients to advertise which methods they support
      // via capabilities; if the Agent calls one we never advertised, this
      // error is the correct response.
      await this.writeFrame({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32601,
          message: `Method not found: ${request.method}`,
        },
      });
      return;
    }
    try {
      const result = await handler(request.params, request as IncomingRequest);
      await this.writeFrame({ jsonrpc: '2.0', id: request.id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.writeFrame({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32000,
          message: `Handler for ${request.method} threw: ${message}`,
        },
      });
    }
  }

  // -- Sending --------------------------------------------------------------

  /**
   * Send a JSON-RPC request and await the response.
   *
   * Prefer the typed helpers below for standard methods; this is the
   * escape hatch for custom or future methods the client doesn't model yet.
   */
  async sendRequest<R = unknown, P = unknown>(
    method: string,
    params?: P,
    opts: { timeoutMs?: number } = {},
  ): Promise<R> {
    await this.start();
    if (this.exited) {
      throw new AcpTransportError(`cannot send ${method}: subprocess has exited`);
    }
    const id = this.nextId++;
    const request: JsonRpcRequest<P> = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;

    return new Promise<R>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
        method,
      };
      if (timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpTimeoutError(method, timeoutMs));
        }, timeoutMs);
        pending.timeout.unref?.();
      }
      this.pending.set(id, pending);
      this.writeFrame(request).catch((err) => {
        this.pending.delete(id);
        if (pending.timeout) clearTimeout(pending.timeout);
        reject(err);
      });
    });
  }

  /** Send a JSON-RPC notification. No response is expected. */
  async sendNotification<P = unknown>(method: string, params?: P): Promise<void> {
    await this.start();
    if (this.exited) {
      throw new AcpTransportError(`cannot send ${method} notification: subprocess has exited`);
    }
    const notification: JsonRpcNotification<P> = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    await this.writeFrame(notification);
  }

  private writeFrame(frame: JsonRpcFrame): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.stdin.destroyed) {
      return Promise.reject(
        new AcpTransportError('cannot write frame: stdin is not open'),
      );
    }
    const payload = JSON.stringify(frame) + '\n';
    return new Promise((resolve, reject) => {
      proc.stdin.write(payload, 'utf8', (err) => {
        if (err) reject(new AcpTransportError('write to stdin failed', err));
        else resolve();
      });
    });
  }

  /**
   * Register a handler for an incoming request from the Agent. Handlers
   * are invoked for each matching method. Returns a disposer that
   * unregisters the handler.
   *
   * Call this before `initialize()` for request methods you claim to
   * support (`fs/read_text_file`, `fs/write_text_file`, `terminal/*`,
   * `session/request_permission`).
   */
  onRequest<P = unknown, R = unknown>(method: string, handler: RequestHandler<P, R>): () => void {
    this.requestHandlers.set(method, handler as RequestHandler);
    return () => {
      if (this.requestHandlers.get(method) === (handler as RequestHandler)) {
        this.requestHandlers.delete(method);
      }
    };
  }

  // -- Typed ACP method helpers --------------------------------------------

  /** `initialize` — MUST be the first request on a new subprocess. */
  async initialize(
    args: {
      capabilities?: ClientCapabilities;
      clientInfo?: ImplementationInfo;
      protocolVersion?: ProtocolVersion;
    } = {},
  ): Promise<InitializeResult> {
    const params: InitializeParams = {
      protocolVersion: args.protocolVersion ?? CLIENT_PROTOCOL_VERSION,
      clientCapabilities: args.capabilities ?? DEFAULT_CLIENT_CAPABILITIES,
      clientInfo: args.clientInfo ?? DEFAULT_CLIENT_INFO,
    };
    return this.sendRequest<InitializeResult, InitializeParams>('initialize', params);
  }

  /** `session/new` — create a conversation session. */
  async newSession(
    args: { cwd: string; mcpServers?: McpServer[] },
  ): Promise<SessionNewResult> {
    const params: SessionNewParams = {
      cwd: args.cwd,
      mcpServers: args.mcpServers ?? [],
    };
    return this.sendRequest<SessionNewResult, SessionNewParams>('session/new', params);
  }

  /**
   * `session/load` — resume a session by replaying its history.
   * Returns `null` on success per the ACP spec.
   */
  async loadSession(args: SessionLoadParams): Promise<null> {
    return this.sendRequest<null, SessionLoadParams>('session/load', args);
  }

  /** `session/resume` — resume without replay. Requires `sessionCapabilities.resume`. */
  async resumeSession(args: SessionResumeParams): Promise<Record<string, unknown>> {
    return this.sendRequest<Record<string, unknown>, SessionResumeParams>(
      'session/resume',
      args,
    );
  }

  /**
   * `session/prompt` — send a user message and await the turn's stop reason.
   *
   * Progress arrives via `session/update` events. If you need to render
   * streaming output, subscribe to `client.on('session/update', ...)`
   * before awaiting this promise.
   */
  async prompt(args: SessionPromptParams, opts: { timeoutMs?: number } = {}): Promise<SessionPromptResult> {
    return this.sendRequest<SessionPromptResult, SessionPromptParams>(
      'session/prompt',
      args,
      opts,
    );
  }

  /**
   * `session/cancel` — notify the Agent to stop the current turn.
   * Per ACP spec, the Agent responds to the outstanding `session/prompt`
   * with `stopReason: 'cancelled'` once it finishes aborting.
   */
  async cancel(sessionId: SessionId): Promise<void> {
    const params: SessionCancelParams = { sessionId };
    await this.sendNotification<SessionCancelParams>('session/cancel', params);
  }

  /** `session/set_mode` — switch the active agent mode. */
  async setMode(args: SessionSetModeParams): Promise<Record<string, unknown>> {
    return this.sendRequest<Record<string, unknown>, SessionSetModeParams>(
      'session/set_mode',
      args,
    );
  }

  /** `session/close` — tear down an active session. Requires `sessionCapabilities.close`. */
  async closeSession(sessionId: SessionId): Promise<Record<string, unknown>> {
    const params: SessionCloseParams = { sessionId };
    return this.sendRequest<Record<string, unknown>, SessionCloseParams>(
      'session/close',
      params,
    );
  }
}

// ============================================================================
// Functional convenience helper
// ============================================================================

/**
 * One-shot helper: spawn kiro-cli, run a prompt in a fresh session, and
 * return the full assistant text + stop reason. Intended for tests and
 * quick scripts; long-lived programs should use `KiroAcpClient` directly.
 */
export async function runKiroPrompt(
  prompt: string,
  opts: KiroAcpClientOptions & {
    cwd: string;
    mcpServers?: McpServer[];
    capabilities?: ClientCapabilities;
    clientInfo?: ImplementationInfo;
    promptTimeoutMs?: number;
  },
): Promise<{
  sessionId: SessionId;
  text: string;
  stopReason: SessionPromptResult['stopReason'];
  capabilities?: AgentCapabilities;
}> {
  const client = new KiroAcpClient(opts);
  const chunks: string[] = [];
  client.on('session/update', (params) => {
    const update = params.update;
    if (
      update.sessionUpdate === 'agent_message_chunk' &&
      'content' in update &&
      update.content.type === 'text'
    ) {
      chunks.push(update.content.text);
    }
  });
  try {
    await client.start();
    const init = await client.initialize({
      capabilities: opts.capabilities,
      clientInfo: opts.clientInfo,
    });
    const { sessionId } = await client.newSession({
      cwd: opts.cwd,
      mcpServers: opts.mcpServers,
    });
    const result = await client.prompt(
      { sessionId, prompt: [{ type: 'text', text: prompt }] },
      { timeoutMs: opts.promptTimeoutMs },
    );
    return {
      sessionId,
      text: chunks.join(''),
      stopReason: result.stopReason,
      capabilities: init.agentCapabilities,
    };
  } finally {
    await client.close();
  }
}
