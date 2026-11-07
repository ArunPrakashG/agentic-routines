import * as secrets from '../store/secrets.ts';

// `secrets add` is the one way in, and it reads from the terminal with nothing shown. A value is never an argument, where the shell's history and any process list would keep it.

const USAGE = `Usage:
  agentic-routines secrets add <name> --origin https://example.com [--totp]
  agentic-routines secrets list
  agentic-routines secrets remove <name>`;

function hidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error('This reads the value from a terminal, with nothing shown. Run it yourself, not through an agent.'));
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let v = '';
    const done = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', on);
      stdout.write('\n');
      fn();
    };
    const on = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') return done(() => resolve(v));
        if (c === '\u0003') return done(() => reject(new Error('Nothing was saved.')));
        if (c === '\u007f' || c === '\b') v = v.slice(0, -1);
        else v += c;
      }
    };
    stdin.on('data', on);
  });
}

export async function runSecrets(args: string[]): Promise<void> {
  const [what, name, ...rest] = args;
  if (!what || what === 'list') {
    const all = await secrets.list();
    if (!all.length) return console.log('None. "agentic-routines secrets add <name> --origin <origin>" keeps one for a site.');
    for (const s of all) console.log(`${s.name}  ${s.origin}${s.kind === 'totp' ? '  one-time code' : ''}`);
    return;
  }
  if (what === 'remove' && name) return console.log((await secrets.remove(name)) ? `Removed ${name}.` : `There is no secret called ${name}.`);
  if (what !== 'add' || !name) throw new Error(USAGE);
  const given = rest[rest.indexOf('--origin') + 1];
  if (!rest.includes('--origin') || !given) throw new Error(USAGE);
  const origin = secrets.originOf(given);
  const kind = rest.includes('--totp') ? 'totp' : 'value';
  if (origin.startsWith('http:') && !/\/\/(localhost|127\.0\.0\.1)/.test(origin)) console.log(`${origin} is not encrypted: what is typed there can be read on the network.`);
  const value = await hidden(kind === 'totp' ? `One-time code seed for ${origin} (nothing is shown): ` : `Value for ${origin} (nothing is shown): `);
  if (!value) throw new Error('Nothing was saved.');
  if (kind === 'totp') secrets.totp(value);
  await secrets.add({ name, origin, kind, value });
  console.log(`Saved ${name} for ${origin}. Agents can see the name and use it there. They never get the value.`);
  if (kind === 'totp') console.log('A seed kept next to the password makes two-factor sign-in one factor: anything that can read this folder gets both.');
}
