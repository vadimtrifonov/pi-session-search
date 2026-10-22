import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryIndex } from '../src/search.mjs';

const timestamp = '2026-01-01T00:00:00Z';
const message = (id, message) => ({ type: 'message', id, parentId: null, timestamp, message });
const text = [{ type: 'text', text: 'preserve OpenSpec evidence' }];

test('kind selects provenance before ranking and composes with scope', async t => {
  const base = mkdtempSync(join(tmpdir(), 'pi-selection-')), root = join(base, 'sessions');
  mkdirSync(root);
  const index = new HistoryIndex(join(base, 'index.db'));
  t.after(() => { index.close(); rmSync(base, { recursive: true, force: true }); });
  const user = message('request', { role: 'user', content: text });
  const entries = [user, message('request2', { role: 'user', content: [{ type: 'text', text: 'earlier OpenSpec request' }] }),
    message('claim', { role: 'assistant', content: [...text,
      { type: 'thinking', thinking: 'OpenSpec private reasoning' },
      { type: 'toolCall', id: 'call', name: 'inspect', arguments: { query: 'OpenSpec evidence' } }] }),
    message('result', { role: 'toolResult', toolCallId: 'call', toolName: 'inspect', content: text }),
    message('shell', { role: 'bashExecution', command: 'OpenSpec inspect', output: 'OpenSpec verified', exitCode: 0 }),
    { type: 'compaction', id: 'summary', parentId: null, timestamp, summary: 'OpenSpec summary' },
    { type: 'custom_message', id: 'custom', parentId: null, timestamp, customType: 'note', content: 'OpenSpec note' }
  ];
  for (const [id, rows] of [['original', entries], ['fork', [user]]]) {
    writeFileSync(join(root, id + '.jsonl'), [{ type: 'session', version: 3, id, timestamp, cwd: '/project' }, ...rows].map(JSON.stringify).join('\n') + '\n');
  }
  await index.sync(root);
  for (const kind of ['user', 'assistant', 'summary', 'custom', 'tool_call', 'tool_result', 'shell']) {
    const result = index.search({ query: 'OpenSpec', kind, reasoning: true });
    const hits = [...result.conversation.hits, ...result.tools.hits];
    assert.ok(hits.length > 0);
    assert.ok(hits.every(h => h.kind === kind));
    const later = index.search({ query: 'OpenSpec', kind, since: '2026-01-02' });
    assert.deepEqual([...later.conversation.hits, ...later.tools.hits], []);
  }
  const users = index.search({ query: 'OpenSpec', kind: 'user' }).conversation.hits;
  assert.equal(users.find(h => h.entryId === 'request').copies, 2);
  assert.deepEqual(index.search({ query: 'OpenSpec', kind: 'user', session: 'fork' }).conversation.hits.map(h => h.entryId), ['request']);
  assert.deepEqual(index.search({ query: 'OpenSpec', kind: 'user', tool: 'inspect' }).conversation.hits, []);
  assert.deepEqual(index.search({ query: 'OpenSpec', kind: 'tool_result', tool: 'inspect' }).tools.hits.map(h => h.entryId), ['result']);
  const first = index.search({ query: 'OpenSpec', kind: 'user', limit: 1 });
  assert.equal(first.conversation.more, true);
  const all = index.search({ query: 'OpenSpec', kind: 'user', limit: 2 });
  assert.equal(new Set(all.conversation.hits.map(h => h.entryId)).size, 2);
  assert.equal(all.conversation.more, false);
  assert.throws(() => index.search({ kind: 'user' }), /require a nonblank query/);
  assert.throws(() => index.search({ query: 'OpenSpec', kind: 'reasoning' }), /kind must be/);
});
