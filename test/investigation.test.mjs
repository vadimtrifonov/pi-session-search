import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSession } from '../src/read.mjs';

const text = text => ({ type: 'text', text });
const call = (id, command) => ({ type: 'toolCall', id, name: 'bash', arguments: { command } });
const message = (id, parentId, role, content, extra = {}) => ({ type: 'message', id, parentId,
  timestamp: '2026-10-01T12:00:00Z', message: { role, content, ...extra } });
const records = [
  { type: 'session', version: 3, id: 'investigation', cwd: '/project', timestamp: '2026-10-01T12:00:00Z' },
  message('prompt', null, 'user', [text('Check the alleged fix.')]),
  message('calls', 'prompt', 'assistant', [call('first', 'test first'), call('second', 'test second')]),
  message('second-result', 'calls', 'toolResult', [text('FAILED second')], { toolCallId: 'second', toolName: 'bash', isError: true }),
  message('first-result', 'second-result', 'toolResult', [text('PASS first'), text('details '.repeat(700))], { toolCallId: 'first', toolName: 'bash' }),
  message('claim', 'first-result', 'assistant', [{ type: 'thinking', thinking: 'PRIVATE REASONING' }, text('The fix is verified.')]),
  message('late', 'claim', 'toolResult', [text('LATER contrary evidence')], { toolCallId: 'orphan', toolName: 'bash' }),
  message('image-prompt', 'late', 'user', [{ type: 'image', data: 'OPAQUE', mimeType: 'image/png' }]),
  message('empty-call', 'image-prompt', 'assistant', [{ type: 'toolCall', id: 'empty', name: 'status', arguments: {} }]),
  message('empty-result', 'empty-call', 'toolResult', [], { toolCallId: 'empty', toolName: 'status' }),
  message('other-branch', 'claim', 'assistant', [text('UNRELATED alternate branch')])
];

function setup(t, source = records) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-investigation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl');
  const save = value => writeFileSync(file, value.map(e => JSON.stringify(e) + '\n').join(''));
  save(source);
  return { file, save };
}

test('entry view reads all parts without adjacent-history or preview overhead', async t => {
  const { file } = setup(t);
  let r = await readSession(file, { view: 'entry', entryId: 'first-result', branchEnd: 'late', maxChars: 2000 });
  let textSeen = '', end = 0;
  do {
    assert.equal(r.view, 'entry');
    assert.ok(r.text.length <= 2000);
    assert.ok(r.spans.every(s => s.entryId === 'first-result'));
    textSeen += r.text;
    for (const span of r.spans.filter(s => s.part === '/message/content/1/text')) {
      assert.equal(span.from, end);
      end = span.to;
    }
    if (!r.next) break;
    await assert.rejects(() => readSession(file, { cursor: r.next, view: 'conversation' }), /view differs/);
    r = await readSession(file, { cursor: r.next, maxChars: 2000 });
  } while (true);
  assert.equal(end, 'details '.repeat(700).length);
  assert.match(textSeen, /PASS first/);
  assert.doesNotMatch(textSeen, /alleged fix|The fix is verified|LATER/);
  assert.match(textSeen, /2026-10-01T12:00:00Z · \/message\/content\/1\/text/);
  const hidden = setup(t, [records[0], message('reasoning-only', null, 'assistant', [{ type: 'thinking', thinking: 'hidden thought' }])]);
  await assert.rejects(() => readSession(hidden.file, { view: 'entry', entryId: 'reasoning-only' }), /no readable text/);
  assert.match((await readSession(hidden.file, { view: 'entry', entryId: 'reasoning-only', part: '/message/content/0/thinking' })).text, /hidden thought/);
});

test('conversation is an explicit branch-aware projection with resumable text', async t => {
  const source = structuredClone(records);
  source.find(e => e.id === 'claim').message.content.push(text('long answer '.repeat(500)));
  const { file } = setup(t, source);
  let r = await readSession(file, { view: 'conversation', branchEnd: 'empty-result', maxChars: 2000 });
  let output = '', pages = 0;
  do {
    output += r.text;
    assert.ok(r.text.length <= 2000);
    assert.ok(r.spans.every(s => ['user', 'assistant'].includes(s.kind)));
    assert.ok(++pages < 10);
    if (!r.next) break;
    r = await readSession(file, { cursor: r.next, maxChars: 2000 });
  } while (true);
  assert.match(output, /Check the alleged fix/);
  assert.match(output, /The fix is verified/);
  assert.match(output, /\[1 image\]/);
  assert.doesNotMatch(output, /PRIVATE REASONING|FAILED|PASS first|LATER|UNRELATED|OPAQUE|test first/);
  await assert.rejects(() => readSession(file, { view: 'conversation', entryId: 'first-result' }), /excluded from conversation view.*Use view:"entry"/);
});

