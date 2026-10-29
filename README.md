# Pi Session Search

Lets Pi's agent find earlier discussions and tool output across projects.
Search uses a local index and returns the recorded text with a reference to its source.

## Install

```sh
pi install git:github.com/vadimtrifonov/pi-session-search
```

Pi must run on Node.js 24.16 or a later 24.x release, or on 26.1 or later.

## Try it

Ask about earlier work:

- "Why did we switch refunds to integer cents?"
- "What was the exact error when the CI build failed last week?"
- "What was I working on yesterday?"

Pi's system prompt includes a guideline to use the extension's search and read tools for history missing from the current context.

## Tools

### `session_search`

Searches past sessions by keywords and phrases, or by exact text such as an identifier or a path.
It can also list recent sessions.

Across every branch of a session, it can search:

- your messages and the agent's replies
- the agent's reasoning
- Pi's compaction and branch summaries
- tool calls and their output

A search can be narrowed by:

- project, date range or session
- kind of content, such as your messages
- tool name, such as `bash`

Hits come in two lists, conversation and tool activity, with up to 5 in each by default; the agent can ask for up to 50.
Searching a sample archive for `refund total` returns:

```text
Archive: ~/.pi/agent/sessions · 2 files
Conversation (2)
1. user · 2026-09-14T14:13-04:00 · /home/alex/code/billing-service
   {"sessionId":"0199a4e2-7c31-7d05-b6f1-3e9a52c04d18","entryId":"3f1a2dd7","part":"/message/content/0/text","offset":4}
   The [refund] [total] test started failing after I added partial refunds. Can you look?
2. assistant · 2026-09-14T14:16-04:00 · /home/alex/code/billing-service
   {"sessionId":"0199a4e2-7c31-7d05-b6f1-3e9a52c04d18","entryId":"3f1a335c","part":"/message/content/0/text","offset":4}
   The [refund] [total] is off by a floating-point error: 0.1 + 0.2 is 0.30000000000000004 in JavaScript. Storing [refund] amounts as integer cents makes the sum exact.
Tool activity (1)
1. tool_result/bash · 2026-09-14T14:15-04:00 · /home/alex/code/billing-service
   {"sessionId":"0199a4e2-7c31-7d05-b6f1-3e9a52c04d18","entryId":"3f1a3185","part":"/message/content/0/text","offset":30}
   FAIL test/refunds.test.js ● [refund] [total] › sums partial refunds Expected: 0.3 Received: 0.30000000000000004
```

### `session_read`

Opens a search hit or a session in one of these views:

- the discussion around a hit
- a whole message or tool output
- a list of the tool calls and results in one turn
- just your messages and the agent's replies
- an outline of the session

Opening the assistant's reply from the results above returns:

```text
session 0199a4e2-7c31-7d05-b6f1-3e9a52c04d18 · branch end 3f1a3533 · view passage
Source: ~/.pi/agent/sessions/--home-alex-code-billing-service--/0199a4e2-7c31-7d05-b6f1-3e9a52c04d18.jsonl
--- user 3f1a2dd7 · 2026-09-14T14:13-04:00
The refund total test started failing after I added partial refunds. Can you look?
--- assistant 3f1a2fae
Running the refund tests first.
--- tool_call bash 3f1a2fae
command: npm test -- refunds
--- tool_result bash error 3f1a3185
FAIL test/refunds.test.js
  ● refund total › sums partial refunds
    Expected: 0.3
    Received: 0.30000000000000004
--- assistant 3f1a335c
The refund total is off by a floating-point error: 0.1 + 0.2 is 0.30000000000000004 in JavaScript. Storing refund amounts as integer cents makes the sum exact.
--- user 3f1a3533 · 2026-09-14T14:17-04:00
Agreed, switch refunds to integer cents.
```

The full definitions of both tools are in [index.ts](index.ts).

## Token cost

| When | Tokens added (Pi 1.4.0, Claude Opus 5.5) |
| --- | --- |
| Every request, without codemode | about 960 |
| Every request, with codemode | about 1,430 |
| Each default search | about 2,000 |
| Each search at the 50-hit maximum | about 20,000 |
| Each full read page (12,000 characters) | about 5,000 |

## Index

The index lives under Pi's agent directory (`~/.pi/agent/cache/session-search/`) and holds a searchable copy of your session text.
The first search builds it: 4.5 GB of sessions took about 40 seconds and produced a 1.4 GB index.
Later searches update it.
If you delete it, the next search rebuilds it.

## Limitations

- Only Pi's v3 session format is supported.
- Search covers `~/.pi/agent/sessions`.
  When Pi stores sessions elsewhere, with `--session-dir`, `PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting, search covers only that directory.

## Development

```sh
npm install
npm test
npm run test:integration
```

## License

[MIT](LICENSE)
