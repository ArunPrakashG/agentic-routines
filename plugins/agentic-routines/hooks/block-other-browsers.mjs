// PreToolUse hook: when the user has asked for Agentic Routines to be the only browser
// (`npx agentic-routines setup --exclusive`), refuse other browser tools and say why.
// It does nothing otherwise, and never looks at tools that are not browsers.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OTHER = /(claude-in-chrome|claude_in_chrome|claude_browser|playwright|puppeteer|chrome-devtools|browsermcp|browser-mcp|browser-use|browserbase|stagehand|selenium)/i;

function exclusive() {
  try {
    const root = process.env.AGENTIC_ROUTINES_HOME || join(homedir(), '.agentic-routines');
    return JSON.parse(readFileSync(join(root, 'agents.json'), 'utf8'))?.claude?.exclusive === true;
  } catch {
    return false;
  }
}

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let name = '';
  try {
    name = JSON.parse(input).tool_name ?? '';
  } catch {
    return;
  }
  if (!name.startsWith('mcp__') || /agentic-routines/i.test(name) || !OTHER.test(name) || !exclusive()) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Blocked: this machine is set to use Agentic Routines for all browser work. Use the agentic-routines tools instead (routines_search and the rt_ tools first, then navigate, read_page, click, type). To allow other browser tools again, the user runs: npx agentic-routines setup --no-exclusive',
      },
    }),
  );
});
