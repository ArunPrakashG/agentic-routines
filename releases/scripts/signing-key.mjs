// Makes the key that signs release manifests. Run it once, and keep the private half safe.
// A copy built with the public half only updates itself from what that key signed. Lose it and installed copies stop updating.
// Usage: node releases/scripts/signing-key.mjs
//
//   .keys/update-signing.pem     Private, and ignored by git. Keep a copy somewhere safe
//   releases/update-key.pub      Public. Commit it: the CLI build reads it
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { releases, root } from './lib.mjs';

const secret = join(root, '.keys', 'update-signing.pem');
if (existsSync(secret)) {
  console.error(`${secret} is there already. Replacing it would strand every installed copy, so move it away yourself if you mean it.`);
  process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
mkdirSync(join(root, '.keys'), { recursive: true, mode: 0o700 });
writeFileSync(secret, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(join(releases, 'update-key.pub'), `${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}\n`);
console.log(`Private key: ${secret}\nPublic key: releases/update-key.pub. Commit that one, and keep a copy of the private one somewhere safe.`);
