// Desktop smoke for the agent bridge (docs/AGENT-BRIDGE.md): a real Electron app
// with its host listening on the loopback, the discovery record in an isolated
// artifacts directory (STYK_BRIDGE_DIR, never the person's ~/.styk-animate), and
// a plain Node WebSocket client that adds a frame and undoes it through the same
// commands a click runs. Artifacts: artifacts/agent-bridge-desktop/.
import {_electron as electron} from '../tests/support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'artifacts', 'agent-bridge-desktop');
const profile = path.join(output, `profile-${Date.now()}`);
const bridgeDir = path.join(output, `bridge-${Date.now()}`);
await mkdir(profile, {recursive: true});
await writeFile(path.join(profile, 'telemetry-state.json'), JSON.stringify({decided: true, consent: {analytics: false, diagnostics: false, policyVersion: '2026-09-10', updatedAt: Date.now()}}));

const checks = [], errors = [], failure = [];
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log('PASS', name); };
let app;

const launch = async () => {
  app = await electron.launch({args: [root], cwd: root, timeout: 45000, env: {
    ...process.env, STYK_USER_DATA_DIR: profile, STYK_LIBRARY_DIR: path.join(profile, 'library'), STYK_BRIDGE_DIR: bridgeDir,
  }});
  app.process().stderr.on('data', data => process.stderr.write(data));
  console.log('Desktop process started');
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready, undefined, {timeout: 30000});
  const welcome = page.getByRole('button', {name: 'Close welcome screen'});
  if (await welcome.isVisible()) await welcome.click();
  return page;
};
const stop = async () => {
  if (!app) return;
  const page = app.windows()[0];
  if (page && !page.isClosed()) await page.evaluate(async () => {
    styk.editor.markSaved();
    await stykDesktop.setDocumentState({name: styk.editor.name, dirty: false});
  }).catch(() => {});
  await app.close().catch(() => {});
  app = null;
};

/** This instance's discovery record, named by the Electron main process pid. */
const record = async (pid) => {
  try { return JSON.parse(await readFile(path.join(bridgeDir, `instance-${pid}.json`), 'utf8')); }
  catch { return null; }
};
const waitUntil = async (predicate, label, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
};

