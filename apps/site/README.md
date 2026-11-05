# Site

The marketing site and the public directory. Astro, built to static files, no server.

- `/` the home page. `/guidelines` and `/privacy` are built from `docs/directory-guidelines.md` and `docs/privacy.md`.
- `/directory`, `/r?o=owner&n=name` and `/u?h=handle` read the public API in the browser. They are not indexed (`r` and `u`); the directory page is.
- `PUBLIC_API_URL` points them at another API (default: the production one). `SITE_URL` sets the canonical address and the sitemap.

```bash
pnpm --filter @browser-routines/site dev     # http://127.0.0.1:4321
pnpm --filter @browser-routines/site build   # apps/site/dist
```
