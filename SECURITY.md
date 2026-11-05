# Security

## Reporting a problem

Please do not open a public issue for a security problem. Use GitHub's private
vulnerability reporting on this repository (Security tab, "Report a vulnerability"),
or email arun.prakash.456789@gmail.com.

Include what you found, how to reproduce it, and what it lets someone do. You will get
a reply within a few days. Once it is fixed you are welcome to be credited.

## What is in scope

- The directory API (`apps/api`): sign-in, sessions, publishing, review, blocks.
- The extension and the CLI: what a routine can make them do on a person's machine.
- Routines in the directory that leave their site, read local files, or hide what they do.

## Secrets

No credentials belong in this repository. The Google OAuth client secret and the
signing key live only in the server's environment. If you find one in the history,
please report it privately.
