// Reading one recorded Pi session: an outline of one branch, or a bounded passage along one
// ancestry that continues inside oversized parts. Parts, pointers and text come from content.mjs.
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isToolPart, sourceParts } from './content.mjs';
import { readLines } from './jsonl.mjs';

const VIEWS = new Set(['outline', 'passage', 'entry', 'conversation', 'turn']);
const MIN_CHARS = 2000; // leave room for orientation and the focused passage
const CLIP = 600; // characters shown of tool I/O, summaries and custom messages away from the focus
const FULL = new Set(['user', 'assistant']);

const fail = message => { throw new Error(message); };
const stamp = at => (at ? `${at.slice(0, 16).replace('T', ' ')}Z` : '');
const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const need = (s, id) => s.byId.get(id) ?? fail(`entry ${id} not found`);

// Records in file order. IDs are unique and parents precede children, so every walk below ends
// and the newest entry under an anchor is a branch end. An unterminated tail is still being written.
async function loadSession(file) {
  const handle = await open(file, 'r');
  const entries = [], byId = new Map();
  let header;
  try {
    const { size } = await handle.stat();
    for await (const { line, offset } of readLines(handle, 0, size)) {
      const text = line.toString('utf8').trim();
      if (!text) continue;
      let e;
      try { e = JSON.parse(text); } catch { fail(`invalid record at byte ${offset} of ${file}`); }
      if (!e || typeof e.type !== 'string' || typeof e.id !== 'string' || !e.id) fail(`invalid entry at byte ${offset} of ${file}`);
      if (!header) {
        if (e.type !== 'session' || e.version !== 3 || typeof e.cwd !== 'string') fail(`expected a Pi v3 session header in ${file}`);
        header = e; continue;
      }
      if (e.type === 'session') fail(`unexpected session header at byte ${offset} of ${file}`);
      if (e.parentId !== null && typeof e.parentId !== 'string') fail(`invalid parent of entry ${e.id} in ${file}`);
      if (byId.has(e.id)) fail(`duplicate entry ${e.id} in ${file}`);
      if (e.parentId != null && !byId.has(e.parentId)) fail(`entry ${e.id} precedes its parent ${e.parentId} in ${file}`);
      const c = e.message?.content; // retain image blocks, not their opaque payloads
      if (Array.isArray(c)) for (const b of c) { if (b.type === 'image') b.data = undefined; b.thinkingSignature = undefined; }
      e.index = entries.length;
      entries.push(e);
      byId.set(e.id, e);
    }
  } finally { await handle.close(); }
  return { header: header ?? fail(`${file} has no session header`), entries, byId };
}

function ancestry(s, leafId) {
  const path = [];
  for (let e = need(s, leafId); e; e = s.byId.get(e.parentId)) path.push(e);
  return path.reverse();
}

function newestUnder(s, id) {
  const inside = new Set([need(s, id).id]);
  let newest = id;
  for (let i = s.byId.get(id).index + 1; i < s.entries.length; i++) {
    const e = s.entries[i];
    if (inside.has(e.parentId)) { inside.add(e.id); newest = e.id; }
  }
  return newest;
}

function unitsOf(e) {
  const parts = sourceParts(e);
  if (e.type === 'message' && e.message.role === 'user' && !parts.length) {
    // Textless user entries are still turn boundaries, but do not belong in the search index.
    const images = Array.isArray(e.message.content) ? e.message.content.filter(b => b.type === 'image').length : 0;
    parts.push({ part: '/message/content', kind: 'user', text: images ? `[${images} image${images === 1 ? '' : 's'}]` : '[empty user message]' });
  }
  // Empty calls/results still belong in a turn inventory and must be openable.
  const m = e.message;
  if (m?.role === 'assistant' && Array.isArray(m.content)) {
    m.content.forEach((b, i) => {
      const part = `/message/content/${i}/arguments`;
      if (b.type === 'toolCall' && !parts.some(p => p.part === part)) {
        parts.push({ part, kind: 'tool_call', text: '[no readable arguments]', tool: b.name, identity: b.id });
      }
    });
    parts.sort((a, b) => Number(a.part.split('/')[3]) - Number(b.part.split('/')[3]));
  }
  if (m?.role === 'toolResult' && !parts.length) {
    parts.push({ part: '/message/content', kind: 'tool_result', text: '[no readable output]', tool: m.toolName, identity: [m.toolCallId, !!m.isError] });
  }
  return parts.map(p => ({ ...p, id: e.id, at: e.timestamp, index: e.index, label: labelOf(e, p) }));
}

