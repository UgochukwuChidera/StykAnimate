import {BRIDGE_NAME, BRIDGE_SCHEMA} from './constants.mjs';

export const AGENT_OPS = Object.freeze(['list', 'invoke', 'undo', 'redo']);
export const AGENT_SOURCE = 'agent';
const PENDING_OPS = new Set(['render', 'snapshot', 'events']);

export class AgentDispatcher {
  constructor({registry, editor = null, send = () => {}, handlers = {}} = {}) {
    if (!registry) throw new Error('dispatcher needs a command registry');
    this.registry = registry;
    this.editor = editor;
    this.send = send;
    this.handlers = handlers;
  }

  status() {
    const editor = this.editor;
    return {
      revision: editor?.revision ?? null,
      canUndo: Boolean(editor?.canUndo),
      canRedo: Boolean(editor?.canRedo),
      historyDepth: editor?.historyDepth ?? null,
    };
  }

  commandRows() {
    return this.registry.ids().map(id => {
      const command = this.registry.get(id);
      return {
        id,
        label: command.label,
        category: command.category,
        enabled: command.enabled,
        reason: command.reason ?? '',
        ...(typeof command.checked === 'boolean' ? {checked: command.checked} : {}),
      };
    });
  }

  ops() {
    return [...AGENT_OPS, ...Object.keys(this.handlers)];
  }

  /** Returns a reply for registry ops; a handler op resolves through its handler. */
  handle(message, context = {}) {
    const reply = baseReply(message);
    if (!message || typeof message !== 'object' || typeof message.op !== 'string') {
      reply.ok = false;
      reply.error = 'unknown op';
      return reply;
    }
    if (message.op === 'list') {
      reply.ok = true;
      reply.ops = this.ops();
      reply.commands = this.commandRows();
      reply.status = this.status();
      return reply;
    }
    if (!AGENT_OPS.includes(message.op) && !PENDING_OPS.has(message.op) && !(message.op in this.handlers)) {
      reply.ok = false;
      reply.error = 'unknown op';
      return reply;
    }
    if (message.op in this.handlers) return this.delegate(message, context, reply);
    if (PENDING_OPS.has(message.op)) {
      reply.ok = false;
      reply.error = `${message.op} is not supported yet`;
      return reply;
    }
    const command = message.op === 'invoke' ? message.command : message.op;
    if (typeof command !== 'string' || !command) {
      reply.ok = false;
      reply.error = 'unknown op';
      return reply;
    }
    return this.invoke(command, reply);
  }

  delegate(message, context, reply) {
    let outcome;
    try { outcome = this.handlers[message.op](message, context); }
    catch (error) { return failed(reply, message, error); }
    if (outcome && typeof outcome.then === 'function') {
      return outcome.then(value => ({...baseReply(message), ...value})).catch(error => failed(reply, message, error));
    }
    return {...baseReply(message), ...(outcome && typeof outcome === 'object' ? outcome : {ok: false, error: 'handler produced no reply'})};
  }

  invoke(command, reply) {
    if (!this.registry.has(command)) {
      reply.ok = false;
      reply.error = 'unknown command';
      reply.command = command;
      return reply;
    }
    const description = this.registry.get(command);
    if (!description.enabled) {
      reply.ok = false;
      reply.error = 'unavailable';
      reply.command = command;
      reply.reason = description.reason ?? '';
      return reply;
    }
    const outcome = this.registry.run(command, {source: AGENT_SOURCE});
    if (outcome.error) {
      reply.ok = false;
      reply.error = 'command failed';
      reply.command = command;
      reply.detail = String(outcome.error?.message ?? outcome.error);
      return reply;
    }
    reply.ok = true;
    reply.command = command;
    reply.ran = outcome.ran;
    reply.reason = outcome.reason ?? '';
    reply.status = this.status();
    return reply;
  }
}

function baseReply(message) {
  const reply = {bridge: BRIDGE_NAME, schema: BRIDGE_SCHEMA};
  if (message && typeof message === 'object' && Number.isInteger(message.seq)) reply.seq = message.seq;
  return reply;
}

function failed(reply, message, error) {
  return {...baseReply(message), ok: false, error: 'handler failed', op: typeof message?.op === 'string' ? message.op : null, detail: String(error?.message ?? error)};
}
