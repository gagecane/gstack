/**
 * Type-level smoke test for lib/kiro-acp-types.ts.
 *
 * This file compiles and runs as a normal Bun test but its real purpose is to
 * exercise the exported types — it catches regressions where a union loses a
 * variant or a field is renamed. There are no runtime semantics under test;
 * the checks assert on narrowing and on literal-tag values that the wire
 * format MUST preserve.
 */

import { test, expect } from 'bun:test';

import type {
  AcpClientRequests,
  AcpAgentToClientRequests,
  ClientCapabilities,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  JsonRpcRequest,
  JsonRpcResponse,
  KiroAcpMethod,
  KiroMetadataNotification,
  KiroRequests,
  KiroSubagentStatus,
  NewSessionRequest,
  NewSessionResponse,
  PermissionOption,
  PermissionOptionKind,
  PromptRequest,
  PromptResponse,
  RequestPermissionOutcome,
  SessionUpdate,
  StopReason,
  TaggedNotification,
  ToolCall,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from './kiro-acp-types';

test('InitializeRequest shape matches the §2a live capture', () => {
  const req: InitializeRequest = {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: 'gstack-preflight', version: '0.0.1' },
  };
  expect(req.protocolVersion).toBe(1);
  expect(req.clientCapabilities?.fs?.readTextFile).toBe(false);
});

test('InitializeResponse captures agentInfo.version (sdkClaudeCodeVersion replacement)', () => {
  const resp: InitializeResponse = {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
      mcpCapabilities: { http: true, sse: false },
      sessionCapabilities: {},
    },
    agentInfo: { name: 'kiro-cli', version: '2.1.1' },
    authMethods: [{ type: 'agent', id: 'midway', name: 'Midway SSO' }],
  };
  expect(resp.agentInfo?.version).toBe('2.1.1');
  expect(resp.agentCapabilities?.loadSession).toBe(true);
});

test('NewSessionRequest + response include the fields the preflight consumes', () => {
  const req: NewSessionRequest = { cwd: '/tmp', mcpServers: [] };
  const resp: NewSessionResponse = {
    sessionId: 'd1cf288c-aaaa-bbbb-cccc-1234567890ab',
    modes: {
      currentModeId: 'gpu-dev',
      availableModes: [
        { id: 'gpu-dev', name: 'GPU Dev' },
        { id: 'gastown', name: 'Gas Town' },
      ],
    },
    configOptions: [
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: 'claude-haiku-4.5',
        options: [
          { value: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
          { value: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
        ],
      },
    ],
  };
  expect(req.cwd).toBe('/tmp');
  expect(resp.sessionId.length).toBeGreaterThan(0);
  expect(resp.modes?.currentModeId).toBe('gpu-dev');
});

test('PromptRequest accepts the four ContentBlock variants the design doc promises', () => {
  const blocks: ContentBlock[] = [
    { type: 'text', text: 'hi' },
    { type: 'image', data: 'base64==', mimeType: 'image/png' },
    { type: 'audio', data: 'base64==', mimeType: 'audio/mp3' },
    { type: 'resource_link', name: 'spec', uri: 'file:///tmp/spec.md' },
    {
      type: 'resource',
      resource: { uri: 'file:///tmp/x.md', text: '# hello' },
    },
  ];
  const req: PromptRequest = { sessionId: 's1', prompt: blocks };
  expect(req.prompt).toHaveLength(5);
});

test('PromptResponse.stopReason covers every wire value', () => {
  const reasons: StopReason[] = [
    'end_turn',
    'max_tokens',
    'max_turn_requests',
    'refusal',
    'cancelled',
  ];
  // Round-trip: each string must be assignable AS PromptResponse.stopReason.
  for (const r of reasons) {
    const resp: PromptResponse = { stopReason: r };
    expect(resp.stopReason).toBe(r);
  }
});

test('SessionUpdate union has every variant §1b lists', () => {
  // The point of this test: if any variant is deleted, these declarations
  // fail at compile time.
  const variants: SessionUpdate[] = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Write to file',
      kind: 'edit',
      status: 'in_progress',
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
    },
    {
      sessionUpdate: 'tool_call_chunk',
      toolCallId: 't1',
      delta: { input: { path: '/tmp/x' } },
    },
    {
      sessionUpdate: 'plan',
      entries: [{ content: 'do it', priority: 'high', status: 'pending' }],
    },
    {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: '/help', description: 'show help' }],
    },
    { sessionUpdate: 'current_mode_update', currentModeId: 'gastown' },
    { sessionUpdate: 'config_option_update', configOptions: [] },
    { sessionUpdate: 'session_info_update', title: 'my session' },
  ];
  expect(variants).toHaveLength(11);
});

test('SessionUpdate narrows correctly via the sessionUpdate discriminant', () => {
  const upd: SessionUpdate = {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hello' },
  };
  switch (upd.sessionUpdate) {
    case 'agent_message_chunk': {
      // Inside this branch, upd.content is a ContentBlock — no cast needed.
      if (upd.content.type === 'text') {
        expect(upd.content.text).toBe('hello');
      }
      break;
    }
    default:
      throw new Error('expected agent_message_chunk');
  }
});

test('ToolCallContent carries all three kinds (content, diff, terminal)', () => {
  const cs: ToolCallContent[] = [
    { type: 'content', content: { type: 'text', text: 'stdout' } },
    { type: 'diff', path: '/tmp/a.ts', newText: 'new', oldText: 'old' },
    { type: 'terminal', terminalId: 'term-1' },
  ];
  expect(cs[0].type).toBe('content');
  expect(cs[1].type).toBe('diff');
  expect(cs[2].type).toBe('terminal');
});

