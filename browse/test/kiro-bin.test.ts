import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { resolveKiroCliBinary } from '../src/kiro-bin';

// Empty env baseline — no PATH, no overrides — ensures no environmental kiro-cli binary leaks in.
const EMPTY_ENV = { PATH: '', Path: '' } as NodeJS.ProcessEnv;

describe('kiro-bin', () => {
  test('no override, no PATH match → returns null', () => {
    expect(resolveKiroCliBinary(EMPTY_ENV)).toBeNull();
  });

  test('absolute-path override returned as-is', () => {
    const got = resolveKiroCliBinary({
      ...EMPTY_ENV,
      GSTACK_KIRO_CLI_BIN: '/opt/custom/kiro-cli',
    });
    expect(got).toBe('/opt/custom/kiro-cli');
  });

  test('toolbox path resolves correctly as absolute-path override', () => {
    // Acceptance criterion from gsk-9p0.2: toolbox path resolves correctly.
    // We assert shape only — the actual file may not exist on CI.
    const got = resolveKiroCliBinary({
      ...EMPTY_ENV,
      GSTACK_KIRO_CLI_BIN: '/home/canewiw/.toolbox/bin/kiro-cli',
    });
    expect(got).toBe('/home/canewiw/.toolbox/bin/kiro-cli');
  });

  test('PATH-resolvable override goes through Bun.which', () => {
    // Make a fake binary in a temp dir, point PATH at it, set override to bare command name.
    // Windows requires the file to have a PATHEXT-listed extension to be discoverable
    // via Bun.which — without the extension Bun.which returns undefined.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-bin-test-'));
    const isWindows = process.platform === 'win32';
    const fakeBinName = isWindows ? 'fake-kiro-cli.cmd' : 'fake-kiro-cli';
    const fakeBin = path.join(tmpDir, fakeBinName);
    fs.writeFileSync(fakeBin, isWindows ? '@echo fake\r\n' : '#!/bin/sh\necho fake\n');
    if (!isWindows) fs.chmodSync(fakeBin, 0o755);
    try {
      const got = resolveKiroCliBinary({
        PATH: tmpDir,
        GSTACK_KIRO_CLI_BIN: 'fake-kiro-cli',
      });
      expect(got).toBe(fakeBin);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('override pointing at missing binary → null (no silent fallback to bare kiro-cli)', () => {
    const got = resolveKiroCliBinary({
      ...EMPTY_ENV,
      GSTACK_KIRO_CLI_BIN: 'definitely-not-a-real-binary-xyz',
    });
    expect(got).toBeNull();
  });

  test('override with wrapping quotes is stripped', () => {
    const got = resolveKiroCliBinary({
      ...EMPTY_ENV,
      GSTACK_KIRO_CLI_BIN: '"/opt/custom/kiro-cli"',
    });
    expect(got).toBe('/opt/custom/kiro-cli');
  });

  test('whitespace-only override is ignored (falls through to bare lookup)', () => {
    // With EMPTY_ENV.PATH, bare lookup also fails → null. This checks that the
    // override path isn't taken when the env var is effectively empty.
    const got = resolveKiroCliBinary({
      ...EMPTY_ENV,
      GSTACK_KIRO_CLI_BIN: '   ',
    });
    expect(got).toBeNull();
  });
});
