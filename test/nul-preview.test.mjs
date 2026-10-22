import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryIndex } from '../src/search.mjs';
import { readSession } from '../src/read.mjs';

const timestamp = '2026-01-01T00:00:00.000Z';

test('word previews retain native match offsets and original text across NUL separators without changing the stored index', async t => {
  const base = mkdtempSync(join(tmpdir(), 'pi-history-nul-')), root = join(base, 'sessions');
  mkdirSync(root);
  const index = new HistoryIndex(join(base, 'index.db'));
  t.after(() => { index.close(); rmSync(base, { recursive: true, force: true }); });
  // Reduced from a real git-style NUL-delimited result: native snippet/highlight drop
  // MIT/unknown, not just the separators. Deleting NULs cannot restore alignment.
  const actual = 'https://github.com/russo-2025/papyrus-compiler\0MIT\0unknown\0Papyrus\n';
  const cases = [
    { id: 'observed', text: actual, query: 'Papyrus compiler', offset: actual.indexOf('papyrus') },
    { id: 'false-substring', text: 'ffoo before f\0o\0o then foo', query: 'foo', offset: 23 },
    { id: 'phrase', text: '🧪 before\0hidden alpha\0beta tail', query: '"alpha beta"', offset: 17 },
    { id: 'leading', text: '\0hidden foo', query: 'foo', offset: 8 },
    { id: 'trailing', text: 'foo\0hidden suffix', query: 'foo', offset: 0 },
    { id: 'markers', text: '\u00010\u0002 before\0hidden \u00030\u0004 foo', query: 'foo', offset: 22 },
    { id: 'deep', text: '🧪 padding '.repeat(900) + 'ffoo before f\0o\0o then foo', query: 'foo', offset: 9923 }
  ];
  for (const c of cases) writeFileSync(join(root, c.id + '.jsonl'), [
    { type: 'session', version: 3, id: c.id, cwd: '/project', timestamp },
    { type: 'message', id: 'entry', parentId: null, timestamp, message: c.id === 'observed'
      ? { role: 'toolResult', toolName: 'inspect', toolCallId: 'call', content: [{ type: 'text', text: c.text }] }
      : { role: 'assistant', content: [{ type: 'text', text: c.text }] } }
  ].map(JSON.stringify).join('\n') + '\n');
  await index.sync(root);
  const changes = index.db.prepare('SELECT total_changes() n').get().n;
  const schema = index.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
  for (const c of cases) {
    const found = index.search({ query: c.query, session: c.id });
    const hit = [...found.conversation.hits, ...found.tools.hits][0];
    assert.ok(hit, c.id);
    assert.equal(hit.offset, c.offset, c.id);
    const from = Math.max(0, c.offset - 160), to = Math.min(c.text.length, from + 598);
    assert.equal(hit.excerpt, (from ? '…' : '') + c.text.slice(from, to) + (to < c.text.length ? '…' : ''));
    assert.ok(hit.excerpt.length <= 600);
    const read = await readSession(hit.sessionFile, { entryId: hit.entryId, part: hit.part, offset: hit.offset, maxChars: 2000 });
    assert.ok(read.text.includes(c.text.slice(c.offset, c.offset + 20)));
  }
  const literal = index.search({ query: '\0unknown\0', mode: 'literal', session: 'observed' }).tools.hits[0];
  assert.equal(literal.offset, actual.indexOf('\0unknown\0'));
  assert.ok(literal.excerpt.includes('\0MIT\0unknown\0'));
  assert.equal(index.db.prepare('SELECT text FROM tool_io').get().text, actual);
  assert.equal(index.db.prepare('SELECT total_changes() n').get().n, changes);
  assert.deepEqual(index.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), schema);
});
