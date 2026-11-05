# API

Accounts and the directory for Browser Routines. A small Go service: Google sign-in, short-lived access tokens, rotating refresh tokens, and the public directory of published routines.

It runs on Postgres and Redis, in one 16 MB image, and idles around 4 MiB.

## Endpoints

All under `/api/v1`, all JSON, all `Cache-Control: no-store`.

| Method | Path | What it does |
|---|---|---|
| POST | `/auth/google` | Takes the Google authorization code, its PKCE verifier and nonce, and the install id. Returns tokens and the account. |
| POST | `/auth/refresh` | Swaps a refresh token for a new pair. A reused token ends the session. |
| POST | `/auth/signout` | Ends the session. |
| GET | `/me` | The signed-in account. Needs `Authorization: Bearer` and `x-install-id`. |
| DELETE | `/me` | Deletes the account, its sessions and everything it published. |
| PUT | `/me/handle` | Claims the handle that owns published routines. Once per account. |
| GET | `/me/routines` | What the account has published. |
| PUT | `/routines/{name}` | Publishes a routine, or the next version of it. Needs a handle. |
| DELETE | `/routines/{name}` | Takes one of the account's routines down. |
| GET | `/routines?q=&site=` | Public. Search by words, or by the site a person is on. |
| GET | `/routines/{owner}/{name}` | Public. The routine in full. |
| POST | `/routines/{owner}/{name}/installs` | Public. Counts an install, reported by the installer. |
| GET | `/healthz` | Database check, outside `/api/v1`. |

Publishing checks the shape and rebuilds it field by field, so nothing unexpected is stored: the description needs a "Use when" clause, every step and recorded page must be on the routine's site, and there are caps on steps, size and routines per account. Example values never leave the machine. Readers should still run the same checks on what they fetch.

Access tokens last 15 minutes and are bound to the install id. Refresh tokens last 60 days, are stored hashed and rotate on every use. The `/auth/*` routes allow 30 requests a minute per visitor, counted in Redis; reads, writes and install counts have limits of their own. If Redis is down the limit is skipped, not the sign-in.

## Config

Environment variables. The service refuses to start without the first five.

| Name | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection string |
| `GOOGLE_CLIENT_ID` | Public, same value as in the extension |
| `GOOGLE_CLIENT_SECRET` | From the Google client JSON in `.keys/` |
| `SESSION_SECRET` | At least 32 characters, signs access tokens |
| `PORT` | Default 8080 |

Migrations in `migrations/` are embedded and run at start, under an advisory lock.

## Test

```bash
pnpm e2e:api
```

Builds the binary, starts throwaway Postgres and Redis containers and a stand-in for Google, and checks the whole flow: bad codes and ID tokens are refused, tokens are bound to the install, refresh rotation and reuse, a restart keeps sessions, the rate limit, and the request size limit. It ends with a throughput line.

## Deploy

```bash
apps/api/deploy/deploy.sh
```

Builds the image here, ships it over ssh, restarts the container and waits for it to be healthy. The tag is the date and commit, and the three newest images stay. It refuses to run with uncommitted changes under `apps/api`.

## First-time server setup

The deploy script assumes these exist. They are done once.

1. A database and a role named `browserroutines` in the shared Postgres.
2. `~/infra/apps/browserroutines/.env` on the server, mode 600, with the names in the config table.
3. A block in the main Caddy config for `browserroutines.arunprakashg.com`: the security headers snippet, compression, a 32 KB request body limit on `/api/*`, a reverse proxy to the container with `X-Client-IP` set from Caddy's client address, and a 404 for everything else.
4. A proxied DNS record for the name in Cloudflare.
5. A Cloudflare cache rule for that host with caching off. The zone has a catch-all "cache everything" rule, and later rules win, so this one has to come after it.

Firefox needs its own redirect URL added to the Google client before sign-in works there.
