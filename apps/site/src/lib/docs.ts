import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';

// The pages of the documentation, in reading order. Each is docs/guide/<slug>.md in the repository.
export const pages = [
  { slug: 'getting-started', title: 'Getting started', summary: 'Add the extension, connect your agent, record a first routine.' },
  { slug: 'how-it-works', title: 'How it works', summary: 'What is recorded, what a save changes, and how a replay checks each step.' },
  { slug: 'refine', title: 'Refine a routine', summary: 'How an agent proposes, edits, tests and saves a routine, and what the extension refuses.' },
  { slug: 'routines', title: 'Routine format', summary: 'ROUTINE.md, parameters, pauses and the steps behind a routine.' },
  { slug: 'hooks', title: 'Hooks and instructions', summary: 'Notes for the agent, and code that runs on events during a replay, with what it may do and how it is approved.' },
  { slug: 'tools', title: 'Agent tools', summary: 'Every tool the MCP server gives your agent.' },
  { slug: 'cli', title: 'Command line', summary: 'setup, doctor, sources and export.' },
  { slug: 'repositories', title: 'Routine repositories', summary: 'config.routine: what a Git repository of routines says about itself, with a full example.' },
  { slug: 'sharing', title: 'Sharing and publishing', summary: 'The directory, GitHub repositories and what review involves.' },
  { slug: 'development', title: 'Development', summary: 'Repository layout, running it locally and adding a browser.' },
] as const;

export async function render(slug: string): Promise<{ title: string; html: string }> {
  // Relative to the site's folder, which is where astro runs: the built chunk's own location moves between Astro versions.
  const md = readFileSync(join(process.cwd(), '../../docs/guide', `${slug}.md`), 'utf8');
  const title = md.match(/^# (.*)$/m)?.[1] ?? slug;
  return { title, html: await marked.parse(md.replace(/^# .*\n/, '')) };
}
