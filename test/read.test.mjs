import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSession } from '../src/read.mjs';

const at = n => `2026-10-14T12:${String(n).padStart(2, '0')}:00.000Z`;
const msg = (id, parentId, n, message) => ({ type: 'message', id, parentId, timestamp: at(n), message });
const text = t => [{ type: 'text', text: t }];
const jsonl = records => records.map(r => JSON.stringify(r) + '\n').join('');
const big = Array.from({ length: 5000 }, (_, i) => `line ${i} xxxx`).join('\n');
// Branch A: a..f. Branch B leaves d through a branch summary and ends with retrieval and direct shell use.
const records = [
  { type: 'session', version: 3, id: 'S1', timestamp: at(0), cwd: 'C:\\proj' },
  msg('a', null, 1, { role: 'user', content: 'first question' }),
  msg('b', 'a', 2, { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'answer one' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }] }),
  msg('c', 'b', 3, { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: text(big), isError: false }),
  msg('d', 'c', 4, { role: 'assistant', content: text('conclusion A') }),
  msg('e', 'd', 5, { role: 'user', content: 'second question on branch A' }),
  msg('f', 'e', 6, { role: 'assistant', content: text('reply A2') }),
  { type: 'branch_summary', id: 'g', parentId: 'd', timestamp: at(7), fromId: 'f', summary: 'explored A' },
  msg('h', 'g', 8, { role: 'user', content: 'question on branch B' }),
  msg('i', 'h', 9, { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'session_search', arguments: { query: 'needle' } }] }),
  msg('j', 'i', 10, { role: 'toolResult', toolCallId: 'c2', toolName: 'session_search', content: text('recalled needle'), isError: false }),
  msg('k', 'j', 11, { role: 'bashExecution', command: 'echo hi', output: 'hi', exitCode: 0, cancelled: false, truncated: false }),
];
const complete = jsonl(records);
const bigPart = { entryId: 'c', part: '/message/content/0/text' };

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-read-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, content) => { const path = join(dir, name); writeFileSync(path, content); return path; };
  return { write, file: write('s1.jsonl', complete + '{"type":"message","id":"l","parentId":"k"') }; // unfinished tail
}

test('outline the newest recorded branch; anchored passages follow the anchor branch', async t => {
  const { file } = setup(t);
  let r = await readSession(file);
  assert.equal(r.branchEnd, 'k');
  assert.match(r.text, /question on branch B/);
  assert.doesNotMatch(r.text, /second question on branch A/);
  assert.match(r.text, /^ {2}f · .* diverges after d$/m);
  r = await readSession(file, { entryId: 'e' });
  assert.equal(r.branchEnd, 'f');
  assert.match(r.text, /^--- user e .*\nsecond question on branch A\n--- assistant f\nreply A2\n$/); // no previous turn
  await assert.rejects(() => readSession(file, { entryId: 'e', branchEnd: 'k' }), /not on the branch/);
  assert.match((await readSession(file, bigPart)).text, /^--- user a /); // other anchors lead with their turn's prompt
});

test('orientation includes the preceding user entry in source order and marks prompt omissions', async t => {
  const { write } = setup(t);
  const request = 'Investigate the cache invalidation failure in getSessionDir.';
  const caption = 'Screenshot attached.';
  const offset = big.indexOf('line 3000 '), maxChars = 2000;
  for (const stressed of [false, true]) {
    const source = structuredClone(records);
    const prompt = request + (stressed ? ' Additional details.'.repeat(200) : '');
    source.find(e => e.id === 'a').message.content = [
      { type: 'text', text: prompt },
      { type: 'image', mimeType: 'image/png', data: 'opaque' },
      { type: 'text', text: caption }
    ];
    const file = write(`multipart-${stressed}.jsonl`, jsonl(source));
    const r = await readSession(file, { ...bigPart, offset, maxChars });
    assert.ok(r.text.length <= maxChars);
    assert.match(r.text, /Investigate the cache invalidation failure in getSessionDir/);
    const promptSpans = r.spans.filter(s => s.entryId === 'a');
    assert.deepEqual(promptSpans.map(s => s.part), stressed
      ? ['/message/content/0/text'] : ['/message/content/0/text', '/message/content/2/text']);
    if (stressed) {
      assert.ok(promptSpans[0].to < prompt.length);
      assert.match(r.text, /\[\+\d+ chars of \/message\/content\/0\/text\]/);
      assert.match(r.text, /1 prompt text part omitted/);
      assert.doesNotMatch(r.text, /Screenshot attached/);
    } else {
      assert.ok(r.text.indexOf(request) < r.text.indexOf(caption));
      assert.deepEqual(promptSpans.map(s => [s.from, s.to]), [[0, request.length], [0, caption.length]]);
      assert.doesNotMatch(r.text, /prompt text parts? omitted/);
    }
    const focusStart = r.text.indexOf('--- tool_result bash c');
    assert.ok(focusStart >= 0 && focusStart <= maxChars / 4); // entire orientation, including omission markers
    assert.match(r.text, /line 3000 xxxx/);
    const focus = r.spans.find(s => s.entryId === 'c');
    assert.ok(focus.from <= offset && focus.to > offset);
    const next = await readSession(file, { cursor: r.next, maxChars });
    assert.ok(next.text.length <= maxChars);
    assert.deepEqual([next.spans[0].entryId, next.spans[0].part, next.spans[0].from], ['c', bigPart.part, focus.to]);
    assert.doesNotMatch(next.text, /--- user a /);
  }
});

