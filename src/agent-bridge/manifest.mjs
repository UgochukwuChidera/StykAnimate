import {BRIDGE_NAME, BRIDGE_SCHEMA} from './constants.mjs';
import {HOTKEY_COMMANDS, HOTKEY_SCOPES} from '../hotkeys.mjs';

export const BRIDGE_OPS = ['list', 'invoke', 'undo', 'redo', 'pose', 'joints', 'render', 'snapshot', 'events'];

export function buildManifest(commands = HOTKEY_COMMANDS, ops = BRIDGE_OPS) {
  const seen = new Set();
  const entries = commands.map(command => {
    if (seen.has(command.id)) throw new Error(`duplicate bridge command id: ${command.id}`);
    seen.add(command.id);
    return {
      id: command.id,
      label: command.label,
      category: command.category,
      scope: command.scope,
      defaults: [...command.defaults],
      repeat: Boolean(command.repeat),
      hold: Boolean(command.hold),
      extraShift: Boolean(command.extraShift),
    };
  });
  return {bridge: BRIDGE_NAME, schema: BRIDGE_SCHEMA, ops: [...ops], commands: entries};
}

export function commandCatalogScopes() {
  const names = Object.keys(HOTKEY_SCOPES);
  return names.includes('global') ? names : names.concat('global');
}
