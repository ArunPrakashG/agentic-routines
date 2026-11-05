import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

// The public key pins the unpacked extension id (fafmcnlaedchfncjiimcndjlfphdfkdo),
// which the native host manifest allows. The private key is not in the repo.
// Store builds (AR_STORE=1) leave it out, as each store assigns its own id.
const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqbu+qVmFQjwSMU5UCg/t6JzebfwLbANF4g+gl5MVCW0GhE3TgAJH0549j4Jfw2xLAyBbP9abNSsgdiagHIYn5WWa61dJ+dNqNQenQSdKBKzG9il3Jc6yill2/VN1OP2cg5UPxWoaL62E/Tcm4rdPvqEhfO6PdeQaD6dJ3wS0M9DR1gGd0soDOnNQBVOL5Y5rnLYqQEWB3yXRdUKsOO8bGFn60oRrdWkqJzswlhLc88+eAjtIoCMocmhi4xfY4BSMsFg++lMYBIWHj9vSHyGgeVOzlZjac1ENKPvpFxHH2daKjdD3DxelXa//wr62upirXIzLI9iYm/7AWHt/unWIawIDAQAB';

const STORE = !!process.env.AR_STORE;

export default defineConfig({
  // Release builds write somewhere else so they never disturb the unpacked build.
  outDir: process.env.AR_OUT ?? '.output',
  // The source Firefox Add-ons asks for: enough of the workspace to build the extension, and nothing else.
  zip: {
    sourcesRoot: '../..',
    excludeSources: ['**/node_modules/**', '**/.output/**', '**/.wxt/**', '**/.env*', '.git/**', '.dev/**', '.keys/**', 'apps/**', 'dev/**', 'design/**', 'releases/**', 'packages/cli/**', 'agentic-routines.md'],
  },
  vite: () => ({ plugins: [preact()] }),
  manifest: ({ browser }) => ({
    name: 'Agentic Routines',
    description: 'Record a browser task once from your agent, replay it without the model.',
    homepage_url: 'https://github.com/ArunPrakashG/agentic-routines',
    ...(browser === 'firefox' ? {} : { minimum_chrome_version: '116' }),
    permissions: ['nativeMessaging', 'tabs', 'scripting', 'storage', 'identity', ...(browser === 'firefox' ? [] : ['sidePanel', 'debugger'])],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Agentic Routines' },
    commands: {
      record: { suggested_key: { default: 'Alt+Shift+R' }, description: 'Start or stop recording' },
    },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'agentic-routines@agentic-routines.dev',
              strict_min_version: '128.0',
              // Nothing leaves the browser except a Google sign-in, which is optional.
              data_collection_permissions: { required: ['none'], optional: ['authenticationInfo', 'personallyIdentifyingInfo'] },
            },
          },
        }
      : STORE
        ? {}
        : { key: KEY }),
  }),
});
