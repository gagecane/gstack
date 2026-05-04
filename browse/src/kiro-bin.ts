/**
 * kiro-bin.ts — Cross-platform `kiro-cli` binary resolution.
 *
 * Parallel to `claude-bin.ts`. Uses Bun.which() for the platform handling
 * (PATH parsing, Windows PATHEXT, X_OK, case-insensitive Path/PATH on Windows).
 * Adds the gstack-specific override on top.
 *
 * Override precedence:
 *   1. GSTACK_KIRO_CLI_BIN — absolute path or PATH-resolvable command.
 *   2. Plain `Bun.which('kiro-cli')` if no override is set.
 *
 * Returns null when nothing resolves; callers should report a clear failure
 * (e.g. preflight check prints FAIL, ACP client refuses to spawn) rather
 * than assume a default path.
 *
 * Scope note (gsk-9p0.2): kiro-cli doesn't currently need an args prefix
 * (unlike `claude` where `GSTACK_CLAUDE_BIN_ARGS` supports `wsl claude ...`
 * bridges on Windows). If a future caller needs one, mirror the claude-bin
 * design — don't invent a divergent shape.
 */

import * as path from 'path';

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, '$1');
}

/**
 * Resolve the `kiro-cli` binary for pinning, honoring the gstack override env.
 * Returns null when nothing resolves.
 */
export function resolveKiroCliBinary(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // Honor case-insensitive Path/PATH on Windows. Bun.which reads process.env
  // so we forward whichever the caller passed.
  const PATH = env.PATH ?? env.Path ?? '';
  const override = env.GSTACK_KIRO_CLI_BIN?.trim();

  if (override) {
    const trimmed = stripWrappingQuotes(override);
    // Absolute path: use as-is. Otherwise PATH-resolve through Bun.which so
    // overrides like GSTACK_KIRO_CLI_BIN=kiro-cli-next find the actual binary.
    return path.isAbsolute(trimmed)
      ? trimmed
      : (Bun.which(trimmed, { PATH }) ?? null);
  }

  return Bun.which('kiro-cli', { PATH });
}
