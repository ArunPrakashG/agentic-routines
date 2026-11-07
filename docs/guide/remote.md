# A browser on another computer

The agent can run on a server while the browser stays on your own computer, with your sign-ins. The agent's computer has the agent and this program. The browser's computer needs only the browser and the extension, with nothing to install or run in a terminal there. The extension connects out to an address you enter, and no server of ours is in the middle.

## Set it up

Ask your agent to connect to your browser. It calls `remote_pair` and tells you an address and a code. On the agent's computer you can get the same from a terminal:

```bash
agentic-routines remote pair
```

On the computer with the browser, open the Agentic Routines side panel, then Settings, and under Another computer enter the two. The code works once, for 10 minutes. If the extension has no companion program there, the panel shows the same form under "My agent is on another computer".

The browser then shows up in `browser_profile` as "on another computer". When no browser is open on the agent's computer it is the one used.

The agent's computer has to be reachable from the browser's:

- **Tailscale.** With Tailscale on the agent's computer, `remote pair` listens on its Tailscale address by itself.
- **An SSH tunnel.** With no private network, `remote pair` listens only to itself and prints the command. Run it on the browser's computer and leave it running: `ssh -N -L 47931:127.0.0.1:47931 <the agent's computer>`. Then enter `127.0.0.1:47931`.
- **Another address.** `agentic-routines remote pair 10.0.0.5:47931` listens where you say, such as a WireGuard address.

## The link is not encrypted

We do not encrypt this link. Pairing gives each browser a key of its own, and on every connection both sides prove they hold it, the agent's side first, without sending it. That keeps strangers out. After that, everything passes in the open, and someone on the path can read it and change it: the pages you have open, what is typed, and the agent's commands.

So use [Tailscale](https://tailscale.com), [WireGuard](https://www.wireguard.com) or an SSH tunnel. Do not open the port to the internet. If the address you enter is not on a private network, the panel warns you and asks you to confirm.

A website cannot connect to the port, but anyone you give an address and a code to could get you to connect your browser to their computer, and they would then be able to use it with your sign-ins. Connect only to a computer of your own.

## What crosses the link

To agents, this browser is like one on their own computer. The DevTools address from `cdp_endpoint`, `execute` and fast runs stay on the agent's computer and reach the browser through the link. Routines, recordings and captures are kept on the agent's computer too.

- **Uploads.** `upload` reads the file on the agent's computer and sends it over in pieces, up to 25 MB at a time. A routine that uploads does the same. For a bigger file, copy it over and let the person attach it. Scripts cannot pass a local path to a file input over the link, and are told to use `upload`.
- **Downloads.** `download` lists what the browser has downloaded since the agent started. Asking for one sends a new request for the same address with that browser's sign-ins, and puts what comes back in `downloads/` in the Agentic Routines folder on the agent's computer, where it stays for 14 days. It is a second request, so it says when the size differs, and an address that works once or that needed a form sent cannot be fetched. The file is still on the browser's computer then, and you have to send it over. A download you start yourself in that browser while the agent is working is on the list too.
- **Secrets.** A secret stored on the agent's computer crosses to the browser only when the agent's side listens on Tailscale or on its own loopback address for a tunnel. On any other address it is refused, and you type it there yourself.
- **Files named in the panel.** A routine you run from the panel on the browser's computer cannot use a path on the agent's computer. Ask the agent to run it.

With an agent on both computers, each one's files and secrets stay with it, and the panel shows the routines of the one on the browser's computer. The extension connects to one other computer at a time.

The paired computer can do on that browser what an agent on it could, within the limits on [Safety](safety.md). Pausing, handing over and the side panel all work the same. A browser you paired can ask the agent's computer for the secrets stored there and for the routines it keeps, so pair only browsers of your own too.

## Turning it off

In the panel, Disconnect closes the link and gives the key back. On the agent's computer, `agentic-routines remote revoke <id>` takes a key back and closes its connection, `agentic-routines remote stop` stops listening, and `agentic-routines remote status` lists the browsers. Keys sit in `remote/` in the Agentic Routines folder, as plain files only you can read, and in the browser's extension storage.

Once set up, it starts listening again with the next agent, or with `agentic-routines remote start`. The extension keeps trying until it gets through.
