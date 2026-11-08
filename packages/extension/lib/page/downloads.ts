import * as native from '../agent/native';
import { listed, policyOf } from './policy';

// What the browser has downloaded, for the agent working in it. Only what began after that agent turned up, and only from the
// sites its session may use: earlier history is the person's own. The browser cannot say which tab began a download, so one the
// person began meanwhile is listed too.
//
// With a browser on another computer the file has to get to the agent, and an extension cannot read what is on disk. So it asks
// for the address again with this browser's sign-ins and sends what comes back over the link. That is a second request, not the
// bytes the page got, so it says when they differ and when it cannot be done.

const MAX = 2 * 1024 * 1024 * 1024;
const PIECE = 384 * 1024;

async function visible(session?: string) {
  const startedAfter = new Date(native.firstSeenAt(session)).toISOString();
  const all = await browser.downloads.search({ startedAfter, orderBy: ['-startTime'], limit: 50 });
  const hosts = policyOf(session)?.hosts;
  return all.filter((d) => !hosts || listed(hosts, d.finalUrl || d.url));
}

const nameOf = (path: string) => path.split(/[\\/]/).pop() ?? '';

export async function listDownloads(session?: string) {
  return (await visible(session)).slice(0, 20).map((d) => ({ id: d.id, name: nameOf(d.filename), url: d.finalUrl || d.url, bytes: d.fileSize > 0 ? d.fileSize : d.bytesReceived, state: d.state, startedAt: d.startTime }));
}

export async function getDownload(session: string | undefined, id: number): Promise<{ path: string; bytes: number; warning?: string }> {
  const d = (await visible(session)).find((x) => x.id === id);
  if (!d) throw new Error(`There is no download ${id} since this agent started. Call download with no id for the list.`);
  if (d.state === 'in_progress') throw new Error(`${nameOf(d.filename)} is still downloading.`);
  if (d.state !== 'complete') throw new Error(`${nameOf(d.filename)} did not finish downloading.`);
  if (!native.linked({ session })) return { path: d.filename, bytes: d.fileSize };
  const cannot = (why: string) => new Error(`${nameOf(d.filename)} could not be fetched again (${why}). An address that works once, or that needed a form sent, cannot be repeated. The file is on the browser's computer at ${d.filename}, so ask the person to send it over.`);
  const url = d.finalUrl || d.url;
  if (!/^https?:/i.test(url)) throw cannot('it did not come from a web address');
  const r = await fetch(url, { credentials: 'include' }).catch((e: Error) => {
    throw cannot(e.message);
  });
  if (!r.ok || !r.body) throw cannot(`the site answered ${r.status}`);
  const safe = nameOf(d.filename).replace(/[^\w.-]/g, '_').replace(/\.{2,}/g, '.').replace(/^\.+/, '').slice(-100) || 'download';
  const name = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${crypto.randomUUID().slice(0, 8)}-${safe}`;
  const via = { session };
  let path = '';
  let bytes = 0;
  let held = new Uint8Array(0);
  const send = async (piece: Uint8Array) => {
    let raw = '';
    for (let i = 0; i < piece.length; i += 0x8000) raw += String.fromCharCode(...piece.subarray(i, i + 0x8000));
    // One at a time, so a big file waits for the link instead of filling this browser's memory.
    path = (await native.call<{ path: string }>('fs.download', { name, data: btoa(raw) }, via)).path;
  };
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > MAX) {
      await reader.cancel();
      throw new Error(`${nameOf(d.filename)} is over the 2 GB that can cross the link.`);
    }
    const joined = new Uint8Array(held.length + value.length);
    joined.set(held);
    joined.set(value, held.length);
    held = joined;
    while (held.length >= PIECE) {
      await send(held.subarray(0, PIECE));
      held = held.slice(PIECE);
    }
  }
  if (held.length || !path) await send(held);
  const warning = d.fileSize > 0 && d.fileSize !== bytes ? `The browser saved ${d.fileSize} bytes and this request got ${bytes}, so this may not be the same file.` : undefined;
  return { path, bytes, warning };
}
