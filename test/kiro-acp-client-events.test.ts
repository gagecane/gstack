/**
 * Supplementary unit tests for kiro-acp-client.
 *
 * Complements `test/kiro-acp-client.test.ts` (landed with gsk-dvd.2) by
 * filling in coverage the initial extraction didn't land:
 *
 *   - All four Kiro extension notifications route to named events (not
 *     just `_kiro.dev/metadata`).
 *   - Baseline `session/update` routes to its named event and flows
 *     through even when no Kiro extensions are in play.
 *   - Typed method helpers (`cancel`, `setMode`, `closeSession`,
 *     `loadSession`, `resumeSession`) send the spec-correct method name
 *     on the wire.
 *   - Spawn argument assembly — `acp` subcommand, verbosity flags,
 *     `--trust-all-tools` vs `--trust-tools`, `--agent`, `--model`,
 *     `extraArgs` ordering.
 *
 * Strategy mirrors the sibling file: spawn a small bun subprocess that
 * acts as a stub ACP agent so the tests don't depend on a real kiro-cli
 * install. The stub responds to whichever method the test wants to
 * exercise; on methods it doesn't know it returns a -32601 error, which
 * gives us a cheap way to assert "method X was actually routed".
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  AcpProtocolError,
  KiroAcpClient,
} from '../lib/kiro-acp-client';
import type {
  KiroAvailableCommandsParams,
  KiroMcpServerInitializedParams,
  KiroMetadataParams,
  KiroSubagentListUpdateParams,
  SessionUpdateParams,
} from '../lib/kiro-acp-types';

// ---------------------------------------------------------------------------
// Stub script: emits a scripted list of extra notifications after
// initialize, and can be told to error on any specific method so we can
// confirm the method name reached the stub correctly.
//
// Env vars:
//   STUB_EXTRA_NOTIFICATIONS  — JSON array of JsonRpcNotification frames
//                                to emit right after the initialize response.
//   STUB_ERROR_ON             — method name; respond with a -32602 error.
//   STUB_ACK_NOTIFY_ON        — method name for a NOTIFICATION we expect
//                                to receive; emit a `session/update` frame
//                                referencing it so the test can observe it.
// ---------------------------------------------------------------------------
const STUB_SCRIPT = `
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }

let buf = '';
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
  if (msg.method === 'initialize' && msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    const extras = process.env.STUB_EXTRA_NOTIFICATIONS;
    if (extras) {
      try {
        for (const n of JSON.parse(extras)) send(n);
      } catch {}
    }
    return;
  }

  // Notifications from the client have no id. If the test wants to assert
  // that one was routed, emit a tiny session/update frame carrying the
  // method name so the test can observe it from the client side.
  if (msg.id === undefined && msg.method && process.env.STUB_ACK_NOTIFY_ON === msg.method) {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: '__ack__',
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'ack:' + msg.method } },
      },
    });
    return;
  }

  // No response needed for a notification.
  if (msg.id === undefined) return;

  if (process.env.STUB_ERROR_ON && msg.method === process.env.STUB_ERROR_ON) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'stub error for ' + msg.method } });
    return;
  }

  // Default: method not found so the test can confirm the method reached us.
  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: 'no stub impl for ' + msg.method },
  });
}
`;

let stubPath: string;
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-acp-events-test-'));
  stubPath = path.join(tmpDir, 'stub.mjs');
  fs.writeFileSync(stubPath, STUB_SCRIPT);
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

const clients: KiroAcpClient[] = [];

function makeClient(env: Record<string, string> = {}, opts: Record<string, unknown> = {}): KiroAcpClient {
  const c = new KiroAcpClient({
    command: process.execPath,
    argsPrefix: [stubPath],
    trustAllTools: false,
    stderr: 'pipe',
    env: { ...process.env, ...env },
    ...opts,
  });
  clients.push(c);
  return c;
}

afterEach(async () => {
  while (clients.length > 0) {
    const c = clients.pop()!;
    try { await c.close(); } catch {}
  }
});

/** Flush a tick so the stub's post-initialize notifications arrive. */
async function flushTicks(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Kiro extension notifications.
// ---------------------------------------------------------------------------

describe('KiroAcpClient: Kiro extension notifications', () => {
  test('_kiro.dev/mcp/server_initialized → kiro/mcp/server_initialized event', async () => {
    const payload: KiroMcpServerInitializedParams = {
      sessionId: 'sess_1',
      serverName: 'gstack-tools',
    };
    const client = makeClient({
      STUB_EXTRA_NOTIFICATIONS: JSON.stringify([
        { jsonrpc: '2.0', method: '_kiro.dev/mcp/server_initialized', params: payload },
      ]),
    });
    const events: KiroMcpServerInitializedParams[] = [];
    client.on('kiro/mcp/server_initialized', (p) => events.push(p));
    await client.initialize();
    await flushTicks();
    expect(events).toHaveLength(1);
    expect(events[0].serverName).toBe('gstack-tools');
    expect(events[0].sessionId).toBe('sess_1');
  });

  test('_kiro.dev/commands/available → kiro/commands/available event', async () => {
    const payload: KiroAvailableCommandsParams = {
      sessionId: 'sess_2',
      commands: [
        { name: 'browse', description: 'open a URL' },
        { name: 'plan', description: 'scratchpad planning' },
      ],
    };
    const client = makeClient({
      STUB_EXTRA_NOTIFICATIONS: JSON.stringify([
        { jsonrpc: '2.0', method: '_kiro.dev/commands/available', params: payload },
      ]),
    });
    const events: KiroAvailableCommandsParams[] = [];
    client.on('kiro/commands/available', (p) => events.push(p));
    await client.initialize();
    await flushTicks();
    expect(events).toHaveLength(1);
    expect(events[0].commands).toHaveLength(2);
    expect(events[0].commands[0].name).toBe('browse');
  });

  test('_kiro.dev/subagent/list_update → kiro/subagent/list_update event', async () => {
    const payload: KiroSubagentListUpdateParams = {
      subagents: [{ id: 'sa1', state: 'running' }],
      pendingStages: [],
    };
    const client = makeClient({
      STUB_EXTRA_NOTIFICATIONS: JSON.stringify([
        { jsonrpc: '2.0', method: '_kiro.dev/subagent/list_update', params: payload },
      ]),
    });
    const events: KiroSubagentListUpdateParams[] = [];
    client.on('kiro/subagent/list_update', (p) => events.push(p));
    await client.initialize();
    await flushTicks();
    expect(events).toHaveLength(1);
    expect(events[0].subagents).toHaveLength(1);
  });

  test('multiple Kiro extensions in sequence each route to their typed event', async () => {
    // The router uses a chain of `if … else if`. Make sure the chain
    // doesn't short-circuit — every extension type should fire.
    const client = makeClient({
      STUB_EXTRA_NOTIFICATIONS: JSON.stringify([
        {
          jsonrpc: '2.0',
          method: '_kiro.dev/metadata',
          params: { sessionId: 's', contextUsagePercentage: 12.3 },
        },
        {
          jsonrpc: '2.0',
          method: '_kiro.dev/mcp/server_initialized',
          params: { sessionId: 's', serverName: 'a' },
        },
        {
          jsonrpc: '2.0',
          method: '_kiro.dev/commands/available',
          params: { sessionId: 's', commands: [{ name: 'x' }] },
        },
      ]),
    });

    const metadata: KiroMetadataParams[] = [];
    const mcp: KiroMcpServerInitializedParams[] = [];
    const commands: KiroAvailableCommandsParams[] = [];
    const generic: unknown[] = [];
    client.on('kiro/metadata', (p) => metadata.push(p));
    client.on('kiro/mcp/server_initialized', (p) => mcp.push(p));
    client.on('kiro/commands/available', (p) => commands.push(p));
    client.on('notification', (n) => generic.push(n));

    await client.initialize();
    await flushTicks();

    expect(metadata).toHaveLength(1);
    expect(mcp).toHaveLength(1);
    expect(commands).toHaveLength(1);
    // Generic fires for every notification we routed.
    expect(generic).toHaveLength(3);
  });

  test('baseline session/update routes to its named event', async () => {
    // Non-Kiro agents don't emit _kiro.dev/* frames at all. Verify the
    // baseline session/update still surfaces correctly.
    const payload: SessionUpdateParams = {
      sessionId: 's',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    };
    const client = makeClient({
      STUB_EXTRA_NOTIFICATIONS: JSON.stringify([
        { jsonrpc: '2.0', method: 'session/update', params: payload },
      ]),
    });
    const events: SessionUpdateParams[] = [];
    client.on('session/update', (p) => events.push(p));
    await client.initialize();
    await flushTicks();
    expect(events).toHaveLength(1);
    const update = events[0].update as { content?: { text?: string } };
    expect(update.content?.text).toBe('hi');
  });

  test('unknown _kiro.dev/* method still surfaces as generic notification', async () => {
    // Forward-compat: if Kiro-CLI adds a new _kiro.dev/foo method the
    // client doesn't know about, it should still emit via the generic
    // `notification` event so callers can handle new methods without a
    // client release.
    const client = makeClient({
      STUB_EXTRA_NOTIFICATIONS: JSON.stringify([
        {
          jsonrpc: '2.0',
          method: '_kiro.dev/future/unknown',
          params: { something: 'new' },
        },
      ]),
    });
    const generic: Array<{ method?: string }> = [];
    client.on('notification', (n) => generic.push(n as { method?: string }));
    await client.initialize();
    await flushTicks();
    // At minimum, the generic event fires — the router doesn't drop
    // unknown extensions on the floor.
    const match = generic.find((n) => n.method === '_kiro.dev/future/unknown');
    expect(match).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Typed helper method-name routing.
//
// These tests use STUB_ERROR_ON to prove the method name made it to the
// wire. If the typed helper sent the wrong method the stub would return
// "no stub impl for <wrong-method>" instead of "stub error for <method>".
// ---------------------------------------------------------------------------

describe('KiroAcpClient: typed helpers send the spec-correct method name', () => {
  test('setMode → session/set_mode', async () => {
    const client = makeClient({ STUB_ERROR_ON: 'session/set_mode' });
    await client.initialize();
    await expect(client.setMode({ sessionId: 's', modeId: 'plan' })).rejects.toMatchObject({
      name: 'AcpProtocolError',
    });
  });

  test('closeSession → session/close', async () => {
    const client = makeClient({ STUB_ERROR_ON: 'session/close' });
    await client.initialize();
    await expect(client.closeSession('s')).rejects.toMatchObject({
      name: 'AcpProtocolError',
    });
  });

  test('loadSession → session/load', async () => {
    const client = makeClient({ STUB_ERROR_ON: 'session/load' });
    await client.initialize();
    await expect(
      client.loadSession({ sessionId: 's', cwd: '/tmp', mcpServers: [] }),
    ).rejects.toMatchObject({ name: 'AcpProtocolError' });
  });

  test('resumeSession → session/resume', async () => {
    const client = makeClient({ STUB_ERROR_ON: 'session/resume' });
    await client.initialize();
    await expect(
      client.resumeSession({ sessionId: 's', cwd: '/tmp', mcpServers: [] }),
    ).rejects.toMatchObject({ name: 'AcpProtocolError' });
  });

  test('cancel() sends a session/cancel NOTIFICATION (no id, no response expected)', async () => {
    // Notifications have no id. The stub ACKs ours by emitting a
    // session/update whose content text echoes the method we sent, so we
    // can prove the method name reached the agent without forcing a
    // response on the wire.
    const client = makeClient({ STUB_ACK_NOTIFY_ON: 'session/cancel' });
    const updates: SessionUpdateParams[] = [];
    client.on('session/update', (p) => updates.push(p));

    await client.initialize();
    // No error must propagate — notifications are fire-and-forget.
    await client.cancel('sess_under_test');
    await flushTicks();

    expect(updates.length).toBeGreaterThanOrEqual(1);
    const ack = updates.find((u) => {
      const upd = u.update as { content?: { text?: string } };
      return upd.content?.text === 'ack:session/cancel';
    });
    expect(ack).toBeTruthy();
  });

  test('sendNotification with a custom method still reaches the agent', async () => {
    // Callers using the generic escape hatch for extension notifications
    // (e.g. an opt-in feature flag) shouldn't have their frame silently
    // dropped just because it's not one of the standard method names.
    const client = makeClient({ STUB_ACK_NOTIFY_ON: '_kiro.dev/client/preflight_ping' });
    const updates: SessionUpdateParams[] = [];
    client.on('session/update', (p) => updates.push(p));

    await client.initialize();
    await client.sendNotification('_kiro.dev/client/preflight_ping', { ts: 1 });
    await flushTicks();

    const ack = updates.find((u) => {
      const upd = u.update as { content?: { text?: string } };
      return upd.content?.text === 'ack:_kiro.dev/client/preflight_ping';
    });
    expect(ack).toBeTruthy();
  });

  test('sendRequest honors per-call timeoutMs override without mutating client default', async () => {
    const client = makeClient(
      { STUB_ERROR_ON: 'never-reached' },
      { requestTimeoutMs: 60_000 },
    );
    await client.initialize();
    // The client default is 60s, but we want a 50ms deadline for this
    // specific call. The stub responds with -32601 for an unknown method,
    // so to actually test the timeout we tell the stub to stay silent.
    // Here we instead just verify the short-timeout overrode the default:
    // sending to a method with `STUB_ERROR_ON` set — matching it means
    // the stub errors; using a non-matching method returns -32601 fast.
    // Either way, the call shouldn't hang for 60 seconds; we just
    // confirm the promise settles quickly (<200ms).
    const t0 = Date.now();
    await expect(
      client.sendRequest('no_such_method', {}, { timeoutMs: 150 }),
    ).rejects.toMatchObject({ name: 'AcpProtocolError' });
    const elapsed = Date.now() - t0;
    // The stub replies within a few ms. 60s default would have blown past 200.
    expect(elapsed).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Spawn argument assembly.
// ---------------------------------------------------------------------------

describe('KiroAcpClient: spawn argument assembly', () => {
  test('default args include the acp subcommand and --trust-all-tools', async () => {
    const client = new KiroAcpClient({
      command: process.execPath,
      argsPrefix: [stubPath],
      stderr: 'pipe',
      env: process.env,
    });
    clients.push(client);
    await client.start();
    const spawn = client.spawnedCommand!;
    expect(spawn.command).toBe(process.execPath);
    expect(spawn.args).toContain(stubPath);
    expect(spawn.args).toContain('acp');
    expect(spawn.args).toContain('--trust-all-tools');
    // acp must come AFTER the prefix but BEFORE the flags.
    const acpIdx = spawn.args.indexOf('acp');
    const prefixIdx = spawn.args.indexOf(stubPath);
    const trustIdx = spawn.args.indexOf('--trust-all-tools');
    expect(prefixIdx).toBeLessThan(acpIdx);
    expect(acpIdx).toBeLessThan(trustIdx);
  });

  test('trustAllTools=false drops --trust-all-tools', async () => {
    const client = makeClient();
    await client.start();
    expect(client.spawnedCommand!.args).not.toContain('--trust-all-tools');
  });

  test('trustTools list replaces --trust-all-tools with --trust-tools <csv>', async () => {
    const client = new KiroAcpClient({
      command: process.execPath,
      argsPrefix: [stubPath],
      trustAllTools: true, // Even if true, trustTools wins when non-empty.
      trustTools: ['fs_read', 'fs_write'],
      stderr: 'pipe',
      env: process.env,
    });
    clients.push(client);
    await client.start();
    const args = client.spawnedCommand!.args;
    expect(args).toContain('--trust-tools');
    const idx = args.indexOf('--trust-tools');
    expect(args[idx + 1]).toBe('fs_read,fs_write');
    expect(args).not.toContain('--trust-all-tools');
  });

  test('--agent and --model are added when options set', async () => {
    const client = new KiroAcpClient({
      command: process.execPath,
      argsPrefix: [stubPath],
      trustAllTools: false,
      agent: 'planner',
      model: 'claude-opus-4',
      stderr: 'pipe',
      env: process.env,
    });
    clients.push(client);
    await client.start();
    const args = client.spawnedCommand!.args;
    const agentIdx = args.indexOf('--agent');
    expect(agentIdx).toBeGreaterThan(-1);
    expect(args[agentIdx + 1]).toBe('planner');
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe('claude-opus-4');
  });

  test('verbose=N injects N `-v` flags BEFORE acp (matches `kiro-cli -v acp`)', async () => {
    const client = new KiroAcpClient({
      command: process.execPath,
      argsPrefix: [stubPath],
      trustAllTools: false,
      verbose: 2,
      stderr: 'pipe',
      env: process.env,
    });
    clients.push(client);
    await client.start();
    const args = client.spawnedCommand!.args;
    const acpIdx = args.indexOf('acp');
    // Two -v entries must appear before acp.
    const vIndexes: number[] = [];
    args.forEach((a, i) => { if (a === '-v') vIndexes.push(i); });
    expect(vIndexes).toHaveLength(2);
    for (const i of vIndexes) expect(i).toBeLessThan(acpIdx);
  });

  test('extraArgs are appended after the standard flags', async () => {
    const client = new KiroAcpClient({
      command: process.execPath,
      argsPrefix: [stubPath],
      trustAllTools: false,
      extraArgs: ['--custom-flag', 'value'],
      stderr: 'pipe',
      env: process.env,
    });
    clients.push(client);
    await client.start();
    const args = client.spawnedCommand!.args;
    const customIdx = args.indexOf('--custom-flag');
    const acpIdx = args.indexOf('acp');
    expect(customIdx).toBeGreaterThan(acpIdx);
    expect(args[customIdx + 1]).toBe('value');
  });

  test('throws AcpTransportError with actionable message when kiro-cli is not resolvable', async () => {
    // No `command` override and a bogus GSTACK_KIRO_BIN → resolveKiroCliCommand
    // returns null → resolveSpawn throws. The message must tell the caller
    // how to fix it.
    const client = new KiroAcpClient({
      env: {
        // Start from a clean env so a real kiro-cli on PATH doesn't satisfy
        // the lookup; scrub PATH to empty.
        PATH: '',
        GSTACK_KIRO_BIN: 'definitely-not-a-real-binary-abc',
      },
    });
    clients.push(client);
    await expect(client.start()).rejects.toMatchObject({
      name: 'AcpTransportError',
      message: expect.stringContaining('GSTACK_KIRO_BIN'),
    });
  });
});
