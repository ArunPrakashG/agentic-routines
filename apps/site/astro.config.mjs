import { defineConfig } from 'astro/config';

// The public address is not decided yet; set SITE_URL when building for it.
export default defineConfig({
  site: process.env.SITE_URL || 'https://agenticroutines.arunprakashg.com',
  output: 'static',
  trailingSlash: 'never',
  build: { format: 'file' },
  // The site's CSP only allows scripts from its own origin, so small scripts must not be inlined into the page.
  vite: { build: { assetsInlineLimit: 0 } },
  devToolbar: { enabled: false },
});
