import * as native from '../agent/native';
import { listed, policyOf } from './policy';

// What the browser has downloaded, for the agent working in it. Only what began after that agent turned up, and only from the
// sites its session may use: earlier history is the person's own. The browser cannot say which tab began a download, so one the
// person began meanwhile is listed too.
//
// With a browser on another computer the file has to get to the agent, and an extension cannot read what is on disk. So it asks
// for the address again with this browser's sign-ins and sends what comes back over the link. That is a second request, not the
// bytes the page got, so it says when they differ and when it cannot be done.
//
// A browser set to ask where to save each file puts up the operating system's own box, which nothing here can answer. The
// download then waits with no file name. The agent can still have the file: this cancels that download, asks for the address
// again (or, for a file the page made itself, asks the page), and sends it where a download would have gone.

const MAX = 2 * 1024 * 1024 * 1024;
const PIECE = 384 * 1024;

async function visible(session?: string) {
  const startedAfter = new Date(native.firstSeenAt(session)).toISOString();
  const all = await browser.downloads.search({ startedAfter, orderBy: ['-startTime'], limit: 50 });
  const hosts = policyOf(session)?.hosts;
  return all.filter((d) => !hosts || listed(hosts, d.finalUrl || d.url));
}

const nameOf = (path: string) => path.split(/[\\/]/).pop() ?? '';

/** Held at the operating system's save box: started, but with no file name yet. */
const asking = (d: { state: string; filename: string }) => d.state === 'in_progress' && !d.filename;
const rescued = new Map<number, { path: string; bytes: number; warning?: string }>();

const urlOf = (d: { finalUrl?: string; url: string }) => d.finalUrl || d.url;
const nameFromUrl = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'download';
  } catch {
    return 'download';
  }
};

export async function listDownloads(session?: string) {
  return (await visible(session)).slice(0, 20).map((d) => {
    const done = rescued.has(d.id);
    return {
      id: d.id,
      name: done || asking(d) ? nameFromUrl(urlOf(d)) : nameOf(d.filename),
      url: urlOf(d),
      bytes: d.fileSize > 0 ? d.fileSize : d.bytesReceived,
      state: done ? 'complete' : asking(d) ? 'waiting_at_save_box' : d.state,
      startedAt: d.startTime,
    };
  });
}

/** A file the page made for itself has an address only that page can read. */
async function fromPage(tabId: number, url: string): Promise<Uint8Array> {
  const [r] = await browser.scripting.executeScript({
    target: { tabId },
    func: async (u: string) => {
      const blob = await (await fetch(u)).blob();
      if (blob.size > 64 * 1024 * 1024) throw new Error('over 64 MB');
      return await new Promise<string>((ok, no) => {
        const f = new FileReader();
        f.onload = () => ok(String(f.result).split(',')[1] ?? '');
        f.onerror = () => no(new Error('could not be read'));
        f.readAsDataURL(blob);
      });
    },
    args: [url],
  });
  const raw = atob((r?.result as string | undefined) ?? '');
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function getDownload(session: string | undefined, id: number, tabId?: number): Promise<{ path: string; bytes: number; warning?: string }> {
  const d = (await visible(session)).find((x) => x.id === id);
  if (!d) throw new Error(`There is no download ${id} since this agent started. Call download with no id for the list.`);
  const was = rescued.get(id);
  if (was) return was;
  const url = urlOf(d);
  const ask = asking(d);
  if (!ask && d.state === 'in_progress') throw new Error(`${nameOf(d.filename)} is still downloading.`);
  if (!ask && d.state !== 'complete') throw new Error(`${nameOf(d.filename)} did not finish downloading.`);
  if (!ask && !native.linked({ session })) return { path: d.filename, bytes: d.fileSize };
  const label = ask ? nameFromUrl(url) : nameOf(d.filename);
  const cannot = (why: string) =>
    new Error(
      ask
        ? `${label} is waiting at the browser's own save box, and it could not be fetched without it (${why}). An address that works once, or that needed a form sent, cannot be repeated. The person can choose a place in that box.`
        : `${label} could not be fetched again (${why}). An address that works once, or that needed a form sent, cannot be repeated. The file is on the browser's computer at ${d.filename}.`,
    );
  if (ask) await browser.downloads.cancel(id).catch(() => {});
  const safe = label.replace(/[^\w.-]/g, '_').replace(/\.{2,}/g, '.').replace(/^\.+/, '').slice(-100) || 'download';
  const name = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${crypto.randomUUID().slice(0, 8)}-${safe}`;
  const via = { session };
  let path = '';
  let bytes = 0;
  const send = async (piece: Uint8Array) => {
    let raw = '';
    for (let i = 0; i < piece.length; i += 0x8000) raw += String.fromCharCode(...piece.subarray(i, i + 0x8000));
    // One at a time, so a big file waits for the link instead of filling this browser's memory.
    path = (await native.call<{ path: string }>('fs.download', { name, data: btoa(raw) }, via)).path;
  };
  if (/^blob:/i.test(url)) {
    if (tabId === undefined) throw cannot('there is no tab to ask');
    const all = await fromPage(tabId, url).catch((e: Error) => {
      throw cannot(e.message);
    });
    bytes = all.length;
    for (let i = 0; i < all.length; i += PIECE) await send(all.subarray(i, i + PIECE));
    if (!path) await send(new Uint8Array(0));
  } else {
    if (!/^https?:/i.test(url)) throw cannot('it did not come from a web address');
    const r = await fetch(url, { credentials: 'include' }).catch((e: Error) => {
      throw cannot(e.message);
    });
    if (!r.ok || !r.body) throw cannot(`the site answered ${r.status}`);
    let held = new Uint8Array(0);
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX) {
        await reader.cancel();
        throw new Error(`${label} is over the 2 GB that can cross the link.`);
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
  }
  const warning = !ask && d.fileSize > 0 && d.fileSize !== bytes ? `The browser saved ${d.fileSize} bytes and this request got ${bytes}, so this may not be the same file.` : undefined;
  const got = { path, bytes, warning };
  if (ask) rescued.set(id, got);
  return got;
}
