# API

Accounts and the directory for Agentic Routines. A small Go service: sign-in (Google, GitHub, Microsoft, or email and password), short-lived access tokens, rotating refresh tokens, and the public directory of published routines.

It runs on Postgres and Redis, in one 16 MB image, and idles around 4 MiB.

## Endpoints

All under `/api/v1`, all JSON, all `Cache-Control: no-store`.

| Method | Path | What it does |
|---|---|---|
| GET | `/auth/providers` | Which ways of signing in are on, with their public client ids, and whether email and password is on. |
| POST | `/auth/google` | Takes the Google authorization code, its PKCE verifier and nonce, and the install id. Returns tokens and the account. |
| POST | `/auth/github` | The same for GitHub (`code`, `code_verifier`, `redirect_uri`, `install_id`; `nonce` is ignored). Only when the GitHub client is set. |
| POST | `/auth/microsoft` | The same for Microsoft, with the nonce checked in the ID token. Only when the Microsoft client is set. |
| POST | `/auth/password/code` | `{email}`. Mails a six digit code, good for ten minutes. Answers `202` whatever the address, and mails at most three an address in fifteen minutes. |
| POST | `/auth/password/set` | `{email, code, password, install_id}`. With the right code, makes the account for the address, adds a password to the account that already has that verified address, or replaces its password and ends its other sessions. |
| POST | `/auth/password/login` | `{email, password, install_id}`. Eight wrong passwords for an address stop it for fifteen minutes; setting a password with a mailed code lifts that. |
| POST | `/auth/refresh` | Swaps a refresh token for a new pair. A reused token ends the session. |
| POST | `/auth/signout` | Ends the session. |
| GET | `/me` | The signed-in account. Needs `Authorization: Bearer` and `x-install-id`. |
| DELETE | `/me` | Deletes the account, its sessions and everything it published. |
| PUT | `/me/handle` | Claims the handle that owns published routines. Once per account. |
| GET | `/me/routines` | What the account has live, and whether an admin switched it off. |
| GET | `/me/submissions` | Everything the account has sent for review, newest first, with the guideline and note of a rejection. |
| DELETE | `/me/submissions/{id}` | Withdraws a submission that is still waiting. |
| PUT | `/routines/{name}` | Sends a routine, or the next version of it, for review. Needs a handle. Answers `202` with the submission, `status: "pending"`. Nothing is public until a person approves it. |
| DELETE | `/routines/{name}` | Takes one of the account's routines down, and withdraws anything of its that is waiting. |
| GET | `/routines?q=&site=` | Public. Search by words, or by the site a person is on. |
| GET | `/routines/{owner}/{name}` | Public. The routine in full. |
| POST | `/routines/{owner}/{name}/installs` | Public. Counts an install, reported by the installer. |
| GET | `/blocklist` | Public, cached for five minutes. Blocked publishers, blocked Git repositories, and routines that are blocked or switched off, so a client can turn off what it installed from them. |
| GET | `/healthz` | Database check, outside `/api/v1`. |

## Sign-in

An account has one or more identities: a provider and the provider's id for the person (`google`, `github`, `microsoft`, or `password` with the lower-case email as the id). Rules:

- A new identity with a **verified** email joins the account that already has that verified email. Google, GitHub (the primary verified address from the API) and a mailed code count as verified.
- **Microsoft's email claim is never trusted.** A tenant admin can set it to anything, so a Microsoft identity never joins another account and never makes a reviewer. Its id is `tenant:sub`.
- A reviewer must have a verified email in `ADMIN_EMAILS`.
- Passwords are argon2id (19 MiB, 2 passes), at most two hashing at once. They need 10 to 128 characters and have no other rule. An unknown address costs the same time as a wrong password and gets the same answer.
- Setting a password always needs a code mailed to the address, so nobody can register an address they do not control.
- Blocking a publisher blocks every identity of the account (`kind=account`, value `provider:subject`, such as `google:1234`). Email accounts are cheap to make, so this is weaker against someone who starts over with a new address than it was when Google was the only way in.
- Email and password is off unless `SMTP_ADDR` is set. GitHub and Microsoft are off unless both halves of their client are set.

## Review

Every submission is read by a person before it goes live, every time, whoever sent it. Publishing only adds a pending submission. Approving it is what writes the routine to the live table, so search, install and the block list never see anything that was not approved. An update to a live routine is a new submission, and the approved version stays live while it waits. A newer submission replaces the one waiting, and a publisher can have ten waiting at a time and thirty submissions a day. Rejections carry a guideline number G1 to G8 (see `docs/directory-guidelines.md`) and a note.

The reviewers are the accounts whose email is in `ADMIN_EMAILS`. Anyone else gets a 404 from `/admin`.

