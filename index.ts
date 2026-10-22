import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { SessionService } from './src/service.mjs';

const nullableString = Type.Union([Type.String(), Type.Null()]);
const Sync = Type.Union([
  Type.Object({ root: Type.String(), refreshed: Type.Literal(false) }),
  Type.Object({
    root: Type.String(), refreshed: Type.Literal(true),
    files: Type.Integer(), changed: Type.Integer(), appended: Type.Integer(), removed: Type.Integer(),
    pendingBytes: Type.Integer(), complete: Type.Boolean(), ms: Type.Number(),
    errors: Type.Array(Type.Object({ path: Type.String(), error: Type.String() }))
  })
]);
const Hit = Type.Object({
  sessionId: Type.String(), entryId: Type.String(), part: Type.String(), offset: Type.Integer(),
  sessionFile: Type.String(), cwd: Type.String(), name: nullableString,
  kind: Type.String(), tool: nullableString, timestamp: Type.String(),
  excerpt: Type.String(), excerptTruncated: Type.Boolean(), copies: Type.Integer()
});
const Section = Type.Object({ hits: Type.Array(Hit), more: Type.Boolean() });
const SearchOutput = Type.Union([
  Type.Object({ conversation: Section, tools: Section, ms: Type.Number(), sync: Sync }),
  Type.Object({
    sessions: Type.Array(Type.Object({
      sessionId: Type.String(), sessionFile: Type.String(), cwd: Type.String(), name: nullableString,
      started: Type.String(), updated: Type.String()
    })), more: Type.Boolean(), ms: Type.Number(), sync: Sync
  })
]);
const ReadOutput = Type.Object({
  sessionId: Type.String(), sessionFile: Type.String(), branchEnd: Type.String(), view: Type.String(), text: Type.String(), next: Type.Optional(Type.String()), sync: Sync,
  turn: Type.Optional(Type.Object({ anchor: Type.String(), promptEntryId: nullableString, nextPromptEntryId: nullableString, totalParts: Type.Integer() })),
  activities: Type.Optional(Type.Array(Type.Object({
    entryId: Type.String(), part: Type.String(), kind: Type.String(), tool: nullableString, callId: nullableString,
    timestamp: Type.String(), relation: Type.String(), excerpt: Type.String(), totalChars: Type.Integer(), excerptTruncated: Type.Boolean()
  }))),
  spans: Type.Optional(Type.Array(Type.Object({
    entryId: Type.String(), part: Type.String(), kind: Type.String(), from: Type.Integer(), to: Type.Integer(),
    preview: Type.Optional(Type.Boolean())
  })))
});

const oneLine = (value: string, max = 600) => value.replace(/\s+/g, ' ').slice(0, max);
function indexStatus(sync: Static<typeof Sync>) {
  const scope = `Archive: ${oneLine(sync.root, 240)} · `;
  if (!sync.refreshed) return scope + 'index not refreshed\n';
  const refreshed = scope + `${sync.files} files\n`;
  if (sync.complete) return refreshed;
  return refreshed + `Index refresh incomplete: ${sync.errors.length} error(s), ${sync.pendingBytes} pending bytes. Cached results may be stale or incomplete.\n`
    + sync.errors.slice(0, 3).map(e => `${oneLine(e.path, 200)}: ${oneLine(e.error, 200)}\n`).join('');
}

function rowsText(heading: string, rows: string[]) {
  return [heading, ...rows].join('\n') + '\n';
}

