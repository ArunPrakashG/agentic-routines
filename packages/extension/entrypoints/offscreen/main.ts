import { browser } from 'wxt/browser';

// A service worker cannot hold a frame, so this page does: it frames the sandbox page and passes a hook
// and its context in, and the answer back. It has no more power than the background has, and it does not
// read the answer, only passes it on; the background validates it.

interface Answer {
  id: number;
  json?: string;
  error?: string;
  ms: number;
}

let frame: HTMLIFrameElement | undefined;
let ready: Promise<void> = Promise.resolve();
const waiting = new Map<number, (a: Answer) => void>();

function boot() {
  frame?.remove();
  for (const [id, f] of waiting) f({ id, error: 'the sandbox was restarted', ms: 0 });
  waiting.clear();
  const f = document.createElement('iframe');
  f.src = browser.runtime.getURL('/sandbox.html' as any);
  ready = new Promise((res) => {
    const on = (e: MessageEvent) => {
      if (e.source === f.contentWindow && e.data?.ready) {
        removeEventListener('message', on);
        res();
      }
    };
    addEventListener('message', on);
  });
  document.body.append(f);
  frame = f;
}

addEventListener('message', (e) => {
  if (e.source !== frame?.contentWindow || e.data?.ready) return;
  const a = e.data as Answer;
  waiting.get(a.id)?.(a);
  waiting.delete(a.id);
});

boot();

browser.runtime.onMessage.addListener((msg: { t?: string; id: number; code: string; ctx: unknown; ms: number; max: number }, sender: { id?: string }, send: (a: unknown) => void) => {
  if (msg?.t !== 'hook.run' || sender.id !== browser.runtime.id) return;
  void (async () => {
    await ready;
    const answer = new Promise<Answer>((res) => {
      waiting.set(msg.id, res);
      // The sandbox ends a hook by itself at its limit. This is for the case where the frame stops answering.
      setTimeout(() => {
        if (!waiting.has(msg.id)) return;
        boot();
      }, msg.ms + 2000);
    });
    frame!.contentWindow!.postMessage({ id: msg.id, code: msg.code, ctx: msg.ctx, ms: msg.ms, max: msg.max }, '*');
    send(await answer);
  })();
  return true;
});