| Method | Path | What it does |
|---|---|---|
| GET | `/admin/submissions?status=` | The queue: `pending` (oldest first, the default), `approved`, `rejected`, `withdrawn` or `all`. |
| GET | `/admin/submissions/{id}` | One submission in full, the automatic checks, the live copy to compare with, and what the publisher has done before. |
| POST | `/admin/submissions/{id}/approve` | Puts it live. The shape is checked again first. |
| POST | `/admin/submissions/{id}/reject` | `{guideline, note}`. |
| GET | `/admin/routines?status=` | Live routines: `live`, `disabled` or `all`. |
| POST | `/admin/routines/{owner}/{name}/disable` | `{reason}`. Hidden from the directory at once; an update does not switch it back on. |
| POST | `/admin/routines/{owner}/{name}/enable` | Switches it back on. |
| DELETE | `/admin/routines/{owner}/{name}` | Deletes it. |
| GET / PUT / DELETE | `/admin/blocks` | Blocks on a publisher (handle), a Git repository (https address) or one routine (`owner/name`). `PUT {kind, value, reason}`, `DELETE ?kind=&value=`. |
| GET | `/admin/audit` | The last hundred decisions and who made them. |

The automatic checks (shape, one site, fixed values typed in, anything that looks like a key, final actions without a pause) only tell the reviewer where to look. None of them approves anything.

Publishing checks the shape and rebuilds it field by field, so nothing unexpected is stored: the description needs a "Use when" clause, every step and recorded page must be on the routine's site, and there are caps on steps, size and routines per account. Example values never leave the machine. Readers should still run the same checks on what they fetch.

Access tokens last 15 minutes and are bound to the install id. Refresh tokens last 60 days, are stored hashed and rotate on every use. The `/auth/*` routes allow 30 requests a minute per visitor, counted in Redis; reads, writes and install counts have limits of their own. If Redis is down the limit is skipped, not the sign-in.

## Config

Environment variables. The service refuses to start without the first five.

| Name | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection string |
| `TRUSTED_PROXY` | Host name of the proxy whose `X-Client-IP` is believed. Empty believes nobody and uses the connection's address |
| `GOOGLE_CLIENT_ID` | Public, same value as in the extension |
| `GOOGLE_CLIENT_SECRET` | From the Google client JSON in `.keys/` |
| `SESSION_SECRET` | At least 32 characters, signs access tokens |
| `ADMIN_EMAILS` | Optional. Comma-separated emails that may review submissions. The account needs that email verified |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Optional, both or neither. A GitHub OAuth app whose callback is the extension's `chromiumapp.org` address |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Optional, both or neither. A Microsoft Entra app registered as a web app for any organization and personal accounts, with the same callback |
| `SMTP_ADDR`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Optional. `host:port` of a mail server that offers STARTTLS (587), and the sender. Turns on email and password. `SMTP_USER` may be empty for a relay on the same network |
| `PORT` | Default 8080 |

Migrations in `migrations/` are embedded and run at start, under an advisory lock.

## Test

```bash
pnpm e2e:api
```

Builds the binary, starts throwaway Postgres and Redis containers and stand-ins for Google, GitHub, Microsoft and a mail server, and checks the whole flow: bad codes and ID tokens are refused, tokens are bound to the install, refresh rotation and reuse, a restart keeps sessions, the rate limit, and the request size limit. It ends with a throughput line.

## Deploy

```bash
apps/api/deploy/deploy.sh
```

Builds the image here, ships it over ssh, restarts the container and waits for it to be healthy. The tag is the date and commit, and the three newest images stay. It refuses to run with uncommitted changes under `apps/api`.

The website is deployed separately with `apps/site/deploy/deploy.sh`: it builds the static site, ships it to `the deploy folder's site/www/releases/<tag>`, moves the `current` symlink, keeps the three newest releases and purges the edge cache. It runs in its own 32 MB Caddy container next to the API.

## First-time server setup

The deploy script assumes these exist. They are done once.

1. A database and a role named `browserroutines` in the shared Postgres (the name from before the project was renamed; nothing depends on it matching).
2. `the deploy folder's .env` on the server, mode 600, with the names in the config table.
3. A block in the main Caddy config for `agenticroutines.arunprakashg.com`: the security headers snippet, compression, a 32 KB request body limit on `/api/*`, a reverse proxy to the container for `/api/*` and `/healthz` with `X-Client-IP` set from Caddy's client address, and a reverse proxy to `agenticroutines-site:8080` (the website, see `apps/site`) for everything else.
4. A proxied DNS record for the name in Cloudflare.
5. Three Cloudflare cache rules for that host, in this order, after the zone's catch-all "cache everything" rule (later rules win): respect origin cache headers for the host; no caching for `/api/*` and `/healthz`; respect origin for `/api/v1/blocklist` (public, five minutes). The website sets its own headers: built files under `/_astro/` are immutable for a year, pages revalidate in the browser and stay five minutes on the edge, and `apps/site/deploy/deploy.sh` purges the host after a release.

Firefox needs its own redirect URL added to each provider's client before sign-in works there.
