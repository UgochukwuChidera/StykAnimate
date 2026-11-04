import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentDispatcher, AGENT_SOURCE, AGENT_OPS} from '../src/agent-bridge/dispatcher.mjs';
import {BRIDGE_NAME, BRIDGE_SCHEMA} from '../src/agent-bridge/host.mjs';

function fakeRegistry({ids = ['save', 'mirror', 'undo', 'redo', 'delete', 'add-frame'], get = {}, run = () => ({ran: true, reason: ''})} = {}) {
  const calls = [];
  return {
    calls,
    has: id => ids.includes(id),
    ids: () => ids,
    get: id => ({id, label: `Label for ${id}`, category: 'app', enabled: get[id]?.enabled ?? true, reason: get[id]?.reason ?? '', checked: get[id]?.checked}),
    run: (id, options) => { calls.push([id, options]); return run(id, options); },
  };
}

function fakeEditor(overrides = {}) {
  return {revision: 41, canUndo: true, canRedo: false, historyDepth: 7, ...overrides};
}

test('list reports every registry command with availability and status', () => {
  const registry = fakeRegistry({get: {mirror: {enabled: false, reason: 'Select a figure first'}, undo: {checked: false}}});
  const editor = fakeEditor();
  const dispatcher = new AgentDispatcher({registry, editor});
  const reply = dispatcher.handle({op: 'list', seq: 2});
  assert.equal(reply.ok, true);
  assert.equal(reply.seq, 2);
  assert.equal(reply.bridge, BRIDGE_NAME);
  assert.equal(reply.schema, BRIDGE_SCHEMA);
  assert.deepEqual(reply.ops, [...AGENT_OPS]);
  assert.deepEqual(reply.commands.map(row => row.id), registry.ids());
  const mirror = reply.commands.find(row => row.id === 'mirror');
  assert.equal(mirror.enabled, false);
  assert.equal(mirror.reason, 'Select a figure first');
  const undo = reply.commands.find(row => row.id === 'undo');
  assert.equal(undo.checked, false);
  const save = reply.commands.find(row => row.id === 'save');
  assert.equal(save.checked, undefined);
  assert.deepEqual(reply.status, {revision: 41, canUndo: true, canRedo: false, historyDepth: 7});
});

test('invoke runs through the registry as an agent source and reports status', () => {
  const registry = fakeRegistry();
  const editor = fakeEditor({historyDepth: 8, canUndo: true});
  const dispatcher = new AgentDispatcher({registry, editor});
  const reply = dispatcher.handle({op: 'invoke', command: 'add-frame', seq: 5});
  assert.equal(reply.ok, true);
  assert.equal(reply.command, 'add-frame');
  assert.equal(reply.ran, true);
  assert.equal(reply.status.historyDepth, 8);
  assert.deepEqual(registry.calls, [['add-frame', {source: AGENT_SOURCE}]]);
});

test('unknown, unavailable and failing invokes report clean errors', () => {
  const failing = fakeRegistry({run: () => { throw new Error('boom'); }});
  const dispatcher = new AgentDispatcher({registry: failing});
  assert.equal(dispatcher.handle({op: 'invoke', command: 'nope'}).error, 'unknown command');

  const locked = fakeRegistry({get: {delete: {enabled: false, reason: 'In Build'}}});
  const denial = new AgentDispatcher({registry: locked}).handle({op: 'invoke', command: 'delete'});
  assert.equal(denial.ok, false);
  assert.equal(denial.error, 'unavailable');
  assert.equal(denial.reason, 'In Build');
  assert.equal(locked.calls.length, 0, 'a disabled command never reaches run');

  const broken = fakeRegistry({run: () => ({ran: true, error: new Error('boom')})});
  const failure = new AgentDispatcher({registry: broken}).handle({op: 'invoke', command: 'save', seq: 9});
  assert.equal(failure.ok, false);
  assert.equal(failure.error, 'command failed');
  assert.equal(failure.seq, 9);
  assert.equal(failure.detail, 'boom');
});

test('undo and redo route through their commands', () => {
  const registry = fakeRegistry();
  const dispatcher = new AgentDispatcher({registry});
  assert.equal(dispatcher.handle({op: 'undo'}).command, 'undo');
  assert.equal(dispatcher.handle({op: 'redo'}).command, 'redo');
  assert.deepEqual(registry.calls.map(call => call[0]), ['undo', 'redo']);
});

test('pending and malformed messages answer without running anything', () => {
  const registry = fakeRegistry();
  const dispatcher = new AgentDispatcher({registry});
  for (const [message, error] of [
    [{op: 'render', frames: [4]}, 'render is not supported yet'],
    [{op: 'snapshot'}, 'snapshot is not supported yet'],
    [{op: 'events'}, 'events is not supported yet'],
    [{op: 'wat'}, 'unknown op'],
    [{}, 'unknown op'],
    ['hello', 'unknown op'],
    [{op: 'invoke'}, 'unknown op'],
  ]) {
    const reply = dispatcher.handle(message);
    assert.equal(reply.ok, false);
    assert.equal(reply.error, error, `${JSON.stringify(message)} should say ${error}`);
  }
  assert.equal(registry.calls.length, 0);
});

test('the dispatcher pushes nothing on its own; send stays the bridge side', () => {
  let sent = 0;
  const dispatcher = new AgentDispatcher({registry: fakeRegistry(), send: () => { sent += 1; }});
  dispatcher.handle({op: 'list'});
  assert.equal(sent, 0, 'handle returns replies; the glue decides delivery');
});
