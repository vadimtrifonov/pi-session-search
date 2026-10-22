import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryIndex } from '../src/search.mjs';
import { readSession } from '../src/read.mjs';

const timestamp = '2026-01-01T00:00:00.000Z';
const message = (id, text) => ({ type: 'message', id, parentId: null, timestamp,
  message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('alternative clauses preserve same-part matching, evidence references and occurrence scope', async t => {
  const base = mkdtempSync(join(tmpdir(), 'pi-history-alternatives-')), root = join(base, 'sessions');
  mkdirSync(root);
  const index = new HistoryIndex(join(base, 'index.db'));
  t.after(() => { index.close(); rmSync(base, { recursive: true, force: true }); });
  const shared = message('shared', 'headset display interruption confirmed');
  const entries = [shared, message('second', 'headset shutdown confirmed'),
    message('partial', 'headset display'), message('wrong-topic', 'display interruption'),
    message('split', 'headset'), message('deep', 'padding '.repeat(1000) + 'headset optical blackout'),
    { ...message('blocks', ''), message: { role: 'assistant', content: [
      { type: 'text', text: 'headset' }, { type: 'text', text: 'shutdown' }
    ] } },
    { ...message('activity', ''), message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'headset shutdown' },
      { type: 'toolCall', id: 'inspect-call', name: 'inspect', arguments: { note: 'headset shutdown' } }
    ] } }
  ];
  for (const [id, cwd, rows] of [['origin', 'C:\\Project', entries], ['fork', 'C:\\Project\\Child', [shared]]]) {
    writeFileSync(join(root, `${id}.jsonl`), [{ type: 'session', version: 3, id, cwd, timestamp }, ...rows].map(JSON.stringify).join('\n') + '\n');
  }
  assert.equal((await index.sync(root)).complete, true);
  const options = { query: 'headset', anyOf: ['display interruption', 'shutdown', '"optical blackout"'] };
  const result = index.search(options);
  assert.deepEqual(new Set(result.conversation.hits.map(h => h.entryId)), new Set(['shared', 'second', 'deep']));
  assert.equal(result.tools.hits.length, 1);
  assert.equal(result.conversation.hits.find(h => h.entryId === 'shared').copies, 2);
  assert.deepEqual(index.search({ ...options, session: 'fork' }).conversation.hits.map(h => h.entryId), ['shared']);
  assert.equal(index.search({ ...options, excludeSession: 'origin' }).conversation.hits[0].sessionId, 'fork');
  assert.equal(index.search({ ...options, cwd: 'c:/project/child' }).conversation.hits[0].copies, 1);
  assert.equal(index.search({ ...options, since: '2026-01-02' }).conversation.hits.length, 0);
  assert.equal(index.search({ ...options, reasoning: true }).conversation.hits.length, 4);
  assert.equal(index.search({ anyOf: ['shutdown'], tool: 'inspect' }).tools.hits.length, 1);
  const typed = index.search({ anyOf: ['shutdown'], kind: 'tool_call', tool: 'inspect' });
  assert.equal(typed.tools.hits.length, 1);
  assert.deepEqual(typed.conversation.hits, []);
  assert.ok(typed.tools.hits.every(h => h.kind === 'tool_call'));
  assert.deepEqual(index.search({ ...options, tool: 'inspect' }).conversation.hits, []);
  assert.ok(index.search({ anyOf: ['display interruption'] }).conversation.hits.some(h => h.entryId === 'wrong-topic'));
  assert.deepEqual(index.search({ query: 'headset OR shutdown' }).conversation.hits, []);
  const deep = result.conversation.hits.find(h => h.entryId === 'deep');
  assert.ok(deep.offset >= 8000);
  const source = entries.find(e => e.id === 'deep').message.content[0].text;
  assert.match(source.slice(deep.offset), /^(headset|optical|blackout)/);
  const read = await readSession(join(root, 'origin.jsonl'), { entryId: deep.entryId, part: deep.part, offset: deep.offset, maxChars: 2000 });
  assert.match(read.text, /headset optical blackout/);
  const first = index.search({ ...options, limit: 1 });
  assert.ok(first.next);
  assert.throws(() => index.search({ ...options, anyOf: ['shutdown'], cursor: first.next }), /query or filters changed/);
  assert.throws(() => index.search({ query: 'headset', cursor: first.next }), /query or filters changed/);
  const next = index.search({ ...options, cursor: first.next, limit: 5 });
  assert.equal(new Set([...first.conversation.hits, ...next.conversation.hits].map(h => h.entryId)).size, 3);
  assert.equal(next.next, undefined);
  for (const query of [undefined, 'headset']) {
    assert.throws(() => index.search({ query, anyOf: ['shutdown'], mode: 'literal' }), /only in words mode/);
  }
  for (const anyOf of [[], [''], ['  '], ['""'], ['"unclosed'], [null], 'shutdown', Array(13).fill('shutdown')]) {
    assert.throws(() => index.search({ anyOf }), /anyOf|terms|Unclosed/);
  }
});
