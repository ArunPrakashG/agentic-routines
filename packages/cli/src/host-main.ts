import { runHost } from './host.ts';

// The host as one file with no dependencies. Setup copies it somewhere stable, as npx prunes its cache.
runHost();
