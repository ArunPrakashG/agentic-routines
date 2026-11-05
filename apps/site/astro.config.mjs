import { defineConfig } from 'astro/config';

// The public address is not decided yet; set SITE_URL when building for it.
export default defineConfig({
  site: process.env.SITE_URL || 'https://browserroutines.arunprakashg.com',
  output: 'static',
  trailingSlash: 'never',
  build: { format: 'file' },
  devToolbar: { enabled: false },
});
