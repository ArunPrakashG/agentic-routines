// Marks drawn onto the picture an agent asks for, so a person reading it sees what was touched.
// Replay-check pictures never get them.

export interface Mark {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  /** A mark the agent asked for by hand points at its element with an arrow. */
  arrow?: boolean;
}

const ACCENT = '#6B66FF';
export const MAX_MARKS = 8;

/** Draws the marks on a canvas whose pixels are `scale` times the page's, with the page's (ox, oy) at the corner. */
export function paint(g: OffscreenCanvasRenderingContext2D, marks: Mark[], scale: number, ox = 0, oy = 0): void {
  const W = g.canvas.width;
  const H = g.canvas.height;
  g.save();
  g.lineWidth = Math.max(2, 2 * scale);
  g.font = `600 ${Math.round(Math.max(11, 12 * scale))}px system-ui, sans-serif`;
  g.textBaseline = 'middle';
  marks.forEach((m, i) => {
    const x = (m.x - ox) * scale;
    const y = (m.y - oy) * scale;
    const w = m.w * scale;
    const h = m.h * scale;
    if (x > W || y > H || x + w < 0 || y + h < 0) return;
    g.strokeStyle = ACCENT;
    g.fillStyle = ACCENT;
    g.strokeRect(x, y, w, h);
    const text = `${i + 1} ${m.label}`.slice(0, 48);
    const pad = 6 * scale;
    const th = Math.round(20 * scale);
    const tw = g.measureText(text).width + pad * 2;
    // The label sits above the box, or inside its top edge when there is no room.
    const lx = Math.min(Math.max(0, x), Math.max(0, W - tw));
    const ly = y - th >= 0 ? y - th : y;
    g.fillStyle = ACCENT;
    g.fillRect(lx, ly, tw, th);
    g.fillStyle = '#fff';
    g.fillText(text, lx + pad, ly + th / 2);
    if (m.arrow) {
      const tx = x + w / 2;
      const ty = y + h;
      const sx = Math.min(W - 10, tx + 60 * scale);
      const sy = Math.min(H - 10, ty + 60 * scale);
      g.strokeStyle = ACCENT;
      g.fillStyle = ACCENT;
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(tx, ty + 2);
      g.stroke();
      const a = Math.atan2(ty - sy, tx - sx);
      const hd = 10 * scale;
      g.beginPath();
      g.moveTo(tx, ty + 2);
      g.lineTo(tx - hd * Math.cos(a - 0.45), ty + 2 - hd * Math.sin(a - 0.45));
      g.lineTo(tx - hd * Math.cos(a + 0.45), ty + 2 - hd * Math.sin(a + 0.45));
      g.closePath();
      g.fill();
    }
  });
  g.restore();
}

/** The whole picture with marks on it, as base64 PNG. */
export async function annotatePng(data: string, marks: Mark[], pageWidth: number): Promise<string> {
  if (!marks.length) return data;
  const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
  const c = new OffscreenCanvas(img.width, img.height);
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  paint(g, marks, img.width / (pageWidth || img.width));
  return toBase64(c);
}

export async function toBase64(c: OffscreenCanvas): Promise<string> {
  const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
