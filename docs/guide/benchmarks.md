# Benchmarks

What a replay saves against the agent doing the same task by hand, measured with a real Claude Code session on a real browser. The runner is [`dev/bench`](../../dev/bench), and the raw results are in `dev/bench/results/*.jsonl`.

## How it is measured

- Each run is one `claude -p` session (Sonnet 5.5) given the task in plain words. Cost, tokens and tool calls are what Claude Code reports, at list prices. Time is wall-clock from start to finish.
- Arms: **by hand** is the agent using the browser tools with no routine; **record** is by hand and then saving the routine; **replay** calls the saved routine; **changed** replays it after one button was renamed, so one step goes back to the agent.
- The side panel's pause is approved at once, so waiting for a person is not counted.
- Token totals include context read back from the prompt cache, which is why they are large.
- Numbers are medians. The samples are small, and costs move by a cent or two between identical runs.

## Replica of a store console

Run on a cloud machine (4 vCPU, 16 GB), median of 3 runs each, all 27 runs finished the task.

| Task | By hand | Replay | Changed button |
|---|---|---|---|
| One form: release a build to testers | 530k tokens, 0:26, $0.10, 16 tool calls | 109k tokens, 0:10, $0.02, 2 tool calls | 226k tokens, 0:23, $0.04, 5 tool calls |
| Long form: every setting | 1.29M tokens, 0:57, $0.29, 41 tool calls | 339k tokens, 0:28, $0.09, 8 tool calls | 381k tokens, 0:38, $0.07, 9 tool calls |

Saving a routine costs more than doing the task once: $0.16 and 19 tool calls on the one form, $0.35 and 45 on the long one.

A replay is not free. The agent still starts a session, finds the routine, calls it and reads the answer, which is about $0.02 before any page work.

## Against Claude in Chrome

Earlier runs on another machine used Claude in Chrome as the by-hand baseline, median of 5 runs. They are not directly comparable with the table above, because the machine and the browser differ.

| Task | Claude in Chrome by hand | Replay |
|---|---|---|
| One form | 430k tokens, 0:46, $0.17, 18 tool calls | 131k tokens, 0:15, $0.04 |
| Long form (one run in five said it was done without starting the rollout) | 879k tokens, 1:32, $0.32, 44 tool calls | 199k tokens, 0:27, $0.06 |
| Edit a YouTube description, on real YouTube | 539k tokens, 0:56, $0.21 | 97k tokens, 0:19, $0.04 |

## When it does not pay

Length decides. A one-step lookup on GitHub used about 70% more tokens as a replay than by hand, because the agent still has to find the routine, call it and read the answer. A short task may never earn back the cost of saving it.

## Run it yourself

```bash
dev/bench/start.sh                       # a browser with the extension and the replica site
node dev/bench/run.mjs --arms tools-small,record-small,replay-small,changed-small --reps 3 --tag mine
```

Results go to `dev/bench/results/mine.jsonl`. The `cic-*` arms need Claude in Chrome in your own browser. Setting `BENCH_MODEL` changes the model.
