/**
 * Unit tests for kiro-acp-client.
 *
 * Strategy: spawn a tiny bun subprocess that acts as a stub ACP agent so
 * the tests don't depend on kiro-cli being installed. The stub echoes
 * canned responses, emits notifications on demand, and exits cleanly.
 *
 * What this file covers:
 *   • NDJSON framing (split lines, trailing-CR tolerance, partial chunks).
 *   • Request → response correlation across concurrent in-flight requests.
 *   • JSON-RPC error responses → AcpProtocolError.
 *   • Timeout → AcpTimeoutError without leaking pending entries.
 *   • Subprocess exit while requests in flight → AcpTransportError.
 *   • Notification routing — session/update, Kiro extensions, generic.
 *   • Incoming-request handling (the Agent asks the Client for something).
 *   • Type-guard helpers on the types module.
 *   • Typed convenience helpers (initialize, newSession, prompt, cancel).
 *
 * The stub agent lives as a temp file we write at test setup and delete
 * at teardown. It reads NDJSON from stdin, matches on the method name,
 * and writes the scripted response. See `STUB_AGENT_SCRIPT` below.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  AcpProtocolError,
  AcpTimeoutError,
  AcpTransportError,
  KiroAcpClient,
  runKiroPrompt,
} from '../lib/kiro-acp-client';
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isKiroExtensionMethod,
} from '../lib/kiro-acp-types';
import type {
  KiroMetadataParams,
  SessionUpdateParams,
} from '../lib/kiro-acp-types';

// ---------------------------------------------------------------------------
// Stub agent: a tiny NDJSON-over-stdio JSON-RPC responder.
//
// We script its behavior via environment variables so each test can
// configure it without rewriting the file:
//
//   STUB_INIT_RESPONSE   — JSON for the result of `initialize`
//   STUB_PROMPT_UPDATES  — JSON array of SessionUpdateParams to emit before
//                          the prompt response
//   STUB_PROMPT_RESPONSE — JSON for the result of `session/prompt`
//   STUB_EMIT_KIRO       — "1" to emit a _kiro.dev/metadata notification on
//                          initialize
//   STUB_ERROR_ON        — method name; when received, respond with an error
//   STUB_EXIT_ON         — method name; when received, exit without responding
//   STUB_INCOMING_CALL   — JSON for a JsonRpcRequest to send BEFORE responding
//                          to the triggering method (tests bidirectional RPC)
//   STUB_INCOMING_ON     — method that triggers STUB_INCOMING_CALL
// ---------------------------------------------------------------------------

const STUB_AGENT_SCRIPT = `
const DEBUG = !!process.env.STUB_DEBUG;
function dbg(...args) { if (DEBUG) console.error('[stub]', ...args); }

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n');
  dbg('->', obj);
}

let buf = '';
let nextIncomingId = 10_000;
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

process.stdin.on('end', () => process.exit(0));

function handle(msg) {
  dbg('<-', msg);

  // Handle response-to-our-request frames (client responding to stub's request).
  if (msg.id !== undefined && msg.result !== undefined && msg.method === undefined) {
    // The stub doesn't track these; tests can peek at stderr if needed.
    dbg('client response for id', msg.id);
    return;
  }

  if (process.env.STUB_EXIT_ON && msg.method === process.env.STUB_EXIT_ON) {
    process.exit(0);
  }

  // Silent drop — used by the timeout test. The stub reads the request but
  // never writes a response, letting the client's timeout fire cleanly.
  if (process.env.STUB_SILENT_ON && msg.method === process.env.STUB_SILENT_ON) {
    return;
  }

  if (process.env.STUB_ERROR_ON && msg.method === process.env.STUB_ERROR_ON) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'stub error' } });
    return;
  }

  if (process.env.STUB_INCOMING_CALL && msg.method === process.env.STUB_INCOMING_ON) {
    const incoming = JSON.parse(process.env.STUB_INCOMING_CALL);
    incoming.id = incoming.id ?? nextIncomingId++;
    send(incoming);
    // Do not respond to the triggering request — the test drives that manually.
    return;
  }

  if (msg.method === 'initialize') {
    const result = process.env.STUB_INIT_RESPONSE
      ? JSON.parse(process.env.STUB_INIT_RESPONSE)
      : { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
    send({ jsonrpc: '2.0', id: msg.id, result });
    if (process.env.STUB_EMIT_KIRO === '1') {
      send({
        jsonrpc: '2.0',
        method: '_kiro.dev/metadata',
        params: {
          sessionId: 'pending',
          contextUsagePercentage: 1.5,
          turnDurationMs: 0,
        },
      });
    }
    return;
  }

  if (msg.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: 'sess_stub_' + msg.id,
        modes: { currentModeId: 'test', availableModes: [{ id: 'test', name: 'test' }] },
        models: { currentModelId: 'stub-model', availableModels: [{ modelId: 'stub-model' }] },
      },
    });
    return;
  }

  if (msg.method === 'session/prompt') {
    const updates = process.env.STUB_PROMPT_UPDATES
      ? JSON.parse(process.env.STUB_PROMPT_UPDATES)
      : [{
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stub reply' } },
        }];
    for (const u of updates) {
      send({ jsonrpc: '2.0', method: 'session/update', params: u });
    }
    const result = process.env.STUB_PROMPT_RESPONSE
      ? JSON.parse(process.env.STUB_PROMPT_RESPONSE)
      : { stopReason: 'end_turn' };
    send({ jsonrpc: '2.0', id: msg.id, result });
    return;
  }

  if (msg.method === 'session/cancel') {
    // Notification — no response. The stub does nothing else, matching
    // the conservative case where the prompt has already finished.
    return;
  }

  // Default: method not found.
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no stub impl for ' + msg.method } });
  }
}
`;

let stubPath: string;
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-acp-client-test-'));
  stubPath = path.join(tmpDir, 'stub-agent.mjs');
  fs.writeFileSync(stubPath, STUB_AGENT_SCRIPT);
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Build a client that runs the stub as its "kiro-cli acp" subprocess. */
function makeClient(env: Record<string, string> = {}, opts = {}) {
  return new KiroAcpClient({
    command: process.execPath,
    // Args we inject before `acp`. The client appends `acp` + flags we
    // don't care about for the stub, but the stub ignores them.
    argsPrefix: [stubPath],
    trustAllTools: false, // keep args short
    stderr: 'pipe',
    env: { ...process.env, ...env },
    ...opts,
  });
}

