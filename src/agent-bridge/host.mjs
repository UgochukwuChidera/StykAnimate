import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import {WebSocketServer} from 'ws';

export const BRIDGE_NAME = 'styk-agent';
export const BRIDGE_SCHEMA = 1;

export const CLOSE_PROTOCOL = 4400;
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_LOCKED_OUT = 4403;
export const CLOSE_SCHEMA = 4409;

const DEFAULTS = Object.freeze({
  authTimeout: 5000,
  maxConnections: 4,
  maxMessageBytes: 4 * 1024 * 1024,
  failureDelay: 1000,
  backoffFromFailures: 3,
  lockoutAtFailures: 10,
  lockoutSeconds: 60,
  recordsDir: null,
  appVersion: null,
  projectLabel: null,
  instanceLabel: null,
  onAuthenticated: null,
  onMessage: null,
});

function defaultRecordsDir() { return path.join(os.homedir(), '.styk-animate', 'bridge'); }
function recordName(pid) { return `instance-${pid}.json`; }

function alivePid(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function loopbackHost(value) {
  const host = String(value ?? '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
    || host.startsWith('127.0.0.1:') || host.startsWith('localhost:') || host.startsWith('[::1]:');
}

export function allowedOrigin(origin) {
  const value = String(origin ?? '');
  return value === '' || value === 'null' || value.startsWith('http://127.0.0.1:') || value.startsWith('http://localhost:') || value.startsWith('ws://127.0.0.1:') || value.startsWith('ws://localhost:');
}

export function sweepStaleRecords(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const removed = [];
  for (const entry of entries) {
    if (!/^instance-\d+\.json$/.test(entry)) continue;
    const file = path.join(dir, entry);
    let record = null;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const dead = !record || typeof record.pid !== 'number' || (record.pid !== process.pid && !alivePid(record.pid));
    if (dead) {
      try { fs.unlinkSync(file); } catch {}
      removed.push(entry);
    }
  }
  return removed;
}

export class AgentBridgeHost {
  constructor(options = {}) {
    this.options = {...DEFAULTS, ...options};
    this.server = null;
    this.upgrades = new WebSocketServer({noServer: true, maxPayload: this.options.maxMessageBytes});
    this.clients = new Set();
    this.failures = new Map();
    this.recordPath = null;
    this._token = null;
    this._stopping = false;
  }

  get running() { return Boolean(this.server); }
  get port() { return this.server?.address()?.port ?? null; }
  get token() { return this._token; }
  get connections() { return this.clients.size; }

  async start() {
    if (this.running) throw new Error('bridge already running');
    this._stopping = false;
    this._token = crypto.randomBytes(16).toString('hex');
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => this._accept(req, socket, head));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({host: '127.0.0.1', port: 0}, resolve);
    });
    this.server = server;
    const dir = this.options.recordsDir ?? defaultRecordsDir();
    fs.mkdirSync(dir, {recursive: true});
    sweepStaleRecords(dir);
    this.recordPath = path.join(dir, recordName(process.pid));
    const record = {
      bridge: BRIDGE_NAME,
      schema: BRIDGE_SCHEMA,
      port: this.port,
      token: this._token,
      pid: process.pid,
      version: this.options.appVersion,
      project: this.options.projectLabel,
      name: this.options.instanceLabel,
      started: Date.now(),
    };
    this._writeRecord(this.recordPath, record);
    return {port: this.port, token: this._token, recordPath: this.recordPath};
  }

  async stop() {
    this._stopping = true;
    const server = this.server;
    this.server = null;
    this._deleteRecord();
    this.failures.clear();
    for (const ws of [...this.clients]) this._close(ws, 1000, 'bridge off');
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const ws of [...this.clients]) {
      if (ws.readyState !== 3) { try { ws.terminate(); } catch {} }
    }
    this.clients.clear();
    if (!server) return;
    await new Promise(resolve => server.close(() => resolve()));
  }

  send(ws, message) {
    if (ws.readyState === 1) ws.send(JSON.stringify(message));
  }

  _close(ws, code, reason) {
    try { ws.close(code, reason); } catch { try { ws.terminate(); } catch {} }
  }

  _reject(socket, status) {
    socket.write(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  _writeRecord(file, record) {
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(record), {mode: 0o600});
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  }

  _deleteRecord() {
    if (!this.recordPath) return;
    try { fs.unlinkSync(this.recordPath); } catch {}
    this.recordPath = null;
  }

  _accept(req, socket, head) {
    if (this._stopping || !this.server) { this._reject(socket, 403); return; }
    if (!loopbackHost(req.headers.host)) { this._reject(socket, 403); return; }
    if (!allowedOrigin(req.headers.origin)) { this._reject(socket, 403); return; }
    if (this.clients.size >= this.options.maxConnections) { this._reject(socket, 403); return; }
    this.upgrades.handleUpgrade(req, socket, head, ws => {
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => {});
      const ip = socket.remoteAddress ?? 'unknown';
      const recorded = this.failures.get(ip);
      if (recorded?.failures >= this.options.lockoutAtFailures && Date.now() < recorded.until) {
        this._close(ws, CLOSE_LOCKED_OUT, 'locked out');
        return;
      }
      this._awaitHello(ws, ip);
    });
  }

  _awaitHello(ws, ip) {
    let timer = setTimeout(() => this._close(ws, CLOSE_PROTOCOL, 'authentication timeout'), this.options.authTimeout);
    ws.on('close', () => clearTimeout(timer));
    ws.on('message', data => {
      ws.removeAllListeners('message');
      clearTimeout(timer);
      this._firstMessage(ws, ip, data);
    });
  }

  _registerFailure(ip, delay) {
    const record = this.failures.get(ip) ?? {failures: 0, until: 0};
    record.failures += 1;
    const waiting = record.failures >= this.options.backoffFromFailures;
    record.until = record.failures >= this.options.lockoutAtFailures
      ? Date.now() + this.options.lockoutSeconds * 1000
      : record.until;
    this.failures.set(ip, record);
    return waiting ? delay : 0;
  }

  _firstMessage(ws, ip, data) {
    let hello = null;
    try { hello = JSON.parse(data.toString()); } catch {}
    if (!hello || typeof hello !== 'object' || hello.op !== 'hello' || typeof hello.token !== 'string') {
      const delay = this._registerFailure(ip, this.options.failureDelay);
      setTimeout(() => this._close(ws, CLOSE_PROTOCOL, 'expected hello'), delay);
      return;
    }
    if (hello.schema !== BRIDGE_SCHEMA) { this._close(ws, CLOSE_SCHEMA, 'unsupported schema'); return; }
    if (hello.token !== this._token) {
      const delay = this._registerFailure(ip, this.options.failureDelay);
      setTimeout(() => this._close(ws, CLOSE_UNAUTHORIZED, 'unauthorized'), delay);
      return;
    }
    this.failures.delete(ip);
    const context = {ip, hello};
    this.options.onMessage?.(ws, hello, context);
    this.options.onAuthenticated?.(ws, hello, context);
    this.send(ws, {ok: true, bridge: BRIDGE_NAME, schema: BRIDGE_SCHEMA, pid: process.pid, version: this.options.appVersion});
  }
}
