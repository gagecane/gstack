/**
 * Unit tests for `lib/kiro-acp-client.ts`.
 *
 * Exercises the client against a tiny fake ACP agent (test/fixtures/fake-acp-agent.ts)
 * driven via `FAKE_ACP_MODE` so we can cover the full protocol surface without
 * a live `kiro-cli` binary:
 *   - call/response happy path with buffered notifications
 *   - JSON-RPC error surfaced as thrown Error
 *   - agent→client request dispatched to a registered handler
 *   - unregistered agent→client method responds with -32601
 *   - notifications() async iterator yields across arrival timing
 *   - call() timeout after `callTimeoutMs`
 *   - child exit rejects pending calls with a useful error
 *   - close() is idempotent and safe after exit
 *
 * Runs in free `bun test` — no network, no paid calls.
 */

import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import {
  AcpClient,
  resolveKiroCliBinary,
  type JsonRpcNotification,
} from '../lib/kiro-acp-client';

const FAKE_AGENT = path.resolve(__dirname, 'fixtures', 'fake-acp-agent.ts');

/** Build an AcpClient that spawns `bun run <fake-agent>` with a given mode. */
function makeClient(
  mode: string,
  opts: { callTimeoutMs?: number; closeTimeoutMs?: number } = {},
): AcpClient {
  const bunBin = process.execPath; // the bun we're running in
  return new AcpClient({
    binary: bunBin,
    spawnArgs: ['run', FAKE_AGENT],
    env: { ...process.env, FAKE_ACP_MODE: mode },
    callTimeoutMs: opts.callTimeoutMs,
    closeTimeoutMs: opts.closeTimeoutMs,
  });
}

describe('AcpClient — happy path', () => {
  test('call() returns the echoed result and drainNotifications() captures the stream', async () => {
    const client = makeClient('echo');
    try {
      const result = (await client.call('session/prompt', { hello: 'world' })) as {
        echoed: unknown;
      };
      expect(result).toEqual({ echoed: { hello: 'world' } });

      // Give the stream a tick to land the notification we know came first.
      await new Promise((r) => setTimeout(r, 20));
      const notifs = client.drainNotifications();
      expect(notifs.length).toBeGreaterThanOrEqual(1);
      const update = notifs.find((n) => n.method === 'session/update');
      expect(update).toBeDefined();
      expect((update!.params as { from: string; payload: { hello: string } }).from).toBe(
        'session/prompt',
      );
    } finally {
      await client.close();
    }
  });

  test('multiple concurrent calls resolve independently by id', async () => {
    const client = makeClient('echo');
    try {
      const [a, b, c] = await Promise.all([
        client.call('a', { i: 1 }),
        client.call('b', { i: 2 }),
        client.call('c', { i: 3 }),
      ]);
      expect((a as { echoed: { i: number } }).echoed.i).toBe(1);
      expect((b as { echoed: { i: number } }).echoed.i).toBe(2);
      expect((c as { echoed: { i: number } }).echoed.i).toBe(3);
    } finally {
      await client.close();
    }
  });
});

