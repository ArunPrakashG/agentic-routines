import { checkFetched, stringifyRoutineFile } from '@agentic-routines/core';
import * as sources from './sources.ts';
import * as store from './store.ts';

// agentic-routines sources [add <address> | remove <address> | on <address> | off <address>]
// agentic-routines export <routine>
// Installing from a source is not here: it needs the person's click in the browser.

export async function runSources(args: string[]): Promise<void> {
  const [cmd, address] = args;
  if (!cmd || cmd === 'list') {
    const { directory, sources: all } = await sources.list();
    console.log(`Directory · reviewed by Agentic Routines · ${directory ? 'on' : 'off'}`);
    for (const s of all) {
      const state = !s.enabled ? 'off' : s.error ? `could not be read: ${s.error}` : `${s.routines ?? 0} routines`;
      console.log(`${s.id} · ${s.kind === 'folder' ? 'local folder' : 'GitHub'} · not reviewed · ${state}`);
    }
    console.log('\nAdd one with: agentic-routines sources add github.com/owner/repository');
    return;
  }
  if (!address) throw new Error(`Usage: agentic-routines sources ${cmd} <address>`);
  if (cmd === 'add') {
    const s = await sources.add(address);
    console.log(`Added ${s.id}. Nothing from it is installed until you click Install in the side panel.`);
    return;
  }
  const id = address === 'directory' ? 'directory' : (await sources.find(address))?.id;
  if (!id) throw new Error('That source is not in your list.');
  if (cmd === 'remove') await sources.remove(id);
  else if (cmd === 'on' || cmd === 'off') await sources.setEnabled(id, cmd === 'on');
  else throw new Error('Use list, add, remove, on or off.');
  console.log('Done.');
}

/** Prints a routine as the one file a Git source holds, ready to commit under routines/. */
export async function runExport(args: string[]): Promise<void> {
  if (!args[0]) throw new Error('Usage: agentic-routines export <routine>');
  const r = await store.read(args[0]);
  // The same checks the person who installs it will run, so a problem is found here first.
  const problems = checkFetched(r);
  if (problems.length) throw new Error(`Fix this first: ${problems.join(' ')}`);
  process.stdout.write(stringifyRoutineFile({ meta: { ...r.meta, owner: undefined }, body: r.body, steps: r.steps }));
}
