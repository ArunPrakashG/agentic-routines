import { connect } from 'node:net';
import { DEFAULT_PORT, listenConfig, mintCode, pair, pairedClients, remoteBrowsers, revokeClient, setListenConfig, setRemoteBrowsers } from '../host/remote.ts';
import { hosts, type HostInfo } from '../mcp/bridge.ts';
import { hostname } from 'node:os';

// `remote` is a browser on one machine and an agent on another. Opening the browser to a network is a person's call, so it asks
// in the terminal, where an agent's shell is not.

const USAGE = `Usage, on the machine with the browser:
  agentic-routines remote listen <address> [--port n]   Listen on that address, such as a Tailscale one, or 0.0.0.0 for all
  agentic-routines remote pair                          Make a one-time code
  agentic-routines remote status                        What is listening, and who is paired
  agentic-routines remote revoke <id>                   Take a key back, and drop its connections
  agentic-routines remote stop                          Stop listening

On the machine with the agent:
  agentic-routines remote connect <address[:port]> <code> [--name name]
  agentic-routines remote forget <name>`;

const NOT_ENCRYPTED = 'The link is not encrypted: both sides prove who they are, then anyone on the path can read and change what passes, passwords included. Use Tailscale, WireGuard or a network you trust.';

function askHost(h: HostInfo, method: string, params: unknown) {
  return new Promise<unknown>((resolve, reject) => {
    const s = connect(h.socket);
    let buf = '';
    s.on('connect', () => s.write(`${JSON.stringify({ id: 1, method, params })}\n`));
    s.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      const m = JSON.parse(buf.slice(0, buf.indexOf('\n')));
      s.destroy();
      if (m.error) reject(new Error(m.error));
      else resolve(m.result);
    });
    s.on('error', reject);
  });
}

const tellHosts = async (params: unknown) => {
  const open = await hosts();
  return Promise.all(open.map((h) => askHost(h, 'host.remote', params).catch(() => null))) as Promise<({ address: string; port: number } | null)[]>;
};

const inTerminal = () => {
  if (!process.stdin.isTTY) throw new Error('Run this yourself in a terminal, so that an agent cannot open your browser to a network.');
};

export async function runRemote(args: string[]): Promise<void> {
  const [what, ...rest] = args;
  const flag = (name: string) => {
    const at = rest.indexOf(`--${name}`);
    return at >= 0 ? rest[at + 1] : undefined;
  };
  switch (what) {
    case 'listen': {
      inTerminal();
      const address = rest[0];
      if (!address || address.startsWith('--')) throw new Error(USAGE);
      const port = Number(flag('port') ?? DEFAULT_PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65525) throw new Error('A port is a number up to 65525.');
      setListenConfig({ address, port });
      const on = (await tellHosts({ op: 'sync' })).filter(Boolean);
      console.log(on.length ? on.map((l) => `Listening on ${l!.address}:${l!.port}`).join('\n') : `Saved. It starts listening on ${address}:${port} when a browser with the extension opens.`);
      console.log(`DevTools and everything else stay on 127.0.0.1.\n${NOT_ENCRYPTED}\nNext: agentic-routines remote pair`);
      return;
    }
    case 'stop':
      setListenConfig(null);
      await tellHosts({ op: 'sync' });
      return console.log('Not listening any more.');
    case 'pair': {
      inTerminal();
      if (!listenConfig()) throw new Error('Nothing is listening. Start with: agentic-routines remote listen <address>');
      console.log(`${mintCode()}\n\nIt works once, for 10 minutes. On the machine with the agent:\n  agentic-routines remote connect <this machine's address> <code>`);
      return;
    }
    case 'status': {
      const config = listenConfig();
      console.log(config ? `Set to listen on ${config.address}:${config.port}.` : 'Not listening.');
      for (const h of await hosts()) if (h.listening) console.log(`  ${h.browser}${h.profile ? ` ${h.profile.slice(0, 4)}` : ''} on ${h.listening.address}:${h.listening.port}`);
      const clients = Object.entries(pairedClients());
      if (clients.length) console.log(`Paired here:\n${clients.map(([id, c]) => `  ${id}  ${c.name}  since ${new Date(c.pairedAt).toISOString().slice(0, 10)}`).join('\n')}`);
      const far = remoteBrowsers();
      if (far.length) console.log(`Browsers on other machines:\n${far.map((b) => `  ${b.name}  ${b.browser} at ${b.address}:${b.port}`).join('\n')}`);
      return;
    }
    case 'revoke': {
      const id = rest[0];
      if (!id) throw new Error(USAGE);
      if (!revokeClient(id)) throw new Error(`Nothing is paired as ${id}.`);
      await tellHosts({ op: 'revoke', id });
      return console.log('Revoked. Its connections are closed.');
    }
    case 'connect': {
      const [where, code] = rest;
      if (!where || !code) throw new Error(USAGE);
      const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(where);
      if (!m) throw new Error(USAGE);
      const address = m[1].replace(/[[\]]/g, '');
      const name = flag('name') ?? address;
      const b = await pair(address, Number(m[2] ?? DEFAULT_PORT), code, name, hostname());
      console.log(`Paired with ${b.browser} at ${b.address}:${b.port}, as “${name}”. A key is kept in this machine's Agentic Routines folder.\n${NOT_ENCRYPTED}`);
      return;
    }
    case 'forget': {
      const name = rest[0];
      if (!name) throw new Error(USAGE);
      setRemoteBrowsers(remoteBrowsers().filter((b) => b.name !== name));
      return console.log(`Forgot ${name}. The other machine still lists it until you revoke it there.`);
    }
    default:
      throw new Error(USAGE);
  }
}
