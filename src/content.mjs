// Searchable parts of recorded Pi entries. Source graph and opaque payloads stay outside FTS.
const pad = n => String(n).padStart(2, '0');

// A recorded instant on this computer's clock with its UTC offset, to the minute: the clock that
// since/until bounds without an offset use, and a valid bound itself.
export function localTime(at) {
  const d = new Date(at), offset = -d.getTimezoneOffset(), abs = Math.abs(offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    + `${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const retrievalTools = new Set(['session_search', 'session_read', 'recall']);

function argumentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(argumentText).join('\n');
  if (value && typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}: ${argumentText(v)}`).join('\n');
  return JSON.stringify(value) ?? '';
}

export function sourceParts(entry) {
  const parts = [];
  const add = (part, kind, text, tool = null, identity = null) => {
    if (typeof text === 'string' && text.trim()) parts.push({part, kind, text, tool, identity});
  };
  const textParts = (content, base, kind, tool = null, identity = null) => {
    if (typeof content === 'string') add(base, kind, content, tool, identity);
    else if (Array.isArray(content)) content.forEach((b, i) => {
      if (b.type === 'text') add(`${base}/${i}/text`, kind, b.text, tool, identity);
    });
  };
  if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    add('/summary', 'summary', entry.summary);
  } else if (entry.type === 'custom_message') {
    textParts(entry.content, '/content', 'custom', null, entry.customType);
  } else if (entry.type === 'message') {
    const m = entry.message;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      m.content.forEach((b, i) => {
        const base = `/message/content/${i}`;
        if (b.type === 'text') add(`${base}/text`, 'assistant', b.text);
        if (b.type === 'thinking' && !b.redacted) add(`${base}/thinking`, 'reasoning', b.thinking);
        if (b.type === 'toolCall') {
          add(`${base}/arguments`, 'tool_call', argumentText(b.arguments), b.name, b.id);
        }
      });
    } else if (m.role === 'toolResult') {
      // A script tool records the calls it made on its result; their outputs exist only in its content.
      m.nestedCalls?.calls?.forEach((c, i) => add(`/message/nestedCalls/calls/${i}/arguments`, 'tool_call', argumentText(c.arguments), c.name, c.id));
      textParts(m.content, '/message/content', 'tool_result', m.toolName, [m.toolCallId, !!m.isError]);
    } else if (m.role === 'user' || m.role === 'custom') {
      textParts(m.content, '/message/content', m.role, null, m.customType ?? null);
    } else if (m.role === 'bashExecution') {
      const status = [m.exitCode ?? null, !!m.cancelled, !!m.truncated];
      add('/message/command', 'shell', m.command, 'shell', status);
      add('/message/output', 'shell', m.output, 'shell', status);
    }
  }
  return parts;
}

export function searchParts(entry) {
  const nested = entry.message?.role === 'toolResult' ? entry.message.nestedCalls : null;
  if (nested?.complete && nested.calls.length > 0 && nested.calls.every(c => retrievalTools.has(c.name))) return [];
  return sourceParts(entry).filter(p => !retrievalTools.has(p.tool));
}

export const isToolPart = kind => kind === 'tool_call' || kind === 'tool_result' || kind === 'shell';

export function normalizeCwd(cwd) {
  const windows = /^[a-z]:[/\\]/i.test(cwd) || cwd.startsWith('\\\\');
  let result = windows ? cwd.replaceAll('\\', '/').toLowerCase() : cwd;
  if (result !== '/' && !/^[a-z]:\/$/.test(result)) result = result.replace(/\/+$/, '');
  return result;
}
