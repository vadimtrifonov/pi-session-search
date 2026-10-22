import { DatabaseSync } from 'node:sqlite';

// SQLite highlight/snippet can drop text at NULs, including within matched phrases.
// NUL and space are separators for this tokenizer; their replacement preserves UTF-16 offsets.
export function nulMatchOffset(source, query) {
  const projection = source.replaceAll('\0', ' ');
  let n = 0, start, end;
  do {
    start = `\u0001${n}\u0002`; end = `\u0003${n}\u0004`; n++;
  } while (projection.includes(start) || projection.includes(end));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE VIRTUAL TABLE preview USING fts5(text, tokenize='unicode61 remove_diacritics 2')");
    db.prepare('INSERT INTO preview(text) VALUES(?)').run(projection);
    const row = db.prepare('SELECT highlight(preview,0,?,?) marked FROM preview WHERE preview MATCH ?').get(start, end, query);
    if (!row || row.marked.replaceAll(start, '').replaceAll(end, '') !== projection) {
      throw new Error('NUL-safe word preview does not preserve the source projection');
    }
    const offset = row.marked.indexOf(start);
    if (offset < 0) throw new Error('NUL-safe word preview has no native match position');
    return offset;
  } finally { db.close(); }
}
