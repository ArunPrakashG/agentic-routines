# 0.3.7

## History
- Every tool call and browser step is now kept in `~/.agentic-routines/logs/history`, one file per day, even with debug logging off.
- Typed values are not kept. A short hash only shows whether two runs typed the same thing. Nothing is kept for password or file fields, and page addresses lose their query and fragment.
- `agentic-routines history on|off|status|show` turns it on or off and shows recent entries. `doctor` says whether it is on.
- Old debug logs are kept when the log rotates, instead of being overwritten.

## Running routines one after another
- Each routine says where it starts and where it leaves the tab, and names the routines that fit before and after it. Where it ends is learned from its runs.
- After a run, the result says which page the tab is on and which routines start on or open that page.
- If a routine stops after starting on the wrong page, the result says which page it needs and which routine gets there.
- New `keep_page: true` option on routine tools and `routine_run`. When the tab is already on the page a routine opens, it works on that page as it is and does not reload it, so a form the last routine filled stays filled.
