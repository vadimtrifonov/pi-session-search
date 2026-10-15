import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let hasPeers = true;
try { import.meta.resolve('@earendil-works/pi-coding-agent'); import.meta.resolve('typebox/value'); }
catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') hasPeers = false; else throw error; }

test('Pi loader: paginated results, archive paths, self-exclusion and no-UI lifecycle', {
  skip: hasPeers ? false : 'Pi peer dependencies are not installed in this checkout', timeout: 20000
}, async t => {
  const { discoverAndLoadExtensions } = await import('@earendil-works/pi-coding-agent');
  const { Check } = await import('typebox/value');
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
  function source(directory, id, count = 1) {
    mkdirSync(directory, { recursive: true });
    const entries = [{ type: 'session', version: 3, id, cwd, timestamp }];
    for (let i = 0; i < count; i++) entries.push({
      type: 'message', id: `entry${i}`, parentId: i ? `entry${i-1}` : null, timestamp,
      message: { role: 'assistant', content: [
        { type: 'text', text: `archive needle ${i}: ` + 'verified detail '.repeat(40) },
        { type: 'toolCall', id: `call${i}`, name: 'inspect', arguments: { query: `archive needle ${i}: ` + 'verified detail '.repeat(40) } }
      ] }
    });
    writeFileSync(join(directory, `${id}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  }
  const selfDir = join(agentDir, 'sessions', '--project-one--');
  source(selfDir, 'self');
  const otherDir = join(agentDir, 'sessions', '--project-two--');
  source(otherDir, 'other', 60);
  source(join(agentDir, 'sessions', '--project-three--'), 'third');
  writeFileSync(join(selfDir, 'invalid.jsonl'), '{bad}\n');
  const entrypoint = fileURLToPath(new URL('../index.ts', import.meta.url));
  const loaded = await discoverAndLoadExtensions([entrypoint], cwd, agentDir);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find(e => e.tools.has('session_search'));
  assert.ok(extension);
  assert.deepEqual([...extension.tools.keys()], ['session_search', 'session_read']);
  assert.equal(existsSync(join(agentDir, 'cache')), false); // loading starts no worker or scan
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
    return result;
  }
  const found = await call('session_search', { query: 'archive needle', limit: 50 });
  assert.equal(found.structuredContent.sync.root, join(agentDir, 'sessions'));
  assert.equal(found.structuredContent.sync.refreshed, true);
  assert.equal(found.structuredContent.sync.complete, false);
  assert.equal(found.structuredContent.sync.errors.length, 1);
  assert.equal(found.structuredContent.conversation.hits.length, 50);
  assert.equal(found.structuredContent.tools.hits.length, 50);
  assert.ok(found.structuredContent.conversation.hits.every(h => h.sessionId === 'other'));
  assert.ok(found.content[0].text.length <= 12000);
  assert.match(found.content[0].text, /further hits in structuredContent/);
  assert.match(found.content[0].text, /Tool activity/);
  assert.match(found.content[0].text, /Index refresh incomplete/);
  assert.ok(found.structuredContent.next && found.content[0].text.includes(found.structuredContent.next));
  const { sessionId, entryId, part, offset } = found.structuredContent.conversation.hits[0];
  const read = await call('session_read', { sessionId, entryId, part, offset, maxChars: 2000 });
  assert.match(read.structuredContent.text, /archive needle/);
  assert.equal(read.structuredContent.sessionId, 'other');
  assert.equal(read.structuredContent.sync.refreshed, false);
  assert.match(read.content[0].text, /index not refreshed/);
  assert.doesNotMatch(read.content[0].text, /Index refresh incomplete/);
  const continuation = { query: 'archive needle', cursor: found.structuredContent.next, limit: 5 };
  await assert.rejects(call('session_search', continuation, context(selfDir, 'other')), /query|scope|filter/i); // implicit exclusion changed
  appendFileSync(join(otherDir, 'other.jsonl'), JSON.stringify({
    type: 'message', id: 'appended', parentId: 'entry59', timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text: 'archive needle appended evidence' }] }
  }) + '\n');
  const appended = await call('session_read', { sessionId: 'other', entryId: 'appended', maxChars: 2000 });
  assert.match(appended.structuredContent.text, /appended evidence/);
  assert.equal(appended.structuredContent.sync.refreshed, false);
  const continued = await call('session_search', continuation);
  assert.equal(continued.structuredContent.sync.refreshed, false);
  assert.equal(continued.structuredContent.conversation.hits.length, 5);
  assert.equal(continued.structuredContent.tools.hits.length, 5);
  for (const section of ['conversation', 'tools']) {
    const seen = new Set(found.structuredContent[section].hits.map(h => `${h.entryId}:${h.part}`));
    assert.ok(continued.structuredContent[section].hits.every(h => h.entryId !== 'appended' && !seen.has(`${h.entryId}:${h.part}`)));
  }
  const own = await call('session_search', { query: 'archive needle', sessionId: 'self' });
  assert.equal(own.structuredContent.conversation.hits[0].sessionId, 'self');
  assert.equal(own.structuredContent.sync.appended, 1);
  await assert.rejects(call('session_search', continuation), /index changed/i);
  const browsing = await call('session_search', { limit: 1 });
  assert.ok(browsing.structuredContent.next && browsing.content[0].text.includes(browsing.structuredContent.next));
  const browseNext = await call('session_search', { cursor: browsing.structuredContent.next, limit: 2 });
  assert.equal(browseNext.structuredContent.sync.refreshed, false);
  assert.deepEqual([...browsing.structuredContent.sessions, ...browseNext.structuredContent.sessions].map(s => s.sessionId), ['other', 'third']);
  assert.equal(browseNext.structuredContent.next, undefined);
  for (const query of [undefined, ' \t\n ']) {
    const options = query === undefined ? {} : { query };
    for (const filter of [{ tool: 'inspect' }, { tool: '' }, { reasoning: true }]) {
      await assert.rejects(call('session_search', { ...options, ...filter }), /query/i);
    }
    const neutral = await call('session_search', { ...options, reasoning: false });
    assert.deepEqual(neutral.structuredContent.sessions.map(s => s.sessionId), ['other', 'third']);
  }
  for (const tool of ['', 'missing']) {
    const empty = await call('session_search', { query: 'archive needle', tool });
    assert.deepEqual(empty.structuredContent.conversation.hits, []);
    assert.deepEqual(empty.structuredContent.tools.hits, []);
    assert.equal(empty.structuredContent.next, undefined);
  }
  const filtered = await call('session_search', { query: 'archive needle', tool: 'inspect' });
  assert.deepEqual(filtered.structuredContent.conversation.hits, []);
  assert.ok(filtered.structuredContent.tools.hits.length > 0);
  assert.ok(filtered.structuredContent.tools.hits.every(h => h.tool === 'inspect'));
  const customDir = join(base, 'custom-archive'); source(customDir, 'custom');
  const custom = await call('session_search', { query: 'archive needle' }, context(customDir, 'ephemeral'));
  assert.equal(custom.structuredContent.sync.root, customDir);
  assert.deepEqual(custom.structuredContent.conversation.hits.map(h => h.sessionId), ['custom']);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(call('session_search', {}, ctx, aborted.signal), { name: 'AbortError' });
  await shutdown(); await shutdown();
  assert.equal((await call('session_read', { sessionId: 'other' })).structuredContent.sessionId, 'other');
});
