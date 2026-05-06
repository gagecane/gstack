/**
 * Unit tests for kiro-bin.ts — `kiro-cli` binary resolution.
 *
 * Mirrors browse/test/claude-bin.test.ts so the two resolvers stay
 * behaviourally locked-in together. The coverage goals are identical:
 *
 *   1. Empty PATH + no override → null (no environmental leakage).
 *   2. Absolute-path override is returned as-is.
 *   3. KIRO_BIN works as a fallback alias for GSTACK_KIRO_BIN.
 *   4. GSTACK_KIRO_BIN takes precedence over KIRO_BIN when both are set.
 *   5. PATH-resolvable override goes through Bun.which (e.g. `wsl`) so
 *      Windows wrapper scenarios work.
 *   6. Override pointing at a non-existent binary → null (no silent
 *      fallback to bare `kiro-cli`).
 *   7. GSTACK_KIRO_BIN_ARGS as JSON array → parsed argsPrefix.
 *   8. GSTACK_KIRO_BIN_ARGS as a scalar string → single-argument prefix.
 *   9. argsPrefix is empty when no override args are set.
 *
 * Plus a couple of kiro-specific cases that fall out of the header doc:
 *
 *   10. KIRO_BIN_ARGS is honored as a fallback when GSTACK_KIRO_BIN_ARGS
 *       isn't set. Callers shouldn't have to prefix both names.
 *   11. An arg-prefix is NOT applied when there's no override — a bare
 *       `kiro-cli` lookup returns an empty argsPrefix even if
 *       GSTACK_KIRO_BIN_ARGS is set.
 *
 * The test file does NOT spawn kiro-cli — these are pure resolution
 * tests. Spawn coverage lives in
 *   browse/test/terminal-agent-integration.test.ts (browse daemon PTY path)
 *   test/kiro-acp-client.test.ts (ACP client subprocess lifecycle)
 */

import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { resolveKiroCliCommand, resolveKiroCliBinary } from '../src/kiro-bin';

// Empty env baseline — no PATH, no overrides — ensures no environmental
// kiro-cli install leaks in. This is the same contract as claude-bin.test.ts.
const EMPTY_ENV = { PATH: '', Path: '' } as NodeJS.ProcessEnv;

