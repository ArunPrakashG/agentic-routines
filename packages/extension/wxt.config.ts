import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

// The public key pins the unpacked extension id (fafmcnlaedchfncjiimcndjlfphdfkdo),
// which the native host manifest allows. The private key is not in the repo.
const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqbu+qVmFQjwSMU5UCg/t6JzebfwLbANF4g+gl5MVCW0GhE3TgAJH0549j4Jfw2xLAyBbP9abNSsgdiagHIYn5WWa61dJ+dNqNQenQSdKBKzG9il3Jc6yill2/VN1OP2cg5UPxWoaL62E/Tcm4rdPvqEhfO6PdeQaD6dJ3wS0M9DR1gGd0soDOnNQBVOL5Y5rnLYqQEWB3yXRdUKsOO8bGFn60oRrdWkqJzswlhLc88+eAjtIoCMocmhi4xfY4BSMsFg++lMYBIWHj9vSHyGgeVOzlZjac1ENKPvpFxHH2daKjdD3DxelXa//wr62upirXIzLI9iYm/7AWHt/unWIawIDAQAB';

export default defineConfig({
  vite: () => ({ plugins: [preact()] }),
  manifest: ({ browser }) => ({
    name: 'Browser Routines',
    description: 'Record a browser task once from your agent, replay it without the model.',
    permissions: ['nativeMessaging', 'tabs', 'scripting', 'storage', 'identity', ...(browser === 'firefox' ? [] : ['sidePanel', 'debugger'])],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Browser Routines' },
    commands: {
      record: { suggested_key: { default: 'Alt+Shift+R' }, description: 'Start or stop recording' },
    },
    ...(browser === 'firefox'
      ? { browser_specific_settings: { gecko: { id: 'browser-routines@browser-routines.dev', strict_min_version: '128.0' } } }
      : { key: KEY }),
  }),
});
