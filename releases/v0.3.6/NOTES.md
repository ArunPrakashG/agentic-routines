# 0.3.6

## No more approvals
- A replay no longer pauses. Every recorded step runs, including send, submit, delete, pay and publish, for your routines and for routines from other people.
- A replay no longer stops for a dialog or a row that looks irreversible, and routines from other people no longer stop at steps that use a saved secret.
- Installing from Git or the directory, and publishing, no longer wait for a click in the side panel. A publish still waits if your account has no handle yet.
- A routine's hooks run as soon as it is installed. No review step.
- `agentic-routines session allow`, `session write` and `update on|off` no longer ask for a terminal or a typed yes. The `session_allowlist` tool can widen a session.
- `routine_test` still skips steps that would pause, so a test of a draft never submits or deletes.

## Kept
- Untrusted-content filtering, site limits, secret masking, file limits and the own-site check on routines.
