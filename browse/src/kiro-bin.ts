/**
 * kiro-bin.ts — Cross-platform `kiro-cli` binary resolution.
 *
 * Mirrors the pattern in claude-bin.ts: Bun.which() does all the platform
 * heavy lifting (PATH parsing, Windows PATHEXT, X_OK, case-insensitive
 * Path/PATH on Windows). This module layers the gstack-specific override +
 * arg-prefix logic on top so downstream callers can route kiro-cli through
 * a wrapper (e.g. `wsl kiro-cli` on Windows) or pin a specific absolute path.
 *
 * Override precedence:
 *   1. GSTACK_KIRO_BIN (or KIRO_BIN as fallback) — absolute path or
 *      PATH-resolvable command. `wsl` resolves through Bun.which('wsl') just
 *      like a bare `kiro-cli` lookup would.
 *   2. Plain `Bun.which('kiro-cli')` if no override is set.
 *
 * Arg prefix:
 *   GSTACK_KIRO_BIN_ARGS (or KIRO_BIN_ARGS) prepends arguments to every
 *   spawn. Accepts a JSON array (e.g. '["kiro-cli", "--no-cache"]') or a
 *   single scalar string treated as one argument. Only applied when an
 *   override is active — bare `kiro-cli` resolution doesn't pick up an arg
 *   prefix.
 *
 * Returns null when nothing resolves; callers should degrade (e.g. skip the
 * kiro code path entirely) rather than throw.
 */

import * as path from 'path';

export interface KiroCommand {
  command: string;
  argsPrefix: string[];
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, '$1');
}

function parseOverrideArgs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.GSTACK_KIRO_BIN_ARGS ?? env.KIRO_BIN_ARGS;
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      return parsed;
    }
  } catch {
    // Not JSON — treat as a single scalar argument.
  }
  return [stripWrappingQuotes(raw.trim())];
}

export function resolveKiroCliCommand(
  env: NodeJS.ProcessEnv = process.env,
): KiroCommand | null {
  const argsPrefix = parseOverrideArgs(env);
  const override = (env.GSTACK_KIRO_BIN ?? env.KIRO_BIN)?.trim();
  // Honor case-insensitive Path/PATH on Windows. Bun.which itself reads
  // process.env so we forward whichever the caller passed.
  const PATH = env.PATH ?? env.Path ?? '';

  if (override) {
    const trimmed = stripWrappingQuotes(override);
    // Absolute path: use as-is. Otherwise PATH-resolve through Bun.which so
    // overrides like GSTACK_KIRO_BIN=wsl find the actual binary.
    const resolved = path.isAbsolute(trimmed) ? trimmed : Bun.which(trimmed, { PATH });
    return resolved ? { command: resolved, argsPrefix } : null;
  }

  const command = Bun.which('kiro-cli', { PATH });
  return command ? { command, argsPrefix: [] } : null;
}

/** Convenience wrapper for callers that only need the command path. */
export function resolveKiroCliBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveKiroCliCommand(env)?.command ?? null;
}
