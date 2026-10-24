import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { SessionService } from './src/service.mjs';

type SyncStatus =
  | { root: string; refreshed: false }
  | { root: string; refreshed: true; files: number; pendingBytes: number; complete: boolean; errors: { path: string; error: string }[] };

// Declared outputs are rendered into codemode prompts, so they list only fields that scripts act on.
// Results also carry refresh counters, timings, and read spans.
const nullableString = Type.Union([Type.String(), Type.Null()]);
const IndexState = Type.Object({
  complete: Type.Boolean(), errors: Type.Array(Type.Object({ path: Type.String(), error: Type.String() }))
});
const Hit = Type.Object({
  sessionId: Type.String(), entryId: Type.String(), part: Type.String(), offset: Type.Integer(),
  sessionFile: Type.String(), cwd: Type.String(), name: nullableString,
  kind: Type.String(), tool: nullableString, timestamp: Type.String(),
  excerpt: Type.String(), excerptTruncated: Type.Boolean(), copies: Type.Integer()
});
const Section = Type.Object({ hits: Type.Array(Hit), more: Type.Boolean() });
const SearchOutput = Type.Union([
  Type.Object({ conversation: Section, tools: Section, sync: IndexState }),
  Type.Object({
    sessions: Type.Array(Type.Object({
      sessionId: Type.String(), sessionFile: Type.String(), cwd: Type.String(), name: nullableString,
      started: Type.String(), updated: Type.String()
    })), more: Type.Boolean(), sync: IndexState
  })
]);
type SearchResult = Static<typeof SearchOutput> & { sync: SyncStatus };
const ReadOutput = Type.Object({
  sessionId: Type.String(), sessionFile: Type.String(), branchEnd: Type.String(), view: Type.String(), text: Type.String(), next: Type.Optional(Type.String()),
  turn: Type.Optional(Type.Object({ anchor: Type.String(), promptEntryId: nullableString, nextPromptEntryId: nullableString, totalParts: Type.Integer() })),
  activities: Type.Optional(Type.Array(Type.Object({
    entryId: Type.String(), part: Type.String(), kind: Type.String(), tool: nullableString, callId: nullableString,
    timestamp: Type.String(), relation: Type.String(), excerpt: Type.String(), totalChars: Type.Integer(), excerptTruncated: Type.Boolean()
  })))
});

const oneLine = (value: string, max = 600) => value.replace(/\s+/g, ' ').slice(0, max);
function indexStatus(sync: SyncStatus) {
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

function searchText(result: SearchResult) {
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
    description: 'Search recorded Pi sessions across projects, excluding the current session unless sessionId names it. Without query or anyOf, list recent sessions.',
    promptSnippet: 'Find prior investigations and decisions in recorded Pi sessions.',
    promptGuidelines: ['When an answer depends on prior sessions or findings missing from current context, use session_search, then session_read on relevant source hits.'],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: 'Words mode: all words and "quoted phrases" must occur in the same text part; OR is an ordinary word.' })),
      anyOf: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 12, description: 'Alternative words-mode queries; a hit matches at least one, and query if given.' })),
      mode: Type.Optional(Type.Union([Type.Literal('words'), Type.Literal('literal')], { description: 'words (default): whole tokens. literal: exact case-sensitive substring, for partial identifiers, paths or punctuation; newest first.' })),
      cwd: Type.Optional(Type.String({ description: 'Exact recorded working directory.' })),
      descendants: Type.Optional(Type.Boolean({ description: 'Include cwd subdirectories.' })),
      sessionId: Type.Optional(Type.String({ description: 'Search only this session.' })),
      since: Type.Optional(Type.String({ description: 'Inclusive ISO date/time of the evidence, or of last activity when browsing.' })),
      until: Type.Optional(Type.String({ description: 'Exclusive ISO date/time; same target as since.' })),
      reasoning: Type.Optional(Type.Boolean({ description: 'Also search recorded reasoning.' })),
      tool: Type.Optional(Type.String({ description: 'Exact recorded tool name.' })),
      kind: Type.Optional(Type.Union(['user', 'assistant', 'summary', 'custom', 'tool_call', 'tool_result', 'shell'].map(v => Type.Literal(v)), { description: 'shell: user shell commands and output, not agent tool calls.' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: 'Hits per section, or sessions when browsing; default 5.' }))
    }),
    outputSchema: SearchOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    executionMode: 'parallel',
    async execute(_id, params, signal, _update, ctx) {
      if (params.descendants && !params.cwd) throw new Error('descendants requires cwd');
      const { sessionId, ...options } = params;
      const result = await service(ctx).search({
        ...options, session: sessionId, excludeSession: sessionId ? undefined : ctx.sessionManager.getSessionId()
      }, signal) as SearchResult;
      return { content: [{ type: 'text', text: searchText(result) }], structuredContent: result, details: undefined };
    }
  });

  pi.registerTool({
    name: 'session_read', label: 'Session Read',
    description: 'Read one branch of a recorded Pi session. To read around a search hit, pass its sessionId, entryId, part and offset.',
    promptSnippet: 'Read recorded Pi session history.',
    parameters: Type.Object({
      sessionId: Type.String(),
      view: Type.Optional(Type.Union(['outline', 'passage', 'entry', 'conversation', 'turn'].map(v => Type.Literal(v)), { description: 'passage (default with entryId): history around and after the selected part; other tool output is clipped. outline (default without entryId): user prompts and summaries. entry: only this entry, unclipped. conversation: user and assistant text only. turn: tool and shell activity in the user turn containing entryId; no part or offset.' })),
      entryId: Type.Optional(Type.String()),
      part: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      branchEnd: Type.Optional(Type.String({ description: 'Branch endpoint; default: newest descendant of entryId, or newest entry without one.' })),
      cursor: Type.Optional(Type.String({ description: 'next from a previous read. Continues the same view and branch; omit other selection fields.' })),
      maxChars: Type.Optional(Type.Integer({ minimum: 2000, maximum: 12000, description: 'Character budget; default 12000.' }))
    }),
    outputSchema: ReadOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    executionMode: 'parallel',
    async execute(_id, params, signal, _update, ctx) {
      if (!params.entryId && !params.cursor && (params.part !== undefined || params.offset !== undefined)) {
        throw new Error('part and offset require entryId or a continuation cursor');
      }
      const result = await service(ctx).read(params, signal) as Static<typeof ReadOutput> & { sync: SyncStatus };
      const text = indexStatus(result.sync) + `session ${result.sessionId} · branch end ${result.branchEnd} · view ${result.view}\nSource: ${result.sessionFile}\n`
        + result.text + (result.next ? `\nContinue: ${JSON.stringify({ sessionId: result.sessionId, cursor: result.next })}` : '');
      return { content: [{ type: 'text', text }], structuredContent: result, details: undefined };
    }
  });
}
