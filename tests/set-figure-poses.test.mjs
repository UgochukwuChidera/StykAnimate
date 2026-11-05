import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
const clone = value => structuredClone(value);
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [0, 1, 2].map(index => createFrame([createObject(figure, 1, 100 + index * 20, 180), createObject(figure, 2, 260, 180), createObject(figure, 3, 420, 180)], 5));
  const editor = new Editor({demo: false}).load(report); editor.select(1); return editor;
}
const poseOf = (editor, frame, uid) => { const object = editor.report.keyframes[frame - 1].objects.find(o => o.unique_id === uid); return {root_x: object.root_x, root_y: object.root_y, scale: object.scale}; };

test('posing one figure at three frames is one undo step with per-frame values', () => {
  const editor = fixture(), before = clone(editor.report), depth = editor._undo.length;
  const result = editor.setFigurePoses([
    {unique_id: 1, frame: 1, patch: {root_x: 10}},
    {unique_id: 1, frame: 2, patch: {root_x: 20, root_y: 60}},
    {unique_id: 1, frame: 3, patch: {scale: 2}},
  ], 'Test pose');
  assert.equal(result, true);
  assert.equal(editor._undo.length, depth + 1, 'the batch records exactly one history entry');
  assert.deepEqual(poseOf(editor, 1, 1), {root_x: 10, root_y: 180, scale: 1});
  assert.deepEqual(poseOf(editor, 2, 1), {root_x: 20, root_y: 60, scale: 1});
  assert.deepEqual(poseOf(editor, 3, 1), {root_x: 140, root_y: 180, scale: 2});
  editor.undo();
  assert.deepEqual(editor.report, before, 'one undo restores all three frames');
  assert.equal(editor._undo.length, depth);
  editor.redo();
  assert.deepEqual(poseOf(editor, 2, 1), {root_x: 20, root_y: 60, scale: 1});
});

test('an unknown figure id rejects the whole batch and changes nothing', () => {
  const editor = fixture(), before = clone(editor.report), revision = editor.revision, depth = editor._undo.length;
  assert.throws(() => editor.setFigurePoses([
    {unique_id: 1, frame: 1, patch: {root_x: 10}},
    {unique_id: 1, frame: 2, patch: {root_x: 20}},
    {unique_id: 99, frame: 3, patch: {root_x: 30}},
  ]), /is not in keyframe/);
  assert.deepEqual(editor.report, before, 'the document is untouched after a rejected batch');
  assert.equal(editor.revision, revision);
  assert.equal(editor._undo.length, depth, 'no history entry was recorded');
});

test('structurally invalid edits throw: out-of-range frames and identity fields', () => {
  const editor = fixture(), before = clone(editor.report), depth = editor._undo.length;
  assert.throws(() => editor.setFigurePoses([{unique_id: 1, frame: 0, patch: {root_x: 1}}]), /keyframes/);
  assert.throws(() => editor.setFigurePoses([{unique_id: 1, frame: 4, patch: {root_x: 1}}]), /keyframes/);
  assert.throws(() => editor.setFigurePoses([{unique_id: 1, frame: 1, patch: {figure_type_id: 5}}]), /structural operations/i);
  assert.throws(() => editor.setFigurePoses([{unique_id: 1, frame: 1, patch: {runtime_segments: []}}]), /root position/i);
  assert.deepEqual(editor.report, before);
  assert.equal(editor._undo.length, depth);
  assert.equal(editor.canUndo, false);
});

test('a negative scale throws the localized scale error', () => {
  const editor = fixture(), before = clone(editor.report), depth = editor._undo.length;
  assert.throws(() => editor.setFigurePoses([{unique_id: 1, frame: 1, patch: {scale: -0.5}}]), /Scale cannot be negative/);
  assert.deepEqual(editor.report, before);
  assert.equal(editor._undo.length, depth);
});

test('an identical pose reports false without recording history', () => {
  const editor = fixture(), before = clone(editor.report), revision = editor.revision, depth = editor._undo.length;
  const result = editor.setFigurePoses([{unique_id: 1, frame: 1, patch: {root_x: 100, scale: 1}}]);
  assert.equal(result, false);
  assert.equal(editor._undo.length, depth);
  assert.deepEqual(editor.report, before);
  assert.equal(editor.revision, revision, 'revision stays where it was');
});