test('ToolKind and ToolCallStatus permit the documented values', () => {
  const kinds: ToolKind[] = [
    'read',
    'edit',
    'delete',
    'move',
    'search',
    'execute',
    'think',
    'fetch',
    'switch_mode',
    'other',
  ];
  const statuses: ToolCallStatus[] = ['pending', 'in_progress', 'completed', 'failed'];
  expect(kinds).toHaveLength(10);
  expect(statuses).toHaveLength(4);
});

test('RequestPermissionOutcome discriminates on outcome + the four kinds', () => {
  const allow: PermissionOption = {
    optionId: 'allow_once',
    name: 'Allow once',
    kind: 'allow_once',
  };
  const kinds: PermissionOptionKind[] = [
    'allow_once',
    'allow_always',
    'reject_once',
    'reject_always',
  ];
  const selected: RequestPermissionOutcome = { outcome: 'selected', optionId: 'allow_once' };
  const cancelled: RequestPermissionOutcome = { outcome: 'cancelled' };
  expect(allow.kind).toBe('allow_once');
  expect(kinds).toHaveLength(4);
  if (selected.outcome === 'selected') expect(selected.optionId).toBe('allow_once');
  if (cancelled.outcome === 'cancelled') expect(cancelled.outcome).toBe('cancelled');
});

test('KiroMetadataNotification replaces claude-agent-sdk total_cost_usd', () => {
  const n: KiroMetadataNotification = {
    sessionId: 's1',
    contextUsagePercentage: 25.019,
    turnDurationMs: 2096,
    meteringUsage: [{ value: 0.0633, unit: 'credit', unitPlural: 'credits' }],
  };
  expect(n.meteringUsage?.[0]?.unit).toBe('credit');
});

test('KiroSubagentStatus accepts every state the binary surfaces', () => {
  const states: KiroSubagentStatus[] = [
    'working',
    'awaitingInstruction',
    'terminated',
    'started',
    'completed',
    'failed',
  ];
  expect(states).toHaveLength(6);
});

test('JsonRpc envelope narrows response vs error', () => {
  const req: JsonRpcRequest<'session/prompt', PromptRequest> = {
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] },
  };
  const ok: JsonRpcResponse<PromptResponse> = {
    jsonrpc: '2.0',
    id: 3,
    result: { stopReason: 'end_turn' },
  };
  const err: JsonRpcResponse<PromptResponse> = {
    jsonrpc: '2.0',
    id: 3,
    error: { code: -32603, message: 'boom' },
  };
  expect(req.method).toBe('session/prompt');
  if ('result' in ok) expect(ok.result.stopReason).toBe('end_turn');
  if ('error' in err) expect(err.error.code).toBe(-32603);
});

test('Typed request map keys cover every standard + Kiro method', () => {
  // Compile-time check: these keys must exist. If the types lose a method,
  // this test stops compiling.
  const requestMethods: Array<keyof AcpClientRequests> = [
    'initialize',
    'authenticate',
    'session/new',
    'session/load',
    'session/resume',
    'session/close',
    'session/list',
    'session/prompt',
    'session/set_mode',
    'session/set_config_option',
  ];
  const agentToClientMethods: Array<keyof AcpAgentToClientRequests> = [
    'session/request_permission',
    'fs/read_text_file',
    'fs/write_text_file',
    'terminal/create',
    'terminal/output',
    'terminal/wait_for_exit',
    'terminal/kill',
    'terminal/release',
  ];
  const kiroMethods: Array<keyof KiroRequests> = [
    '_kiro.dev/commands/execute',
    '_kiro.dev/commands/options',
    '_kiro.dev/session/list',
    '_kiro.dev/session/terminate',
    '_kiro.dev/settings/list',
  ];
  expect(requestMethods).toHaveLength(10);
  expect(agentToClientMethods).toHaveLength(8);
  expect(kiroMethods).toHaveLength(5);
});

test('KiroAcpMethod accepts every string the wire carries', () => {
  const sample: KiroAcpMethod[] = [
    'initialize',
    'session/new',
    'session/prompt',
    'session/update',
    '_kiro.dev/metadata',
    '_kiro.dev/commands/available',
  ];
  expect(sample).toHaveLength(6);
});

test('TaggedNotification can hold both ACP and Kiro variants', () => {
  const n: TaggedNotification[] = [
    {
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
      },
    },
    {
      method: '_kiro.dev/metadata',
      params: {
        sessionId: 's1',
        meteringUsage: [{ value: 0.06, unit: 'credit' }],
      },
    },
  ];
  for (const msg of n) {
    if (msg.method === '_kiro.dev/metadata') {
      expect(msg.params.meteringUsage?.[0]?.value).toBeCloseTo(0.06);
    } else if (msg.method === 'session/update') {
      expect(msg.params.update.sessionUpdate).toBe('agent_message_chunk');
    }
  }
});

test('ClientCapabilities terminal flag is a plain boolean', () => {
  const caps: ClientCapabilities = { terminal: true };
  expect(caps.terminal).toBe(true);
});

test('ToolCall.title is optional but preserved (observed in §2b)', () => {
  const tc: ToolCall = {
    toolCallId: 'tc-1',
    kind: 'edit',
    status: 'pending',
    title: 'Write to file',
    rawInput: { path: '/tmp/a.ts', content: 'x' },
  };
  expect(tc.title).toBe('Write to file');
});
