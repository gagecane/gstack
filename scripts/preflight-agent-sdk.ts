/**
 * Preflight for the overlay efficacy harness — kiro-cli ACP edition.
 *
 * Historical context: this script used `@anthropic-ai/claude-agent-sdk.query()`
 * plus a local `claude` binary to smoke-test the harness prerequisites. Under
 * the "run gstack entirely on kiro-cli" epic (gsk-aca, investigation gsk-i76)
 * we're replacing that with a thin Agent Client Protocol (ACP) client talking
 * to `kiro-cli acp` over stdio. See `docs/designs/KIRO_CLI_SCRIPTABLE_INTERFACE.md`.
 *
 * Scope for gsk-jfm: demonstrate parity ONLY for this file. The inline ACP
 * client below is intentionally minimal — a future bead extracts it to a
 * reusable `lib/kiro-acp-client.ts`. No changes to the SDK callers elsewhere.
 *
 * Confirms, before any paid eval runs:
 *   1. `scripts/resolvers/model-overlay.ts` resolves `{{INHERIT:claude}}` against
 *      `opus-4-7.md` with no unresolved inheritance directives.
 *   2. A local `kiro-cli` binary resolves (via PATH or GSTACK_KIRO_CLI_BIN)
 *      so binary pinning is possible.
 *   3. `kiro-cli acp` speaks the JSON-RPC 2.0 protocol we assume: initialize
 *      responds with agentCapabilities + agentInfo.version, session/new yields
 *      a session id + currently-selected model, session/prompt streams an
 *      `agent_message_chunk` and terminates with a `stopReason`.
 *   4. Per-turn metadata (`_kiro.dev/metadata.meteringUsage`) is emitted —
 *      this is the Kiro equivalent of `SDKResultMessage.total_cost_usd` and
 *      our downstream cost accounting depends on it.
 *
 * Run: bun run scripts/preflight-agent-sdk.ts
 *
 * Exit 0 on success. Exit non-zero with a clear message on any failure. No
 * side effects beyond stdout and a ~0.06-credit live ACP call on claude-haiku-4.5.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { readOverlay } from './resolvers/model-overlay';

/** Smoke-test model: cheapest non-experimental, rate_multiplier 0.4. */
const SMOKE_MODEL = 'claude-haiku-4.5';

/** Hard ceiling for each ACP call. The entire preflight finishes in <15s live. */
const ACP_RPC_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// kiro-cli binary resolver (inline, parallel to browse/src/claude-bin.ts).
// Deliberately kept here — a separate bead will extract to browse/src/kiro-bin.ts
// once more callers need it.
// ---------------------------------------------------------------------------

/**
 * Resolve the `kiro-cli` binary for pinning, honoring the gstack override env.
 * Returns null when nothing resolves — callers should report a clear failure.
 *
 * Override precedence:
 *   1. GSTACK_KIRO_CLI_BIN (absolute path or PATH-resolvable command)
 *   2. `Bun.which('kiro-cli')`
 */
function resolveKiroCliBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const PATH = env.PATH ?? env.Path ?? '';
  const override = env.GSTACK_KIRO_CLI_BIN?.trim();
  if (override) {
    // Absolute path: use as-is. Otherwise PATH-resolve.
    if (override.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(override)) return override;
    return Bun.which(override, { PATH }) ?? null;
  }
  return Bun.which('kiro-cli', { PATH });
}

// ---------------------------------------------------------------------------
// Minimal ACP client. JSON-RPC 2.0, newline-delimited, over kiro-cli stdio.
// Not a full SDK replacement — just enough to drive the preflight's smoke test.
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
}

type StreamMessage = JsonRpcResponse | JsonRpcNotification;

interface AcpSession {
  sessionId: string;
  currentModelId: string | null;
}

interface AcpRunResult {
  agentVersion: string | null;
  session: AcpSession;
  assistantChunks: string[];
  stopReason: string | null;
  meteringCredits: number | null;
  meteringUnit: string | null;
  durationMs: number | null;
  contextUsagePercent: number | null;
}

class AcpClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stdoutBuf = '';
  private readonly pending = new Map<number, {
    resolve: (r: JsonRpcResponse) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly notifications: JsonRpcNotification[] = [];
  private readonly stderrChunks: string[] = [];
  private exited = false;
  private exitError: Error | null = null;

  constructor(binary: string, args: string[]) {
    this.proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf-8');
    this.proc.stderr.setEncoding('utf-8');
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk: string) => {
      this.stderrChunks.push(chunk);
    });
    // Swallow EPIPE from stdin writes after the child exits — the 'exit' /
    // 'error' handlers below surface a more useful error to callers.
    this.proc.stdin.on('error', () => {});
    const failAll = (err: Error) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    };
    this.proc.on('error', (err) => {
      this.exited = true;
      // A spawn-time 'error' (ENOENT, EACCES, ...) is more specific than the
      // generic 'exited with code=null' that 'exit' will emit next — keep it.
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

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    // JSON-RPC over stdio is line-delimited here — kiro-cli writes one
    // message per line (verified in the live smoke test).
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
      if ('id' in msg && msg.id !== undefined && ('result' in msg || 'error' in msg)) {
        const p = this.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
      } else if ('method' in msg) {
        this.notifications.push(msg);
      }
    }
  }

  /** Send a JSON-RPC request and await the matching response by id. */
  async call(method: string, params: unknown): Promise<unknown> {
    if (this.exited) throw this.exitError ?? new Error('kiro-cli acp already exited');
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const payload = JSON.stringify(req) + '\n';
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP call timed out after ${ACP_RPC_TIMEOUT_MS}ms: ${method}`));
      }, ACP_RPC_TIMEOUT_MS);
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

  /** Drain and clear the notification buffer. */
  drainNotifications(): JsonRpcNotification[] {
    const copy = this.notifications.slice();
    this.notifications.length = 0;
    return copy;
  }

  get stderrText(): string {
    return this.stderrChunks.join('');
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.proc.stdin.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.proc.kill('SIGTERM');
        resolve();
      }, 3_000);
      this.proc.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

/**
 * Drive a full initialize → session/new → session/prompt cycle and collect
 * the shape we need for downstream consumers.
 */
async function runAcpSmokeTest(binary: string, model: string): Promise<AcpRunResult> {
  const client = new AcpClient(binary, [
    'acp',
    '--trust-all-tools',
    `--model=${model}`,
  ]);

  try {
    // 1. initialize
    const init = (await client.call('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'gstack-preflight', version: '0.0.1' },
    })) as {
      protocolVersion?: number;
      agentCapabilities?: unknown;
      agentInfo?: { name?: string; title?: string; version?: string };
    };
    const agentVersion = init?.agentInfo?.version ?? null;

    // 2. session/new
    const ses = (await client.call('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    })) as {
      sessionId?: string;
      modes?: unknown;
      models?: { currentModelId?: string };
    };
    if (!ses?.sessionId) throw new Error('session/new returned no sessionId');
    const session: AcpSession = {
      sessionId: ses.sessionId,
      currentModelId: ses.models?.currentModelId ?? null,
    };

    // 3. session/prompt — ~15-token smoke call
    const promptResp = (await client.call('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Reply with exactly the four letters: PONG' }],
    })) as { stopReason?: string };
    const stopReason = promptResp?.stopReason ?? null;

    // Collect streamed notifications that arrived during the prompt turn.
    const notifs = client.drainNotifications();
    const assistantChunks: string[] = [];
    let meteringCredits: number | null = null;
    let meteringUnit: string | null = null;
    let durationMs: number | null = null;
    let contextUsagePercent: number | null = null;

    for (const n of notifs) {
      if (n.method === 'session/update') {
        const p = n.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } };
        const upd = p?.update;
        if (upd?.sessionUpdate === 'agent_message_chunk' && upd.content?.type === 'text') {
          assistantChunks.push(upd.content.text ?? '');
        }
      } else if (n.method === '_kiro.dev/metadata') {
        const p = n.params as {
          contextUsagePercentage?: number;
          turnDurationMs?: number;
          meteringUsage?: Array<{ value?: number; unit?: string }>;
        };
        if (typeof p.contextUsagePercentage === 'number') {
          contextUsagePercent = p.contextUsagePercentage;
        }
        if (typeof p.turnDurationMs === 'number') {
          durationMs = p.turnDurationMs;
        }
        if (Array.isArray(p.meteringUsage) && p.meteringUsage.length > 0) {
          const m = p.meteringUsage[0];
          if (typeof m.value === 'number') meteringCredits = m.value;
          if (typeof m.unit === 'string') meteringUnit = m.unit;
        }
      }
    }

    return {
      agentVersion,
      session,
      assistantChunks,
      stopReason,
      meteringCredits,
      meteringUnit,
      durationMs,
      contextUsagePercent,
    };
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Preflight checks
// ---------------------------------------------------------------------------

async function main() {
  const failures: string[] = [];
  const pass = (msg: string) => console.log(`  ok  ${msg}`);
  const fail = (msg: string) => {
    console.log(`  FAIL  ${msg}`);
    failures.push(msg);
  };

  // 1. Overlay resolver
  console.log('1. Overlay resolver');
  const resolved = readOverlay('opus-4-7');
  if (!resolved) {
    fail("readOverlay('opus-4-7') returned empty");
  } else {
    pass(`resolved overlay length: ${resolved.length} chars`);
    if (resolved.includes('{{INHERIT:')) {
      fail('resolved overlay still contains {{INHERIT:...}} directive');
    } else {
      pass('no unresolved INHERIT directives');
    }
  }

  // 2. Binary pinning — kiro-cli
  console.log('\n2. Binary pinning');
  const kiroPath = resolveKiroCliBinary();
  if (kiroPath) {
    pass(`local kiro-cli binary: ${kiroPath}`);
  } else {
    fail('`Bun.which("kiro-cli")` failed — cannot pin binary (set GSTACK_KIRO_CLI_BIN to override)');
  }

  // 3. ACP end-to-end
  console.log('\n3. kiro-cli ACP end-to-end');
  if (!kiroPath) {
    console.log('  skip  no kiro-cli binary — cannot test live ACP cycle');
  } else {
    try {
      const result = await runAcpSmokeTest(kiroPath, SMOKE_MODEL);

      if (!result.agentVersion) {
        fail('initialize returned no agentInfo.version');
      } else {
        pass(`initialize: agentInfo.version=${result.agentVersion}`);
      }

      if (!result.session.sessionId) {
        fail('session/new returned no sessionId');
      } else {
        pass(
          `session/new: sessionId=${result.session.sessionId.slice(0, 8)}…, currentModelId=${result.session.currentModelId}`,
        );
        if (result.session.currentModelId !== SMOKE_MODEL) {
          fail(
            `session/new currentModelId=${result.session.currentModelId} did not match requested model=${SMOKE_MODEL}`,
          );
        }
      }

      if (result.assistantChunks.length === 0) {
        fail('no agent_message_chunk notifications received — model ID may be rejected');
      } else {
        const joined = result.assistantChunks.join('');
        pass(
          `agent_message_chunk: ${result.assistantChunks.length} chunk(s), joined=${JSON.stringify(joined.slice(0, 40))}`,
        );
      }

      if (!result.stopReason) {
        fail('session/prompt returned no stopReason');
      } else if (result.stopReason !== 'end_turn') {
        fail(`session/prompt stopReason=${result.stopReason} (expected end_turn)`);
      } else {
        pass(`session/prompt: stopReason=${result.stopReason}`);
      }

      if (result.meteringCredits === null) {
        fail('no _kiro.dev/metadata.meteringUsage observed — downstream cost accounting will break');
      } else {
        pass(
          `metadata: credits=${result.meteringCredits.toFixed(4)} ${result.meteringUnit ?? '?'}` +
            (result.durationMs !== null ? `, turnDurationMs=${result.durationMs}` : '') +
            (result.contextUsagePercent !== null
              ? `, contextUsage=${result.contextUsagePercent.toFixed(1)}%`
              : ''),
        );
      }
    } catch (err) {
      fail(`ACP smoke test threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log();
  if (failures.length > 0) {
    console.log(`PREFLIGHT FAILED: ${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('PREFLIGHT OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
