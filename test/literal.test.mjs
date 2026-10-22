import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryIndex } from '../src/search.mjs';
import { readSession } from '../src/read.mjs';

const timestamp = '2026-01-01T00:00:00.000Z';
const message = (id, text) => ({ type: 'message', id, parentId: null, timestamp,
  message: { role: 'assistant', content: [{ type: 'text', text }] } });
const jsonl = rows => rows.map(e => JSON.stringify(e)).join('\n') + '\n';

test('literal search preserves exact text, short strings, original offsets and word defaults', async t => {
  const base = mkdtempSync(join(tmpdir(), 'pi-history-literal-')), root = join(base, 'sessions');
  mkdirSync(root);
  const index = new HistoryIndex(join(base, 'index.db'));
  t.after(() => { index.close(); rmSync(base, { recursive: true, force: true }); });
  const longLiteral = 'wide-' + 'x'.repeat(1200) + '-end';
  const original = 'α🧪 ' + 'padding '.repeat(1000) + 'getSessionDir C++ "left right" 100%_[x]*? État A\0B ' + longLiteral;
  const source = message('source', original);
  const entries = [source, message('other', 'getSessionDir C#'),
    { ...message('blocks', ''), message: { role: 'assistant', content: [{ type: 'text', text: 'left' }, { type: 'text', text: 'right' }] } },
    { ...message('activity', ''), message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'getSessionDir hidden' },
      { type: 'toolCall', id: 'inspect-call', name: 'inspect', arguments: { path: 'getSessionDir' } }
    ] } }
  ];
  for (const [id, cwd, rows] of [['origin', 'C:\\Project', entries], ['fork', 'C:\\Project\\Child', [source]]]) {
    writeFileSync(join(root, `${id}.jsonl`), jsonl([{ type: 'session', version: 3, id, cwd, timestamp }, ...rows]));
  }
  assert.equal((await index.sync(root)).complete, true);
  const literal = query => index.search({ query, mode: 'literal' });
  for (const query of ['SessionDir', 'C++', '"left right"', '100%_[x]*?', 'État', 'É', '🧪', 'A\0B', longLiteral]) {
    const hit = literal(query).conversation.hits.find(h => h.entryId === 'source');
    assert.ok(hit, query);
    assert.equal(hit.offset, original.indexOf(query));
    assert.equal(original.slice(hit.offset, hit.offset + query.length), query);
    assert.ok(hit.excerpt.length <= 600);
    if (query.length <= 400) assert.ok(hit.excerpt.includes(query));
    assert.equal(hit.excerptTruncated, true);
  }
  assert.deepEqual(literal('sessiondir').conversation.hits, []);
  assert.deepEqual(literal('état').conversation.hits, []);
  assert.deepEqual(literal('left right').conversation.hits.map(h => h.entryId), ['source']);
  assert.deepEqual(literal(' C++ ').conversation.hits.map(h => h.entryId), ['source']);
  assert.deepEqual(literal('  C++ ').conversation.hits, []);
  assert.deepEqual(index.search({ query: 'SessionDir' }).conversation.hits, []);
  assert.equal(index.search({ query: '"C++"' }).conversation.hits.length, 2);
  const hit = literal('C++').conversation.hits[0];
  const read = await readSession(join(root, 'origin.jsonl'), { entryId: hit.entryId, part: hit.part, offset: hit.offset, maxChars: 2000 });
  assert.match(read.text, /getSessionDir C\+\+/);
  const options = { query: 'SessionDir', mode: 'literal' };
  assert.equal(index.search(options).conversation.hits.find(h => h.entryId === 'source').copies, 2);
  assert.equal(index.search({ ...options, excludeSession: 'origin' }).conversation.hits[0].sessionId, 'fork');
  assert.equal(index.search({ ...options, cwd: 'c:/project/child' }).conversation.hits[0].copies, 1);
  assert.equal(index.search({ ...options, session: 'fork' }).conversation.hits.length, 1);
  assert.equal(index.search({ ...options, since: '2026-01-02' }).conversation.hits.length, 0);
  assert.equal(index.search({ ...options, reasoning: true }).conversation.hits.length, 3);
  assert.equal(index.search({ ...options, tool: 'inspect' }).tools.hits.length, 1);
  assert.deepEqual(index.search({ ...options, tool: 'inspect' }).conversation.hits, []);
  const first = index.search({ ...options, limit: 1 });
  assert.equal(first.conversation.hits.length, 1);
  assert.equal(first.conversation.more, true);
  const all = index.search(options);
  assert.equal(new Set(all.conversation.hits.map(h => h.entryId)).size, 2);
  assert.equal(all.conversation.more, false);
  appendFileSync(join(root, 'origin.jsonl'), jsonl([message('append', 'getSessionDir appended')]));
  await index.sync(root);
  assert.equal(index.search(options).conversation.hits.length, 3);
  for (const query of [undefined, '', ' \n\t']) assert.throws(() => index.search({ query, mode: 'literal' }), /nonblank query/);
  assert.throws(() => index.search({ query: 'x', mode: 'unknown' }), /mode must/);
});
