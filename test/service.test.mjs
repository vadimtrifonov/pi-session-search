import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { SessionService } from '../src/service.mjs';

const timestamp = '2026-01-01T00:00:00.000Z';
const jsonl = entries => entries.map(e => JSON.stringify(e) + '\n').join('');
const message = (id, parentId, role, content, extra = {}) => ({ type: 'message', id, parentId, timestamp, message: { role, content, ...extra } });
const text = value => [{ type: 'text', text: value }];
const evidence = 'ordinary line\n'.repeat(10000) + 'needle evidence\n' + 'following line\n'.repeat(10000);
const entries = [
  { type: 'session', version: 3, id: 'session-a', timestamp, cwd: 'C:\\fixture' },
  message('prompt', null, 'user', 'What did the investigation find?'),
  message('call', 'prompt', 'assistant', [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'inspect' } }]),
  message('output', 'call', 'toolResult', text(evidence), { toolName: 'bash', toolCallId: 'call-1', isError: false }),
  message('answer', 'output', 'assistant', text('The checked answer is consistent.'))
];

function setup(t) {
  const base = mkdtempSync(join(tmpdir(), 'pi-session-service-'));
  const root = join(base, 'sessions'), db = join(base, 'cache', 'index.db');
  mkdirSync(root);
  const file = join(root, 'a.jsonl');
  writeFileSync(file, jsonl(entries));
  const service = new SessionService({ root, db });
  t.after(async () => { await service.close(); rmSync(base, { recursive: true, force: true }); });
  return { service, base, root, db, file };
}

test('lazy worker service serializes jobs, refreshes searches, and continues source reads', async t => {
  const { service, root, db, file } = setup(t);
  assert.equal(existsSync(db), false); // constructing an extension service does no I/O
  const [search, outline] = await Promise.all([
    service.search({ query: 'needle evidence' }),
    service.read({ sessionId: 'session-a' })
  ]);
  assert.equal(search.sync.refreshed, true);
  assert.equal(search.sync.complete, true);
  assert.deepEqual(outline.sync, { root, refreshed: false });
  assert.match(outline.text, /What did the investigation find/);
  const hit = search.tools.hits[0];
  assert.equal(hit.entryId, 'output');
  const { sessionId, entryId, part, offset } = hit;
  const page = await service.read({ sessionId, entryId, part, offset, maxChars: 2000 });
  assert.match(page.text, /needle evidence/);
  assert.ok(page.text.length <= 2000 && page.next);
  const next = await service.read({ sessionId, cursor: page.next, maxChars: 2000 });
  assert.notEqual(next.next, page.next);
  assert.equal(next.branchEnd, page.branchEnd);
  appendFileSync(file, jsonl([message('new', 'answer', 'user', 'newly appended finding')]));
  const fresh = await service.search({ query: 'newly appended finding' });
  assert.equal(fresh.conversation.hits[0].entryId, 'new');
  assert.equal(fresh.sync.appended, 1);
});

test('source reads preserve search pages until a fresh query refreshes the index', async t => {
  const { service, root, file } = setup(t);
  const facts = Array.from({ length: 6 }, (_, i) => message(`fact${i}`, i ? `fact${i-1}` : 'answer', 'assistant', text(`needle fact ${i}`)));
  appendFileSync(file, jsonl(facts));
  for (const id of ['session-b', 'session-c']) writeFileSync(join(root, `${id}.jsonl`), jsonl([
    { ...entries[0], id }, message(`${id}-prompt`, null, 'user', 'Another investigation')
  ]));
  const query = { query: 'needle', limit: 2 };
  const first = await service.search(query);
  assert.ok(first.next);
  assert.equal(first.tools.hits.length, 1);
  appendFileSync(file, jsonl([message('newfact', 'fact5', 'assistant', text('needle appended evidence'))]));
  const source = await service.read({ sessionId: 'session-a', entryId: 'newfact', maxChars: 2000 });
  assert.match(source.text, /needle appended evidence/);
  assert.deepEqual(source.sync, { root, refreshed: false });
  const second = await service.search({ ...query, cursor: first.next, limit: 3 });
  assert.deepEqual(second.sync, { root, refreshed: false });
  assert.equal(second.conversation.hits.length, 3);
  assert.deepEqual(second.tools.hits, []);
  const last = await service.search({ ...query, cursor: second.next, limit: 5 });
  assert.equal(last.next, undefined);
  const ids = [...first.conversation.hits, ...second.conversation.hits, ...last.conversation.hits].map(h => h.entryId);
  assert.deepEqual(ids.sort(), facts.map(e => e.id).sort()); // no new source entry, repeats, or gaps

  const fresh = await service.search({ query: 'appended evidence' });
  assert.equal(fresh.sync.refreshed, true);
  assert.equal(fresh.sync.appended, 1);
  assert.equal(fresh.conversation.hits[0].entryId, 'newfact');
  await assert.rejects(service.search({ ...query, cursor: first.next }), /index changed/i);

  const browse = await service.search({ limit: 1 });
  assert.ok(browse.next);
  const remainder = await service.search({ limit: 2, cursor: browse.next });
  assert.deepEqual(remainder.sync, { root, refreshed: false });
  assert.deepEqual([...browse.sessions, ...remainder.sessions].map(s => s.sessionId), ['session-a', 'session-b', 'session-c']);
  assert.equal(remainder.next, undefined);
  await assert.rejects(service.search({ limit: 1, cursor: browse.next, session: 'session-a' }), /query|scope|filter/i);
});

test('active and queued cancellation do not poison the next worker job', { timeout: 10000 }, async t => {
  const { service } = setup(t);
  const active = new AbortController(), queued = new AbortController();
  const a = assert.rejects(service.search({ query: 'needle' }, active.signal), { name: 'AbortError' });
  const b = assert.rejects(service.read({ sessionId: 'session-a' }, queued.signal), { name: 'AbortError' });
  queued.abort();
  await setImmediate(); // allow the active job to allocate its worker
  active.abort();
  await Promise.all([a, b]);
  const result = await service.search({ query: 'needle evidence' });
  assert.equal(result.sync.complete, true);
  assert.equal(result.tools.hits[0].entryId, 'output');
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(service.search({}, preAborted.signal), { name: 'AbortError' });
});

test('worker errors are isolated and reads check source session identity', async t => {
  const { service, file } = setup(t);
  await assert.rejects(service.read({ sessionId: 'session-a' }), /session_search/);
  await service.search({ query: 'needle' });
  await assert.rejects(service.search({ query: '"unfinished' }), /Unclosed/);
  await assert.rejects(service.read({ sessionId: 'missing' }), /session_search/);
  assert.equal((await service.search({ query: 'needle' })).tools.hits[0].sessionId, 'session-a');
  // The cached path does not prove that the current source still has the requested identity.
  writeFileSync(file, jsonl([{ ...entries[0], id: 'session-b' }, ...entries.slice(1)]));
  await assert.rejects(service.read({ sessionId: 'session-a', entryId: 'answer' }), /changed identity: expected session-a, found session-b/);
});

test('closing is idempotent, stops active work and rejects queued or new jobs', async t => {
  const { service } = setup(t);
  const a = assert.rejects(service.search({ query: 'needle' }), /closed/);
  const b = assert.rejects(service.read({ sessionId: 'session-a' }), /closed/);
  await setImmediate();
  await Promise.all([service.close(), service.close(), a, b]);
  await assert.rejects(service.search(), /closed/);
});
