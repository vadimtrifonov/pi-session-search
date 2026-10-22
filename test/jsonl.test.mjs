import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLines } from '../src/jsonl.mjs';

test('byte-range reads assemble spanning UTF-8 records and withhold unfinished tails', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-jsonl-'));
  let handle;
  t.after(async () => { await handle?.close(); await rm(dir, { recursive: true, force: true }); });
  const prefix = Buffer.from('outside range\n');
  // The emoji crosses a 1 MiB read boundary; the record spans several more chunks.
  const large = Buffer.from('x'.repeat((1 << 20) - 1) + '🧪' + 'y'.repeat(2 << 20) + '\r\n');
  const small = Buffer.from('next β\n');
  const last = Buffer.from('not published until newline\n');
  const file = join(dir, 'records.jsonl');
  await writeFile(file, Buffer.concat([prefix, large, small, last]));
  handle = await open(file, 'r');
  const end = prefix.length + large.length + small.length + last.length - 1;
  const actual = [];
  for await (const row of readLines(handle, prefix.length, end)) actual.push(row);
  assert.deepEqual(actual, [
    { line: large, offset: prefix.length },
    { line: small, offset: prefix.length + large.length }
  ]);
  const completed = [];
  for await (const row of readLines(handle, prefix.length + large.length + small.length, end + 1)) completed.push(row);
  assert.deepEqual(completed, [{ line: last, offset: prefix.length + large.length + small.length }]);
});
