// Messages between the MCP server, the native host and the extension.
// Requests carry an id; responses echo it. Events have no id.

export interface Request {
  id: number;
  method: string;
  params?: unknown;
}

export interface Response {
  id: number;
  result?: unknown;
  error?: string;
}

export interface Event {
  event: string;
  data?: unknown;
}

export type Message = Request | Response | Event;

export const isRequest = (m: Message): m is Request => 'method' in m && 'id' in m;
export const isResponse = (m: Message): m is Response => 'id' in m && !('method' in m);
export const isEvent = (m: Message): m is Event => 'event' in m;

/** One line from a local program is never this long; a longer one is dropped rather than kept growing. */
const MAX_LINE = 32 << 20;

/** Newline-delimited JSON over a stream (the unix socket). A line that is not JSON is skipped. */
export function lineReader(onMessage: (m: Message) => void) {
  let buf = '';
  return (chunk: Buffer | string) => {
    buf += chunk.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: Message;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m && typeof m === 'object') onMessage(m);
    }
    if (buf.length > MAX_LINE) buf = '';
  };
}

/** Native messaging: 4-byte little-endian length, then UTF-8 JSON. */
export function nativeReader(onMessage: (m: Message) => void) {
  let buf = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len).toString('utf8');
      buf = buf.subarray(4 + len);
      let m: Message;
      try {
        m = JSON.parse(body);
      } catch {
        continue;
      }
      if (m && typeof m === 'object') onMessage(m);
    }
  };
}

export function nativeFrame(m: Message): Buffer {
  const body = Buffer.from(JSON.stringify(m), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}
