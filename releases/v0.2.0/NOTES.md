# 0.2.0

## Agents
- Several agents can work in the browser at once, each in its own tab group, with locks so two never drive the same tab.
- Several browser profiles can be connected at the same time. `browser_profile` and `agentic-routines profiles` pick one.
- Clicks, typing and screenshots work in tabs that are not in front, and the person is no longer switched to the tab an agent works in.
- `read_page` can wait for a page that is still loading, or read one element. Tool results say which account the page is signed in as, and what a timeout may have done.
- Annotated screenshots: `agentic-routines marks on` draws a numbered box and label on what an agent just touched. `note` and `ref` on `screenshot` add a box, label and arrow anywhere.
- Agents decide on their own whether a task is worth saving as a routine, and tidy the routines they run.

## Routines
- Hooks, scripts and custom instructions for routines, from Git sources. Hooks run in the unpacked build only: the store builds leave out the sandbox they need.
- Page and routine text is treated as untrusted data, uploads are hardened, and `page_llm_content` was added.
- The side panel library shows a routine the moment an agent saves it.

## Tools
- `agentic-routines debug on` writes an action log, and `logs` reads it.
