/**
 * Unit tests for the Terminal-tab PTY agent and its server-side glue.
 *
 * Coverage:
 *   - pty-session-cookie module: mint / validate / revoke / TTL pruning.
 *   - source-level guard: /pty-session and /terminal/* are NOT in TUNNEL_PATHS.
 *   - source-level guard: /health does not surface ptyToken.
 *   - source-level guard: terminal-agent binds 127.0.0.1 only.
 *   - source-level guard: terminal-agent enforces Origin AND cookie on /ws.
 *
 * These are read-only checks against source — they prevent silent surface
 * widening during a routine refactor (matches the dual-listener.test.ts
 * pattern). End-to-end behavior (real /bin/bash PTY round-trip,
 * tunnel-surface 404 + denial-log) lives in
 * `browse/test/terminal-agent-integration.test.ts`.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  mintPtySessionToken, validatePtySessionToken, revokePtySessionToken,
  extractPtyCookie, buildPtySetCookie, buildPtyClearCookie,
  PTY_COOKIE_NAME, __resetPtySessions,
} from '../src/pty-session-cookie';

const SERVER_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/server.ts'), 'utf-8');
const AGENT_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/terminal-agent.ts'), 'utf-8');

describe('pty-session-cookie: mint/validate/revoke', () => {
  beforeEach(() => __resetPtySessions());

  test('a freshly minted token validates', () => {
    const { token } = mintPtySessionToken();
    expect(validatePtySessionToken(token)).toBe(true);
  });

  test('null and unknown tokens fail validation', () => {
    expect(validatePtySessionToken(null)).toBe(false);
    expect(validatePtySessionToken(undefined)).toBe(false);
    expect(validatePtySessionToken('')).toBe(false);
    expect(validatePtySessionToken('not-a-real-token')).toBe(false);
  });

  test('revoke makes a token invalid', () => {
    const { token } = mintPtySessionToken();
    expect(validatePtySessionToken(token)).toBe(true);
    revokePtySessionToken(token);
    expect(validatePtySessionToken(token)).toBe(false);
  });

  test('Set-Cookie has HttpOnly + SameSite=Strict + Path=/ + Max-Age', () => {
    const { token } = mintPtySessionToken();
    const cookie = buildPtySetCookie(token);
    expect(cookie).toContain(`${PTY_COOKIE_NAME}=${token}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toMatch(/Max-Age=\d+/);
    // Secure is intentionally omitted — daemon binds 127.0.0.1 over HTTP.
    expect(cookie).not.toContain('Secure');
  });

  test('clear-cookie has Max-Age=0', () => {
    expect(buildPtyClearCookie()).toContain('Max-Age=0');
  });

  test('extractPtyCookie reads gstack_pty from a Cookie header', () => {
    const { token } = mintPtySessionToken();
    const req = new Request('http://127.0.0.1/ws', {
      headers: { 'cookie': `othercookie=foo; gstack_pty=${token}; baz=qux` },
    });
    expect(extractPtyCookie(req)).toBe(token);
  });

  test('extractPtyCookie returns null when the cookie is missing', () => {
    const req = new Request('http://127.0.0.1/ws', {
      headers: { 'cookie': 'unrelated=value' },
    });
    expect(extractPtyCookie(req)).toBe(null);
  });
});

describe('Source-level guard: /pty-session is not on the tunnel surface', () => {
  test('TUNNEL_PATHS does not include /pty-session or /terminal/*', () => {
    const start = SERVER_SRC.indexOf('const TUNNEL_PATHS = new Set<string>([');
    expect(start).toBeGreaterThan(-1);
    const end = SERVER_SRC.indexOf(']);', start);
    const body = SERVER_SRC.slice(start, end);
    expect(body).not.toContain('/pty-session');
    expect(body).not.toContain('/terminal/');
    expect(body).not.toContain('/terminal-');
  });
});

describe('Source-level guard: /health does NOT surface ptyToken', () => {
  test('/health response body does not include ptyToken', () => {
    const healthIdx = SERVER_SRC.indexOf("url.pathname === '/health'");
    expect(healthIdx).toBeGreaterThan(-1);
    // Slice from /health through the response close-bracket.
    const slice = SERVER_SRC.slice(healthIdx, healthIdx + 2000);
    // The /health JSON.stringify body must not mention the cookie token.
    // It's allowed to include `terminalPort` (a port number, not auth).
    expect(slice).not.toContain('ptyToken');
    expect(slice).not.toContain('gstack_pty');
    expect(slice).toContain('terminalPort');
  });
});

describe('Source-level guard: terminal-agent', () => {
  test('binds 127.0.0.1 only, never 0.0.0.0', () => {
    expect(AGENT_SRC).toContain("hostname: '127.0.0.1'");
    expect(AGENT_SRC).not.toContain("hostname: '0.0.0.0'");
  });

  test('rejects /ws upgrades without chrome-extension:// Origin', () => {
    // The Origin check must run BEFORE the cookie check — otherwise a
    // missing-origin attempt would surface the 401 cookie message and
    // signal to attackers that they need to forge a cookie.
    const wsHandler = AGENT_SRC.slice(AGENT_SRC.indexOf("if (url.pathname === '/ws')"));
    expect(wsHandler).toContain('chrome-extension://');
    expect(wsHandler).toContain('forbidden origin');
  });

  test('validates the session token against an in-memory token set', () => {
    const wsHandler = AGENT_SRC.slice(AGENT_SRC.indexOf("if (url.pathname === '/ws')"));
    // Two transports: Sec-WebSocket-Protocol (preferred for browsers) and
    // Cookie gstack_pty (fallback). Both verify against validTokens.
    expect(wsHandler).toContain('sec-websocket-protocol');
    expect(wsHandler).toContain('gstack_pty');
    expect(wsHandler).toContain('validTokens.has');
  });

  test('Sec-WebSocket-Protocol auth: strips gstack-pty. prefix and echoes back', () => {
    const wsHandler = AGENT_SRC.slice(AGENT_SRC.indexOf("if (url.pathname === '/ws')"));
    // Browsers send `Sec-WebSocket-Protocol: gstack-pty.<token>`. The agent
    // must strip the prefix before checking validTokens, AND echo the
    // protocol back in the upgrade response — without the echo, the
    // browser closes the connection immediately.
    expect(wsHandler).toContain("'gstack-pty.'");
    expect(wsHandler).toContain('Sec-WebSocket-Protocol');
    expect(wsHandler).toContain('acceptedProtocol');
  });

  test('lazy spawn: claude PTY is spawned in message handler, not on upgrade', () => {
    // The whole point of lazy-spawn (codex finding #8) is that the WS
    // upgrade itself does NOT call spawnClaude. Spawn happens on first
    // message frame.
    const upgradeBlock = AGENT_SRC.slice(
      AGENT_SRC.indexOf("if (url.pathname === '/ws')"),
      AGENT_SRC.indexOf("websocket: {"),
    );
    expect(upgradeBlock).not.toContain('spawnClaude(');
    // Spawn must be invoked from the message handler (lazy on first byte).
    const messageHandler = AGENT_SRC.slice(AGENT_SRC.indexOf('message(ws, raw)'));
    expect(messageHandler).toContain('spawnClaude(');
    expect(messageHandler).toContain('!session.spawned');
  });

  test('process.on uncaughtException + unhandledRejection handlers exist', () => {
    expect(AGENT_SRC).toContain("process.on('uncaughtException'");
    expect(AGENT_SRC).toContain("process.on('unhandledRejection'");
  });

  test('cleanup escalates SIGINT to SIGKILL after 3s on close', () => {
    // disposeSession must be idempotent and use a SIGINT-then-SIGKILL pattern.
    const dispose = AGENT_SRC.slice(AGENT_SRC.indexOf('function disposeSession'));
    expect(dispose).toContain("'SIGINT'");
    expect(dispose).toContain("'SIGKILL'");
    expect(dispose).toContain('3000');
  });

  test('tabState frames write tabs.json + active-tab.json', () => {
    expect(AGENT_SRC).toContain("msg?.type === 'tabState'");
    expect(AGENT_SRC).toContain('function handleTabState');
    const fn = AGENT_SRC.slice(AGENT_SRC.indexOf('function handleTabState'));
    // Atomic write via tmp + rename for both files (so claude never reads
    // a half-written JSON document).
    expect(fn).toContain("'tabs.json'");
    expect(fn).toContain("'active-tab.json'");
    expect(fn).toContain('renameSync');
    // Skip chrome:// and chrome-extension:// pages — they're not useful
    // targets for browse commands.
    expect(fn).toContain("startsWith('chrome://')");
    expect(fn).toContain("startsWith('chrome-extension://')");
  });

  test('claude is spawned with --append-system-prompt tab-awareness hint', () => {
    expect(AGENT_SRC).toContain('function buildTabAwarenessHint');
    const hint = AGENT_SRC.slice(AGENT_SRC.indexOf('function buildTabAwarenessHint'));
    // The hint must mention the live state files and the fanout command —
    // those are the two affordances that distinguish a gstack-PTY claude
    // from a plain `claude` session.
    expect(hint).toContain('tabs.json');
    expect(hint).toContain('active-tab.json');
    expect(hint).toContain('tab-each');
    // And it must be passed via --append-system-prompt at spawn time
    // (NOT written into the PTY as user input — that would pollute the
    // visible transcript). The injection lives inside spawnAgent now
    // (host-aware generalization for gsk-dvd.3); spawnClaude is a thin
    // back-compat shim over spawnAgent. We scope to the spawnAgent body
    // so the assertion proves the tab hint still ships with claude.
    const agentSpawn = AGENT_SRC.slice(
      AGENT_SRC.indexOf('function spawnAgent'),
      AGENT_SRC.indexOf('function spawnClaude('),
    );
    expect(agentSpawn).toContain("'--append-system-prompt'");
    expect(agentSpawn).toContain('tabHint');
    // Tab-hint injection must be gated on host === 'claude'. kiro-cli
    // does not support --append-system-prompt and would abort on it, so
    // source-level we require the claude-only branch.
    expect(agentSpawn).toContain("agent.host === 'claude'");
  });

  test('host routing: resolveAgent picks between claude and kiro-cli', () => {
    // gsk-dvd.3 — the agent resolves which binary to spawn based on the
    // GSTACK_HOST env var. Source-level we lock in:
    //   (a) both resolver imports are wired up (claude-bin + kiro-bin),
    //   (b) a normalized host preference is read from GSTACK_HOST, and
    //   (c) the auto path prefers claude but falls back to kiro-cli.
    // This prevents a future refactor from silently dropping kiro support.
    expect(AGENT_SRC).toContain("from './claude-bin'");
    expect(AGENT_SRC).toContain("from './kiro-bin'");
    expect(AGENT_SRC).toContain('function readHostPreference');
    expect(AGENT_SRC).toContain("env.GSTACK_HOST");
    expect(AGENT_SRC).toContain('function resolveAgent');
    const resolve = AGENT_SRC.slice(AGENT_SRC.indexOf('function resolveAgent'));
    // Explicit pref branches
    expect(resolve).toContain("pref === 'claude'");
    expect(resolve).toContain("pref === 'kiro'");
    // auto: claude first, kiro fallback. Order matters — historical
    // installs must keep working when GSTACK_HOST is unset.
    expect(resolve).toContain('tryClaude() ?? tryKiro()');
  });

  test('BROWSE_TERMINAL_BINARY override wins over host routing', () => {
    // The test override has been in place since the integration tests
    // first landed (commit history for terminal-agent.ts). It lets us
    // spawn /bin/bash without requiring claude or kiro-cli on CI runners.
    // Lock it in source-level so a future refactor can't accidentally
    // move the override check behind the env-var branch.
    const resolve = AGENT_SRC.slice(AGENT_SRC.indexOf('function resolveAgent'));
    const pref = resolve.indexOf('readHostPreference');
    const override = resolve.indexOf('BROWSE_TERMINAL_BINARY');
    expect(override).toBeGreaterThan(-1);
    expect(pref).toBeGreaterThan(-1);
    // Override must be evaluated BEFORE the host preference — otherwise
    // GSTACK_HOST=kiro on a CI runner without kiro-cli installed would
    // short-circuit and the integration tests would never reach bash.
    expect(override).toBeLessThan(pref);
  });

  test('error payload is host-aware on lazy-spawn failure', () => {
    const messageHandler = AGENT_SRC.slice(AGENT_SRC.indexOf('message(ws, raw)'));
    // Back-compat: CLAUDE_NOT_FOUND is still emitted when the caller did
    // not explicitly request kiro, so older sidebars continue to show
    // the "install claude" card unchanged.
    expect(messageHandler).toContain('CLAUDE_NOT_FOUND');
    // New: kiro-mode failure surfaces its own code so a future sidebar
    // revision can show a kiro-specific install hint.
    expect(messageHandler).toContain('KIRO_NOT_FOUND');
    expect(messageHandler).toContain('kiro.dev');
  });

  test('writeClaudeAvailable emits both claude-available.json and agent-available.json', () => {
    const fn = AGENT_SRC.slice(AGENT_SRC.indexOf('function writeClaudeAvailable'));
    // Back-compat file — older extensions still read this.
    expect(fn).toContain("'claude-available.json'");
    // Host-aware successor — newer extensions can negotiate host choice.
    expect(fn).toContain("'agent-available.json'");
    // The new file must carry host + preference so consumers can show
    // the right install hint when the pick is kiro.
    expect(fn).toContain('host: resolvedHost');
    expect(fn).toContain('preference');
  });

  test('/agent-available HTTP route serves the host-aware JSON payload', () => {
    // The in-memory route matches what the extension bootstrap fetches.
    // Locking in source-level prevents a future refactor from dropping
    // the route silently.
    expect(AGENT_SRC).toContain("url.pathname === '/agent-available'");
    const route = AGENT_SRC.slice(AGENT_SRC.indexOf("url.pathname === '/agent-available'"));
    // Must report host + preference (mirrors the file-based contract).
    expect(route).toContain('host: agent?.host');
    expect(route).toContain('preference: readHostPreference()');
  });
});

describe('Source-level guard: server.ts /pty-session route', () => {
  test('validates AUTH_TOKEN, grants over loopback, returns token + Set-Cookie', () => {
    const route = SERVER_SRC.slice(SERVER_SRC.indexOf("url.pathname === '/pty-session'"));
    // Must check auth before minting.
    const beforeMint = route.slice(0, route.indexOf('mintPtySessionToken'));
    expect(beforeMint).toContain('validateAuth');
    // Must call the loopback grant before responding (otherwise the
    // agent's validTokens Set never sees the token and /ws would 401).
    expect(route).toContain('grantPtyToken');
    // Must return the token in the JSON body for the
    // Sec-WebSocket-Protocol auth path (cross-port cookies don't survive
    // SameSite=Strict from a chrome-extension origin).
    expect(route).toContain('ptySessionToken');
    // Set-Cookie is kept as a fallback for non-browser callers.
    expect(route).toContain('Set-Cookie');
    expect(route).toContain('buildPtySetCookie');
  });
});
