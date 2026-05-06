/**
 * Terminal Agent — PTY-backed coding-agent terminal for the gstack browser
 * sidebar. Translates the phoenix gbrowser PTY (cmd/gbd/terminal.go) into
 * Bun, with a few changes informed by codex's outside-voice review:
 *
 *  - Lives in a separate non-compiled bun process from sidebar-agent.ts so
 *    a bug in WS framing or PTY cleanup can't take down the chat path.
 *  - Binds 127.0.0.1 only — never on the dual-listener tunnel surface.
 *  - Origin validation on the WS upgrade is REQUIRED (not defense-in-depth)
 *    because a localhost shell WS is a real cross-site WebSocket-hijacking
 *    target.
 *  - Cookie-based auth via /internal/grant from the parent server, not a
 *    token in /health.
 *  - Lazy spawn: the agent PTY is not spawned until the WS receives its
 *    first data frame. Sidebar opens that never type don't burn a session.
 *  - PTY dies with WS close (one PTY per WS). v1.1 may add session
 *    survival; for v1 we match phoenix's lifecycle.
 *
 * Host routing (gsk-dvd.3). The agent can drive either the `claude` binary
 * (default, matches historical behavior) or `kiro-cli`. The choice is
 * controlled by the `GSTACK_HOST` env var:
 *
 *   GSTACK_HOST=claude   — always spawn `claude`; fail if not on PATH.
 *   GSTACK_HOST=kiro     — always spawn `kiro-cli` (via resolveKiroCliCommand).
 *   GSTACK_HOST=auto     — prefer claude if resolvable, else kiro-cli. This
 *                          is the default so existing installs keep working
 *                          unchanged.
 *
 * The `BROWSE_TERMINAL_BINARY` test override still wins over host routing —
 * integration tests swap in /bin/bash without caring about host selection.
 * Tab-awareness (`--append-system-prompt`) is a claude-only affordance;
 * kiro-cli reads the same tabs.json / active-tab.json state files via the
 * $B helper and doesn't need an injected system prompt.
 *
 * The PTY uses Bun's `terminal:` spawn option (verified at impl time on
 * Bun 1.3.10): pass cols/rows + a data callback; write input via
 * `proc.terminal.write(buf)`; resize via `proc.terminal.resize(cols, rows)`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { safeUnlink } from './error-handling';
import { resolveClaudeCommand, type ClaudeCommand } from './claude-bin';
import { resolveKiroCliCommand, type KiroCommand } from './kiro-bin';

const STATE_FILE = process.env.BROWSE_STATE_FILE || path.join(process.env.HOME || '/tmp', '.gstack', 'browse.json');
const PORT_FILE = path.join(path.dirname(STATE_FILE), 'terminal-port');
const BROWSE_SERVER_PORT = parseInt(process.env.BROWSE_SERVER_PORT || '0', 10);
const EXTENSION_ID = process.env.BROWSE_EXTENSION_ID || ''; // optional: tighten Origin check
const INTERNAL_TOKEN = crypto.randomBytes(32).toString('base64url'); // shared with parent server via env at spawn

// In-memory cookie token registry. Parent posts /internal/grant after
// /pty-session; we validate WS cookies against this set.
const validTokens = new Set<string>();

// Active PTY session per WS. One terminal per connection. Codex finding #4:
// uncaught handlers below catch bugs in framing/cleanup so they don't kill
// the listener loop.
process.on('uncaughtException', (err) => {
  console.error('[terminal-agent] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[terminal-agent] unhandledRejection:', reason);
});

interface PtySession {
  proc: any | null;        // Bun.Subprocess once spawned
  cols: number;
  rows: number;
  cookie: string;
  spawned: boolean;
}

const sessions = new WeakMap<any, PtySession>(); // ws -> session

// ─── Host routing ───────────────────────────────────────────────────────
//
// See header doc. The one invariant we encode programmatically: a resolved
// agent is a (host, command, argsPrefix) triple. `unknown` is reserved for
// the BROWSE_TERMINAL_BINARY test override — we don't know whether the
// caller pointed us at claude, kiro-cli, or bash, so we skip host-specific
// flags and just spawn it.
export type AgentHost = 'claude' | 'kiro' | 'unknown';

export interface ResolvedAgent {
  host: AgentHost;
  command: string;
  argsPrefix: string[];
  /** True when the override test path (`BROWSE_TERMINAL_BINARY`) picked this. */
  fromTestOverride: boolean;
}

