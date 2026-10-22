import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { searchParts, isToolPart, normalizeCwd } from './content.mjs';
import { readLines } from './jsonl.mjs';
import { nulMatchOffset } from './nul-preview.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const iso = value => new Date(value).toISOString();

function discover(root) {
  const files = [], errors = [];
  function visit(directory) {
    let entries;
    try { entries = readdirSync(directory, {withFileTypes: true}); }
    catch (e) { errors.push({path: directory, error: e.message}); return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try { files.push({path, stat: statSync(path)}); }
        catch (e) { errors.push({path, error: e.message}); }
      }
    }
  }
  visit(root);
  return {files, errors};
}

export class HistoryIndex {
  constructor(path) {
    this.db = new DatabaseSync(path);
    try {
      // A concurrent WAL mode switch can fail without invoking SQLite's busy handler.
      // Retry this initialization step only; ordinary contention uses busy_timeout below.
      const deadline = performance.now() + 5000;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      for (;;) {
        try { this.db.exec('PRAGMA journal_mode=WAL'); break; }
        catch (e) {
          if ((e.errcode & 0xff) !== 5 || performance.now() >= deadline) throw e;
          Atomics.wait(pause, 0, 0, 25);
        }
      }
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 1) throw new Error('Index schema changed; rebuild this disposable cache.');
      if (version === 0) this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS session(
          id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, cwd TEXT NOT NULL, cwd_key TEXT NOT NULL,
          started TEXT NOT NULL, updated TEXT NOT NULL, name TEXT, parent TEXT,
          size INTEGER NOT NULL, mtime REAL NOT NULL, indexed_bytes INTEGER NOT NULL,
          tail_start INTEGER NOT NULL, tail_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS doc(
          id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, tool TEXT, timestamp TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS occurrence(
          doc INTEGER NOT NULL REFERENCES doc(id),
          session TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          entry TEXT NOT NULL, part TEXT NOT NULL,
          PRIMARY KEY(session,entry,part)
        );
        CREATE INDEX IF NOT EXISTS occurrence_doc ON occurrence(doc);
        CREATE VIRTUAL TABLE IF NOT EXISTS conversation USING fts5(text, tokenize='unicode61 remove_diacritics 2');
        CREATE VIRTUAL TABLE IF NOT EXISTS tool_io USING fts5(text, tokenize='unicode61 remove_diacritics 2');
        -- Retire the last copy's text in the deleting transaction, not in interruptible later cleanup.
        CREATE TRIGGER IF NOT EXISTS retire_document AFTER DELETE ON occurrence
        WHEN NOT EXISTS(SELECT 1 FROM occurrence WHERE doc=old.doc)
        BEGIN
          DELETE FROM conversation WHERE rowid=old.doc;
          DELETE FROM tool_io WHERE rowid=old.doc;
          DELETE FROM doc WHERE id=old.doc;
        END;
        PRAGMA user_version=1;
      `);
      const p = sql => this.db.prepare(sql);
      this.sql = {
        state: p('SELECT * FROM session WHERE path=?'),
        remove: p('DELETE FROM session WHERE path=?'),
        session: p('INSERT INTO session VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'),
        findDoc: p('SELECT id FROM doc WHERE key=?'),
        doc: p('INSERT INTO doc(key,kind,tool,timestamp) VALUES(?,?,?,?)'),
        occurrence: p('INSERT INTO occurrence VALUES(?,?,?,?)'),
        conversation: p('INSERT INTO conversation(rowid,text) VALUES(?,?)'),
        tool_io: p('INSERT INTO tool_io(rowid,text) VALUES(?,?)'),
        finish: p('UPDATE session SET name=?,updated=?,size=?,mtime=?,indexed_bytes=?,tail_start=?,tail_hash=? WHERE id=?')
      };
    } catch (e) { this.db.close(); throw e; }
  }

  close() { this.db.close(); }

  getSessionFile(sessionId) {
    const row = this.db.prepare('SELECT path FROM session WHERE id=?').get(sessionId);
    if (!row) throw new Error(`Session ${sessionId} is not indexed; run session_search to refresh the archive.`);
    return row.path;
  }

  checkRoot(root) {
    const cached = this.db.prepare("SELECT value FROM meta WHERE key='root'").get()?.value;
    if (!cached) throw new Error('Index is not initialized; run session_search first.');
    if (cached !== resolve(root)) throw new Error('This index belongs to another sessions root.');
  }

  async sync(root) {
    const start = performance.now();
    root = resolve(root);
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES('root',?)").run(root);
    this.checkRoot(root);
    const {files, errors} = discover(root);
    const walkComplete = errors.length === 0;
    let changed = 0, appended = 0, removed = 0;
    // Retire missing paths first so a renamed file can reclaim its session ID in this refresh.
    if (walkComplete) {
      const seen = new Set(files.map(f => f.path));
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const {path} of this.db.prepare('SELECT path FROM session').all()) {
          if (seen.has(path)) continue;
          try { statSync(path); }
          catch (e) {
            if (e.code === 'ENOENT' || e.code === 'ENOTDIR') { this.sql.remove.run(path); removed++; }
            else errors.push({path, error: e.message});
          }
        }
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    // Use a larger cache for index writes, then restore the query cache.
    const cacheSize = this.db.prepare('PRAGMA cache_size').get().cache_size;
    try {
      this.db.exec('PRAGMA cache_size=-32768');
      for (const file of files) {
        const previous = this.sql.state.get(file.path);
        if (previous && previous.size === file.stat.size && previous.mtime === file.stat.mtimeMs) continue;
        try {
          const result = await this.indexFile(file.path);
          if (result) {
            changed++;
            if (result === 'append') appended++;
          }
        } catch (e) { errors.push({path: file.path, error: e.message}); }
      }
    } finally { this.db.exec(`PRAGMA cache_size=${cacheSize}`); }
    const pending = this.db.prepare('SELECT coalesce(sum(size-indexed_bytes),0) bytes FROM session').get().bytes;
    return {files: files.length, changed, appended, removed, pendingBytes: pending, complete: errors.length === 0 && pending === 0, errors, ms: +(performance.now() - start).toFixed(1)};
  }

  async indexFile(path) {
    // Re-read cache state after obtaining the writer lock: another process may have synced it.
    this.db.exec('BEGIN IMMEDIATE');
    let handle;
    try {
      handle = await open(path, 'r');
      const snapshot = await handle.stat();
      if (!snapshot.isFile()) throw new Error('Not a regular session file');
      const previous = this.sql.state.get(path);
      if (previous && previous.size === snapshot.size && previous.mtime === snapshot.mtimeMs) {
        this.db.exec('COMMIT'); return null;
      }
      let append = false;
      if (previous && snapshot.size > previous.size && previous.indexed_bytes > 0) {
        const tail = Buffer.alloc(previous.indexed_bytes - previous.tail_start);
        const {bytesRead} = await handle.read(tail, 0, tail.length, previous.tail_start);
        append = bytesRead === tail.length && hash(tail) === previous.tail_hash;
      }
      if (!append) this.sql.remove.run(path);
      let session = append ? previous.id : null;
      let name = append ? previous.name : null;
      let updated = append ? previous.updated : null;
      let indexedBytes = append ? previous.indexed_bytes : 0;
      let tailStart = append ? previous.tail_start : 0;
      let tailHash = append ? previous.tail_hash : '';
      let tailLine;
      for await (const {line, offset} of readLines(handle, indexedBytes, snapshot.size)) {
        // readLines does not reuse yielded buffers. Keep the bytes actually indexed,
        // releasing the preceding line before parsing this one; do not re-read the file.
        tailLine = line;
        const text = line.toString('utf8').trim();
        if (text) {
          const e = JSON.parse(text);
          if (!session) {
            if (e.type !== 'session' || e.version !== 3 || typeof e.id !== 'string' || !e.id || typeof e.cwd !== 'string') throw new Error('Expected a Pi v3 session header');
            session = e.id;
            updated = iso(e.timestamp);
            this.sql.session.run(session, path, e.cwd, normalizeCwd(e.cwd), updated, updated, null, e.parentSession ?? null, 0, 0, 0, 0, '');
          } else {
            if (typeof e.type !== 'string' || typeof e.id !== 'string' || !e.id || (e.parentId !== null && typeof e.parentId !== 'string')) throw new Error(`Invalid entry identity at byte ${offset}`);
            const timestamp = iso(e.timestamp);
            if (timestamp > updated) updated = timestamp;
            if (e.type === 'session_info') name = e.name ?? null;
            for (const part of searchParts(e)) {
              const key = `${e.id}|${part.part}|${hash(JSON.stringify([part.kind, part.tool, part.identity, timestamp, part.text]))}`;
              let doc = this.sql.findDoc.get(key)?.id;
              if (doc === undefined) {
                doc = Number(this.sql.doc.run(key, part.kind, part.tool, timestamp).lastInsertRowid);
                this.sql[isToolPart(part.kind) ? 'tool_io' : 'conversation'].run(doc, part.text);
              }
              this.sql.occurrence.run(doc, session, e.id, part.part);
            }
          }
        }
        indexedBytes = offset + line.length;
        tailStart = offset;
      }
      if (!session) throw new Error('Session header is incomplete');
      if (tailLine) tailHash = hash(tailLine);
      const after = await handle.stat();
      if (after.size < snapshot.size || (after.size === snapshot.size && after.mtimeMs !== snapshot.mtimeMs)) throw new Error('Source changed while indexing; retry');
      this.sql.finish.run(name, updated, snapshot.size, snapshot.mtimeMs, indexedBytes, tailStart, tailHash, session);
      this.db.exec('COMMIT');
      return append ? 'append' : previous ? 'replace' : 'new';
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { await handle?.close(); }
  }

  search(options = {}) {
    this.db.exec('BEGIN');
    try {
      const result = this.#search(options);
      this.db.exec('COMMIT');
      return result;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  #search(options) {
    const start = performance.now();
    const limit = options.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be 1..50 per section');
    const scope = occurrenceScope(options);
    // Search dates refer to the evidence; browsing dates refer to a session's last activity.
    const mode = options.mode ?? 'words';
    if (mode !== 'words' && mode !== 'literal') throw new Error('mode must be words or literal');
    const literal = mode === 'literal';
    if (literal && options.anyOf !== undefined) throw new Error('anyOf is available only in words mode');
    const clauses = options.query?.trim() ? [literal ? options.query : ftsQuery(options.query)] : [];
    if (options.anyOf !== undefined) {
      if (!Array.isArray(options.anyOf) || options.anyOf.length < 1 || options.anyOf.length > 12
        || options.anyOf.some(q => typeof q !== 'string' || !q.trim())) {
        throw new Error('anyOf must contain 1..12 nonblank query strings');
      }
      clauses.push('(' + options.anyOf.map(q => '(' + ftsQuery(q) + ')').join(' OR ') + ')');
    }
    const query = clauses.length ? clauses.join(' AND ') : null;
    const hasQuery = query !== null, tool = options.tool ?? null, kind = options.kind;
    if (kind !== undefined && !['user', 'assistant', 'summary', 'custom', 'tool_call', 'tool_result', 'shell'].includes(kind)) {
      throw new Error('kind must be user, assistant, summary, custom, tool_call, tool_result, or shell');
    }
    if (!hasQuery && literal) throw new Error('literal mode requires a nonblank query');
    if (!hasQuery && (tool !== null || options.reasoning || kind !== undefined)) throw new Error('tool, kind and reasoning:true require a nonblank query or anyOf; omit them to browse sessions.');
    const dateColumn = hasQuery ? 'd.timestamp' : 's.updated';
    const dateSql = [], dateArgs = [];
    if (options.since) { dateSql.push(`${dateColumn}>=?`); dateArgs.push(iso(options.since)); }
    if (options.until) { dateSql.push(`${dateColumn}<?`); dateArgs.push(iso(options.until)); }
    // Both sections, hit owners and copy counts come from one read transaction, consistent under a concurrent sync.
    if (!hasQuery) {
      const filter = [scope.sql, ...dateSql].join(' AND ');
      const rows = this.db.prepare(`SELECT s.id sessionId,s.path sessionFile,s.cwd,s.name,s.started,s.updated FROM session s WHERE ${filter} ORDER BY s.updated DESC,s.id LIMIT ?`).all(...scope.args, ...dateArgs, limit + 1);
      return {sessions: rows.slice(0, limit), more: rows.length > limit, ms: +(performance.now() - start).toFixed(1)};
    }
    const results = {};
    const scopedLiteral = literal && !!options.session;
    for (const table of ['conversation', 'tool_io']) {
      const filters = [...dateSql];
      if (!options.reasoning) filters.push("d.kind<>'reasoning'");
      if (tool !== null) filters.push('d.tool=?');
      if (kind !== undefined) filters.push('d.kind=?');
      const args = [query, ...dateArgs, ...(tool !== null ? [tool] : []), ...(kind === undefined ? [] : [kind]), ...scope.args];
      // A single session gives a bounded document set; scan text only for those documents.
      // Otherwise literal scans start from text, avoiding archive-wide random rowid lookups.
      const from = scopedLiteral ? `doc d CROSS JOIN ${table} f ON f.rowid=d.id`
        : `${table} f ${literal ? 'CROSS JOIN' : 'JOIN'} doc d ON d.id=f.rowid`;
      const inScope = scopedLiteral
        ? `d.id IN (SELECT o.doc FROM occurrence o JOIN session s ON s.id=o.session WHERE ${scope.sql})`
        : `EXISTS(SELECT 1 FROM occurrence o JOIN session s ON s.id=o.session WHERE o.doc=d.id AND ${scope.sql})`;
      const rows = this.db.prepare(`
        SELECT d.id,d.kind,d.tool,d.timestamp
        FROM ${from}
        WHERE ${literal ? 'instr(f.text,?)>0' : `f.${table} MATCH ?`} ${filters.length ? 'AND ' + filters.join(' AND ') : ''}
          AND ${inScope}
        ORDER BY ${literal ? '' : 'f.rank,'}d.key LIMIT ?
      `).all(...args, limit + 1);
      // Load complete text/snippets only for the displayed page.
      const preview = this.db.prepare(literal ? `SELECT text source FROM ${table} WHERE rowid=?` : `SELECT text source,
        snippet(${table},0,'[',']','…',32) excerpt, snippet(${table},0,'','',char(1),32) plain
        FROM ${table} WHERE rowid=? AND ${table} MATCH ?`);
      const occurrences = this.db.prepare(`
        SELECT s.id sessionId,s.path sessionFile,s.cwd,s.name,o.entry entryId,o.part
        FROM occurrence o JOIN session s ON s.id=o.session WHERE o.doc=? AND ${scope.sql}
        ORDER BY s.started,s.id LIMIT 1
      `);
      const copies = this.db.prepare(`SELECT count(DISTINCT s.id) n FROM occurrence o JOIN session s ON s.id=o.session WHERE o.doc=? AND ${scope.sql}`);
      results[table === 'tool_io' ? 'tools' : 'conversation'] = {
        hits: rows.slice(0, limit).map(({id, ...row}) => {
          // FTS5 MATCH can ignore a REAL rowid constraint; bind the identifier as INTEGER.
          const {source, plain, excerpt} = literal ? preview.get(BigInt(id)) : preview.get(BigInt(id), query);
          const match = literal ? literalPreview(source, query)
            : source.includes('\0') ? sourcePreview(source, nulMatchOffset(source, query)) : matchPreview(source, plain, excerpt);
          return {...occurrences.get(id, ...scope.args), ...row, ...match,
            copies: copies.get(id, ...scope.args).n};
        }),
        more: rows.length > limit
      };
    }
    return {...results, ms: +(performance.now() - start).toFixed(1)};
  }
}

function literalPreview(source, query) {
  const offset = source.indexOf(query);
  if (offset < 0) throw new Error('Literal match is not an exact source substring');
  return sourcePreview(source, offset);
}

function sourcePreview(source, offset) {
  const from = Math.max(0, offset - 160), to = Math.min(source.length, from + 598);
  return { offset, excerpt: (from ? '…' : '') + source.slice(from, to) + (to < source.length ? '…' : ''),
    excerptTruncated: from > 0 || to < source.length };
}

function matchPreview(source, plain, marked) {
  const text = plain.replace(/^\x01|\x01$/g, '');
  const base = source.indexOf(text);
  if (base < 0) throw new Error('FTS excerpt is not an exact source substring');
  // FTS budgets tokens, not characters. A long token can put the match far past the
  // excerpt's start; the first inserted highlight locates it without parsing the query again.
  const prefix = plain.startsWith('\x01') ? 1 : 0;
  let first = 0;
  while (first < text.length && marked[first + prefix] === text[first]) first++;
  let excerpt = marked;
  const excerptTruncated = text.length < source.length || marked.length > 600;
  if (marked.length > 600) {
    const from = Math.max(0, first + prefix - 200), to = Math.min(marked.length, from + 598);
    excerpt = (from ? '…' : '') + marked.slice(from, to) + (to < marked.length ? '…' : '');
  }
  return {offset: base + first, excerpt, excerptTruncated};
}

function occurrenceScope(options) {
  const clauses = ['1=1'], args = [];
  if (options.cwd) {
    const cwd = normalizeCwd(options.cwd);
    if (options.descendants) {
      const prefix = cwd.endsWith('/') ? cwd : cwd + '/';
      clauses.push('(s.cwd_key=? OR substr(s.cwd_key,1,length(?))=?)'); args.push(cwd, prefix, prefix);
    } else { clauses.push('s.cwd_key=?'); args.push(cwd); }
  }
  if (options.session) { clauses.push('s.id=?'); args.push(options.session); }
  if (options.excludeSession) { clauses.push('s.id<>?'); args.push(options.excludeSession); }
  return {sql: clauses.join(' AND '), args};
}

export function ftsQuery(query) {
  const parts = [];
  let i = 0;
  while (i < query.length) {
    if (/\s/.test(query[i])) { i++; continue; }
    let value;
    if (query[i] === '"') {
      const end = query.indexOf('"', i + 1);
      if (end < 0) throw new Error('Unclosed phrase quote');
      value = query.slice(i + 1, end); i = end + 1;
      if (i < query.length && !/\s/.test(query[i])) throw new Error('Separate phrases with whitespace');
    } else {
      const start = i;
      while (i < query.length && !/\s/.test(query[i])) i++;
      value = query.slice(start, i);
      if (value.includes('"')) throw new Error('Use quotes around a whole phrase');
    }
    if (value.trim()) parts.push('"' + value + '"');
  }
  if (!parts.length) throw new Error('No search terms');
  return parts.join(' AND ');
}
