import { Worker } from 'node:worker_threads';
import type { RealmResult } from './realm.ts';

/** How long code may hold on to the thread: its first run, one callback, one timer, one promise continuation with what follows it. */
export const SLICE_MS = 2000;

/**
 * Runs a worker that says 'ready', then 'alive' while it can, { did } as it acts, then { result }. Stopping the thread is what stops a loop, and it
 * takes the connection with it. No env, no stdout: code that got out of the realm finds no keys there, and MCP's stdout stays clean.
 * The flag is for the realm: without it, import() in the code rejects with an error from outside.
 */
export function watched(file: URL, data: unknown, timeoutMs: number, sliceMs = SLICE_MS): Promise<RealmResult> {
  return new Promise((resolve) => {
    const worker = new Worker(file, { workerData: data, env: {}, execArgv: ['--experimental-vm-modules', '--no-warnings'], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    let heard = 0;
    // As it happens, as a thread that gets stopped has no last word.
    const did: string[] = [];
    const end = (r: RealmResult | string) => {
      clearTimeout(limit);
      clearInterval(watch);
      void worker.terminate();
      resolve(typeof r === 'string' ? { error: r, logs: [], did, files: [] } : did.length ? { ...r, did } : r);
    };
    const limit = setTimeout(() => end(`Stopped after ${Math.round(timeoutMs / 1000)}s. What it had done up to there stays done.`), timeoutMs);
    const watch = setInterval(() => {
      if (heard && Date.now() - heard > sliceMs) end(`Stopped: the code held on for more than ${Math.round(sliceMs / 1000)}s without yielding. What it had done up to there stays done.`);
    }, 200);
    worker.on('message', (m: 'ready' | 'alive' | { did: string } | { result: RealmResult }) => {
      if (typeof m === 'string') heard = Date.now();
      else if ('did' in m) did.push(m.did);
      else end(m.result);
    });
    worker.on('error', (e) => end((e as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'Stopped: the code used too much memory.' : `It could not run: ${e.message}`));
    worker.on('exit', () => end('It ended without an answer.'));
  });
}

export const executeWorker = () => new URL('./execute-worker.js', import.meta.url);
