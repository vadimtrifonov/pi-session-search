import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { Check } from 'typebox/value';

test('Pi loader: schemas, rendered results, archive scope and no-UI lifecycle', { timeout: 20000 }, async t => {
  const base = mkdtempSync(join(tmpdir(), 'pi-session-adapter-'));
  const agentDir = join(base, 'agent'), cwd = join(base, 'work');
  mkdirSync(cwd);
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let shutdown = async () => {};
  t.after(async () => {
    await shutdown();
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(base, { recursive: true, force: true });
  });
  const timestamp = '2026-01-01T00:00:00.000Z';
  function source(directory, id, count = 1, name) {
    mkdirSync(directory, { recursive: true });
    const entries = [{ type: 'session', version: 3, id, cwd, timestamp }];
    for (let i = 0; i < count; i++) entries.push({
      type: 'message', id: `entry${i}`, parentId: i ? `entry${i - 1}` : null, timestamp,
      message: { role: 'assistant', content: [
        { type: 'text', text: `archive needle ${i}: ` + 'verified detail '.repeat(40) },
        { type: 'toolCall', id: `call${i}`, name: 'inspect', arguments: { query: `archive needle ${i}: ` + 'verified detail '.repeat(40) } }
      ] }
    });
    if (name) entries.push({ type: 'session_info', id: 'label', parentId: `entry${count - 1}`, timestamp, name });
    writeFileSync(join(directory, `${id}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  }
  const selfDir = join(agentDir, 'sessions', '--project-one--');
  source(selfDir, 'self');
  source(join(agentDir, 'sessions', '--project-two--'), 'other', 51);
  writeFileSync(join(selfDir, 'invalid.jsonl'), '{bad}\n');
  const entrypoint = fileURLToPath(new URL('../index.ts', import.meta.url));
  const loaded = await discoverAndLoadExtensions([entrypoint], cwd, agentDir);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find(e => e.tools.has('session_search'));
  assert.ok(extension);
  assert.deepEqual([...extension.tools.keys()], ['session_search', 'session_read']);
  assert.equal(existsSync(join(agentDir, 'cache')), false);
  const context = (sessionDir, sessionId) => ({
    mode: 'print', hasUI: false, cwd,
    get ui() { throw new Error('UI must not be used'); },
    sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => sessionId }
  });
  const ctx = context(selfDir, 'self');
  shutdown = async () => { for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown' }, ctx); };
  async function call(name, params, callCtx = ctx, signal) {
    const tool = extension.tools.get(name).definition;
    assert.equal(Check(tool.parameters, params), true);
    const result = await tool.execute('test-call', params, signal, undefined, callCtx);
    assert.equal(Check(tool.outputSchema, result.structuredContent), true);
    assert.equal(result.content[0].type, 'text');
    assert.equal(Object.hasOwn(result, 'details'), true);
    return result;
  }

  const found = await call('session_search', { query: 'archive needle', limit: 50 });
  assert.equal(found.structuredContent.sync.root, join(agentDir, 'sessions'));
  assert.equal(found.structuredContent.sync.refreshed, true);
  assert.equal(found.structuredContent.sync.complete, false);
  assert.equal(found.structuredContent.sync.errors.length, 1);
  assert.match(found.content[0].text, /Index refresh incomplete/);
  const text = found.content[0].text;
  const refs = [...text.matchAll(/^   (\{"sessionId":.*\})$/gm)].map(m => JSON.parse(m[1]));
  const expected = ['conversation', 'tools'].flatMap(key => found.structuredContent[key].hits.map(
    ({ sessionId, entryId, part, offset }) => ({ sessionId, entryId, part, offset })
  ));
  assert.deepEqual(refs, expected);
  const previews = [...text.matchAll(/^   \{"sessionId":.*\}\n   ([^\n]*)/gm)];
  assert.equal(previews.length, expected.length);
  assert.ok(previews.every(m => m[1].length <= 600));
  assert.ok(text.length > 12000); // Larger limits must not silently drop rendered hits.
  for (const [name, key] of [['Conversation', 'conversation'], ['Tool activity', 'tools']]) {
    const section = found.structuredContent[key];
    assert.equal(section.hits.length, 50);
    assert.equal(section.more, true);
    assert.ok(section.hits.every(h => h.sessionId === 'other'));
    assert.ok(text.includes(`${name} (50+)\n`));
  }
  const { sessionId, entryId, part, offset } = found.structuredContent.conversation.hits[0];
  const read = await call('session_read', { sessionId, entryId, part, offset, maxChars: 2000 });
  assert.match(read.structuredContent.text, /archive needle/);
  assert.equal(read.structuredContent.sync.refreshed, false);
  assert.match(read.content[0].text, /index not refreshed/);
  assert.doesNotMatch(read.content[0].text, /Index refresh incomplete/);
  for (const view of ['outline', 'entry', 'conversation', 'turn']) {
    const result = await call('session_read', { sessionId, view, ...(view === 'outline' ? {} : { entryId }), maxChars: 2000 });
    assert.equal(result.structuredContent.view, view);
    if (view === 'entry' || view === 'conversation') assert.ok(result.structuredContent.spans.length > 0);
    if (view === 'turn') assert.ok(result.structuredContent.activities.length > 0 && result.structuredContent.next);
    if (result.structuredContent.next) {
      const next = await call('session_read', { sessionId, cursor: result.structuredContent.next, maxChars: 2000 });
      assert.equal(next.structuredContent.view, view);
    }
  }
  const own = await call('session_search', { query: 'archive needle', sessionId: 'self' });
  assert.equal(own.structuredContent.conversation.hits[0].sessionId, 'self');
  const typed = await call('session_search', { query: 'archive', kind: 'tool_call' });
  assert.deepEqual(typed.structuredContent.conversation.hits, []);
  assert.ok(typed.structuredContent.tools.hits.length > 0);
  const absent = await call('session_search', { query: 'archive', anyOf: ['absent'] });
  assert.deepEqual([...absent.structuredContent.conversation.hits, ...absent.structuredContent.tools.hits], []);
  const literal = await call('session_search', { query: 'eedle 0:', mode: 'literal' });
  assert.equal(literal.structuredContent.conversation.hits.length, 1);
  assert.equal(literal.structuredContent.tools.hits.length, 1);

  const customDir = join(base, 'custom-archive');
  for (let i = 0; i < 51; i++) source(customDir, `catalog-${i}`, 1, 'Detailed investigation and verification notes '.repeat(5));
  const listing = await call('session_search', { limit: 50 }, context(customDir, 'ephemeral'));
  assert.equal(listing.structuredContent.sync.root, customDir);
  assert.equal(listing.structuredContent.sessions.length, 50);
  assert.equal(listing.structuredContent.more, true);
  assert.ok(listing.content[0].text.length > 12000);
  assert.match(listing.content[0].text, /Recent sessions \(50\+\)/);
  for (const session of listing.structuredContent.sessions) {
    assert.ok(session.sessionId.startsWith('catalog-'));
    assert.ok(listing.content[0].text.includes(session.sessionId + ' · '));
  }
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(call('session_search', {}, ctx, aborted.signal), { name: 'AbortError' });
  await shutdown(); await shutdown();
  assert.equal((await call('session_read', { sessionId: 'other' })).structuredContent.sessionId, 'other');
});