function labelOf(e, p) {
  switch (p.kind) {
    case 'summary': return e.type === 'compaction' ? 'compaction' : 'branch';
    case 'custom': return p.identity;
    case 'tool_call': return p.tool;
    case 'tool_result': return e.message.isError ? `${p.tool} error` : p.tool;
    case 'shell': return p.part === '/message/output'
      ? `output${e.message.exitCode ? ` exit ${e.message.exitCode}` : ''}${e.message.cancelled ? ' cancelled' : ''}${e.message.truncated ? ' truncated' : ''}`
      : 'command';
  }
}

function head(u, from, provenance = false) {
  let h = `--- ${u.kind}${u.label ? ` ${u.label}` : ''} ${u.id}`;
  if (u.kind === 'user' || provenance) h += ` · ${provenance ? u.at ?? '' : stamp(u.at)}`;
  if (provenance) h += ` · ${u.part}`;
  if (from) h += ` · from char ${from} of ${u.text.length}`;
  return h + '\n';
}

function render(u, from, clip, provenance = false) {
  const body = u.text.slice(from, clip == null ? undefined : from + clip);
  const rest = u.text.length - from - body.length;
  return head(u, from, provenance) + body + (rest > 0 ? `\n… [+${rest} chars of ${u.part}]` : '') + '\n';
}

// Keep some lead-in, but reserve at least half the available body for text at/after the offset.
function leadIn(text, offset, before) {
  const floor = offset - Math.min(CLIP, before);
  if (floor <= 0) return 0;
  const newline = text.indexOf('\n', floor - 1);
  return newline >= 0 && newline < offset ? newline + 1 : floor;
}

function encodeCursor(state) {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    if (cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const state = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (!VIEWS.has(state.view) || typeof state.session !== 'string' || typeof state.branchEnd !== 'string'
      || typeof state.entryId !== 'string' || typeof state.part !== 'string'
      || !Number.isInteger(state.offset) || state.offset < 0
      || (state.view !== 'outline' && !/^[a-f0-9]{16}$/.test(state.hash))
      || (state.view === 'turn' && typeof state.anchor !== 'string')) throw new Error();
    return state;
  } catch { fail('invalid read cursor'); }
}