test('excluded conversation anchors direct readers to entry view without changing the projection', async t => {
  const source = [...records,
    { type: 'compaction', id: 'compact', parentId: 'late', summary: 'COMPACTION evidence', timestamp: '2026-10-01T12:00:00Z' },
    { type: 'branch_summary', id: 'branch-summary', parentId: 'compact', summary: 'BRANCH SUMMARY evidence', timestamp: '2026-10-01T12:00:00Z' }
  ];
  const { file } = setup(t, source);
  const branchEnd = 'branch-summary';
  for (const selection of [
    { entryId: 'compact' },
    { entryId: 'branch-summary', part: '/summary' },
    { entryId: 'first-result' },
    { entryId: 'calls', part: '/message/content/0/arguments' }
  ]) {
    await assert.rejects(() => readSession(file, { ...selection, branchEnd, view: 'conversation' }), error => {
      assert.match(error.message, /excluded from conversation view.*Use view:"entry"/);
      assert.ok(error.message.includes(selection.entryId));
      return true;
    });
    const entry = await readSession(file, { ...selection, branchEnd, view: 'entry' });
    assert.ok(entry.spans.length > 0);
    assert.ok(entry.spans.every(s => s.entryId === selection.entryId));
  }
  const conversation = await readSession(file, { view: 'conversation', branchEnd });
  assert.deepEqual(conversation.spans.map(s => s.entryId), ['prompt', 'claim']);
  assert.doesNotMatch(conversation.text, /COMPACTION|BRANCH SUMMARY|PASS first/);
  await assert.rejects(() => readSession(file, { view: 'conversation', entryId: 'compact', branchEnd: 'claim' }), /not on the branch/);
  await assert.rejects(() => readSession(file, { view: 'conversation', entryId: 'claim', part: '/missing' }), /has no part/);
});

test('turn inventory preserves call IDs, late and orphan results, and image-only boundaries', async t => {
  const { file } = setup(t);
  const result = await readSession(file, { view: 'turn', entryId: 'claim', branchEnd: 'empty-result' });
  assert.deepEqual(result.turn, { anchor: 'claim', promptEntryId: 'prompt', nextPromptEntryId: 'image-prompt', totalParts: 6 });
  assert.deepEqual(result.activities.map(a => [a.entryId, a.callId, a.relation]), [
    ['calls', 'first', 'before'], ['calls', 'second', 'before'],
    ['second-result', 'second', 'before'], ['first-result', 'first', 'before'],
    ['first-result', 'first', 'before'], ['late', 'orphan', 'after']
  ]);
  assert.match(result.text, /tool_result bash error/);
  assert.doesNotMatch(result.text, /UNRELATED|empty-call/);
  assert.equal((await readSession(file, { view: 'turn', entryId: 'claim', branchEnd: 'other-branch' })).activities.length, 5);
  const empty = await readSession(file, { view: 'turn', entryId: 'empty-result', branchEnd: 'empty-result' });
  assert.equal(empty.turn.promptEntryId, 'image-prompt');
  assert.equal(empty.activities.length, 2);
  for (const activity of empty.activities) {
    const read = await readSession(file, { view: 'entry', entryId: activity.entryId, part: activity.part });
    assert.match(read.text, /no readable/);
  }
});

test('turn continuation pins anchor and branch; changed evidence is rejected, appends are harmless', async t => {
  const source = structuredClone(records);
  let parent = 'late';
  for (let i = 0; i < 20; i++) {
    const id = `extra-${i}`;
    source.push(message(id, parent, 'toolResult', [text('result '.repeat(60))], { toolName: 'bash', toolCallId: `id-${i}` }));
    parent = id;
  }
  const { file, save } = setup(t, source);
  const first = await readSession(file, { view: 'turn', entryId: 'claim', branchEnd: parent, maxChars: 2000 });
  assert.ok(first.next);
  let page = first;
  const activities = [];
  do {
    assert.ok(page.text.length <= 2000);
    assert.equal(page.turn.anchor, 'claim');
    activities.push(...page.activities);
    if (!page.next) break;
    page = await readSession(file, { cursor: page.next, maxChars: 2000 });
  } while (true);
  assert.equal(activities.length, first.turn.totalParts);
  assert.equal(new Set(activities.map(a => a.entryId + a.part)).size, activities.length);
  const expected = await readSession(file, { cursor: first.next, maxChars: 2000 });
  save([...source, message('append', parent, 'user', [text('later prompt')])]);
  assert.deepEqual(await readSession(file, { cursor: first.next, maxChars: 2000 }), expected);
  source.find(e => e.id === 'late').message.toolName = 'changed-tool';
  save(source);
  await assert.rejects(() => readSession(file, { cursor: first.next }), /activity changed/);
  source.find(e => e.id === 'late').message.toolName = 'bash';
  source.find(e => e.id === 'late').message.content = [text('changed evidence')];
  save(source);
  await assert.rejects(() => readSession(file, { cursor: first.next }), /activity changed/);
});