test('pages cover oversized parts once and start near search offsets', async t => {
  const { file, write } = setup(t);
  for (const maxChars of [2000, 12000]) {
    let covered = 0, pages = 0;
    for (let r = await readSession(file, { ...bigPart, maxChars }); ; r = await readSession(file, { cursor: r.next, maxChars })) {
      assert.ok(++pages < 100 && r.text.length <= maxChars);
      if (pages > 1) assert.doesNotMatch(r.text, /Non-contiguous preview/);
      for (const s of r.spans) if (s.entryId === 'c') { assert.equal(s.from, covered); covered = s.to; }
      if (!r.next) break;
    }
    assert.equal(covered, big.length);
    assert.ok(pages > 5);
  }
  const offset = big.indexOf('line 3000 ');
  const span = (await readSession(file, { ...bigPart, offset })).spans.find(s => s.entryId === 'c');
  assert.ok(span.from <= offset && offset - span.from <= 600 && big[span.from - 1] === '\n');
  await assert.rejects(() => readSession(file, { ...bigPart, maxChars: 1999 }), /at least 2000/);
  const titled = write('title.jsonl', complete + jsonl([{ type: 'session_info', id: 'name', parentId: 'k', timestamp: at(12), name: 'long title '.repeat(300) }]));
  await assert.rejects(() => readSession(titled, { maxChars: 2000 }), /too small for the session header/);
  assert.ok((await readSession(titled, { maxChars: 4000 })).text.length <= 4000);
});

test('focused reads preserve the match and keep previews within budget and the raw user turn', async t => {
  const { write } = setup(t), imageTurn = structuredClone(records);
  imageTurn.find(e => e.id === 'a').message.content = 'long prompt '.repeat(200);
  imageTurn.find(e => e.id === 'd').message.content = text('conclusion A '.repeat(500));
  imageTurn.find(e => e.id === 'e').message.content = [{ type: 'image', mimeType: 'image/png', data: 'opaque' }];
  const file = write('image-turn.jsonl', jsonl(imageTurn));
  const r = await readSession(file, { ...bigPart, branchEnd: 'f', maxChars: 2000 });
  assert.ok(r.text.length <= 2000);
  assert.match(r.text, /Non-contiguous preview: later assistant response in this user turn\]\n--- assistant d\nconclusion A/);
  assert.doesNotMatch(r.text, /reply A2/);
  assert.equal(r.spans.at(-1).preview, true);
  assert.ok(r.spans.at(-1).to < imageTurn.find(e => e.id === 'd').message.content[0].text.length);
  assert.equal((await readSession(file, { cursor: r.next, maxChars: 2000 })).spans[0].entryId, 'c');
  assert.match((await readSession(file, { branchEnd: 'f' })).text, /e · .*\[1 image\]/);
  assert.match((await readSession(file, { entryId: 'f' })).text, /^--- user e .*\n\[1 image\]\n--- assistant f\nreply A2\n$/);
  assert.match((await readSession(file, { entryId: 'e' })).text, /^--- user e .*\n\[1 image\]\n/);
  assert.doesNotMatch((await readSession(file, { entryId: 'd', maxChars: 2000 })).text, /Non-contiguous preview/);

  const ids = [1, 2, 3, 4].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
  const tool = 'mcp_' + 'x'.repeat(124);
  const dense = write('dense.jsonl', jsonl([records[0],
    msg(ids[0], null, 1, { role: 'user', content: 'Q'.repeat(1200) }),
    msg(ids[1], ids[0], 2, { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: tool, arguments: { command: 'inspect' } }] }),
    msg(ids[2], ids[1], 3, { role: 'toolResult', toolName: tool, toolCallId: 'call', content: text('x'.repeat(5000) + 'NEEDLE' + 'y'.repeat(5000)) }),
    msg(ids[3], ids[2], 4, { role: 'assistant', content: text('Later response. '.repeat(400)) })
  ]));
  const focused = await readSession(dense, { entryId: ids[2], part: bigPart.part, offset: 5000, maxChars: 2000 });
  assert.ok(focused.text.length <= 2000);
  assert.match(focused.text, /NEEDLE/);
  const span = focused.spans.find(s => s.entryId === ids[2]);
  assert.ok(span.from <= 5000 && span.to > 5000);
});