export async function readSession(file, { entryId, part, offset = 0, branchEnd, cursor, view, maxChars = 12000 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < MIN_CHARS || maxChars > 12000) fail(`maxChars must be an integer of at least ${MIN_CHARS} and at most 12000`);
  const s = await loadSession(file), session = s.header.id;
  let hash, anchor;
  if (cursor) {
    const state = decodeCursor(cursor);
    if (state.session !== session) fail(`cursor belongs to session ${state.session}, not ${session}`);
    if (view !== undefined && view !== state.view) fail('view differs from the read cursor');
    ({ view, branchEnd, entryId, part, offset, hash, anchor } = state);
  }
  view ??= entryId ? 'passage' : 'outline';
  if (!VIEWS.has(view)) fail('unknown read view');
  if (['entry', 'turn', 'passage'].includes(view) && !entryId) fail(`${view} view requires entryId`);
  if (view === 'turn' && !cursor && (part !== undefined || offset !== 0)) fail('turn view accepts an entryId, not a part or offset');
  branchEnd ??= entryId ? newestUnder(s, entryId) : s.entries.at(-1)?.id ?? fail('session has no entries');
  const path = ancestry(s, branchEnd);
  if (entryId && !path.some(e => e.id === entryId)) fail(`entry ${entryId} is not on the branch ending at ${branchEnd}`);
  let units = (view === 'entry' ? [need(s, entryId)] : path).flatMap(unitsOf);
  const cursorAt = (u, from = 0, text = '') => encodeCursor({ view, session, branchEnd, entryId: u.id, part: u.part, offset: from, hash: text ? digest(text) : undefined });
  let page;
  if (view === 'outline') {
    page = outline(s, path, units, branchEnd, cursor && { id: entryId, part }, maxChars, cursorAt);
  } else if (view === 'turn') {
    page = turnInventory(path, units, { anchor: anchor ?? entryId, entryId, part, hash, resumed: !!cursor }, maxChars,
      (u, anchor, hash) => encodeCursor({ view, session, branchEnd, entryId: u.id, part: u.part, offset: 0, anchor, hash }));
  } else {
    if (view === 'conversation') {
      const selected = units.filter(u => u.id === entryId && (part === undefined ? u.kind !== 'reasoning' : u.part === part));
      if (selected.length && !selected.some(u => FULL.has(u.kind))) {
        const target = part === undefined ? `entry ${entryId}` : `part ${part} of entry ${entryId}`;
        fail(`${target} is excluded from conversation view, which only shows user and assistant text. Use view:"entry" to read it.`);
      }
      units = units.filter(u => FULL.has(u.kind));
      entryId ??= units[0]?.id;
      if (!entryId) return { sessionId: session, branchEnd, view, text: 'No user or assistant text on this branch.\n', spans: [] };
    }
    page = passage(units, { entryId, part, offset, hash }, maxChars, cursorAt, view !== 'passage');
  }
  return { sessionId: session, branchEnd, view, ...page };
}

