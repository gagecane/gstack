/**
 * Preflight for the overlay efficacy harness — kiro-cli ACP edition.
 *
 * Historical context: this script used `@anthropic-ai/claude-agent-sdk.query()`
 * plus a local `claude` binary to smoke-test the harness prerequisites. Under
 * the "run gstack entirely on kiro-cli" epic (gsk-aca, investigation gsk-i76)
 * we replaced that with a thin Agent Client Protocol (ACP) client talking to
 * `kiro-cli acp` over stdio. See `docs/designs/KIRO_CLI_SCRIPTABLE_INTERFACE.md`.
 *
 * Scope note: the inline ACP client that originally lived in this file was
 * extracted to `lib/kiro-acp-client.ts` under bead gsk-9p0.1 so other callers
 * (overlay-efficacy harness, test helpers, one-shot judge calls) don't each
 * reinvent the subprocess + JSON-RPC framing layer. This script now only
 * orchestrates the preflight checks on top of that client.
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

import {
  AcpClient,
  resolveKiroCliBinary,
  type AcpRunResult,
  type AcpSession,
} from '../lib/kiro-acp-client';
import { readOverlay } from './resolvers/model-overlay';

/** Smoke-test model: cheapest non-experimental, rate_multiplier 0.4. */
const SMOKE_MODEL = 'claude-haiku-4.5';

/**
 * Drive a full initialize → session/new → session/prompt cycle and collect
 * the shape we need for downstream consumers.
 */
async function runAcpSmokeTest(binary: string, model: string): Promise<AcpRunResult> {
  const client = new AcpClient({
    binary,
    cliArgs: ['--trust-all-tools', `--model=${model}`],
  });

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
