import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { paths } from './paths.ts';

// Whether screenshots are annotated: a box, number and label on what the agent acted on. Off unless
// AGENTIC_ROUTINES_MARK is set or `agentic-routines marks on` made the flag file, checked on every call.

export function marksOn(): boolean {
  const e = process.env.AGENTIC_ROUTINES_MARK;
  if (e) return !/^(0|false|off|no)$/i.test(e);
  return existsSync(paths.marksFlag());
}

export function setMarks(on: boolean): void {
  mkdirSync(paths.root(), { recursive: true });
  if (on) writeFileSync(paths.marksFlag(), `${new Date().toISOString()}\n`);
  else rmSync(paths.marksFlag(), { force: true });
}
