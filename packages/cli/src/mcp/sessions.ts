import type { Bridge } from './bridge.ts';
import type { NamedSession } from '../store/sessions.ts';

export const policyOf = (s: NamedSession) => ({ name: s.name, hosts: s.hosts, allowPrivate: s.allowPrivate, readOnly: s.readOnly });

/** Point the bridge at a named session, in the browser it started in, and tell that browser its limits. */
export async function sessionIn(bridge: Bridge, s: NamedSession) {
  bridge.useSession(s.id, s.profile);
  await bridge.call('browser.session', { target: s.id, policy: policyOf(s) });
}
