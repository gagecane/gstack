#!/usr/bin/env bun
/**
 * Fake ACP agent for unit testing `lib/kiro-acp-client.ts`.
 *
 * Speaks just enough JSON-RPC 2.0 over stdin/stdout to exercise the client's
 * request/response, notification streaming, agent→client handler, and
 * timeout/shutdown paths. Behavior is driven by an env var so individual
 * test cases can pick a scenario without separate fixture files.
 *
 * Scenarios (env `FAKE_ACP_MODE`):
 *   - "echo" (default): respond to every request with `{echoed: params}`,
 *     emit one `session/update` notification beforehand.
 *   - "notifications_only": never respond, just emit 3 notifications then hold.
 *   - "error": respond with a JSON-RPC error `{code: -32000, message: "boom"}`.
 *   - "server_request": after the first client call, send an agent→client
 *     `session/request_permission` RPC and forward the client's response back
 *     as a notification so the test can assert on it.
 *   - "exit_immediately": close stdin + exit 0 without responding to anything.
 *   - "hang": never respond and never emit notifications — for timeout tests.
 *
 * Not part of the shipped product. Pulled in only by the test file.
 */

const mode = process.env.FAKE_ACP_MODE ?? 'echo';

let buf = '';
process.stdin.setEncoding('utf-8');

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

interface IncomingMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let idx: number;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(line) as IncomingMessage;
    } catch {
      continue;
    }
    handle(msg);
  }
});

process.stdin.on('end', () => {
  // exit cleanly
  process.exit(0);
});

function handle(msg: IncomingMessage): void {
  if (mode === 'hang') return;

  // Handle response to an agent→client request (scenario "server_request").
  if (msg.id !== undefined && !msg.method) {
    // Forward the client's response to a server_request back as a
    // notification so the test can assert on it.
    write({
      jsonrpc: '2.0',
      method: 'test/echo_client_response',
      params: { id: msg.id, result: msg.result, error: msg.error },
    });
    return;
  }

  if (msg.id === undefined) return; // ignore notifications from client

  if (mode === 'exit_immediately') {
    process.exit(0);
    return;
  }

  if (mode === 'notifications_only') {
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { n: 1 },
    });
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { n: 2 },
    });
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { n: 3 },
    });
    // Intentionally never respond — tests that use this mode should not
    // wait on client.call() completion.
    return;
  }

  if (mode === 'error') {
    write({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32000, message: 'boom' },
    });
    return;
  }

  if (mode === 'server_request') {
    // Emit a server→client request before our own response.
    write({
      jsonrpc: '2.0',
      id: 999,
      method: 'session/request_permission',
      params: { toolCallId: 'abc', title: 'write' },
    });
    // Respond to the client's call.
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: { ok: true },
    });
    return;
  }

  // "echo" (default): emit one notification, then respond with echoed params.
  write({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { from: msg.method, payload: msg.params },
  });
  write({
    jsonrpc: '2.0',
    id: msg.id,
    result: { echoed: msg.params },
  });
}
