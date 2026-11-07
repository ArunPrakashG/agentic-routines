import { parentPort, workerData } from 'node:worker_threads';
import { runInRealm } from './realm.ts';

// One execute call, on a thread of its own so that code which never yields can be stopped without stopping the server.

const { code, endpoint, url, dir } = workerData as { code: string; endpoint: string; url?: string; dir: string };
const { chromium } = await import('playwright-core');
const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0];
const pages = context.pages();
const page = pages.find((p) => p.url() === url) ?? pages[0];
if (!page) throw new Error('The session has no page.');
// From here on the watch in execute.ts expects to hear from this thread.
setInterval(() => parentPort?.postMessage('alive'), 200);
parentPort?.postMessage('ready');
process.on('unhandledRejection', () => {});
const result = await runInRealm(code, { page, context, dir, did: (line) => parentPort?.postMessage({ did: line }) });
await browser.close().catch(() => {});
parentPort?.postMessage({ result });
