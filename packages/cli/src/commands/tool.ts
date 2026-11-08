import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as sessions from '../store/sessions.ts';
import { runMcp } from '../mcp/server.ts';

// Every tool an agent has, as a command: `agentic-routines navigate https://example.com`. It is the same server, in this
// process. A command ends and the next begins, so they share a named session, whose tabs stay open between them.

type Schema = { properties?: Record<string, { type?: string | string[]; description?: string }>; required?: string[] };

export async function connected(cli = true) {
  const [ours, theirs] = InMemoryTransport.createLinkedPair();
  await runMcp({ transport: ours, cli });
  const client = new Client({ name: 'cli', version: '1.0.0' });
  await client.connect(theirs);
  return client;
}

const toolName = (s: string) => s.replace(/-/g, '_');

/** A flag's text, as the type the tool asks for. */
function typed(value: string, type: string | string[] | undefined): unknown {
  const t = Array.isArray(type) ? type.find((x) => x !== 'null') : type;
  if (t === 'number' || t === 'integer') return Number(value);
  if (t === 'boolean') return value !== 'false';
  if (t === 'array') return value.trim().startsWith('[') ? JSON.parse(value) : value.split(',');
  if (t === 'object') return JSON.parse(value);
  return value;
}

export function parseArgs(args: string[], schema: Schema): Record<string, unknown> {
  const props = schema.properties ?? {};
  const out: Record<string, unknown> = {};
  const free = (schema.required ?? []).filter((k) => {
    const t = props[k]?.type;
    return t === 'string' || t === 'number' || t === 'integer';
  });
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') {
      Object.assign(out, JSON.parse(args[++i] ?? '{}'));
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = toolName(a.slice(2, eq > 0 ? eq : undefined));
      const type = props[name]?.type;
      if (!props[name]) throw new Error(`This tool has no --${name}. It takes: ${Object.keys(props).join(', ') || 'nothing'}.`);
      const given = eq > 0 ? a.slice(eq + 1) : type === 'boolean' ? 'true' : args[++i];
      if (given === undefined) throw new Error(`--${name} needs a value.`);
      out[name] = typed(given, type);
    } else {
      const name = free.find((k) => !(k in out));
      if (!name) throw new Error(`What is “${a}” for? Name it with a flag.`);
      out[name] = typed(a, props[name].type);
    }
  }
  return out;
}

function pull(args: string[], flag: string) {
  const at = args.indexOf(`--${flag}`);
  if (at < 0) return undefined;
  const [, value] = args.splice(at, 2);
  return value;
}

export async function runTool(cmd: string, args: string[]): Promise<void> {
  const session = pull(args, 'session') ?? process.env.AGENTIC_ROUTINES_SESSION ?? 'cli';
  const known = await sessions.get(session);
  // Picked up by the server as it starts, when the session is there already.
  process.env.AGENTIC_ROUTINES_SESSION = session;
  const client = await connected();
  const { tools } = await client.listTools();
  if (cmd === 'tools') {
    for (const t of tools) console.log(`${t.name.padEnd(26)} ${(t.description ?? '').split(/(?<=[.!?])\s/)[0]}`);
    return process.exit(0);
  }
  const tool = tools.find((t) => t.name === toolName(cmd));
  if (!tool) throw new Error(`There is no command or tool called ${cmd}. "agentic-routines" lists the commands, "agentic-routines tools" the tools.`);
  if (args.includes('--help')) {
    const schema = tool.inputSchema as Schema;
    console.log(`${tool.description ?? ''}\n\n${Object.entries(schema.properties ?? {}).map(([k, p]) => `  --${k}${schema.required?.includes(k) ? ' (needed)' : ''}${p.description ? `  ${p.description}` : ''}`).join('\n')}`);
    return process.exit(0);
  }
  const params = parseArgs(args, tool.inputSchema as Schema);
  // A first command makes the session. One that does not need a browser goes ahead without it.
  if (!known && !tool.name.startsWith('session_')) await client.callTool({ name: 'session_new', arguments: { name: session } }).catch(() => {});
  const r = (await client.callTool({ name: tool.name, arguments: params }, undefined, { timeout: 15 * 60_000 })) as { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
  for (const c of r.content ?? []) {
    if (c.type === 'text') console.log(c.text);
    else if (c.data) {
      const file = join(tmpdir(), `agentic-routines-${Date.now()}.${c.mimeType?.split('/')[1] ?? 'bin'}`);
      writeFileSync(file, Buffer.from(c.data, 'base64'), { mode: 0o600 });
      console.log(file);
    }
  }
  process.exit(r.isError ? 1 : 0);
}
