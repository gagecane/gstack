/**
 * Preflight for the overlay efficacy harness + kiro-cli runtime integration.
 *
 * Confirms, before any paid eval runs or kiro-cli session spawns:
 *   1. `@anthropic-ai/claude-agent-sdk` loads and `query()` is the expected shape.
 *   2. `claude-opus-4-7` is a live API model ID (not a Claude Code alias).
 *   3. The SDK event stream contains the types we assume (system init, assistant,
 *      result) with the fields we destructure.
 *   4. `scripts/resolvers/model-overlay.ts` resolves `{{INHERIT:claude}}` against
 *      `opus-4-7.md` with no unresolved inheritance directives.
 *   5. A local `claude` binary exists at `which claude` so binary pinning is possible.
 *   6. A local `kiro-cli` binary exists and exposes the `acp` subcommand (Agent
 *      Client Protocol) that the downstream kiro-acp-client (gsk-dvd.2) and
 *      browse daemon integration (gsk-dvd.3) depend on.
 *
 * Run: bun run scripts/preflight-agent-sdk.ts
 *
 * Exit 0 on success. Exit non-zero with a clear message on any failure. No
 * side effects beyond stdout and a ~15 token API call.
 */

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { readOverlay } from './resolvers/model-overlay';
import { resolveClaudeBinary } from '../browse/src/claude-bin';
import { resolveKiroCliCommand } from '../browse/src/kiro-bin';

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

  // 2. Local claude binary exists
  console.log('\n2. Binary pinning');
  let claudePath: string | null = resolveClaudeBinary();
  if (claudePath) {
    pass(`local claude binary: ${claudePath}`);
  } else {
    fail('`Bun.which("claude")` failed — cannot pin binary (set GSTACK_CLAUDE_BIN to override)');
  }

  // 3. SDK query end-to-end
  console.log('\n3. SDK query end-to-end');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  skip  ANTHROPIC_API_KEY not set — cannot test live query');
  } else {
    try {
      const events: SDKMessage[] = [];
      const q = query({
        prompt: 'say pong',
        options: {
          model: 'claude-opus-4-7',
          systemPrompt: '',
          tools: [],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: [],
          maxTurns: 1,
          pathToClaudeCodeExecutable: claudePath ?? undefined,
          env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
        },
      });
      for await (const ev of q) events.push(ev);
      pass(`received ${events.length} events`);

      const init = events.find(
        (e) => e.type === 'system' && (e as { subtype?: string }).subtype === 'init',
      ) as { claude_code_version?: string; model?: string } | undefined;
      if (!init) {
        fail('no system/init event received');
      } else {
        pass(`system init: claude_code_version=${init.claude_code_version}, model=${init.model}`);
      }

      const assistantEvents = events.filter((e) => e.type === 'assistant');
      if (assistantEvents.length === 0) {
        fail('no assistant events received — model ID may be rejected');
      } else {
        pass(`received ${assistantEvents.length} assistant event(s)`);
        const first = assistantEvents[0] as { message?: { content?: unknown[] } };
        const content = first.message?.content;
        if (!Array.isArray(content)) {
          fail('first assistant event has no content[] array');
        } else {
          pass(`first assistant content[] has ${content.length} block(s)`);
        }
      }

      const result = events.find((e) => e.type === 'result') as
        | { subtype?: string; total_cost_usd?: number; num_turns?: number }
        | undefined;
      if (!result) {
        fail('no result event received');
      } else {
        pass(
          `result: subtype=${result.subtype}, cost=$${result.total_cost_usd?.toFixed(4)}, turns=${result.num_turns}`,
        );
      }
    } catch (err) {
      fail(`SDK query threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. kiro-cli runtime surface
  //
  // Mirrors the claude binary check in section 2, then probes the ACP subcommand
  // (Agent Client Protocol) which is the capability-negotiation surface the
  // downstream kiro-acp-client (gsk-dvd.2) and browse daemon integration
  // (gsk-dvd.3) will attach to. Failure here signals the kiro runtime is
  // either missing or too old — flag before downstream pieces land so those
  // tasks have a known-good preflight to rely on.
  //
  // Unlike the Claude SDK query in section 3, we don't require an API key or
  // spawn a live chat session here — (a) there is no published kiro SDK
  // equivalent to @anthropic-ai/claude-agent-sdk today, and (b) session
  // initialization and tool registration happen through the ACP client once
  // gsk-dvd.2 extracts it. For now, binary + ACP-surface presence is the
  // contract this preflight can honestly assert.
  console.log('\n4. kiro-cli runtime surface');
  const kiro = resolveKiroCliCommand();
  if (!kiro) {
    fail(
      'kiro-cli not found — install kiro or set GSTACK_KIRO_BIN (supports absolute path or PATH-resolvable command, e.g. `wsl` on Windows with GSTACK_KIRO_BIN_ARGS=\'["kiro-cli"]\')',
    );
  } else {
    pass(`local kiro-cli binary: ${kiro.command}${kiro.argsPrefix.length ? ` (argsPrefix: ${JSON.stringify(kiro.argsPrefix)})` : ''}`);

    // Probe `kiro-cli --version`. Short timeout because this is a local
    // process spawn; if it doesn't return in 5s something is wrong with the
    // install.
    const versionProc = Bun.spawnSync([kiro.command, ...kiro.argsPrefix, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5000,
    });
    if (versionProc.exitCode !== 0) {
      fail(
        `kiro-cli --version exited ${versionProc.exitCode}: ${versionProc.stderr.toString().trim() || '(no stderr)'}`,
      );
    } else {
      const versionLine = versionProc.stdout.toString().trim().split('\n')[0];
      pass(`kiro-cli version: ${versionLine}`);
    }

    // Probe the ACP subcommand surface via --help. This is a capability check:
    // if `kiro-cli acp --help` returns non-zero, the build we're talking to
    // predates ACP support and downstream integration will not work.
    //
    // We intentionally do NOT start a real ACP session here — spawning a
    // persistent agent from a preflight would leave stranded processes. The
    // --help probe confirms the command exists and the binary parses args,
    // which is all a preflight can assert without the full ACP client.
    const acpHelpProc = Bun.spawnSync([kiro.command, ...kiro.argsPrefix, 'acp', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5000,
    });
    if (acpHelpProc.exitCode !== 0) {
      fail(
        `kiro-cli acp --help exited ${acpHelpProc.exitCode} — ACP subcommand unavailable: ${acpHelpProc.stderr.toString().trim() || '(no stderr)'}`,
      );
    } else {
      const helpText = acpHelpProc.stdout.toString();
      // Smoke-check the help text for the "Agent Client Protocol" phrase so
      // we fail loudly if kiro ever repurposes the `acp` subcommand for
      // something unrelated.
      if (!/agent client protocol/i.test(helpText)) {
        fail(
          'kiro-cli acp --help returned 0 but did not mention "Agent Client Protocol" — surface may have changed',
        );
      } else {
        pass('kiro-cli acp subcommand present (Agent Client Protocol surface available)');
      }
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