describe('kiro-bin', () => {
  test('no override, no PATH match → returns null', () => {
    expect(resolveKiroCliCommand(EMPTY_ENV)).toBeNull();
    expect(resolveKiroCliBinary(EMPTY_ENV)).toBeNull();
  });

  test('absolute-path override returned as-is', () => {
    const got = resolveKiroCliCommand({
      ...EMPTY_ENV,
      GSTACK_KIRO_BIN: '/opt/custom/kiro-cli',
    });
    expect(got).toEqual({ command: '/opt/custom/kiro-cli', argsPrefix: [] });
  });

  test('KIRO_BIN works as fallback alias for GSTACK_KIRO_BIN', () => {
    const got = resolveKiroCliCommand({
      ...EMPTY_ENV,
      KIRO_BIN: '/opt/custom/kiro-cli',
    });
    expect(got?.command).toBe('/opt/custom/kiro-cli');
  });

  test('GSTACK_KIRO_BIN takes precedence over KIRO_BIN', () => {
    const got = resolveKiroCliCommand({
      ...EMPTY_ENV,
      GSTACK_KIRO_BIN: '/explicit/path',
      KIRO_BIN: '/fallback/path',
    });
    expect(got?.command).toBe('/explicit/path');
  });

  test('PATH-resolvable override goes through Bun.which (wsl-style wrappers)', () => {
    // Create a stub binary in a temp dir, point PATH at it, set the
    // override to the bare command name. This is the main Windows
    // scenario: GSTACK_KIRO_BIN=wsl so the resolver can locate `wsl`
    // on PATH without the caller having to spell out its absolute path.
    // Windows requires a PATHEXT-listed extension for Bun.which to find
    // the file (matches claude-bin.test.ts).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-bin-test-'));
    const isWindows = process.platform === 'win32';
    const fakeBinName = isWindows ? 'fake-kiro-cli.cmd' : 'fake-kiro-cli';
    const fakeBin = path.join(tmpDir, fakeBinName);
    fs.writeFileSync(fakeBin, isWindows ? '@echo fake\r\n' : '#!/bin/sh\necho fake\n');
    if (!isWindows) fs.chmodSync(fakeBin, 0o755);
    try {
      const got = resolveKiroCliCommand({
        PATH: tmpDir,
        GSTACK_KIRO_BIN: 'fake-kiro-cli',
      });
      expect(got?.command).toBe(fakeBin);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('override pointing at missing binary → null (no silent fallback to bare kiro-cli)', () => {
    // The caller asked for a specific override; if it doesn't resolve, we
    // must NOT fall back to Bun.which('kiro-cli') and silently pick up a
    // machine-wide install. That would defeat the whole point of the
    // override. Matches claude-bin's contract.
    const got = resolveKiroCliCommand({
      ...EMPTY_ENV,
      GSTACK_KIRO_BIN: 'definitely-not-a-real-binary-xyz',
    });
    expect(got).toBeNull();
  });

  test('GSTACK_KIRO_BIN_ARGS as JSON array → parsed argsPrefix', () => {
    const got = resolveKiroCliCommand({
      ...EMPTY_ENV,
      GSTACK_KIRO_BIN: '/opt/custom/kiro-cli',
      GSTACK_KIRO_BIN_ARGS: '["--no-cache", "--verbose"]',
    });
    expect(got?.argsPrefix).toEqual(['--no-cache', '--verbose']);
  });

  test('GSTACK_KIRO_BIN_ARGS as scalar string → treated as single argument', () => {
    const got = resolveKiroCliCommand({
      ...EMPTY_ENV,
      GSTACK_KIRO_BIN: '/opt/custom/kiro-cli',
      GSTACK_KIRO_BIN_ARGS: 'kiro-cli',
    });
    expect(got?.argsPrefix).toEqual(['kiro-cli']);
  });

  test('argsPrefix empty when no override args set', () => {
    const got = resolveKiroCliCommand({
      ...EMPTY_ENV,
      GSTACK_KIRO_BIN: '/opt/custom/kiro-cli',
    });
    expect(got?.argsPrefix).toEqual([]);
  });

  // ─── kiro-specific cases ─────────────────────────────────────────────
  //
  // These exercise behavior that's implicit in the header doc but worth
  // pinning down so a future refactor of parseOverrideArgs can't drop the
  // KIRO_BIN_ARGS fallback or accidentally honor arg-prefix when there's
  // no override active.

  test('KIRO_BIN_ARGS works as fallback alias for GSTACK_KIRO_BIN_ARGS', () => {
    const got = resolveKiroCliCommand({
      ...EMPTY_ENV,
      KIRO_BIN: '/opt/custom/kiro-cli',
      KIRO_BIN_ARGS: '["--profile", "alt"]',
    });
    expect(got?.command).toBe('/opt/custom/kiro-cli');
    expect(got?.argsPrefix).toEqual(['--profile', 'alt']);
  });

  test('GSTACK_KIRO_BIN_ARGS takes precedence over KIRO_BIN_ARGS', () => {
    const got = resolveKiroCliCommand({
      ...EMPTY_ENV,
      GSTACK_KIRO_BIN: '/opt/custom/kiro-cli',
      GSTACK_KIRO_BIN_ARGS: '["gstack-preferred"]',
      KIRO_BIN_ARGS: '["kiro-fallback"]',
    });
    expect(got?.argsPrefix).toEqual(['gstack-preferred']);
  });

  test('arg-prefix is NOT applied when no override is active', () => {
    // The header doc is explicit: "Only applied when an override is
    // active — bare `kiro-cli` resolution doesn't pick up an arg prefix."
    // Set up a real kiro-cli on PATH but no override; confirm argsPrefix
    // comes back empty even though GSTACK_KIRO_BIN_ARGS is set.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-bin-noprefix-'));
    const isWindows = process.platform === 'win32';
    const fakeBinName = isWindows ? 'kiro-cli.cmd' : 'kiro-cli';
    const fakeBin = path.join(tmpDir, fakeBinName);
    fs.writeFileSync(fakeBin, isWindows ? '@echo fake\r\n' : '#!/bin/sh\necho fake\n');
    if (!isWindows) fs.chmodSync(fakeBin, 0o755);
    try {
      const got = resolveKiroCliCommand({
        PATH: tmpDir,
        // No GSTACK_KIRO_BIN / KIRO_BIN set — the bare PATH lookup wins.
        GSTACK_KIRO_BIN_ARGS: '["should-be-ignored"]',
      });
      expect(got?.command).toBe(fakeBin);
      expect(got?.argsPrefix).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('override wrapped in quotes is unwrapped', () => {
    // The header doc calls out `stripWrappingQuotes` — some Windows-style
    // env writers wrap values in double quotes. Without this, an absolute
    // path like "C:\\tools\\kiro-cli.exe" would fail path.isAbsolute() and
    // get sent through Bun.which where it can't possibly resolve.
    const got = resolveKiroCliCommand({
      ...EMPTY_ENV,
      GSTACK_KIRO_BIN: '"/opt/quoted/kiro-cli"',
    });
    expect(got?.command).toBe('/opt/quoted/kiro-cli');
  });

  test('GSTACK_KIRO_BIN_ARGS with malformed JSON falls back to scalar', () => {
    // parseOverrideArgs catches the JSON.parse error and treats the raw
    // string as a single argument. Locking this in so we don't regress to
    // throwing a SyntaxError out of resolveKiroCliCommand.
    const got = resolveKiroCliCommand({
      ...EMPTY_ENV,
      GSTACK_KIRO_BIN: '/opt/custom/kiro-cli',
      GSTACK_KIRO_BIN_ARGS: '[not-json',
    });
    expect(got?.argsPrefix).toEqual(['[not-json']);
  });

  test('GSTACK_KIRO_BIN_ARGS with mixed-type JSON array falls back to scalar', () => {
    // The array must be all-strings. Anything else (booleans, numbers,
    // objects) is rejected and the raw value is treated as a scalar arg.
    // This prevents silent type coercion of numeric flags.
    const got = resolveKiroCliCommand({
      ...EMPTY_ENV,
      GSTACK_KIRO_BIN: '/opt/custom/kiro-cli',
      GSTACK_KIRO_BIN_ARGS: '["--foo", 42]',
    });
    expect(got?.argsPrefix).toEqual(['["--foo", 42]']);
  });

  test('empty GSTACK_KIRO_BIN (only whitespace) is ignored → PATH lookup wins', () => {
    // An env var set to whitespace should behave like it's unset —
    // otherwise a user who blanks it to "clear" the override would hit
    // a null result instead of falling back to the PATH install.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-bin-blank-'));
    const isWindows = process.platform === 'win32';
    const fakeBinName = isWindows ? 'kiro-cli.cmd' : 'kiro-cli';
    const fakeBin = path.join(tmpDir, fakeBinName);
    fs.writeFileSync(fakeBin, isWindows ? '@echo fake\r\n' : '#!/bin/sh\necho fake\n');
    if (!isWindows) fs.chmodSync(fakeBin, 0o755);
    try {
      const got = resolveKiroCliCommand({
        PATH: tmpDir,
        GSTACK_KIRO_BIN: '   ',
      });
      expect(got?.command).toBe(fakeBin);
      expect(got?.argsPrefix).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('resolveKiroCliBinary returns only the command string', () => {
    // The convenience wrapper exists so callers that don't need the
    // arg-prefix (e.g. the preflight probe) can get a plain path. Verify
    // it strips the wrapper envelope and doesn't accidentally leak
    // argsPrefix structure.
    const bin = resolveKiroCliBinary({
      ...EMPTY_ENV,
      GSTACK_KIRO_BIN: '/opt/custom/kiro-cli',
      GSTACK_KIRO_BIN_ARGS: '["--ignored-by-wrapper"]',
    });
    expect(bin).toBe('/opt/custom/kiro-cli');
  });

  test('resolveKiroCliBinary returns null when resolution fails', () => {
    const bin = resolveKiroCliBinary(EMPTY_ENV);
    expect(bin).toBeNull();
  });
});
