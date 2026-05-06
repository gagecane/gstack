/**
 * Integration tests for terminal-agent.ts.
 *
 * Spawns the agent as a real subprocess in a temp state directory,
 * exercises:
 *   1. /internal/grant — loopback handshake with the internal token.
 *   2. /ws Origin gate — non-extension Origin → 403.
 *   3. /ws cookie gate — missing/invalid cookie → 401.
 *   4. /ws full PTY round-trip — write `echo hi\n`, read `hi`.
 *   5. resize control message — terminal accepts and stays alive.
 *   6. close behavior — sending close terminates the PTY child.
 *
 * Uses /bin/bash via BROWSE_TERMINAL_BINARY override so CI doesn't need
 * the `claude` binary installed.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const AGENT_SCRIPT = path.join(import.meta.dir, '../src/terminal-agent.ts');
const BASH = '/bin/bash';

let stateDir: string;
let agentProc: any;
let agentPort: number;
let internalToken: string;

function readPortFile(): number {
  for (let i = 0; i < 50; i++) {
    try {
      const v = parseInt(fs.readFileSync(path.join(stateDir, 'terminal-port'), 'utf-8').trim(), 10);
      if (Number.isFinite(v) && v > 0) return v;
    } catch {}
    Bun.sleepSync(40);
  }
  throw new Error('terminal-agent never wrote port file');
}

function readTokenFile(): string {
  for (let i = 0; i < 50; i++) {
    try {
      const t = fs.readFileSync(path.join(stateDir, 'terminal-internal-token'), 'utf-8').trim();
      if (t.length > 16) return t;
    } catch {}
    Bun.sleepSync(40);
  }
  throw new Error('terminal-agent never wrote internal token');
}

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-term-'));
  const stateFile = path.join(stateDir, 'browse.json');
  // browse.json must exist so the agent's readBrowseToken doesn't throw.
  fs.writeFileSync(stateFile, JSON.stringify({ token: 'test-browse-token' }));
  agentProc = Bun.spawn(['bun', 'run', AGENT_SCRIPT], {
    env: {
      ...process.env,
      BROWSE_STATE_FILE: stateFile,
      BROWSE_SERVER_PORT: '0', // not used in this test
      BROWSE_TERMINAL_BINARY: BASH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agentPort = readPortFile();
  internalToken = readTokenFile();
});

afterAll(() => {
  try { agentProc?.kill?.(); } catch {}
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
});

async function grantToken(token: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${agentPort}/internal/grant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${internalToken}`,
    },
    body: JSON.stringify({ token }),
  });
}

describe('terminal-agent: /internal/grant', () => {
  test('accepts grants signed with the internal token', async () => {
    const resp = await grantToken('test-cookie-token-very-long-yes');
    expect(resp.status).toBe(200);
  });

  test('rejects grants with the wrong internal token', async () => {
    const resp = await fetch(`http://127.0.0.1:${agentPort}/internal/grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-token',
      },
      body: JSON.stringify({ token: 'whatever' }),
    });
    expect(resp.status).toBe(403);
  });
});

describe('terminal-agent: /ws gates', () => {
  test('rejects upgrade attempts without an extension Origin', async () => {
    const resp = await fetch(`http://127.0.0.1:${agentPort}/ws`);
    expect(resp.status).toBe(403);
    expect(await resp.text()).toBe('forbidden origin');
  });

  test('rejects upgrade attempts from a non-extension Origin', async () => {
    const resp = await fetch(`http://127.0.0.1:${agentPort}/ws`, {
      headers: { 'Origin': 'https://evil.example.com' },
    });
    expect(resp.status).toBe(403);
  });

  test('rejects extension-Origin upgrades without a granted cookie', async () => {
    const resp = await fetch(`http://127.0.0.1:${agentPort}/ws`, {
      headers: {
        'Origin': 'chrome-extension://abc123',
        'Cookie': 'gstack_pty=never-granted',
      },
    });
    expect(resp.status).toBe(401);
  });
});

describe('terminal-agent: PTY round-trip via real WebSocket (Cookie auth)', () => {
  test('binary writes go to PTY stdin, output streams back', async () => {
    const cookie = 'rt-token-must-be-at-least-seventeen-chars-long';
    const granted = await grantToken(cookie);
    expect(granted.status).toBe(200);

    const ws = new WebSocket(`ws://127.0.0.1:${agentPort}/ws`, {
      headers: {
        'Origin': 'chrome-extension://test-extension-id',
        'Cookie': `gstack_pty=${cookie}`,
      },
    } as any);

    const collected: string[] = [];
    let opened = false;
    let closed = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws never opened')), 5000);
      ws.addEventListener('open', () => { opened = true; clearTimeout(timer); resolve(); });
      ws.addEventListener('error', (e: any) => { clearTimeout(timer); reject(new Error('ws error')); });
    });

    ws.addEventListener('message', (ev: any) => {
      if (typeof ev.data === 'string') return; // ignore control frames
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data;
      collected.push(new TextDecoder().decode(buf));
    });

    ws.addEventListener('close', () => { closed = true; });

    // Lazy-spawn trigger: any binary frame causes the agent to spawn /bin/bash.
    ws.send(new TextEncoder().encode('echo hello-pty-world\nexit\n'));

    // Wait up to 5s for output and shutdown.
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = () => {
        const joined = collected.join('');
        if (joined.includes('hello-pty-world')) return resolve();
        if (Date.now() - start > 5000) return resolve();
        setTimeout(tick, 50);
      };
      tick();
    });

    expect(opened).toBe(true);
    const allOutput = collected.join('');
    expect(allOutput).toContain('hello-pty-world');

    try { ws.close(); } catch {}
    // Give cleanup a moment.
    await Bun.sleep(200);
  });

  test('Sec-WebSocket-Protocol auth path: browser-style upgrade with token in protocol', async () => {
    // This is the path the actual browser extension takes. Cross-port
    // SameSite=Strict cookies don't reliably survive the jump from the
    // browse server (port A) to the agent (port B) when initiated from a
    // chrome-extension origin, so we send the token via the only auth
    // header the browser WebSocket API lets us set: Sec-WebSocket-Protocol.
    //
    // The browser sends `gstack-pty.<token>` and the agent must:
    //   1) strip the gstack-pty. prefix
    //   2) validate the token
    //   3) ECHO the protocol back in the upgrade response
    // Without (3) the browser closes the connection immediately, which
    // is the exact bug the original cookie-only implementation hit in
    // manual dogfood. This test catches that regression in CI.
    const token = 'sec-protocol-token-must-be-at-least-seventeen-chars';
    await grantToken(token);

    // We exercise the protocol path by raw-handshaking via fetch+Upgrade,
    // because Bun's test-client WebSocket constructor doesn't propagate
    // `protocols` cleanly when also passed `headers` (the constructor
    // detects the third-arg form unreliably). Real browsers (Chromium)
    // use the standard protocols arg fine — the server-side handler is
    // identical either way, so this test still locks the load-bearing
    // invariant: the agent accepts a token via Sec-WebSocket-Protocol
    // and echoes the protocol back so a browser would accept the upgrade.
    const handshakeKey = 'dGhlIHNhbXBsZSBub25jZQ==';
    const resp = await fetch(`http://127.0.0.1:${agentPort}/ws`, {
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': handshakeKey,
        'Sec-WebSocket-Protocol': `gstack-pty.${token}`,
        'Origin': 'chrome-extension://test-extension-id',
      },
    });

    // 101 Switching Protocols + protocol echoed back = browser would accept.
    // 401/403/anything else = browser would close the connection immediately
    // (the bug we hit in manual dogfood).
    expect(resp.status).toBe(101);
    expect(resp.headers.get('upgrade')?.toLowerCase()).toBe('websocket');
    expect(resp.headers.get('sec-websocket-protocol')).toBe(`gstack-pty.${token}`);
  });

  test('Sec-WebSocket-Protocol auth: rejects unknown token even with valid Origin', async () => {
    const resp = await fetch(`http://127.0.0.1:${agentPort}/ws`, {
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Protocol': 'gstack-pty.never-granted-token',
        'Origin': 'chrome-extension://test-extension-id',
      },
    });
    expect(resp.status).toBe(401);
  });

  test('text frame {type:"resize"} is accepted (no crash, ws stays open)', async () => {
    const cookie = 'resize-token-must-be-at-least-seventeen-chars';
    await grantToken(cookie);

    const ws = new WebSocket(`ws://127.0.0.1:${agentPort}/ws`, {
      headers: {
        'Origin': 'chrome-extension://test-extension-id',
        'Cookie': `gstack_pty=${cookie}`,
      },
    } as any);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws never opened')), 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
    });

    // Send a resize before anything else (lazy-spawn won't fire).
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));

    // After resize, send a binary frame; should still work.
    ws.send(new TextEncoder().encode('exit\n'));

    await Bun.sleep(300);
    // ws still readyState 1 (OPEN) or 3 (CLOSED after exit) — both fine.
    expect([WebSocket.OPEN, WebSocket.CLOSED]).toContain(ws.readyState);

    try { ws.close(); } catch {}
  });
});

// ─── Host routing (gsk-dvd.3) ────────────────────────────────────────
//
// Spin up a fresh agent process with GSTACK_HOST=kiro pointing at a stub
// kiro-cli script. Confirms that:
//   1. /agent-available reports host='kiro' with the stub path.
//   2. The agent spawns the kiro-cli stub on first PTY frame (not claude).
//   3. When no kiro-cli is resolvable, the error payload uses the new
//      KIRO_NOT_FOUND code instead of the historical CLAUDE_NOT_FOUND.
//
// The stubs are tiny bun scripts — no real kiro-cli install required.
describe('terminal-agent: GSTACK_HOST=kiro routing', () => {
  let kiroStateDir: string;
  let kiroAgentProc: any;
  let kiroAgentPort: number;
  let kiroInternalToken: string;
  let stubKiroPath: string;

  function waitForFile(file: string, minLen = 0): string {
    for (let i = 0; i < 50; i++) {
      try {
        const v = fs.readFileSync(file, 'utf-8').trim();
        if (v.length >= minLen) return v;
      } catch {}
      Bun.sleepSync(40);
    }
    throw new Error(`file never appeared: ${file}`);
  }

  beforeAll(() => {
    kiroStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-kiro-'));
    const stateFile = path.join(kiroStateDir, 'browse.json');
    fs.writeFileSync(stateFile, JSON.stringify({ token: 'test-browse-token' }));

    // Stub kiro-cli: echoes a sentinel then exits 0. We don't need ACP
    // framing because the terminal-agent spawns it as an interactive PTY
    // process — whatever bytes come out go to xterm / the test collector.
    stubKiroPath = path.join(kiroStateDir, 'stub-kiro-cli.sh');
    fs.writeFileSync(
      stubKiroPath,
      // Sentinel lets the test confirm the stub (not claude) ran.
      '#!/bin/sh\necho KIRO_STUB_RAN\nexit 0\n',
      { mode: 0o755 },
    );

    kiroAgentProc = Bun.spawn(['bun', 'run', AGENT_SCRIPT], {
      env: {
        ...process.env,
        BROWSE_STATE_FILE: stateFile,
        BROWSE_SERVER_PORT: '0',
        // Force the kiro host route. Point resolveKiroCliCommand at the
        // stub via GSTACK_KIRO_BIN so no real kiro-cli install is needed.
        GSTACK_HOST: 'kiro',
        GSTACK_KIRO_BIN: stubKiroPath,
        // Make sure BROWSE_TERMINAL_BINARY doesn't leak in from the parent
        // env — it would short-circuit the host router and mask the
        // regression we're trying to catch.
        BROWSE_TERMINAL_BINARY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    kiroAgentPort = parseInt(
      waitForFile(path.join(kiroStateDir, 'terminal-port'), 1),
      10,
    );
    kiroInternalToken = waitForFile(
      path.join(kiroStateDir, 'terminal-internal-token'),
      17,
    );
  });

  afterAll(() => {
    try { kiroAgentProc?.kill?.(); } catch {}
    try { fs.rmSync(kiroStateDir, { recursive: true, force: true }); } catch {}
  });

  test('/agent-available reports host=kiro and the resolved stub path', async () => {
    const resp = await fetch(`http://127.0.0.1:${kiroAgentPort}/agent-available`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as {
      available: boolean; host: string | null; path: string | null; preference: string;
    };
    expect(body.available).toBe(true);
    expect(body.host).toBe('kiro');
    expect(body.path).toBe(stubKiroPath);
    expect(body.preference).toBe('kiro');
  });

  test('agent-available.json is persisted with host=kiro for extension bootstrap', () => {
    const status = JSON.parse(
      fs.readFileSync(path.join(kiroStateDir, 'agent-available.json'), 'utf-8'),
    );
    expect(status.available).toBe(true);
    expect(status.host).toBe('kiro');
    expect(status.preference).toBe('kiro');
    expect(status.install_url).toContain('kiro.dev');

    // Back-compat contract: claude-available.json still exists and is
    // truthful — claude is NOT available here, so available:false is the
    // right value, not a stale true from a prior run.
    const claudeStatus = JSON.parse(
      fs.readFileSync(path.join(kiroStateDir, 'claude-available.json'), 'utf-8'),
    );
    expect(claudeStatus.available).toBe(false);
  });

  test('PTY spawn routes to the kiro-cli stub (not claude) on first frame', async () => {
    const cookie = 'kiro-routing-token-must-be-long-enough';
    const granted = await fetch(`http://127.0.0.1:${kiroAgentPort}/internal/grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${kiroInternalToken}`,
      },
      body: JSON.stringify({ token: cookie }),
    });
    expect(granted.status).toBe(200);

    const ws = new WebSocket(`ws://127.0.0.1:${kiroAgentPort}/ws`, {
      headers: {
        'Origin': 'chrome-extension://test-extension-id',
        'Cookie': `gstack_pty=${cookie}`,
      },
    } as any);

    const collected: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws never opened')), 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
    });
    ws.addEventListener('message', (ev: any) => {
      if (typeof ev.data === 'string') return;
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data;
      collected.push(new TextDecoder().decode(buf));
    });

    // Lazy-spawn trigger. The stub exits immediately after printing.
    ws.send(new TextEncoder().encode('\n'));

    await new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (collected.join('').includes('KIRO_STUB_RAN')) return resolve();
        if (Date.now() - start > 5000) return resolve();
        setTimeout(tick, 50);
      };
      tick();
    });

    expect(collected.join('')).toContain('KIRO_STUB_RAN');
    try { ws.close(); } catch {}
    await Bun.sleep(100);
  });
});

describe('terminal-agent: GSTACK_HOST=kiro with no kiro-cli available', () => {
  let missingStateDir: string;
  let missingAgentProc: any;
  let missingAgentPort: number;
  let missingInternalToken: string;

  function wait(file: string, minLen = 0): string {
    for (let i = 0; i < 50; i++) {
      try {
        const v = fs.readFileSync(file, 'utf-8').trim();
        if (v.length >= minLen) return v;
      } catch {}
      Bun.sleepSync(40);
    }
    throw new Error(`file never appeared: ${file}`);
  }

  beforeAll(() => {
    missingStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-kiromiss-'));
    const stateFile = path.join(missingStateDir, 'browse.json');
    fs.writeFileSync(stateFile, JSON.stringify({ token: 'test-browse-token' }));

    missingAgentProc = Bun.spawn(['bun', 'run', AGENT_SCRIPT], {
      env: {
        ...process.env,
        BROWSE_STATE_FILE: stateFile,
        BROWSE_SERVER_PORT: '0',
        GSTACK_HOST: 'kiro',
        // Use a relative override so resolveKiroCliCommand routes through
        // Bun.which(); a bogus name won't match anything on PATH and
        // the resolver yields null. Keep the parent PATH intact so we
        // can actually spawn `bun` to run the agent.
        GSTACK_KIRO_BIN: 'definitely-not-a-real-binary-xyz-123-gsk-dvd3',
        BROWSE_TERMINAL_BINARY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    missingAgentPort = parseInt(wait(path.join(missingStateDir, 'terminal-port'), 1), 10);
    missingInternalToken = wait(path.join(missingStateDir, 'terminal-internal-token'), 17);
  });

  afterAll(() => {
    try { missingAgentProc?.kill?.(); } catch {}
    try { fs.rmSync(missingStateDir, { recursive: true, force: true }); } catch {}
  });

  test('emits KIRO_NOT_FOUND error frame and closes cleanly', async () => {
    const cookie = 'missing-kiro-token-must-be-long-enough';
    const grant = await fetch(`http://127.0.0.1:${missingAgentPort}/internal/grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${missingInternalToken}`,
      },
      body: JSON.stringify({ token: cookie }),
    });
    expect(grant.status).toBe(200);

    const ws = new WebSocket(`ws://127.0.0.1:${missingAgentPort}/ws`, {
      headers: {
        'Origin': 'chrome-extension://test-extension-id',
        'Cookie': `gstack_pty=${cookie}`,
      },
    } as any);

    const errorFrames: any[] = [];
    let closeCode: number | null = null;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws never opened')), 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
    });

    ws.addEventListener('message', (ev: any) => {
      if (typeof ev.data === 'string') {
        try { errorFrames.push(JSON.parse(ev.data)); } catch {}
      }
    });
    ws.addEventListener('close', (ev: any) => { closeCode = ev.code; });

    ws.send(new TextEncoder().encode('\n'));
    await Bun.sleep(400);

    expect(errorFrames.length).toBeGreaterThan(0);
    const err = errorFrames.find((f) => f.type === 'error');
    expect(err).toBeTruthy();
    expect(err.code).toBe('KIRO_NOT_FOUND');
    expect(err.host).toBe('kiro');
    expect(String(err.message)).toContain('kiro.dev');
    // 4404 = application-level close from the agent when no binary resolved.
    expect(closeCode).toBe(4404);

    try { ws.close(); } catch {}
  });
});
