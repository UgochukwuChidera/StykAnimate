import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import {AgentBridgeHost, BRIDGE_NAME, BRIDGE_SCHEMA, CLOSE_UNAUTHORIZED, CLOSE_LOCKED_OUT, CLOSE_SCHEMA, CLOSE_PROTOCOL, allowedOrigin, sweepStaleRecords} from '../src/agent-bridge/host.mjs';
import WebSocket from 'ws';

const RECORD_PATTERN = /^instance-\d+\.json$/;

async function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bridge-${label}-`));
}

async function startBridge(testDir, extras = {}) {
  const host = new AgentBridgeHost({...extras, recordsDir: testDir, failureDelay: 10, authTimeout: 300, appVersion: '1.2.5', projectLabel: 'test.piv'});
  const info = await host.start();
  return {host, info};
}

async function sureDeadPid(child) {
  child.kill();
  await new Promise(resolve => child.on('exit', resolve));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { process.kill(child.pid, 0); } catch { return true; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return null;
}

function openSocket(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextClose(ws) {
  return new Promise((resolve, reject) => {
    ws.on('close', (code, reason) => resolve({code, reason: reason.toString()}));
    ws.on('error', reject);
  });
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.on('message', data => resolve(JSON.parse(data.toString())));
    ws.on('close', code => reject(new Error(`closed ${code}`)));
    ws.on('error', reject);
  });
}

function send(ws, message) { ws.send(JSON.stringify(message)); }

const WEBSOCKET_KEY = crypto.randomBytes(16).toString('base64');

function rawRequest(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, ...headers});
    req.on('upgrade', () => resolve('upgraded'));
    req.on('response', response => resolve(response.statusCode));
    req.on('error', error => resolve(error.code));
    req.end();
  });
}

function upgradeHeaders(extra = {}) {
  return {path: '/bridge', headers: {Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': WEBSOCKET_KEY, 'Sec-WebSocket-Version': '13', ...extra}};
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

test('the bridge writes a discovery record, authenticates a correct hello and removes the record on stop', async () => {
  const dir = await tmpDir('lifecycle');
  const {host} = await startBridge(dir);
  const recordFile = path.join(dir, `instance-${process.pid}.json`);
  assert.ok(fs.existsSync(recordFile));
  assert.equal(fs.statSync(recordFile).mode & 0o777, 0o600);
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.equal(record.bridge, BRIDGE_NAME);
  assert.equal(record.schema, BRIDGE_SCHEMA);
  assert.equal(record.port, host.port);
  assert.equal(record.pid, process.pid);
  assert.equal(record.version, '1.2.5');
  assert.match(record.token, /^[0-9a-f]{32}$/);

  const ws = await openSocket(host.port);
  send(ws, {op: 'hello', token: record.token, schema: BRIDGE_SCHEMA});
  const reply = await nextMessage(ws);
  assert.equal(reply.ok, true);
  assert.equal(reply.schema, BRIDGE_SCHEMA);

  await ws.close();
  await waitUntil(() => host.connections === 0);
  await host.stop();
  assert.ok(!fs.existsSync(recordFile));
});

test('wrong tokens close 4401, repeated failures back off and then lock out with 4403', async () => {
  const dir = await tmpDir('lockout');
  const {host, info} = await startBridge(dir);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const ws = await openSocket(host.port);
    const close = nextClose(ws);
    send(ws, {op: 'hello', token: 'deadbeef'.repeat(4), schema: BRIDGE_SCHEMA});
    const result = await close;
    if (attempt < 10) assert.equal(result.code, CLOSE_UNAUTHORIZED);
    else assert.equal(result.code, CLOSE_LOCKED_OUT);
  }
  await host.stop();
});

test('browser origins and foreign hosts are rejected before any handshake', async () => {
  const dir = await tmpDir('gate');
  const {host} = await startBridge(dir);
  const evil = await rawRequest(host.port, upgradeHeaders({Origin: 'https://evil.example'}));
  assert.notEqual(evil, 'upgraded');
  const hostileHost = await rawRequest(host.port, upgradeHeaders({'Host': 'rebind.example'}));
  assert.notEqual(hostileHost, 'upgraded');
  await host.stop();
});

test('an unsupported schema closes 4409 and a malformed hello closes 4400', async () => {
  const dir = await tmpDir('protocol');
  const {host, info} = await startBridge(dir);
  const ws = await openSocket(host.port);
  const close = nextClose(ws);
  send(ws, {op: 'hello', token: info.token, schema: 99});
  assert.equal((await close).code, CLOSE_SCHEMA);

  const ws2 = await openSocket(host.port);
  const close2 = nextClose(ws2);
  send(ws2, 'not even json');
  assert.equal((await close2).code, CLOSE_PROTOCOL);
  await host.stop();
});

test('a silent socket times out with 4400', async () => {
  const dir = await tmpDir('timeout');
  const {host} = await startBridge(dir);
  const ws = await openSocket(host.port);
  const close = nextClose(ws);
  assert.equal((await close).code, CLOSE_PROTOCOL);
  await host.stop();
});

test('stopping the bridge closes clients cleanly', async () => {
  const dir = await tmpDir('stop');
  const {host, info} = await startBridge(dir);
  const ws = await openSocket(host.port);
  send(ws, {op: 'hello', token: info.token, schema: BRIDGE_SCHEMA});
  await nextMessage(ws);
  const close = nextClose(ws);
  await host.stop();
  const result = await close;
  assert.ok([1000, 1001].includes(result.code));
});

test('the sweep removes dead and malformed records and keeps live ones', async () => {
  const dir = await tmpDir('sweep');
  const deadChild = spawn(process.execPath, ['-e', 'process.exit(0)']);
  assert.ok(await sureDeadPid(deadChild));
  const liveChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)']);
  try {
    fs.writeFileSync(path.join(dir, 'instance-99999999.json'), JSON.stringify({pid: 99999999}));
    fs.writeFileSync(path.join(dir, 'instance-4242424.json'), 'not json at all');
    fs.writeFileSync(path.join(dir, `instance-${liveChild.pid}.json`), JSON.stringify({pid: liveChild.pid}));
    fs.writeFileSync(path.join(dir, 'unrelated.json'), '{}');
    sweepStaleRecords(dir);
    assert.ok(!fs.existsSync(path.join(dir, 'instance-99999999.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'instance-4242424.json')));
    assert.ok(fs.existsSync(path.join(dir, `instance-${liveChild.pid}.json`)));
    assert.ok(fs.existsSync(path.join(dir, 'unrelated.json')));
  } finally { liveChild.kill(); }
});

test('an instance start sweeps dead records and leaves live and unrelated files alone', async () => {
  const dir = await tmpDir('own');
  const liveChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)']);
  try {
    fs.writeFileSync(path.join(dir, `instance-${liveChild.pid}.json`), JSON.stringify({pid: liveChild.pid}));
    fs.writeFileSync(path.join(dir, 'unrelated.json'), '{}');
    const {host, info} = await startBridge(dir);
    assert.ok(fs.existsSync(path.join(dir, `instance-${liveChild.pid}.json`)));
    assert.ok(fs.existsSync(path.join(dir, 'unrelated.json')));
    assert.equal(JSON.parse(fs.readFileSync(info.recordPath, 'utf8')).pid, process.pid);
    await host.stop();
    assert.ok(!fs.existsSync(`${dir}/instance-${process.pid}.json`));
    assert.ok(fs.existsSync(path.join(dir, `instance-${liveChild.pid}.json`)));
    assert.ok(fs.existsSync(path.join(dir, 'unrelated.json')));
  } finally { liveChild.kill(); }
});

test('the bridge answers over the trusted loopback origin as a same-page client would', async () => {
  const dir = await tmpDir('origin');
  const {host, info} = await startBridge(dir);
  assert.ok(allowedOrigin('null'));
  assert.ok(allowedOrigin(''));
  assert.ok(allowedOrigin(`http://127.0.0.1:${host.port}`));
  assert.ok(!allowedOrigin('https://stykanimate.com'));
  const friendly = await rawRequest(host.port, upgradeHeaders({'Host': `127.0.0.1:${host.port}`, 'Origin': `http://127.0.0.1:${host.port}`}));
  assert.equal(friendly, 'upgraded');
  await host.stop();
});
