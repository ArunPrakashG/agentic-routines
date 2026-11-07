import { ensureListener, listenConfig, listenerState, pairedBrowsers, revokeBrowser, runListener, setListenConfig, startPairing } from '../host/remote.ts';

const USAGE = `Usage:
  agentic-routines remote pair [address[:port]]  Listen, and make a code for a browser on another computer to enter
  agentic-routines remote start                  Listen again, as set up before
  agentic-routines remote status                 What is listening, and the browsers paired with this computer
  agentic-routines remote revoke <id>            Take a browser's key back and close its connection
  agentic-routines remote stop                   Stop listening. Paired browsers try again until you start it again`;

export async function runRemote(args: string[]): Promise<void> {
  const [what, arg] = args;
  switch (what) {
    case 'serve':
      return runListener();
    case 'pair':
      console.log((await startPairing(arg)).text);
      return;
    case 'status': {
      const config = listenConfig();
      const on = listenerState();
      console.log(on ? `Listening on ${on.address}:${on.port}.` : config ? `Set to listen on ${config.address}:${config.port}, but nothing is listening. It starts with the next agent, or with "remote pair".` : 'Not listening.');
      const paired = Object.entries(pairedBrowsers());
      for (const [id, b] of paired) console.log(`  ${id}  ${b.name}, paired ${new Date(b.pairedAt).toISOString().slice(0, 10)}${on?.connected.some((c) => c.id === id) ? ', connected' : ''}`);
      if (!paired.length) console.log('No browser is paired.');
      return;
    }
    case 'revoke':
      if (!arg) throw new Error(USAGE);
      if (!revokeBrowser(arg)) throw new Error(`No browser is paired with the id ${arg}. "remote status" lists them.`);
      console.log('Taken back. Its connection closes within a few seconds.');
      return;
    case 'stop':
      setListenConfig(null);
      console.log('It stops within a few seconds.');
      return;
    case 'start':
      await ensureListener();
      return;
    default:
      throw new Error(USAGE);
  }
}
