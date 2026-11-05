// Reloads the unpacked extension in a running browser, so a new build takes effect. Usage: node dev/reload-extension.mjs <store>
import { connect } from 'node:net';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const hosts = join(process.argv[2], 'hosts');
const socks = readdirSync(hosts).filter((f) => f.endsWith('.sock')).map((f) => join(hosts, f));
const sock = socks.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const c = connect(sock, () => c.write(JSON.stringify({ id: 1, method: 'extension.reload', params: {} }) + '\n'));
c.on('data', (d) => {
  const m = JSON.parse(String(d).split('\n')[0]);
  console.log(m.error ? `Could not reload: ${m.error.message ?? m.error}` : 'Reloading.');
  process.exit(m.error ? 1 : 0);
});
c.on('error', (e) => {
  console.log(`Could not reach the host: ${e.message}`);
  process.exit(1);
});
setTimeout(() => {
  console.log('The browser did not answer.');
  process.exit(1);
}, 5000);