function searchText(result: Static<typeof SearchOutput>) {
  let text = indexStatus(result.sync);
  if ('sessions' in result) {
    return text + rowsText(`Recent sessions (${result.sessions.length}${result.more ? '+' : ''})`, result.sessions.map(s =>
      `${s.sessionId} · ${s.updated} · ${oneLine(s.cwd, 200)}${s.name ? ` · ${oneLine(s.name, 160)}` : ''}`));
  }
  for (const [name, section] of [['Conversation', result.conversation], ['Tool activity', result.tools]] as const) {
    const heading = `${name} (${section.hits.length}${section.more ? '+' : ''})`;
    text += rowsText(heading, section.hits.map((h, i) => {
      const ref = { sessionId: h.sessionId, entryId: h.entryId, part: h.part, offset: h.offset };
      return `${i + 1}. ${h.kind}${h.tool ? `/${h.tool}` : ''} · ${h.timestamp} · ${oneLine(h.cwd, 180)}${h.copies > 1 ? ` · ${h.copies} session copies` : ''}\n`
        + `   ${JSON.stringify(ref)}\n   ${oneLine(h.excerpt)}`;
    }));
  }
  return text;
}

export default function (pi: ExtensionAPI) {
  const services = new Map<string, SessionService>();
  function service(ctx: ExtensionContext) {
    const agentDir = resolve(getAgentDir());
    const defaultRoot = join(agentDir, 'sessions');
    const sessionDir = resolve(ctx.sessionManager.getSessionDir());
    // Direct children of the standard sessions root share that archive; other directories are roots.
    const root = relative(defaultRoot, dirname(sessionDir)) === '' ? defaultRoot : sessionDir;
    let instance = services.get(root);
    if (!instance) {
      const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
      instance = new SessionService({ root, db: join(agentDir, 'cache', 'session-search', `${key}.db`) });
      services.set(root, instance);
    }
    return instance;
  }
  pi.on('session_shutdown', async () => {
    const closing = [...services.values()];
    services.clear();
    await Promise.all(closing.map(s => s.close()));
  });

  pi.registerTool({
    name: 'session_search', label: 'Session Search',
    description: 'Search recorded Pi sessions in separate conversation and tool-activity sections. Word queries require all terms in one text part; anyOf supplies alternative AND queries, combined with query using AND. mode:literal finds exact case-sensitive substrings, including punctuation and partial identifiers, in stable content-key order rather than relevance rank. kind selects source provenance. Omit query and anyOf to browse recent sessions. Each search refreshes the index. The current session is excluded unless sessionId is specified. Copy counts are repeated occurrences, not independent corroboration.',
    promptSnippet: 'Find prior investigations and decisions in recorded Pi sessions.',
    promptGuidelines: ['When an answer depends on prior sessions or findings missing from current context, use session_search, then session_read on relevant source hits.'],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: 'Words mode: all tokens and quoted token phrases must match; operators such as OR are words. Combined with anyOf using AND. Literal mode: exact case-sensitive substring, preserving punctuation, quotes and whitespace. Omit query and anyOf to browse.' })),
      anyOf: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 12, description: 'Words mode only. Alternative queries, each with AND terms/quoted phrases, OR together. If query is present, it must also match the same part. Example: query:"headset", anyOf:["shutdown", "display interruption"].' })),
      mode: Type.Optional(Type.Union([Type.Literal('words'), Type.Literal('literal')], { description: 'words (default): token matching and BM25 rank. literal: case-sensitive substring scan, including short literals, in content-key order. Literal requires a nonblank query and rejects anyOf.' })),
      cwd: Type.Optional(Type.String({ description: 'Exact recorded working directory. Omit to search the archive.' })),
      descendants: Type.Optional(Type.Boolean({ description: 'Include subdirectories of cwd.' })),
      sessionId: Type.Optional(Type.String({ description: 'Restrict to this full session ID, including the current session if specified.' })),
      since: Type.Optional(Type.String({ description: 'Inclusive ISO date/time: evidence timestamp, or last activity when browsing.' })),
      until: Type.Optional(Type.String({ description: 'Exclusive ISO date/time: evidence timestamp, or last activity when browsing.' })),
      reasoning: Type.Optional(Type.Boolean({ description: 'Include recorded reasoning text (default false); enabling it requires query or anyOf.' })),
      tool: Type.Optional(Type.String({ description: 'Restrict search to this exact tool name; requires query or anyOf.' })),
      kind: Type.Optional(Type.Union(['user', 'assistant', 'summary', 'custom', 'tool_call', 'tool_result', 'shell'].map(v => Type.Literal(v)), { description: 'Restrict to one source kind. user: requests/decisions; assistant: written claims, not tool calls or reasoning; summary: Pi summaries; tool_result: recorded output. Requires query or anyOf. A kind is provenance, not a guarantee of truth.' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: 'Hits per section, or sessions when browsing; default 5. All returned hits/sessions are shown in text; hit previews are at most 600 characters. A + after a count means further results were omitted: raise limit (max 50) or narrow the query, filters or dates. Reduce limit for shorter responses.' }))
    }),
    outputSchema: SearchOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    executionMode: 'parallel',
    async execute(_id, params, signal, _update, ctx) {
      if (params.descendants && !params.cwd) throw new Error('descendants requires cwd');
      const { sessionId, ...options } = params;
      const result = await service(ctx).search({
        ...options, session: sessionId, excludeSession: sessionId ? undefined : ctx.sessionManager.getSessionId()
      }, signal) as Static<typeof SearchOutput>;
      return { content: [{ type: 'text', text: searchText(result) }], structuredContent: result, details: undefined };
    }
  });

  pi.registerTool({
    name: 'session_read', label: 'Session Read',
    description: 'Read recorded history on one branch. Default: a source passage around entryId/part/offset, or a prompt/summary outline without entryId. view:entry reads only that entry in full, with continuation. view:conversation pages user/assistant text without tools or summaries. view:turn lists tool activity in the user turn containing entryId, with call IDs and before/after-anchor labels; this is navigation, not proof of a claim. Open listed parts with view:entry. Read outputs include the source file; entry/conversation headings include original timestamps and part pointers for citation. Continue with sessionId and next as cursor; it pins view and branch. Reads current source via the indexed path; unknown sessions require session_search. For further matches within a session, use session_search with sessionId.',
    promptSnippet: 'Read original passages, conversation-only history, or a turn\'s tool evidence.',
    parameters: Type.Object({
      sessionId: Type.String({ description: 'Full session ID already indexed by session_search.' }),
      view: Type.Optional(Type.Union(['outline', 'passage', 'entry', 'conversation', 'turn'].map(v => Type.Literal(v)), { description: 'Default: passage with entryId, outline without. entry: only this entry; conversation: user/assistant text only; turn: tool-activity references, requires entryId but no part/offset.' })),
      entryId: Type.Optional(Type.String({ description: 'Entry to open, or turn anchor. Conversation requires a user/assistant text anchor, or starts at the first such entry if omitted. Use view:entry for summaries or tool entries.' })),
      part: Type.Optional(Type.String({ description: 'Exact source-part pointer from the search hit.' })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: 'UTF-16 code-unit offset from the search hit; default 0.' })),
      branchEnd: Type.Optional(Type.String({ description: 'Recorded entry ending the selected ancestry; defaults to the newest descendant of the anchor, or newest recorded branch.' })),
      cursor: Type.Optional(Type.String({ description: 'next cursor from a previous read; fixes view, branch, and continuation position. Omit other selection fields when continuing.' })),
      maxChars: Type.Optional(Type.Integer({ minimum: 2000, maximum: 12000, description: 'Passage character budget; default 12000.' }))
    }),
    outputSchema: ReadOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    executionMode: 'parallel',
    async execute(_id, params, signal, _update, ctx) {
      if (!params.entryId && !params.cursor && (params.part !== undefined || params.offset !== undefined)) {
        throw new Error('part and offset require entryId or a continuation cursor');
      }
      const result = await service(ctx).read(params, signal) as Static<typeof ReadOutput>;
      const text = indexStatus(result.sync) + `session ${result.sessionId} · branch end ${result.branchEnd} · view ${result.view}\nSource: ${result.sessionFile}\n`
        + result.text + (result.next ? `\nContinue: ${JSON.stringify({ sessionId: result.sessionId, cursor: result.next })}` : '');
      return { content: [{ type: 'text', text }], structuredContent: result, details: undefined };
    }
  });
}