function passage(units, { entryId, part, offset, hash }, max, cursorAt, focused = false) {
  const resumed = hash !== undefined;
  let at = units.findIndex(u => u.id === entryId && (part === undefined ? u.kind !== 'reasoning' : u.part === part));
  if (at < 0 && part === undefined && !focused) at = units.findIndex(u => u.id === entryId);
  if (at < 0) fail(part === undefined ? `entry ${entryId} has no readable text` : `entry ${entryId} has no part ${part}`);
  const focus = units[at];
  if (resumed && digest(focus.text) !== hash) fail(`entry ${entryId} changed since the cursor was issued`);
  if (!Number.isInteger(offset) || offset < 0) fail('offset must be a non-negative integer');
  if (offset > focus.text.length) fail(`offset ${offset} is beyond the ${focus.text.length} characters of ${focus.part}`);
  const prefix = { text: '', spans: [] };
  const add = (page, u, t, from, to) => { page.text += t; page.spans.push({ entryId: u.id, part: u.part, kind: u.kind, from, to }); };

  if (!focused && !resumed && focus.kind !== 'user') { // orientation: the whole user entry, then nearest context, within a quarter page
    let p = at - 1;
    while (p >= 0 && units[p].kind !== 'user') p--;
    let first = p;
    while (first > 0 && units[first - 1].id === units[p].id) first--;
    const prompt = p < 0 ? [] : units.slice(first, p + 1);
    const context = units.slice(p + 1, at).filter(u => u.kind !== 'reasoning');
    const promptGap = n => n ? `… [${n} prompt text part${n === 1 ? '' : 's'} omitted]\n` : '';
    const contextGap = n => n ? `… [${n} parts omitted]\n` : '';
    const budget = Math.floor(max / 4);
    let room = budget - contextGap(context.length).length;
    let included = 0;
    for (; included < prompt.length; included++) {
      const u = prompt[included], available = room - promptGap(prompt.length - included - 1).length;
      let to = u.text.length, t = render(u, 0);
      if (t.length > available) {
        to = available - render(u, 0, 0).length; // reserve the part's truncation marker too
        if (to <= 0) break;
        t = render(u, 0, to);
      }
      add(prefix, u, t, 0, to);
      room -= t.length;
    }
    prefix.text += promptGap(prompt.length - included);
    room = budget - prefix.text.length - contextGap(context.length).length;
    const near = [];
    let omitted = context.length;
    for (; omitted > 0; omitted--) {
      const u = context[omitted - 1], t = render(u, 0, CLIP);
      if (t.length > room) break;
      room -= t.length;
      near.unshift([u, t]);
    }
    prefix.text += contextGap(omitted);
    for (const [u, t] of near) add(prefix, u, t, 0, Math.min(u.text.length, CLIP));
  }
  const fill = budget => {
    const page = { text: prefix.text, spans: [...prefix.spans] };
    for (let i = at; i < units.length; i++) {
      const u = units[i], isFocus = i === at;
      if (u.kind === 'reasoning' && !isFocus) continue;
      const room = budget - page.text.length;
      let from = 0;
      if (isFocus) {
        const bodyRoom = room - head(u, offset, focused).length - 1;
        from = resumed ? offset : leadIn(u.text, offset, Math.max(0, Math.floor(bodyRoom / 2)));
      }
      const full = focused || FULL.has(u.kind) || (isFocus && (!resumed || from > 0));
      const t = render(u, from, full ? null : CLIP, focused);
      if (t.length <= room) { add(page, u, t, from, full ? u.text.length : Math.min(u.text.length, CLIP)); continue; }
      const h = head(u, from, focused), take = room - h.length - 1;
      if (full && (isFocus || take >= 500)) { // split a fully shown part across pages
        if (take <= 0) fail('maxChars is too small for the focus header and context');
        add(page, u, h + u.text.slice(from, from + take) + '\n', from, from + take);
        return { ...page, next: cursorAt(u, from + take, u.text) };
      }
      return { ...page, next: cursorAt(u, 0, u.text) };
    }
    return page;
  };
  let page = fill(max);
  if (!focused && !resumed) {
    let later;
    for (let i = at + 1; i < units.length; i++) {
      if (units[i].kind === 'user' && units[i].id !== focus.id) break;
      if (units[i].kind === 'assistant') later = units[i];
    }
    if (later && !page.spans.some(s => s.entryId === later.id && s.part === later.part)) {
      const label = '\n… [Non-contiguous preview: later assistant response in this user turn]\n';
      const clip = Math.max(0, Math.floor(max / 4) - label.length - render(later, 0, 0).length);
      const footer = label + render(later, 0, clip);
      // A preview must leave room for the focus; its cursor still resumes contiguous history.
      if (footer.length + prefix.text.length + head(focus, offset).length + 1 < max) {
        page = fill(max - footer.length);
        add(page, later, footer, 0, Math.min(later.text.length, clip));
        page.spans.at(-1).preview = true;
      }
    }
  }
  return page;
}

