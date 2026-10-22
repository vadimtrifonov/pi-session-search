import { parentPort, workerData } from 'node:worker_threads';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HistoryIndex } from './search.mjs';
import { readSession } from './read.mjs';

const { root, db, operation, options } = workerData;
let index;
try {
  await mkdir(dirname(db), { recursive: true });
  index = new HistoryIndex(db);
  let result;
  if (operation === 'search') {
    const sync = { ...await index.sync(root), root, refreshed: true };
    result = { ...index.search(options), sync };
  } else if (operation === 'read') {
    index.checkRoot(root);
    const { sessionId, ...readOptions } = options;
    const file = index.getSessionFile(sessionId);
    result = { ...await readSession(file, readOptions), sessionFile: file, sync: { root, refreshed: false } };
    if (result.sessionId !== sessionId) throw new Error(`Session file changed identity: expected ${sessionId}, found ${result.sessionId}`);
  } else {
    throw new Error(`Unknown session history operation: ${operation}`);
  }
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: { name: error.name ?? 'Error', message: error.message ?? String(error) } });
} finally {
  index?.close();
  parentPort.close();
}