test('cursors survive appends, not changed text or another session', async t => {
  const { file, write } = setup(t);
  const { next } = await readSession(file, bigPart);
  await assert.rejects(() => readSession(file, { cursor: next + ':extra' }), /invalid read cursor/);
  const appended = write('appended.jsonl', complete + jsonl([msg('l', 'k', 12, { role: 'user', content: 'later' })]));
  assert.equal((await readSession(appended, { cursor: next })).text, (await readSession(file, { cursor: next })).text);
  assert.equal((await readSession(appended)).branchEnd, 'l');
  const sameLength = write('changed.jsonl', complete.replace('line 0 xxxx', 'line 0 yyyy'));
  await assert.rejects(() => readSession(sameLength, { cursor: next }), /changed since/);
  const other = write('other.jsonl', complete.replace('"id":"S1"', '"id":"S2"'));
  await assert.rejects(() => readSession(other, { cursor: next }), /belongs to session S1/);
});

test('raw history shows retrieval and direct shell use; reasoning only when addressed', async t => {
  const { file, write } = setup(t);
  const b = (await readSession(file, { entryId: 'h' })).text;
  assert.match(b, /--- tool_call session_search i\nquery: needle\n--- tool_result session_search j\nrecalled needle\n/);
  assert.match(b, /--- shell command k\necho hi\n--- shell output k\nhi\n$/);
  assert.doesNotMatch((await readSession(file, { entryId: 'b' })).text, /hmm/);
  for (const view of ['passage', 'entry', 'conversation']) assert.match((await readSession(file, { entryId: 'b', view })).text, /--- assistant b · reasoning in \/message\/content\/0\/thinking[ \n]/);
  assert.match((await readSession(file, { entryId: 'b', part: '/message/content/0/thinking' })).text, /--- reasoning b\nhmm\n/);
  const script = msg('s', 'k', 12, { role: 'toolResult', toolCallId: 'run', toolName: 'codemode', content: [],
    nestedCalls: { complete: true, calls: [{ id: 'run|1', name: 'bash', arguments: { command: 'git status' } }] } });
  const scripted = write('script.jsonl', jsonl([...records, script]));
  const turn = await readSession(scripted, { entryId: 's', view: 'turn' });
  assert.deepEqual(turn.activities.filter(a => a.entryId === 's').map(a => [a.kind, a.tool, a.part]),
    [['tool_call', 'bash', '/message/nestedCalls/calls/0/arguments'], ['tool_result', 'codemode', '/message/content']]);
  assert.match((await readSession(scripted, { entryId: 's', part: '/message/nestedCalls/calls/0/arguments', view: 'entry' })).text, /--- tool_call bash s · \S+ · \/message\/nestedCalls\/calls\/0\/arguments\ncommand: git status\n/);
  const interrupted = structuredClone(records);
  Object.assign(interrupted.at(-1).message, { command: 'inspect --verbose', output: 'partial output', exitCode: 130, cancelled: true, truncated: true });
  const stopped = await readSession(write('interrupted.jsonl', jsonl(interrupted)), { entryId: 'k' });
  assert.match(stopped.text, /--- shell output exit 130 cancelled truncated k\npartial output\n$/);
});

test('malformed complete records fail', async t => {
  const { write } = setup(t);
  const [header, a, b] = records;
  await assert.rejects(() => readSession(write('version.jsonl', jsonl([{ ...header, version: 2 }, a]))), /Pi v3 session header/);
  await assert.rejects(() => readSession(write('bad.jsonl', jsonl([header, a]) + '{bad}\n')), /invalid record at byte/);
  await assert.rejects(() => readSession(write('id.jsonl', jsonl([header, { ...a, id: undefined }]))), /invalid entry/);
  await assert.rejects(() => readSession(write('parent.jsonl', jsonl([header, { ...a, parentId: undefined }]))), /invalid parent/);
  await assert.rejects(() => readSession(write('order.jsonl', jsonl([header, b, a]))), /precedes its parent/);
  await assert.rejects(() => readSession(write('duplicate.jsonl', jsonl([header, a, b, b]))), /duplicate entry b/);
});