/** A loopback client over the bridge: every op's reply carries the request's seq. */
const connect = async (port) => {
  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
  const inbox = [];
  const closePromise = new Promise(resolve => ws.on('close', code => resolve(code)));
  ws.on('message', data => inbox.push(JSON.parse(data.toString())));
  ws.on('error', () => {}); // errors surface as reply timeouts carrying their own message
  const reply = async (seq, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const index = inbox.findIndex(item => item.seq === seq);
      if (index >= 0) return inbox.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error(`no bridge reply${seq === undefined ? '' : ` for seq ${seq}`}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const ask = (message, timeout) => { ws.send(JSON.stringify(message)); return reply(message.seq, timeout); };
  return {ws, ask, reply, closePromise};
};

const started = new Date().toISOString();
try {
  const page = await launch();
  const pid = app.process().pid;
  const original = await page.evaluate(() => ({ticks: styk.editor.totalTicks, settings: Boolean(styk.settingsUI)}));
  check('The fresh document has frames and the settings surface the bridge toggle lives in',
    Number.isInteger(original.ticks) && original.ticks > 0 && original.settings);

  await page.evaluate(() => styk.settingsUI.commit({agentBridge: true}));
  const info = await waitUntil(() => record(pid), 'the discovery record of this app instance');
  check('Toggling the setting writes the record of this instance, found by the main process pid',
    info.bridge === 'styk-agent' && info.pid === pid && Number.isInteger(info.port));
  check('The record lives in the isolated artifacts directory, never the person\u2019s bridge folder',
    bridgeDir.startsWith(output));

  const bridge = await connect(info.port);
  bridge.ws.send(JSON.stringify({op: 'hello', token: info.token, schema: 1}));
  const greeting = await bridge.reply(undefined);
  check('Hello accepts the token and answers the schema-v1 greeting',
    greeting.ok === true && greeting.bridge === 'styk-agent' && greeting.schema === 1);

  const list = await bridge.ask({op: 'list', seq: 0});
  check('List describes the command catalog and the bridge ops',
    list.ok === true && Array.isArray(list.commands) && list.commands.length > 0 &&
    ['invoke', 'render', 'snapshot', 'seek', 'events'].every(op => list.ops.includes(op)));
  check('add-frame is in the catalog', list.commands.some(row => row.id === 'add-frame'));
  const commandCount = list.commands.length;

  // The denial sample must run like a person's attempt with nothing selected:
  // the fresh document auto-selects its default figure once the workspace
  // settles, so clear the selection the way a click on empty stage would.
  await page.evaluate(() => styk.editor.selectMany([]));
  check('The denial sample starts with no figure selected',
    await page.evaluate(() => styk.editor.selectedObjects.length) === 0);
  const denial = await bridge.ask({op: 'invoke', command: 'mirror', seq: 1});
  check('A command a person cannot run now is denied with the palette\u2019s reason',
    denial.ok === false && (denial.error === 'unavailable' || denial.error === 'unknown command') &&
    denial.reason === 'Select a figure first');

  const add = await bridge.ask({op: 'invoke', command: 'add-frame', seq: 2});
  check('Invoke add-frame adds exactly one frame in the running editor',
    add.ok === true && add.seq === 2 && await page.evaluate(() => styk.editor.totalTicks) === original.ticks + 1);

  const undo = await bridge.ask({op: 'invoke', command: 'undo', seq: 3});
  check('Invoke undo walks the same history back to the starting frame count',
    undo.ok === true && await page.evaluate(() => styk.editor.totalTicks) === original.ticks);

  const snapshot = await bridge.ask({op: 'snapshot', seq: 4});
  check('Snapshot answers the bounded scene overview',
    snapshot.ok === true && snapshot.document && snapshot.document.totalTicks === original.ticks &&
    snapshot.document.canvas && Array.isArray(snapshot.document.objects));

  check('Seek moves the playhead', (await bridge.ask({op: 'seek', frame: 1, seq: 5})).ok === true);

  let render, image;
  try {
    render = await bridge.ask({op: 'render', frames: [1], seq: 6}, 45000);
    image = render.frames?.[0]?.image ?? '';
  } catch (noReply) {
    // KNOWN PRODUCT DEFECTS under report, not a script issue: the desktop relay
    // hands the dispatcher's Promise to ipcRenderer.invoke, which throws
    // "An object could not be cloned.", so async ops never answer; and the
    // render handler feeds the full-size scene canvas to the thumbnail worker,
    // whose 512 px budget rejects it. Surface the in-page dispatcher's answer.
    let evidence = '';
    try {
      const inPage = await Promise.race([
        page.evaluate(() => styk.agentBridge.dispatch({op: 'render', frames: [1], seq: 940})),
        new Promise(resolve => setTimeout(() => resolve(null), 20000)),
      ]);
      if (inPage) evidence = ` even in the page it answers ${JSON.stringify({error: inPage.error, detail: inPage.detail})}`;
    } catch {}
    assert.fail(`Render returns a PNG data URL of a real frame (no bridge reply: ${noReply.message}${evidence})`);
  }
  check('Render returns a PNG data URL of a real frame',
    render.ok === true && image.startsWith('data:image/png;base64,') && image.length >= 500);

  await page.evaluate(() => styk.settingsUI.commit({agentBridge: false}));
  await waitUntil(async () => !(await record(pid)), 'the record removal after the toggle off');
  check('Toggling off removes this instance\u2019s record', !(await record(pid)));
  const closeCode = await Promise.race([bridge.closePromise, new Promise(resolve => setTimeout(() => resolve(null), 8000))]);
  check('The stopping bridge ends clients with a clean close code', [1000, 1001].includes(closeCode));

  check('The frame count ends where the bridge round trip found it', await page.evaluate(() => styk.editor.totalTicks) === original.ticks);
  check('No desktop renderer errors', errors.length === 0);
  await page.screenshot({path: path.join(output, 'desktop.png')});
  const report = {
    command: 'npm run test:agent-bridge:desktop', started, finished: new Date().toISOString(),
    result: 'pass', checks, errors, commandCount, port: info.port, closeCode,
    denied: {command: 'mirror', error: denial.error, reason: denial.reason},
    bridgeDirectory: path.basename(bridgeDir), profile: path.basename(profile),
  };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Agent bridge smoke: ${checks.length} checks passed`);
} catch (error) {
  const message = String(error?.stack ?? error);
  failure.push(message);
  console.error('FAIL', message);
  const page = app?.windows()[0];
  if (page && !page.isClosed()) {
    try {
      console.error(await page.evaluate(() => ({
        ready: styk?.ready, totalTicks: styk?.editor?.totalTicks,
        dialogs: [...document.querySelectorAll('dialog[open]')].map(dialog => dialog.outerHTML.slice(0, 600)),
        rendererError: document.querySelector('#renderer-error')?.textContent,
      })));
      await page.screenshot({path: path.join(output, 'failure.png')});
    } catch {}
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({
    command: 'npm run test:agent-bridge:desktop', started, finished: new Date().toISOString(),
    result: 'fail', checks, errors, failure,
  }, null, 2)).catch(() => {});
} finally { try { await stop(); } catch { app?.process().kill?.(); } try { await rm(profile, {recursive: true, force: true}); } catch {} }

process.exitCode = failure.length ? 1 : 0;