type HostPreference = 'claude' | 'kiro' | 'auto';

/**
 * Parse GSTACK_HOST into a normalized preference. Unknown values degrade
 * to 'auto' rather than throwing — the agent should still boot so the
 * bootstrap card can surface a useful error.
 */
export function readHostPreference(env: NodeJS.ProcessEnv = process.env): HostPreference {
  const raw = (env.GSTACK_HOST || '').trim().toLowerCase();
  if (raw === 'claude' || raw === 'kiro' || raw === 'auto') return raw;
  return 'auto';
}

/**
 * Resolve which agent binary to spawn. Precedence:
 *   1. BROWSE_TERMINAL_BINARY override (test-only; host tagged `unknown`).
 *   2. GSTACK_HOST=claude → claude only.
 *   3. GSTACK_HOST=kiro   → kiro-cli only.
 *   4. GSTACK_HOST=auto   → claude if resolvable, else kiro-cli.
 * Returns null if no binary is available under the requested preference.
 */
export function resolveAgent(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAgent | null {
  const override = env.BROWSE_TERMINAL_BINARY;
  if (override && fs.existsSync(override)) {
    return { host: 'unknown', command: override, argsPrefix: [], fromTestOverride: true };
  }

  const pref = readHostPreference(env);

  const tryClaude = (): ResolvedAgent | null => {
    const c = resolveClaudeCommand(env);
    return c ? { host: 'claude', command: c.command, argsPrefix: c.argsPrefix, fromTestOverride: false } : null;
  };
  const tryKiro = (): ResolvedAgent | null => {
    const k = resolveKiroCliCommand(env);
    return k ? { host: 'kiro', command: k.command, argsPrefix: k.argsPrefix, fromTestOverride: false } : null;
  };

  if (pref === 'claude') return tryClaude();
  if (pref === 'kiro') return tryKiro();

  // auto: prefer claude to preserve historical default, fall back to kiro.
  return tryClaude() ?? tryKiro();
}

/**
 * Legacy fallback probe for the claude binary. Kept in the common list of
 * install locations so machines without Bun.which-visible PATH entries
 * (e.g. Conductor with a stripped env) still find their claude install.
 *
 * Returns a minimal ResolvedAgent shaped entry — never picked up by
 * resolveAgent() directly; only consulted as a last-resort fallback in
 * findAgent() below.
 */
function findClaudeInCommonLocations(): ResolvedAgent | null {
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${process.env.HOME}/.local/bin/claude`,
    `${process.env.HOME}/.bun/bin/claude`,
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return { host: 'claude', command: c, argsPrefix: [], fromTestOverride: false }; } catch {}
  }
  return null;
}

/**
 * Resolve the agent for the configured host. Composes resolveAgent() with
 * the legacy fallback list so we match the pre-kiro behavior bit-for-bit
 * when GSTACK_HOST is unset (auto) and claude lives in one of the known
 * install locations.
 */
function findAgent(): ResolvedAgent | null {
  const resolved = resolveAgent();
  if (resolved) return resolved;
  // Legacy fallback — only meaningful for claude lookups. If the caller
  // explicitly requested kiro, we don't silently substitute claude.
  const pref = readHostPreference();
  if (pref === 'kiro') return null;
  return findClaudeInCommonLocations();
}

/**
 * Back-compat shim. Historical name; prefer `findAgent()` in new code.
 * Returns the absolute path to the claude binary if (and only if) the
 * resolved agent happens to be claude. Used by `writeClaudeAvailable`
 * to preserve the exact extension-bootstrap contract.
 */
function findClaude(): string | null {
  const agent = findAgent();
  if (!agent) return null;
  // The test override path reports host='unknown' — historical callers
  // treated any discovered override as "claude is available" because the
  // override was designed as a claude stand-in. Preserve that.
  if (agent.host === 'claude' || agent.fromTestOverride) return agent.command;
  return null;
}

/**
 * Probe + persist agent availability for the bootstrap card. Writes two
 * files atomically:
 *
 *   claude-available.json — back-compat contract. Extension reads this
 *     at bootstrap to decide whether to show the "install claude" card.
 *     In GSTACK_HOST=kiro mode this records `available: false` so the
 *     card no longer lies — but the new code path below gives newer
 *     extensions a richer signal.
 *
 *   agent-available.json  — host-aware successor. Callers that care
 *     about which host was picked read this. Safe to consume even when
 *     GSTACK_HOST=auto resolves to claude; `host: 'claude'` is the
 *     happy-path value.
 */
function writeClaudeAvailable(): void {
  const stateDir = path.dirname(STATE_FILE);
  try { fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 }); } catch {}

  const agent = findAgent();
  const preference = readHostPreference();
  const resolvedHost: AgentHost | null = agent?.host ?? null;

  // claude-available.json: match the pre-kiro schema exactly. If host
  // resolution picked something non-claude, claude is NOT available from
  // the extension's perspective — the terminal will still start, but the
  // bootstrap card should not claim "claude is installed". The existing
  // "install claude" install_url is kept for continuity; the newer
  // agent-available.json below gives a proper per-host install hint.
  const claudePath = agent?.host === 'claude' || agent?.fromTestOverride ? agent.command : null;
  const claudeStatus = {
    available: !!claudePath,
    path: claudePath || undefined,
    install_url: 'https://docs.anthropic.com/en/docs/claude-code',
    checked_at: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(stateDir, 'claude-available.json'), claudeStatus);

  // agent-available.json: host-aware schema.
  const agentStatus = {
    available: !!agent,
    host: resolvedHost,
    path: agent?.command || undefined,
    argsPrefix: agent?.argsPrefix?.length ? agent.argsPrefix : undefined,
    preference,
    install_url:
      resolvedHost === 'kiro'
        ? 'https://kiro.dev/docs/cli'
        : 'https://docs.anthropic.com/en/docs/claude-code',
    checked_at: claudeStatus.checked_at,
  };
  writeJsonAtomic(path.join(stateDir, 'agent-available.json'), agentStatus);
}

function writeJsonAtomic(target: string, value: unknown): void {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.tmp-${path.basename(target)}-${process.pid}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch {
    safeUnlink(tmp);
  }
}

/**
 * System-prompt hint passed to claude via --append-system-prompt. Tells
 * claude what tab-awareness affordances exist in this session so it
 * doesn't have to discover them by trial. The user can override anything
 * here just by saying so — system prompt is a soft hint, not a contract.
 *
 * Two paths claude has:
 *   1. Read live state from <stateDir>/tabs.json + active-tab.json
 *      (updated continuously by the gstack browser extension).
 *   2. Run $B tab, $B tabs, $B tab-each <command> to act on tabs. The
 *      tab-each helper fans a single command across every open tab and
 *      returns per-tab results as JSON.
 */
function buildTabAwarenessHint(stateDir: string): string {
  const tabsFile = path.join(stateDir, 'tabs.json');
  const activeFile = path.join(stateDir, 'active-tab.json');
  return [
    'You are running inside the gstack browser sidebar with live access to the user\'s browser tabs.',
    '',
    'Tab state files (kept fresh automatically by the extension):',
    `  ${tabsFile}        — all open tabs (id, url, title, active, pinned)`,
    `  ${activeFile}    — the currently active tab`,
    'Read these any time the user asks about "tabs", "the current page", or anything multi-tab. Do NOT shell out to $B tabs just to learn what\'s open — read the file.',
    '',
    'Tab manipulation commands (via $B):',
    '  $B tab <id>                 — switch to a tab',
    '  $B newtab [url]             — open a new tab',
    '  $B closetab [id]            — close a tab (current if no id)',
    '  $B tab-each <command>       — fan out a command across every tab; returns JSON results',
    '',
    'When the user asks for multi-tab work, prefer $B tab-each. Examples:',
    '  $B tab-each snapshot -i     — grab a snapshot from every tab',
    '  $B tab-each text            — pull clean text from every tab',
    '  $B tab-each title           — list every tab\'s title',
    '',
    'You\'re in a real terminal with a real PTY — slash commands, /resume, ANSI colors all work as in a normal claude session.',
  ].join('\n');
}

/** Spawn the configured coding agent in a PTY. Returns null if none resolved. */
function spawnAgent(cols: number, rows: number, onData: (chunk: Buffer) => void) {
  const agent = findAgent();
  if (!agent) return null;

  // Match phoenix env so the agent knows which browse server to talk to
  // and doesn't try to autostart its own. BROWSE_HEADED=1 keeps the
  // existing headed-mode browser; BROWSE_NO_AUTOSTART prevents the
  // gstack tooling inside the spawned agent from racing to spawn another
  // server.
  const env: Record<string, string> = {
    ...process.env as any,
    BROWSE_PORT: String(BROWSE_SERVER_PORT),
    BROWSE_STATE_FILE: STATE_FILE,
    BROWSE_NO_AUTOSTART: '1',
    BROWSE_HEADED: '1',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };

  // --append-system-prompt is a claude-only affordance. Per `claude --help`,
  // it gets appended to the model's system prompt so claude treats this as
  // contextual guidance, not a user message. Don't use a leading PTY write
  // for this — that would show up as if the user typed the hint, polluting
  // the visible transcript. kiro-cli has no equivalent today; it discovers
  // tab state by reading the same tabs.json / active-tab.json files on
  // demand through $B helpers.
  const stateDir = path.dirname(STATE_FILE);
  const args = [...agent.argsPrefix];
  if (agent.host === 'claude') {
    const tabHint = buildTabAwarenessHint(stateDir);
    args.push('--append-system-prompt', tabHint);
  }

  const proc = (Bun as any).spawn([agent.command, ...args], {
    terminal: {
      rows,
      cols,
      data(_terminal: any, chunk: Buffer) { onData(chunk); },
    },
    env,
  });
  return proc;
}

/**
 * Back-compat shim. Older callers (and some tests) expect a spawnClaude
 * symbol; retain it so source-level assertions still find the function
 * name. Internally delegates to the host-agnostic spawner above.
 */
function spawnClaude(cols: number, rows: number, onData: (chunk: Buffer) => void) {
  return spawnAgent(cols, rows, onData);
}

/** Cleanup a PTY session: SIGINT, then SIGKILL after 3s. */
function disposeSession(session: PtySession): void {
  try { session.proc?.terminal?.close?.(); } catch {}
  if (session.proc?.pid) {
    try { session.proc.kill?.('SIGINT'); } catch {}
    setTimeout(() => {
      try {
        if (session.proc && !session.proc.killed) session.proc.kill?.('SIGKILL');
      } catch {}
    }, 3000);
  }
  session.proc = null;
  session.spawned = false;
}

/**
 * Build the HTTP server. Two routes:
 *   POST /internal/grant — parent server pushes a fresh cookie token
 *   GET  /ws             — extension upgrades to WebSocket (PTY transport)
 *
 * Everything else returns 404. The listener binds 127.0.0.1 only.
 */
function buildServer() {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0, // PTY connections are long-lived; default idleTimeout would kill them

    fetch(req, server) {
      const url = new URL(req.url);

      // /internal/grant — loopback-only handshake from parent server.
      if (url.pathname === '/internal/grant' && req.method === 'POST') {
        const auth = req.headers.get('authorization');
        if (auth !== `Bearer ${INTERNAL_TOKEN}`) {
          return new Response('forbidden', { status: 403 });
        }
        return req.json().then((body: any) => {
          if (typeof body?.token === 'string' && body.token.length > 16) {
            validTokens.add(body.token);
          }
          return new Response('ok');
        }).catch(() => new Response('bad', { status: 400 }));
      }

      // /internal/revoke — drop a token (called on WS close or bootstrap reload)
      if (url.pathname === '/internal/revoke' && req.method === 'POST') {
        const auth = req.headers.get('authorization');
        if (auth !== `Bearer ${INTERNAL_TOKEN}`) {
          return new Response('forbidden', { status: 403 });
        }
        return req.json().then((body: any) => {
          if (typeof body?.token === 'string') validTokens.delete(body.token);
          return new Response('ok');
        }).catch(() => new Response('bad', { status: 400 }));
      }

      // /claude-available — bootstrap card hits this when user clicks "I installed it".
      // Kept for back-compat with older sidebar builds. See /agent-available
      // below for the host-aware successor.
      if (url.pathname === '/claude-available' && req.method === 'GET') {
        writeClaudeAvailable();
        const claudePath = findClaude();
        return new Response(JSON.stringify({ available: !!claudePath, path: claudePath }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // /agent-available — host-aware availability probe. Mirrors the
      // claude-available payload but also reports which host the daemon
      // resolved so newer sidebar builds can show the right install hint
      // and error messaging. Safe for old sidebars to ignore.
      if (url.pathname === '/agent-available' && req.method === 'GET') {
        writeClaudeAvailable();
        const agent = findAgent();
        return new Response(JSON.stringify({
          available: !!agent,
          host: agent?.host ?? null,
          path: agent?.command ?? null,
          preference: readHostPreference(),
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // /ws — WebSocket upgrade. CRITICAL gates:
      //   (1) Origin must be chrome-extension://<id>. Cross-site WS hijacking
      //       defense — required, not optional.
      //   (2) Token must be in validTokens. We accept the token via two
      //       transports for compatibility:
      //         - Sec-WebSocket-Protocol (preferred for browsers — the only
      //           auth header settable from the browser WebSocket API)
      //         - Cookie gstack_pty (works for non-browser callers and
      //           same-port browser callers; doesn't survive the cross-port
      //           jump from server.ts:34567 to the agent's random port
      //           when SameSite=Strict is set)
      //       Either path works; both verify against the same in-memory
      //       validTokens Set, populated by the parent server's
      //       authenticated /pty-session → /internal/grant chain.
      if (url.pathname === '/ws') {
        const origin = req.headers.get('origin') || '';
        const isExtensionOrigin = origin.startsWith('chrome-extension://');
        if (!isExtensionOrigin) {
          return new Response('forbidden origin', { status: 403 });
        }
        if (EXTENSION_ID && origin !== `chrome-extension://${EXTENSION_ID}`) {
          return new Response('forbidden origin', { status: 403 });
        }

        // Try Sec-WebSocket-Protocol first. Format: a single token, possibly
        // with a `gstack-pty.` prefix (which we strip). Browsers send a
        // comma-separated list when multiple were requested; we pick the
        // first that matches a known token.
        const protoHeader = req.headers.get('sec-websocket-protocol') || '';
        let token: string | null = null;
        let acceptedProtocol: string | null = null;
        for (const raw of protoHeader.split(',').map(s => s.trim()).filter(Boolean)) {
          const candidate = raw.startsWith('gstack-pty.') ? raw.slice('gstack-pty.'.length) : raw;
          if (validTokens.has(candidate)) {
            token = candidate;
            acceptedProtocol = raw;
            break;
          }
        }

        // Fallback: Cookie gstack_pty (legacy / non-browser callers).
        if (!token) {
          const cookieHeader = req.headers.get('cookie') || '';
          for (const part of cookieHeader.split(';')) {
            const [name, ...rest] = part.trim().split('=');
            if (name === 'gstack_pty') {
              const candidate = rest.join('=') || null;
              if (candidate && validTokens.has(candidate)) {
                token = candidate;
              }
              break;
            }
          }
        }

        if (!token) {
          return new Response('unauthorized', { status: 401 });
        }

        const upgraded = server.upgrade(req, {
          data: { cookie: token },
          // Echo the protocol back so the browser accepts the upgrade.
          // Required when the client sends Sec-WebSocket-Protocol — the
          // server MUST select one of the offered protocols, otherwise
          // the browser closes the connection immediately.
          ...(acceptedProtocol ? { headers: { 'Sec-WebSocket-Protocol': acceptedProtocol } } : {}),
        });
        return upgraded ? undefined : new Response('upgrade failed', { status: 500 });
      }

      return new Response('not found', { status: 404 });
    },

    websocket: {
      message(ws, raw) {
        let session = sessions.get(ws);
        if (!session) {
          session = {
            proc: null,
            cols: 80,
            rows: 24,
            cookie: (ws.data as any)?.cookie || '',
            spawned: false,
          };
          sessions.set(ws, session);
        }

        // Text frames are control messages: {type: "resize", cols, rows} or
        // {type: "tabSwitch", tabId, url, title}. Binary frames are raw input
        // bytes destined for the PTY stdin.
        if (typeof raw === 'string') {
          let msg: any;
          try { msg = JSON.parse(raw); } catch { return; }
          if (msg?.type === 'resize') {
            const cols = Math.max(2, Math.floor(Number(msg.cols) || 80));
            const rows = Math.max(2, Math.floor(Number(msg.rows) || 24));
            session.cols = cols;
            session.rows = rows;
            try { session.proc?.terminal?.resize?.(cols, rows); } catch {}
            return;
          }
          if (msg?.type === 'tabSwitch') {
            handleTabSwitch(msg);
            return;
          }
          if (msg?.type === 'tabState') {
            handleTabState(msg);
            return;
          }
          // Unknown text frame — ignore.
          return;
        }

        // Binary input. Lazy-spawn the agent on the first byte.
        if (!session.spawned) {
          session.spawned = true;
          const proc = spawnClaude(session.cols, session.rows, (chunk) => {
            try { ws.sendBinary(chunk); } catch {}
          });
          if (!proc) {
            // Host-aware error reporting. Default to the historical
            // CLAUDE_NOT_FOUND code so older sidebars continue to show
            // the "install claude" card unchanged. When the operator
            // explicitly requested kiro, surface KIRO_NOT_FOUND so the
            // card (when updated) can link to the kiro install docs
            // instead. The generic error envelope still carries a
            // human-readable message either way.
            const pref = readHostPreference();
            const payload = pref === 'kiro' ? {
              type: 'error',
              code: 'KIRO_NOT_FOUND',
              host: 'kiro',
              message: 'kiro-cli not on PATH. Install: https://kiro.dev/docs/cli — or set GSTACK_KIRO_BIN to an explicit binary.',
            } : {
              type: 'error',
              code: 'CLAUDE_NOT_FOUND',
              host: pref === 'auto' ? 'auto' : 'claude',
              message: 'claude CLI not on PATH. Install: https://docs.anthropic.com/en/docs/claude-code',
            };
            try {
              ws.send(JSON.stringify(payload));
              ws.close(4404, `${payload.host} not found`);
            } catch {}
            return;
          }
          session.proc = proc;
          // Watch for child exit so the WS closes cleanly when the agent exits.
          proc.exited?.then?.(() => {
            try { ws.close(1000, 'pty exited'); } catch {}
          });
        }
        try {
          // raw is a Uint8Array; Bun.Terminal.write accepts string|Buffer.
          // Convert to Buffer for safety.
          session.proc?.terminal?.write?.(Buffer.from(raw as Uint8Array));
        } catch (err) {
          console.error('[terminal-agent] terminal.write failed:', err);
        }
      },

      close(ws) {
        const session = sessions.get(ws);
        if (session) {
          disposeSession(session);
          if (session.cookie) {
            // Drop the cookie so it can't be replayed against a new PTY.
            validTokens.delete(session.cookie);
          }
          sessions.delete(ws);
        }
      },
    },
  });
}

