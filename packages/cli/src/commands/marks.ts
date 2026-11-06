import { marksOn, setMarks } from '../marks.ts';

// `marks on|off|status` turns annotated screenshots on or off.

export function runMarks(args: string[]): void {
  const [what = 'status'] = args;
  if (what === 'on' || what === 'off') {
    setMarks(what === 'on');
    console.log(what === 'on' ? 'Annotated screenshots on. A screenshot after a click, type or select shows a numbered box and label on what was acted on.\nNo restart needed.' : 'Annotated screenshots off.');
  } else if (what === 'status') {
    const via = process.env.AGENTIC_ROUTINES_MARK ? 'AGENTIC_ROUTINES_MARK is set' : 'turned on with "marks on"';
    console.log(marksOn() ? `Annotated screenshots: on (${via}).` : 'Annotated screenshots: off. Turn on with: agentic-routines marks on');
  } else {
    console.error('Usage: agentic-routines marks [on|off|status]');
    process.exit(1);
  }
}
