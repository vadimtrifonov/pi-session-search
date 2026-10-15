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
  let sync;
  if (operation === 'search' && options.cursor === undefined) {
    sync = { ...await index.sync(root), root, refreshed: true };
  } else {
    index.checkRoot(root);
    sync = { root, refreshed: false };
  }
  let result;
  if (operation === 'search') {
    result = index.search(options);
  } else if (operation === 'read') {
    const { sessionId, ...readOptions } = options;
    const file = index.getSessionFile(sessionId);
    result = await readSession(file, readOptions);
    if (result.sessionId !== sessionId) throw new Error(`Session file changed identity: expected ${sessionId}, found ${result.sessionId}`);
  } else {
    throw new Error(`Unknown session history operation: ${operation}`);
  }
  parentPort.postMessage({ result: { ...result, sync } });
} catch (error) {
  parentPort.postMessage({ error: { name: error.name ?? 'Error', message: error.message ?? String(error) } });
} finally {
  index?.close();
  parentPort.close();
}