/**
 * Tab-switch helper: write the active tab to a state file (claude reads it)
 * and notify the parent server so its activeTabId stays synced. Skips
 * chrome:// and chrome-extension:// internal pages.
 */
/**
 * Live tab snapshot. Writes <stateDir>/tabs.json (full list) and updates
 * <stateDir>/active-tab.json (current active). claude can read these any
 * time without invoking $B tabs — saves a round-trip when the model just
 * needs to check the landscape before deciding what to do.
 */
function handleTabState(msg: {
  active?: { tabId?: number; url?: string; title?: string } | null;
  tabs?: Array<{ tabId?: number; url?: string; title?: string; active?: boolean; windowId?: number; pinned?: boolean; audible?: boolean }>;
  reason?: string;
}): void {
  const stateDir = path.dirname(STATE_FILE);
  try { fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 }); } catch {}

  // tabs.json — full list
  if (Array.isArray(msg.tabs)) {
    const payload = {
      updatedAt: new Date().toISOString(),
      reason: msg.reason || 'unknown',
      tabs: msg.tabs.map(t => ({
        tabId: t.tabId ?? null,
        url: t.url || '',
        title: t.title || '',
        active: !!t.active,
        windowId: t.windowId ?? null,
        pinned: !!t.pinned,
        audible: !!t.audible,
      })),
    };
    const target = path.join(stateDir, 'tabs.json');
    const tmp = path.join(stateDir, `.tmp-tabs-${process.pid}`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch {
      safeUnlink(tmp);
    }
  }

  // active-tab.json — single active tab. Skip chrome-internal pages so
  // claude doesn't see chrome:// or chrome-extension:// URLs as
  // "current target."
  const active = msg.active;
  if (active && active.url && !active.url.startsWith('chrome://') && !active.url.startsWith('chrome-extension://')) {
    const ctxFile = path.join(stateDir, 'active-tab.json');
    const tmp = path.join(stateDir, `.tmp-tab-${process.pid}`);
    try {
      fs.writeFileSync(tmp, JSON.stringify({
        tabId: active.tabId ?? null,
        url: active.url,
        title: active.title ?? '',
      }), { mode: 0o600 });
      fs.renameSync(tmp, ctxFile);
    } catch {
      safeUnlink(tmp);
    }
  }
}

