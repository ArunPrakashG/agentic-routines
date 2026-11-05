// SessionStart hook: puts the browser guidance in front of the agent from the first message.
// A skill only loads when the agent decides to, and the agent often does not for a plain "open this page".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.CLAUDE_PLUGIN_ROOT;
if (!root) process.exit(0);
let body;
try {
  body = readFileSync(join(root, 'skills/agentic-routines/SKILL.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
} catch {
  process.exit(0);
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: body } }));