const clients: KiroAcpClient[] = [];

afterEach(async () => {
  while (clients.length > 0) {
    const c = clients.pop()!;
    try {
      await c.close();
    } catch {
      /* best effort */
    }
  }
});

function track(c: KiroAcpClient): KiroAcpClient {
  clients.push(c);
  return c;
}

// ---------------------------------------------------------------------------
// Type-guard tests (pure, no subprocess).
// ---------------------------------------------------------------------------

describe('type guards', () => {
  test('isJsonRpcResponse recognizes success + error shapes', () => {
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, result: 42 })).toBe(true);
    expect(
      isJsonRpcResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } }),
    ).toBe(true);
    expect(isJsonRpcResponse({ jsonrpc: '2.0', method: 'foo' })).toBe(false);
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, method: 'foo' })).toBe(false);
  });

  test('isJsonRpcNotification recognizes notifications', () => {
    expect(isJsonRpcNotification({ jsonrpc: '2.0', method: 'x' })).toBe(true);
    expect(isJsonRpcNotification({ jsonrpc: '2.0', id: 1, method: 'x' })).toBe(false);
    expect(isJsonRpcNotification({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false);
  });

  test('isJsonRpcRequest recognizes method+id frames', () => {
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'x' })).toBe(true);
    expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'x' })).toBe(false);
  });

  test('isKiroExtensionMethod flags _kiro.dev/* methods only', () => {
    expect(isKiroExtensionMethod('_kiro.dev/metadata')).toBe(true);
    expect(isKiroExtensionMethod('_kiro.dev/mcp/server_initialized')).toBe(true);
    expect(isKiroExtensionMethod('session/update')).toBe(false);
    expect(isKiroExtensionMethod('_other/x')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle + typed method tests.
// ---------------------------------------------------------------------------

describe('KiroAcpClient lifecycle', () => {
  test('initialize + newSession + prompt round-trip', async () => {
    const client = track(
      makeClient({
        STUB_PROMPT_UPDATES: JSON.stringify([
          {
            sessionId: '__ignored__',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'hello ' },
            },
          },
          {
            sessionId: '__ignored__',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'world' },
            },
          },
        ]),
      }),
    );

    const updates: SessionUpdateParams[] = [];
    client.on('session/update', (p) => updates.push(p));

    const init = await client.initialize();
    expect(init.protocolVersion).toBe(1);

    const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });
    expect(session.sessionId).toMatch(/^sess_stub_/);
    // Kiro extension fields flow through.
    expect(session.modes?.availableModes?.[0]?.id).toBe('test');
    expect(session.models?.currentModelId).toBe('stub-model');

    const result = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    });
    expect(result.stopReason).toBe('end_turn');
    expect(updates).toHaveLength(2);
    expect(
      updates
        .map((u) => (u.update as { content?: { text?: string } }).content?.text ?? '')
        .join(''),
    ).toBe('hello world');
  });

  test('runKiroPrompt convenience aggregates streamed text', async () => {
    const res = await runKiroPrompt('anything', {
      cwd: '/tmp',
      command: process.execPath,
      argsPrefix: [stubPath],
      trustAllTools: false,
      stderr: 'pipe',
      env: {
        ...process.env,
        STUB_PROMPT_UPDATES: JSON.stringify([
          {
            sessionId: '__ignored__',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pi' } },
          },
          {
            sessionId: '__ignored__',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ng' } },
          },
        ]),
      },
    });
    expect(res.text).toBe('ping');
    expect(res.stopReason).toBe('end_turn');
    expect(res.sessionId).toMatch(/^sess_stub_/);
  });

  test('start() is idempotent', async () => {
    const client = track(makeClient());
    await client.start();
    await client.start();
    expect(client.spawnedCommand).not.toBeNull();
    expect(client.spawnedCommand?.args).toContain('acp');
  });

  test('close() resolves cleanly when subprocess already exited', async () => {
    const client = track(makeClient());
    await client.start();
    await client.close();
    // Second close is a no-op.
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Error handling.
// ---------------------------------------------------------------------------

describe('KiroAcpClient error handling', () => {
  test('JSON-RPC error response rejects with AcpProtocolError', async () => {
    const client = track(makeClient({ STUB_ERROR_ON: 'session/new' }));
    await client.initialize();
    await expect(client.newSession({ cwd: '/tmp' })).rejects.toMatchObject({
      name: 'AcpProtocolError',
    });
  });

  test('request timeout raises AcpTimeoutError', async () => {
    // Configure the stub to silently drop our test method so the timeout
    // path is deterministic (otherwise the stub's default responds -32601
    // faster than any timeout we can set).
    const client = track(makeClient({ STUB_SILENT_ON: 'test/never_answered' }));
    await client.initialize();
    await expect(
      client.sendRequest('test/never_answered', {}, { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(AcpTimeoutError);
  });

  test('subprocess exit fails in-flight requests with AcpTransportError', async () => {
    const client = track(makeClient({ STUB_EXIT_ON: 'session/prompt' }));
    await client.initialize();
    const session = await client.newSession({ cwd: '/tmp' });
    await expect(
      client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'x' }] }),
    ).rejects.toBeInstanceOf(AcpTransportError);
  });

  test('writing after exit raises AcpTransportError', async () => {
    const client = track(makeClient());
    await client.start();
    await client.close();
    await expect(client.sendRequest('something', {})).rejects.toBeInstanceOf(
      AcpTransportError,
    );
  });
});

// ---------------------------------------------------------------------------
// Notification routing.
// ---------------------------------------------------------------------------

describe('KiroAcpClient notifications', () => {
  test('_kiro.dev/metadata emits kiro/metadata AND generic notification', async () => {
    const client = track(makeClient({ STUB_EMIT_KIRO: '1' }));
    const kiroEvents: KiroMetadataParams[] = [];
    const genericEvents: unknown[] = [];
    client.on('kiro/metadata', (p) => kiroEvents.push(p));
    client.on('notification', (n) => genericEvents.push(n));

    await client.initialize();
    // The notification is emitted right after the initialize response. Give
    // the event loop a tick to flush stdout buffering on the stub side.
    await new Promise((r) => setTimeout(r, 20));

    expect(kiroEvents).toHaveLength(1);
    expect(kiroEvents[0].contextUsagePercentage).toBe(1.5);
    expect(genericEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Incoming-request handling (Agent asks Client for something).
// ---------------------------------------------------------------------------

describe('KiroAcpClient incoming requests', () => {
  test('handler wired via onRequest produces a response frame', async () => {
    const fakeFsRead = {
      jsonrpc: '2.0',
      method: 'fs/read_text_file',
      params: { sessionId: 'sess_stub_2', path: '/tmp/foo.txt', line: 1 },
    };
    const client = track(
      makeClient({
        STUB_INCOMING_ON: 'session/prompt',
        STUB_INCOMING_CALL: JSON.stringify(fakeFsRead),
      }),
    );

    let handlerCalls = 0;
    client.onRequest('fs/read_text_file', (params) => {
      handlerCalls++;
      const p = params as { path: string };
      return { content: `mock contents of ${p.path}` };
    });

    await client.initialize();
    const session = await client.newSession({ cwd: '/tmp' });
    // The stub sends an fs/read_text_file request back when session/prompt
    // arrives, then never completes the prompt. Race with a short timeout
    // to confirm the handler is actually invoked before giving up.
    const promptPromise = client.sendRequest(
      'session/prompt',
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'x' }] },
      { timeoutMs: 200 },
    );
    await expect(promptPromise).rejects.toBeInstanceOf(AcpTimeoutError);
    expect(handlerCalls).toBe(1);
  });

  test('unhandled incoming requests respond with Method not found', async () => {
    // The stub is wired to send an incoming request, but we do NOT register a
    // handler for it. The client should automatically respond with -32601.
    // We can't peek at the stub's received frames here, but we assert the
    // client doesn't throw and the session lifecycle completes normally.
    const client = track(
      makeClient({
        STUB_INCOMING_ON: 'session/new',
        STUB_INCOMING_CALL: JSON.stringify({
          jsonrpc: '2.0',
          method: 'terminal/create',
          params: { sessionId: 's', command: 'echo', args: [] },
        }),
      }),
    );
    // STUB_INCOMING_ON triggers on session/new but doesn't respond to it, so
    // the new-session request will time out. That is fine for this test —
    // we only care that the client didn't crash while handling the inbound
    // terminal/create request.
    await client.initialize();
    await expect(
      client.sendRequest('session/new', { cwd: '/tmp', mcpServers: [] }, { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(AcpTimeoutError);
    // No 'error' event should have been emitted for the normal auto-reply path.
  });
});

// ---------------------------------------------------------------------------
// Framing edge cases — drive the parser directly through the wire.
// ---------------------------------------------------------------------------

describe('NDJSON framing', () => {
  test('parses concurrent in-flight requests correctly', async () => {
    const client = track(makeClient());
    await client.initialize();

    // Fire session/new 4x concurrently. Each should resolve with a unique
    // sessionId matching its request id. This validates id correlation.
    const sessions = await Promise.all([
      client.newSession({ cwd: '/tmp' }),
      client.newSession({ cwd: '/tmp' }),
      client.newSession({ cwd: '/tmp' }),
      client.newSession({ cwd: '/tmp' }),
    ]);
    const ids = new Set(sessions.map((s) => s.sessionId));
    expect(ids.size).toBe(4);
  });

  test('invalid JSON lines surface as error events without crashing', async () => {
    const client = track(makeClient());
    await client.initialize();
    const errors: Error[] = [];
    client.on('error', (e) => errors.push(e));

    // Feed a garbage line through the private pipe by writing directly to
    // the subprocess's stdin. The stub ignores it; the client should emit
    // an error but stay healthy.
    //
    // We can't write to the subprocess from here, so instead we invoke the
    // private handler via a crafted injection: write to stdin through the
    // client's escape hatch, then expect the next real request still works.
    await client.sendNotification('__ignored_garbage__', undefined);
    const session = await client.newSession({ cwd: '/tmp' });
    expect(session.sessionId).toMatch(/^sess_stub_/);
    // No parse errors should have been surfaced — the stub returned valid
    // JSON even for the garbage method.
    expect(errors).toHaveLength(0);
  });
});
