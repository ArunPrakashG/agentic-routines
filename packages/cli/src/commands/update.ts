import { autoOn, hasKey, launcher, setAuto, updateNow, updateState, version } from '../update.ts';

const USAGE = `Usage:
  agentic-routines update          Look for a new version now and install it
  agentic-routines update status   What is installed and when it last looked
  agentic-routines update off      Stop updating by itself
  agentic-routines update on       Update by itself when idle, which is the default`;

export async function runUpdate(args: string[]): Promise<void> {
  const [what] = args;
  if (!what) return console.log(await updateNow());
  if (what === 'status') {
    const s = updateState();
    console.log(`Version ${version()}, ${launcher() ? 'from the install script' : 'not from the install script, so it does not update itself'}.`);
    if (launcher()) console.log(`Updates by itself: ${!hasKey() ? 'no, this build has no release key' : autoOn() ? 'yes, when idle' : 'no, turned off'}.`);
    if (s.checkedAt) console.log(`Last looked ${new Date(s.checkedAt).toISOString()}${s.error ? `, and it failed: ${s.error}` : ''}.`);
    return;
  }
  if (what !== 'on' && what !== 'off') throw new Error(USAGE);
  // Not something an agent gets to decide. There is no tool for it either.
  if (!process.stdin.isTTY) throw new Error('Run this yourself in a terminal, so that an agent cannot change it.');
  setAuto(what === 'on');
  console.log(what === 'on' ? 'It updates by itself when idle.' : 'It stays on this version until you run: agentic-routines update');
}
