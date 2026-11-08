import { browser } from 'wxt/browser';

// Pictures of a tab go in and a video comes out, a piece at a time, so a long one does not sit in memory.

interface Rec {
  canvas: HTMLCanvasElement;
  mime: string;
  recorder?: MediaRecorder;
  track?: CanvasCaptureMediaStreamTrack;
  sending: Promise<unknown>;
  stopped?: Promise<void>;
}
const recs = new Map<string, Rec>();

const CHOICES = { webm: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'], mp4: ['video/mp4;codecs=avc1', 'video/mp4'] };

function start(id: string, format: 'webm' | 'mp4') {
  const mime = CHOICES[format].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error(`This browser cannot make ${format.toUpperCase()} video. Try ${format === 'mp4' ? 'webm' : 'mp4'}.`);
  recs.set(id, { canvas: document.createElement('canvas'), mime, sending: Promise.resolve() });
}

function begin(id: string, r: Rec) {
  const stream = r.canvas.captureStream(0);
  r.track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  r.recorder = new MediaRecorder(stream, { mimeType: r.mime, videoBitsPerSecond: 4_000_000 });
  r.recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    r.sending = r.sending.then(async () => {
      const bytes = new Uint8Array(await e.data.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await browser.runtime.sendMessage({ t: 'rec.piece', id, data: btoa(bin) });
    });
  };
  r.recorder.start(1000);
}

async function frame(id: string, data: string) {
  const r = recs.get(id);
  if (!r) return;
  const blob = await (await fetch(`data:image/jpeg;base64,${data}`)).blob();
  const bmp = await createImageBitmap(blob);
  // The video keeps the size of its first picture. A later one of another size is fitted in.
  if (!r.recorder) {
    r.canvas.width = bmp.width - (bmp.width % 2);
    r.canvas.height = bmp.height - (bmp.height % 2);
    begin(id, r);
  }
  r.canvas.getContext('2d')!.drawImage(bmp, 0, 0, r.canvas.width, r.canvas.height);
  bmp.close();
  r.track?.requestFrame();
}

async function stop(id: string) {
  const r = recs.get(id);
  recs.delete(id);
  if (!r?.recorder) return { empty: true };
  const done = new Promise<void>((res) => (r.recorder!.onstop = () => res()));
  r.recorder.stop();
  await done;
  await r.sending;
  return { empty: false };
}

export function listenForVideo() {
  browser.runtime.onMessage.addListener((msg: { t?: string; id: string; format: 'webm' | 'mp4'; data: string }, sender, send) => {
    if (sender.id !== browser.runtime.id || !msg?.t?.startsWith('rec.') || msg.t === 'rec.piece') return;
    void (async () => {
      try {
        if (msg.t === 'rec.start') send({ ok: start(msg.id, msg.format) ?? true });
        else if (msg.t === 'rec.frame') send({ ok: (await frame(msg.id, msg.data)) ?? true });
        else if (msg.t === 'rec.stop') send({ ok: await stop(msg.id) });
      } catch (e) {
        send({ err: (e as Error).message });
      }
    })();
    return true;
  });
}
