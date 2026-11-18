import { Bridge } from '../mcp/bridge.ts';
import { policyOf, sessionIn } from '../mcp/sessions.ts';
import * as sessions from '../store/sessions.ts';

// `session` widens a session's limits. It takes effect at once, with no confirmation.

const USAGE = `Usage:
  agentic-routines session list
  agentic-routines session allow <name> <site> [site ...]     Add sites to a session's list
  agentic-routines session allow <name> --any                 Take the list off
  agentic-routines session allow <name> --private             Let a listed site be on a private address
  agentic-routines session write <name>                       Let a read-only session touch pages`;

export async function runSessions(args: string[]): Promise<void> {
  const [what, name, ...rest] = args;
  if (!what || what === 'list') {
    const list = await sessions.all();
    if (!list.length) return console.log('No named sessions. An agent starts one with session_new.');
    for (const s of list) console.log(`${s.name}  ${s.hosts ? s.hosts.join(', ') || 'no sites' : 'any site'}${s.readOnly ? '  read-only' : ''}`);
    return;
  }
  if ((what !== 'allow' && what !== 'write') || !name) throw new Error(USAGE);
  const s = await sessions.get(name);
  if (!s) throw new Error(`There is no session called ${name}.`);
  let change: Partial<sessions.NamedSession>;
  if (what === 'write') {
    change = { readOnly: false };
  } else if (rest.includes('--any')) {
    change = { hosts: undefined };
  } else if (rest.includes('--private')) {
    change = { allowPrivate: true };
  } else {
    const added = rest.map(sessions.hostOf);
    if (!added.length) throw new Error(USAGE);
    change = { hosts: [...new Set([...(s.hosts ?? []), ...added])] };
  }
  const updated = await sessions.update(name, change);
  const bridge = new Bridge();
  // The browser may be closed. It gets the new list when a server next uses the session.
  await sessionIn(bridge, updated)
    .then(() => bridge.call('browser.session', { target: updated.id, policy: policyOf(updated) }))
    .catch(() => {});
  bridge.close();
  console.log('Done.');
}
