export const MIN_INTERVAL_MS = 7000;
export class RequestPacer {
  constructor({ now = Date.now, wait = (ms, signal) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  }) } = {}) { this.now = now; this.wait = wait; this.last = null; this.queue = Promise.resolve(); }
  async take(signal) {
    const pending = this.queue.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      const remaining = this.last === null ? 0 : MIN_INTERVAL_MS - (this.now() - this.last);
      if (remaining > 0) await this.wait(remaining, signal);
      signal?.throwIfAborted(); this.last = this.now();
    });
    this.queue = pending; await pending;
  }
}
export const networkPacer = new RequestPacer();
