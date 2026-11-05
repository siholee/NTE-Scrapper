import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestPacer, MIN_INTERVAL_MS } from '../src/pacing.js';
test('concurrent requests and retries are serialized at seven-second intervals', async () => {
  let time = 0; const starts = [];
  const pacer = new RequestPacer({ now: () => time, wait: async ms => { time += ms; } });
  await Promise.all(Array.from({length: 4}, async () => { await pacer.take(); starts.push(time); }));
  assert.equal(MIN_INTERVAL_MS, 7000);
  assert.deepEqual(starts, [0, 7000, 14000, 21000]);
});
test('cancelled queued requests do not consume a request slot', async () => {
  let time = 0; const pacer = new RequestPacer({ now: () => time, wait: async ms => { time += ms; } });
  await pacer.take(); const controller = new AbortController(); controller.abort(new Error('stopped'));
  await assert.rejects(pacer.take(controller.signal), /stopped/);
  await pacer.take(); assert.equal(time, 7000);
});
