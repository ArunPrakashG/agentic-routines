import { hosts, profileLabel } from '../mcp/bridge.ts';
import { setName } from '../store/profiles.ts';

// `profiles` lists the browser profiles with the extension that are open now. `profiles name <id|number> <name>` names one.

export async function runProfiles(args: string[]): Promise<void> {
  const all = await hosts();
  if (args[0] === 'name') {
    const [, which, ...rest] = args;
    const name = rest.join(' ').trim();
    const h = all.find((x, i) => String(i + 1) === which || x.profile === which);
    if (!which || !h?.profile) {
      console.error('Usage: agentic-routines profiles name <number or id> <name>   (numbers are from "agentic-routines profiles")');
      process.exit(1);
    }
    await setName(h.profile, name);
    console.log(name ? `Named “${name}”.` : 'Name removed.');
    return;
  }
  if (!all.length) {
    console.log('No browser with Agentic Routines is open. Open the browser, then its panel once.');
    return;
  }
  const rows = await Promise.all(all.map(async (h, i) => `${i + 1}. ${await profileLabel(h)}  (${h.browser}${h.email ? `, ${h.email}` : ''})  id=${h.profile ?? h.pid}`));
  console.log(rows.join('\n'));
  if (all.length > 1) console.log('\nAn agent works in the profile you used last. It can switch with the browser_profile tool, or start with AGENTIC_ROUTINES_PROFILE=<name>.');
}
