import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';

const cancelled = () => Object.assign(new Error('Session history request cancelled'), { name: 'AbortError' });

// One short-lived worker per job: no idle thread or retained transcript heap.
// The queue advances on worker exit, including cancellation, not merely on a reply.
export class SessionService {
  #tail = Promise.resolve();
  #active;
  #closed = false;

  constructor({ root, db }) { this.root = resolve(root); this.db = resolve(db); }

  search(options = {}, signal) { return this.#request('search', options, signal); }
  read(options, signal) { return this.#request('read', options, signal); }

  #request(operation, options, signal) {
    if (this.#closed) return Promise.reject(new Error('Session history service is closed'));
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      let worker, aborted = false;
      const abort = () => {
        aborted = true;
        reject(cancelled()); // queued cancellation must not wait for another job
        void worker?.terminate();
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.#tail = this.#tail.then(async () => {
        if (aborted) return;
        if (this.#closed) throw new Error('Session history service is closed');
        worker = new Worker(new URL('./worker.mjs', import.meta.url), {
          workerData: { root: this.root, db: this.db, operation, options }
        });
        this.#active = worker;
        return new Promise((done, fail) => {
          let response, error;
          worker.once('message', value => { response = value; });
          worker.once('error', value => { error = value; });
          worker.once('exit', code => {
            if (aborted) fail(cancelled());
            else if (this.#closed) fail(new Error('Session history service is closed'));
            else if (error) fail(error);
            else if (code !== 0 || !response) fail(new Error(`Session history worker exited without a result (code ${code})`));
            else if (response.error) fail(Object.assign(new Error(response.error.message), { name: response.error.name }));
            else done(response.result);
          });
        });
      }).then(resolve, reject).finally(() => {
        if (this.#active === worker) this.#active = undefined;
        signal?.removeEventListener('abort', abort);
      });
    });
  }

  async close() {
    this.#closed = true;
    void this.#active?.terminate();
    await this.#tail;
  }
}
