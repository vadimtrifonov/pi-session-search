# Pi Session Search

Local keyword search of Pi session history, with source references and bounded, branch-aware reads.
Conversation and tool activity have separate result sections, so large tool outputs do not displace every conversational match.

Requires Node.js 24.16+ (24.x) or 26.1+ and Pi's extension APIs.
These versions include the [SQLite text-decoding fix](https://github.com/nodejs/node/pull/61954) needed to preserve embedded NUL characters in tool output.
Tested with Pi 1.3.0 on Node.js 24.16.0, 26.1.0, and 26.12.0.
Only session-format v3 JSONL files are supported.

## Install

```sh
pi install git:github.com/vadimtrifonov/pi-session-search
```

## Search

`session_search` returns conversation and tool-activity sections, or recently active sessions when both `query` and `anyOf` are omitted.
Each hit includes `sessionId`, `entryId`, `part`, and `offset` for a follow-up `session_read`.
`tool`, `kind`, and `reasoning: true` require a nonblank `query` or `anyOf`; session listings reject them.
The tool filter matches the recorded name exactly.

- In the default `mode: "words"`, all query tokens and quoted token phrases must match within one searchable part, not across separate blocks of a message or elsewhere in the session.
  `anyOf` supplies 1–12 alternative queries, each with the same all-terms semantics.
  At least one alternative must match; if `query` is also supplied, it must match the same part.
  For example, `query: "headset", anyOf: ["shutdown", "display interruption"]` requires `headset` and either `shutdown` or both `display` and `interruption`.
  Operators such as `OR` are search words.
  Quotes require adjacent tokens, not exact punctuation: `"C++"` also matches the `C` token in `C#`.
  Partial identifiers do not match: `SessionDir` does not find `getSessionDir`.
  There is no semantic or fuzzy matching.
  An empty keyword result does not establish absence.
- `mode: "literal"` searches for an exact, **case-sensitive substring** in each readable text part.
  Punctuation, quotes, and whitespace are literal; `SessionDir` finds `getSessionDir`, and `C++` does not match `C#`.
  Queries must contain a non-whitespace character; leading/trailing whitespace remains significant.
  Short literals are supported; `anyOf` is rejected in this mode.
  Results open at the first exact occurrence in the original part, with a match-centred preview of at most 600 characters.
  A longer literal can be clipped in the preview; the returned offset still identifies its beginning, and `session_read` opens the original text.
  This mode scans the existing indexed text and adds no index or storage requirement; short queries can match many parts.
- `cwd` filters the recorded working directory, with optional descendants.
  Date filters apply to evidence timestamps when searching and last activity when browsing.
- `kind` restricts results to `user`, `assistant`, `summary`, `custom`, `tool_call`, `tool_result`, or `shell`.
  It selects provenance before ranking; a source kind does not establish whether the statement is true.
- The calling session is excluded unless `sessionId` is explicitly supplied.
  Historical branches remain searchable.
- Exact copied fork evidence is returned once, after applying occurrence filters.
  Copy counts describe matching session copies, not independent corroboration.
  Distinct summaries remain separate even when their previews are identical.
- Conversation includes user/assistant text, labelled summaries, and custom messages.
  Tool activity includes call arguments, results, and direct shell commands/output.
  Readable reasoning is indexed but searched only with `reasoning: true`; image payloads and encrypted reasoning signatures are excluded.

Word results use BM25 rank with a stable content-key tiebreaker.
Literal results have no relevance rank: they are ordered by evidence timestamp, newest first, with content-key order for ties.
Copied fork evidence keeps its original timestamp.
Hits beyond `limit` are older, not less relevant.
Session listings use last activity followed by session ID.
Model-facing text includes every returned hit or session, with hit previews of at most 600 characters.
`limit` sets the hits per section, or sessions when browsing: five by default, up to fifty; larger limits produce longer responses.
`more` marks a section or listing whose further results were omitted, shown as `+` after its count; raise `limit` or narrow the query, filters, or dates.
Programmatic callers receive the same results through `structuredContent`.
The declared output schemas omit refresh counters, timings, and read spans to keep tool declarations short; the values are still returned.

## Read

`session_read` opens a search hit using its four reference fields.
A search or session listing must first index the session's file location.
Reads load that source file directly without refreshing the index; an unknown session ID requires a search.
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

### Investigation views

`session_read` also accepts an explicit `view`:

- `entry` reads only `entryId`, without adjacent history or a later-response preview.
  All readable parts are available in full, with continuation inside oversized parts.
  Reasoning is shown only when its exact `part` is addressed.
- `conversation` pages through user and assistant text on the selected ancestry, from `entryId` or the first conversation entry.
  Tools, summaries, custom messages, and reasoning are omitted: this is a conversation projection, not complete evidence.
  A supplied entry must contain conversation text; use `view: "entry"` to open a summary or tool entry.
- `turn` requires `entryId` and lists calls, results, and direct shell activity in its containing user turn.
  It includes prompt boundaries, source-part references, recorded call IDs, and whether each activity occurred before, at, or after the anchor.
  Matching call IDs are navigation aids, not proof that a claim was verified; results can be missing, repeated, or later than the claim.
  Nested calls do not have independent source-result entries.
  Empty calls/results are represented by labelled placeholders.
  Open listed references with `view: "entry"`.

Read results include the source file path.
Entry and conversation headings include the original entry timestamp and source-part pointer for citations without JSONL extraction.
Use `session_search` with `sessionId` for further matches in a known session.
The investigation views do not add a second matching engine or generate summaries.

Continue with the same `sessionId` and the returned `next` cursor.
All views pin the view, branch endpoint, and continuation position; normal appends do not invalidate cursors.
An explicitly conflicting view is rejected.
Passage and entry cursors verify the addressed text; turn cursors verify the activity inventory.
Direct retrieval calls/results remain readable even though they are excluded from search.

## Archive and cache

A session directory directly under `<agent-dir>/sessions` uses that parent as the archive, across projects.
Other session directories are searched as their own archives.
`sync.root` reports the effective scope; the extension does not infer a broader archive from an SDK-specific directory layout.
The agent directory comes from Pi's CLI/environment configuration, normally `~/.pi/agent`.

Each search refreshes a disposable SQLite index under `<agent-dir>/cache/session-search/`, keyed by archive root.
The first such search builds the index; subsequent searches reuse it.
`sync.refreshed` distinguishes a completed refresh attempt from a read, which does not scan the archive.
Only refresh attempts include file counts, pending bytes, and errors.
Work runs in short-lived workers, serialized per archive within a Pi instance, with no background scanner.
Source files are read without modification.
The cache contains unredacted searchable transcript text, not just keywords.

Refresh indexes complete appended records and reports unfinished tails and file errors in `sync`.
Each file update or removal is atomic, including its changes to the full-text index.
A failed file refresh preserves its previous indexed evidence; failed directory traversal does not purge unseen sessions.
Incremental refresh assumes older entries are unchanged when a file grows with the same indexed tail.
Manual edits that evade that check, or preserve file size and modification time, require a cache rebuild.
Remove the cache while no calls are running to rebuild it on the next search; incompatible cache schemas also require rebuilding.

## Tests

```sh
npm test
```

The core and worker tests need no external dependencies.
Run the Pi loader integration check separately:

```sh
npm run test:integration
```

This check requires the declared Pi and TypeBox peers to be locally resolvable and fails if they are missing.
Node's test runner does not use Pi's host-module mapping.
