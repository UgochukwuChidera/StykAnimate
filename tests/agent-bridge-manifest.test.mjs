import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {HOTKEY_COMMANDS, HOTKEY_SCOPES} from '../src/hotkeys.mjs';
import {AgentBridgeHost, BRIDGE_NAME, BRIDGE_SCHEMA} from '../src/agent-bridge/host.mjs';
import {buildManifest, BRIDGE_OPS, commandCatalogScopes} from '../src/agent-bridge/manifest.mjs';
import WebSocket from 'ws';

const scopes = commandCatalogScopes();

function openSocket(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.on('message', data => resolve(JSON.parse(data.toString())));
    ws.on('error', reject);
  });
}

test('the manifest mirrors the command catalog by construction', () => {
  const manifest = buildManifest();
  assert.equal(manifest.bridge, BRIDGE_NAME);
  assert.equal(manifest.schema, BRIDGE_SCHEMA);
  assert.deepEqual(manifest.ops, BRIDGE_OPS);
  assert.equal(manifest.commands.length, HOTKEY_COMMANDS.length);
  for (const [index, entry] of manifest.commands.entries()) {
    const command = HOTKEY_COMMANDS[index];
    assert.equal(entry.id, command.id);
    assert.ok(entry.label && typeof entry.label === 'string');
    assert.ok(scopes.includes(entry.scope), `unknown scope for ${entry.id}`);
    assert.ok(Array.isArray(entry.defaults));
    for (const field of ['repeat', 'hold', 'extraShift']) assert.equal(typeof entry[field], 'boolean');
    assert.equal(entry.category, command.category);
  }
});

test('manifest ids and catalog ids are identical sets, in catalog order', () => {
  const manifest = buildManifest();
  assert.deepEqual(manifest.commands.map(entry => entry.id), HOTKEY_COMMANDS.map(command => command.id));
  assert.equal(new Set(manifest.commands.map(entry => entry.id)).size, manifest.commands.length);
  assert.deepEqual(scopes, Object.keys(HOTKEY_SCOPES));
  assert.equal(scopes.length, new Set(scopes).size);
  assert.ok(manifest.commands.every(entry => entry.scope === 'global' || entry.scope in HOTKEY_SCOPES));
});

test('building a manifest from a list with repeated ids throws', () => {
  assert.throws(() => buildManifest([{id: 'save', label: 'Save', category: 'x', scope: 'global', defaults: []}, {id: 'save', label: 'Save again', category: 'x', scope: 'global', defaults: []}]), /duplicate bridge command id/);
});

test('the hello reply carries the manifest when the host is given one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-manifest-'));
  const host = new AgentBridgeHost({recordsDir: dir, authTimeout: 300, failureDelay: 10, manifest: buildManifest()});
  await host.start();
  const ws = await openSocket(host.port);
  ws.send(JSON.stringify({op: 'hello', token: host.token, schema: BRIDGE_SCHEMA}));
  const reply = await nextMessage(ws);
  assert.equal(reply.ok, true);
  assert.equal(reply.manifest.schema, BRIDGE_SCHEMA);
  assert.equal(reply.manifest.bridge, BRIDGE_NAME);
  assert.equal(reply.manifest.commands.length, HOTKEY_COMMANDS.length);
  assert.ok(reply.manifest.ops.includes('invoke'));
  await ws.close();
  await host.stop();
});

test('without a manifest the hello reply stays minimal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-bare-'));
  const host = new AgentBridgeHost({recordsDir: dir, authTimeout: 300, failureDelay: 10});
  await host.start();
  const ws = await openSocket(host.port);
  ws.send(JSON.stringify({op: 'hello', token: host.token, schema: BRIDGE_SCHEMA}));
  const reply = await nextMessage(ws);
  assert.equal(reply.ok, true);
  assert.equal(reply.manifest, undefined);
  await ws.close();
  await host.stop();
});