function handleTabSwitch(msg: { tabId?: number; url?: string; title?: string }): void {
  const url = msg.url || '';
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;

  const stateDir = path.dirname(STATE_FILE);
  const ctxFile = path.join(stateDir, 'active-tab.json');
  const tmp = path.join(stateDir, `.tmp-tab-${process.pid}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({
      tabId: msg.tabId ?? null,
      url,
      title: msg.title ?? '',
    }), { mode: 0o600 });
    fs.renameSync(tmp, ctxFile);
  } catch {
    safeUnlink(tmp);
  }

  // Best-effort sync to parent server so its activeTabId tracking matches.
  // No await; this is fire-and-forget.
  if (BROWSE_SERVER_PORT > 0) {
    fetch(`http://127.0.0.1:${BROWSE_SERVER_PORT}/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${readBrowseToken()}`,
      },
      body: JSON.stringify({
        command: 'tab',
        args: [String(msg.tabId ?? ''), '--no-focus'],
      }),
    }).catch(() => {});
  }
}

function readBrowseToken(): string {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const j = JSON.parse(raw);
    return j.token || '';
  } catch { return ''; }
}

// Boot.
function main() {
  writeClaudeAvailable();
  const server = buildServer();
  const port = (server as any).port || (server as any).address?.port;
  if (!port) {
    console.error('[terminal-agent] failed to bind: no port');
    process.exit(1);
  }

  // Write port file atomically so the parent server can pick it up.
  const dir = path.dirname(PORT_FILE);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  const tmp = `${PORT_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, String(port), { mode: 0o600 });
  fs.renameSync(tmp, PORT_FILE);

  // Hand the parent the internal token so it can call /internal/grant.
  // Parent learns INTERNAL_TOKEN via env (TERMINAL_AGENT_INTERNAL_TOKEN below).
  // We just print it on stdout for the supervising process to pick up if it's
  // not already in env. Defense against env races at spawn time.
  const agent = findAgent();
  const hostTag = agent
    ? (agent.fromTestOverride ? `override(${agent.command})` : `${agent.host}@${agent.command}`)
    : 'no-agent';
  console.log(`[terminal-agent] listening on 127.0.0.1:${port} pid=${process.pid} host=${hostTag} preference=${readHostPreference()}`);

  // Cleanup port file on exit.
  const cleanup = () => { safeUnlink(PORT_FILE); process.exit(0); };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

// Export the internal token so cli.ts can pass the SAME value to the parent
// server via env. Parent reads BROWSE_TERMINAL_INTERNAL_TOKEN and uses it
// for /internal/grant calls.
//
// In practice, the agent generates INTERNAL_TOKEN once at boot and writes it
// to a state file the parent reads. This avoids env-passing races. See main().
const INTERNAL_TOKEN_FILE = path.join(path.dirname(STATE_FILE), 'terminal-internal-token');
try {
  fs.mkdirSync(path.dirname(INTERNAL_TOKEN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(INTERNAL_TOKEN_FILE, INTERNAL_TOKEN, { mode: 0o600 });
} catch {}

main();
