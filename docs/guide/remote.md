# A browser on another machine

The agent can run on a server while the browser stays on your own computer, with your sign-ins.

## Set it up

On the machine with the browser, in a terminal:

```bash
agentic-routines remote listen 100.64.0.2
agentic-routines remote pair
```

Give it the address it should listen on, such as your Tailscale address, or `0.0.0.0` for all of them. `pair` prints a code that works once, for 10 minutes.

On the machine with the agent:

```bash
agentic-routines remote connect 100.64.0.2 ABCD-1234 --name laptop
```

The browser then shows up in `browser_profile` under that name. When no browser is open on the agent's machine it is the one used, and `AGENTIC_ROUTINES_PROFILE=laptop` chooses it when one is.

Each browser profile has a host of its own, which takes the next free port. `remote status` lists them, and `remote connect` takes `address:port`.

## The link is not encrypted

We do not encrypt this link. Pairing gives each browser profile a key of its own, and on every connection both sides prove they hold it, the host first, without sending it. That keeps strangers out. After that, everything passes in the open, and someone on the path can read it and change it: page contents, what the agent types, and any stored secret a routine uses.

So run it over [Tailscale](https://tailscale.com) or [WireGuard](https://www.wireguard.com), or on a network you trust. Do not open the port to the internet.

## What stays on the browser's machine

- The DevTools address. `cdp_endpoint` and `execute` are not available over the link, and a fast run becomes a normal replay.
- Its files. `upload` is not available, and recordings and captures are written over there.
- Its routines, secrets and settings. A routine you save is kept on both machines. One you refine with `from_routine` has to be on the browser's machine.

The other machine can do on that browser what an agent on it could, within the limits on [Safety](safety.md). Pausing, handing over and the side panel all work the same.

## Turning it off

`agentic-routines remote revoke <id>` takes a key back and closes its connections. `agentic-routines remote stop` stops listening. Keys sit in `remote/` in the Agentic Routines folder, as plain files only you can read.