describe('AcpClient — errors', () => {
  test('JSON-RPC error responses are thrown as Error with code + message', async () => {
    const client = makeClient('error');
    try {
      let thrown: Error | null = null;
      try {
        await client.call('anything', { x: 1 });
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).not.toBeNull();
      expect(thrown!.message).toContain('ACP error');
      expect(thrown!.message).toContain('-32000');
      expect(thrown!.message).toContain('boom');
    } finally {
      await client.close();
    }
  });

  test('call() rejects with timeout error after callTimeoutMs', async () => {
    const client = makeClient('hang', { callTimeoutMs: 150 });
    try {
      let thrown: Error | null = null;
      try {
        await client.call('initialize', {});
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).not.toBeNull();
      expect(thrown!.message).toContain('timed out');
      expect(thrown!.message).toContain('initialize');
    } finally {
      await client.close();
    }
  });

  test('pending calls reject when the child exits unexpectedly', async () => {
    const client = makeClient('exit_immediately');
    let thrown: Error | null = null;
    try {
      await client.call('initialize', {});
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    // Either "exited" message from our exit handler, or the child's exit surfaced
    // via the spawn pipeline. Both are acceptable — we just need a useful error.
    expect(thrown!.message.length).toBeGreaterThan(0);
    await client.close(); // should be a no-op, not throw
  });
});

describe('AcpClient — agent→client RPCs', () => {
  test('registered handler responds to server_request and flows result back', async () => {
    const client = makeClient('server_request');
    try {
      const observed: Array<{ id: number; params: unknown }> = [];
      client.onRequest('session/request_permission', (params) => {
        observed.push({ id: 0, params });
        return {
          outcome: { outcome: 'selected', optionId: 'allow_once' },
        };
      });

      const result = (await client.call('session/prompt', { hi: true })) as { ok: boolean };
      expect(result).toEqual({ ok: true });

      // The fake agent echoes our response back as a test/echo_client_response
      // notification so we can assert the payload crossed the boundary.
      await new Promise((r) => setTimeout(r, 30));
      const notifs = client.drainNotifications();
      const echo = notifs.find((n) => n.method === 'test/echo_client_response');
      expect(echo).toBeDefined();
      const echoParams = echo!.params as {
        id: number;
        result?: { outcome: { outcome: string; optionId: string } };
      };
      expect(echoParams.id).toBe(999);
      expect(echoParams.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow_once' },
      });

      // Our handler should have been invoked exactly once.
      expect(observed.length).toBe(1);
      expect((observed[0].params as { toolCallId: string }).toolCallId).toBe('abc');
    } finally {
      await client.close();
    }
  });

  test('unregistered agent→client method responds with -32601', async () => {
    const client = makeClient('server_request');
    try {
      // Deliberately DO NOT register session/request_permission.
      await client.call('session/prompt', {});

      await new Promise((r) => setTimeout(r, 30));
      const notifs = client.drainNotifications();
      const echo = notifs.find((n) => n.method === 'test/echo_client_response');
      expect(echo).toBeDefined();
      const echoParams = echo!.params as {
        id: number;
        error?: { code: number; message: string };
      };
      expect(echoParams.error).toBeDefined();
      expect(echoParams.error!.code).toBe(-32601);
      expect(echoParams.error!.message).toContain('session/request_permission');
    } finally {
      await client.close();
    }
  });
});

describe('AcpClient — notifications async iterator', () => {
  test('yields notifications as they arrive and terminates on exit', async () => {
    const client = makeClient('notifications_only');
    // Don't await a call — this mode never responds. Start the iterator instead.
    const iter = client.notifications();
    const collected: JsonRpcNotification[] = [];

    // Kick the agent by sending a "request" we won't await.
    client.call('kick', {}).catch(() => {
      // will reject when we close — that's fine
    });

    // Collect the 3 scripted notifications.
    for (let i = 0; i < 3; i++) {
      const next = await iter.next();
      if (next.done) break;
      collected.push(next.value);
    }
    expect(collected.length).toBe(3);
    expect((collected[0].params as { n: number }).n).toBe(1);
    expect((collected[2].params as { n: number }).n).toBe(3);

    await client.close();
  });
});

describe('AcpClient — close() semantics', () => {
  test('close() is idempotent', async () => {
    const client = makeClient('echo');
    await client.call('anything', {});
    await client.close();
    await client.close(); // second call should be a cheap no-op
    expect(client.hasExited).toBe(true);
  });
});

describe('resolveKiroCliBinary', () => {
  test('honors GSTACK_KIRO_CLI_BIN absolute path override', () => {
    const abs = process.execPath; // guaranteed to exist
    const got = resolveKiroCliBinary({ GSTACK_KIRO_CLI_BIN: abs, PATH: '' });
    expect(got).toBe(abs);
  });

  test('honors GSTACK_KIRO_CLI_BIN as PATH-resolvable name', () => {
    // bun is on PATH in our test env
    const got = resolveKiroCliBinary({
      GSTACK_KIRO_CLI_BIN: 'bun',
      PATH: process.env.PATH ?? '',
    });
    expect(got).toBeTruthy();
    expect(got!.endsWith('bun') || got!.endsWith('bun.exe')).toBe(true);
  });

  test('falls back to Bun.which("kiro-cli") when no override', () => {
    // We cannot assume kiro-cli is installed in the test environment, so this
    // just asserts the function returns either a string path or null — never
    // throws, never returns undefined.
    const got = resolveKiroCliBinary({ PATH: process.env.PATH ?? '' });
    if (got !== null) {
      expect(typeof got).toBe('string');
      expect(got.length).toBeGreaterThan(0);
    } else {
      expect(got).toBeNull();
    }
  });

  test('returns null when override points at a non-existent bare command', () => {
    const got = resolveKiroCliBinary({
      GSTACK_KIRO_CLI_BIN: 'definitely-not-a-real-binary-xyz123',
      PATH: '/nonexistent',
    });
    expect(got).toBeNull();
  });
});
