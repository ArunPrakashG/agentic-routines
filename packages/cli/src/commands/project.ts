import { relative } from 'node:path';
import * as projects from '../store/projects.ts';

// agentic-routines project [status | add <routine> [--examples] | remove <name> | prune]
// Routines kept in this repository's .agentic-routines folder, so Git tracks them and the team shares them.

const WHAT: Record<projects.ProjectState, string> = {
  new: 'not installed here. Install it from the side panel, or ask your agent to.',
  installed: 'installed',
  changed: 'installed, but the file has changed since. Install it again after reading it.',
};

export async function runProject(args: string[]): Promise<void> {
  const [cmd = 'status', name] = args;
  const rel = (f: string) => relative(process.cwd(), f) || f;
  if (cmd === 'status' || cmd === 'list') {
    const dir = await projects.find();
    if (!dir) {
      console.log(`No ${projects.PROJECT_DIR} folder in this repository.\nShare a routine with: agentic-routines project add <routine>`);
      return;
    }
    const { routines, problems, removed } = await projects.status(dir);
    console.log(`${rel(dir)} · ${routines.length} routines`);
    for (const r of routines) console.log(`  ${r.name} v${r.version} · ${r.site} · ${WHAT[r.state]}`);
    for (const id of removed) console.log(`  ${id} · installed here, but the project no longer has it. Run: agentic-routines project prune`);
    for (const p of problems) console.log(`  problem: ${p}`);
    if (problems.length) process.exitCode = 1;
    return;
  }
  if (cmd === 'add') {
    if (!name) throw new Error('Usage: agentic-routines project add <routine> [--examples]');
    const r = await projects.save(name, { examples: args.includes('--examples') });
    console.log(r.change === 'unchanged' ? `${rel(r.file)} is already up to date.` : `${r.change === 'created' ? 'Added' : 'Updated'} ${rel(r.file)} (version ${r.version}). Review it and commit it, so the team gets it.`);
    return;
  }
  if (cmd === 'remove') {
    if (!name) throw new Error('Usage: agentic-routines project remove <name>');
    console.log(`Removed ${rel(await projects.unshare(name))}. Commit that to take it off the team.`);
    return;
  }
  if (cmd === 'prune') {
    const dir = await projects.find();
    if (!dir) throw new Error(`No ${projects.PROJECT_DIR} folder in this repository.`);
    const gone = await projects.prune(dir);
    console.log(gone.length ? `Uninstalled ${gone.join(', ')}.` : 'Nothing to uninstall.');
    return;
  }
  throw new Error('Use status, add, remove or prune.');
}
