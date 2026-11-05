// Where a routine's hook code runs. This page is a manifest `sandbox` page: it has a unique origin, so no
// extension API, no storage and no cookies, and its CSP is default-src 'none', so a fetch, a WebSocket, an
// image or a script has nowhere to go. The only way out is the message back to the page that framed it.
//
// Each run gets a fresh Worker, which the page terminates when time is up: a loop that never ends cannot
// hold the page, and nothing is left behind for the next hook to find.

const WORKER = `
'use strict';
const post = self.postMessage.bind(self);
// Belt and braces under the CSP: the ways out are removed before any hook code is read.
for (const n of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'Worker', 'SharedWorker', 'BroadcastChannel', 'WebTransport', 'navigator', 'close', 'postMessage']) {
  try { Object.defineProperty(self, n, { value: undefined, configurable: false, writable: false }); } catch (e) {}
}
self.onmessage = async (e) => {
  const { id, code, ctx, max } = e.data;
  try {
    const fn = new Function('ctx', '"use strict";\\n' + code);
    let out = await fn(ctx);
    if (typeof out === 'function') throw new Error('returned a function. A hook returns directives, not code.');
    const json = JSON.stringify(out === undefined ? null : out);
    if (json === undefined) throw new Error('returned something that is not data.');
    if (json.length > max) throw new Error('returned ' + json.length + ' characters, at most ' + max + '.');
    post({ id, json });
  } catch (err) {
    post({ id, error: String(err && err.message || err).slice(0, 300) });
  }
};
`;

const url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));

interface Job {
  id: number;
  code: string;
  ctx: unknown;
  ms: number;
  max: number;
}

function run(job: Job): Promise<{ json?: string; error?: string; ms: number }> {
  const start = performance.now();
  return new Promise((resolve) => {
    let worker: Worker;
    const done = (r: { json?: string; error?: string }) => {
      clearTimeout(timer);
      worker?.terminate();
      resolve({ ...r, ms: Math.round(performance.now() - start) });
    };
    const timer = setTimeout(() => done({ error: `ran out of time (${job.ms} ms)` }), job.ms);
    try {
      worker = new Worker(url);
    } catch (e) {
      return done({ error: `could not start: ${(e as Error).message}` });
    }
    worker.onmessage = (e) => done(e.data.error ? { error: e.data.error } : { json: e.data.json });
    worker.onerror = (e) => done({ error: e.message || 'failed to run' });
    worker.postMessage({ id: job.id, code: job.code, ctx: job.ctx, max: job.max });
  });
}

window.addEventListener('message', async (e) => {
  if (e.source !== parent) return;
  const job = e.data as Job;
  const res = await run(job);
  parent.postMessage({ id: job.id, ...res }, '*');
});

parent.postMessage({ ready: true }, '*');
