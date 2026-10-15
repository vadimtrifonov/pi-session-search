# Pi Session Search

Local keyword search of Pi session history, with source references and bounded, branch-aware reads.
Conversation and tool activity have separate ranked results, so large tool outputs do not displace every conversational match.

Requires Node.js 22.19 or newer and Pi's extension APIs; tested with Pi 1.2.0 on Node.js 26.11.1.
Only session-format v3 JSONL files are supported.

## Load

From this checkout, load it for one Pi invocation:

```sh
pi -e ./index.ts
```

Register this checkout in Pi's user settings with `pi install ./`.
Pi supplies the declared peer dependencies; the extension needs no build step.

## Search

`session_search` returns conversation and tool-activity sections, or recently active sessions when `query` is omitted.
Each hit includes `sessionId`, `entryId`, `part`, and `offset` for a follow-up `session_read`.
`tool` and `reasoning: true` require a nonblank query; session listings reject them.
The tool filter matches the recorded name exactly.

- All query tokens and quoted token phrases must match within one searchable part, not across separate blocks of a message or elsewhere in the session.
  Operators such as `OR` are search words.
  Quotes require adjacent tokens, not exact punctuation: `"C++"` also matches the `C` token in `C#`.
  Partial identifiers do not match: `SessionDir` does not find `getSessionDir`.
  There is no semantic or fuzzy matching.
  For literal or substring discovery, use filesystem search against `sync.root` or a hit's `sessionFile`.
  An empty keyword result does not establish absence.
- `cwd` filters the recorded working directory, with optional descendants.
  Date filters apply to evidence timestamps when searching and last activity when browsing.
- The calling session is excluded unless `sessionId` is explicitly supplied.
  Historical branches remain searchable.
- Exact copied fork evidence is returned once, after applying occurrence filters.
  Copy counts describe matching session copies, not independent corroboration.
  Distinct summaries remain separate even when their previews are identical.
- Conversation includes user/assistant text, labelled summaries, and custom messages.
  Tool activity includes call arguments, results, and direct shell commands/output.
  Readable reasoning is indexed but searched only with `reasoning: true`; image payloads and encrypted reasoning signatures are excluded.

The default page contains five hits per section, up to fifty.
Results use BM25 rank with a stable content-key tiebreaker; session listings use last activity followed by session ID.
Model-facing previews are bounded; programmatic callers receive the complete requested page through `structuredContent`.

When `next` is returned, repeat the query and filters with `cursor: next` to advance both result sections or the session listing.
`limit` may change between pages.
The cursor binds the effective scope, including the calling-session exclusion, and one index revision.
Continuation does not refresh the index.
An index update or rebuild invalidates the cursor explicitly; restart without it rather than silently skipping or repeating results.
Starting another fresh search—even one that only indexes changes in an excluded session—can invalidate earlier cursors because corpus statistics affect ranking.
This fixes the indexed result order, not the source files.

## Read

`session_read` opens a search hit using its four reference fields.
A fresh search or session listing must first index the session's file location.
Reads load that source file directly without refreshing the index; an unknown session ID requires a fresh search.
Without `entryId`, a read returns a prompt/summary outline and other recorded branch ends.
A focused read follows the newest recorded descendant of its anchor unless `branchEnd` selects another ancestry.
This is recorded history, not a reconstruction of model context or the branch currently selected in a running Pi session.

Reads start near the requested offset and continue inside oversized text parts.
Offsets refer to the tool's readable text projection, in UTF-16 code units, not JSONL byte positions.
`maxChars` bounds the passage to 2,000–12,000 code units; status and continuation instructions are additional.
An outline whose metadata cannot fit the requested budget returns an error rather than exceeding it.

For non-user hits, initial reads orient from the preceding user entry.
Its text parts are included in source order, within a quarter-page budget.
Truncated text and wholly omitted prompt parts are marked explicitly.
Nearby tool activity, summaries, and custom messages are abbreviated; open their entry and part directly for a full read.
An otherwise unseen later assistant response may appear as a labelled, non-contiguous preview within the same user turn.
The preview does not advance pagination.

Continue with the same `sessionId` and the returned `next` cursor.
Both views pin the branch endpoint and continuation position, and normal appends do not invalidate cursors.
Passage cursors also verify the addressed text and reject changes.
Direct retrieval calls/results remain readable even though they are excluded from search.

## Archive and cache

A session directory directly under `<agent-dir>/sessions` uses that parent as the archive, across projects.
Other session directories are searched as their own archives.
`sync.root` reports the effective scope; the extension does not infer a broader archive from an SDK-specific directory layout.
The agent directory comes from Pi's CLI/environment configuration, normally `~/.pi/agent`.

Search without a cursor refreshes a disposable SQLite index under `<agent-dir>/cache/session-search/`, keyed by archive root.
The first such search builds the index; subsequent searches reuse it.
`sync.refreshed` distinguishes a completed refresh attempt from a read or continuation that did not scan the archive.
Only refresh attempts include file counts, pending bytes, and errors.
Work runs in short-lived workers, serialized per archive within a Pi instance, with no background scanner.
Source files are read without modification.
The cache contains unredacted searchable transcript text, not just keywords.

Refresh indexes complete appended records and reports unfinished tails and file errors in `sync`.
Each file update or removal is atomic, including its changes to the full-text index.
A failed file refresh preserves its previous indexed evidence; failed directory traversal does not purge unseen sessions.
Incremental refresh assumes older entries are unchanged when a file grows with the same indexed tail.
Manual edits that evade that check, or preserve file size and modification time, require a cache rebuild.
Remove the cache while no calls are running to rebuild it on the next fresh search; incompatible cache schemas also require rebuilding.

## Tests

```sh
npm test
```

The core and worker tests need no external dependencies.
The Pi loader test runs when Pi and TypeBox peers are resolvable; otherwise it is explicitly skipped.