// A navigation inventory, not an inference that these operations prove the anchor's claims.
// Call IDs are the recorded join key; results can be missing, repeated, or occur after the anchor.
function turnInventory(path, units, { anchor, entryId, part, hash, resumed }, max, cursorAt) {
  const at = path.findIndex(e => e.id === anchor);
  if (at < 0) fail(`entry ${anchor} is not on the selected branch`);
  const isUser = e => e.type === 'message' && e.message.role === 'user';
  let start = at;
  while (start >= 0 && !isUser(path[start])) start--;
  let end = at + 1;
  while (end < path.length && !isUser(path[end])) end++;
  const inside = new Set(path.slice(Math.max(0, start), end).map(e => e.id));
  const items = units.filter(u => inside.has(u.id) && isToolPart(u.kind));
  const turn = { anchor, promptEntryId: path[start]?.id ?? null, nextPromptEntryId: path[end]?.id ?? null, totalParts: items.length };
  const fingerprint = digest(JSON.stringify([turn, items.map(u => [u.id, u.part, u.kind, u.tool, u.label, u.text, u.identity, u.at])]));
  if (resumed && fingerprint !== hash) fail('turn activity changed since the cursor was issued');
  const first = resumed ? items.findIndex(u => u.id === entryId && u.part === part) : 0;
  if (first < 0) fail('turn continuation part not found');
  let text = `Tool activity in user turn ${turn.promptEntryId ?? '(no recorded prompt)'}; next prompt ${turn.nextPromptEntryId ?? '(branch end)'}.\n`
    + `Anchor ${anchor}. ${items.length} readable activity parts; call IDs link recorded calls/results, not proof of success.\n`
    + 'Open any entryId/part with view:"entry". Nested tool results are not separate source entries.\n';
  const activities = [];
  for (let i = first; i < items.length; i++) {
    const u = items[i];
    const relation = u.index < path[at].index ? 'before' : u.index > path[at].index ? 'after' : 'at';
    const callId = u.kind === 'tool_call' ? u.identity : u.kind === 'tool_result' ? u.identity?.[0] : undefined;
    const compact = u.text.replace(/\s+/g, ' '), excerpt = compact.slice(0, 180);
    const excerptTruncated = excerpt.length < compact.length;
    const row = `${u.kind} ${u.label ?? ''} · ${relation} anchor · ${u.at ?? ''}${callId ? ` · call ${callId}` : ''}\n`
      + `${JSON.stringify({ entryId: u.id, part: u.part, offset: 0 })} · ${u.text.length} chars\n${excerpt}${excerptTruncated ? ' …' : ''}\n`;
    if (text.length + row.length > max) {
      if (!activities.length) fail('maxChars is too small for a turn activity reference');
      return { text, turn, activities, next: cursorAt(u, anchor, fingerprint) };
    }
    text += row;
    activities.push({ entryId: u.id, part: u.part, kind: u.kind, tool: u.tool, callId: callId ?? null,
      timestamp: u.at, relation, excerpt, totalChars: u.text.length, excerptTruncated });
  }
  return { text, turn, activities };
}

function outline(s, path, units, branchEnd, resume, max, cursorAt) {
  let text = '';
  if (!resume) {
    const h = s.header, name = s.entries.findLast(e => e.type === 'session_info')?.name;
    text += `session ${h.id} · ${h.cwd} · started ${stamp(h.timestamp)}${name ? ` · ${name}` : ''}${h.parentSession ? ` · forked from ${h.parentSession}` : ''}\n`;
    const onPath = new Set(path.map(e => e.id)), parents = new Set(s.entries.map(e => e.parentId));
    const others = s.entries.filter(e => !parents.has(e.id) && e.id !== branchEnd).reverse();
    text += `branch end ${branchEnd} · ${stamp(path.at(-1).timestamp)} · ${others.length} other branch end(s)\n`;
    for (const e of others.slice(0, 5)) {
      let a = e;
      while (a && !onPath.has(a.id)) a = s.byId.get(a.parentId);
      text += `  ${e.id} · ${stamp(e.timestamp)} · diverges after ${a?.id ?? 'a separate root'}\n`;
    }
  }
  if (text.length > max) fail('maxChars is too small for the session header');
  const items = units.filter(u => u.kind === 'user' || u.kind === 'summary');
  const first = resume ? items.findIndex(u => u.id === resume.id && u.part === resume.part) : 0;
  if (first < 0) fail(`entry ${resume.id} is not an outline item`);
  for (let i = first; i < items.length; i++) {
    const u = items[i];
    const line = `${u.id} · ${stamp(u.at)} · ${u.kind === 'summary' ? `[${u.label} summary] ` : ''}${u.text.replace(/\s+/g, ' ').slice(0, 140)}\n`;
    if (text.length + line.length > max) return { text, next: cursorAt(u) };
    text += line;
  }
  return { text };
}
