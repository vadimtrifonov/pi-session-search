// Read a descriptor-pinned byte range without retaining a whole image-heavy session.
// Only newline-terminated records are yielded; the live trailing record remains unpublished.
export async function* readLines(handle, start, end) {
  if (start >= end) return;
  let pending = [], pendingBytes = 0, offset = start;
  const stream = handle.createReadStream({autoClose: false, start, end: end - 1, highWaterMark: 1 << 20});
  for await (const chunk of stream) {
    let from = 0, newline;
    while ((newline = chunk.indexOf(10, from)) !== -1) {
      const tail = chunk.subarray(from, newline + 1);
      // Assemble a spanning record once, rather than recopying its growing prefix per chunk.
      const line = pendingBytes ? Buffer.concat([...pending, tail], pendingBytes + tail.length) : tail;
      pending = []; pendingBytes = 0;
      yield {line, offset};
      offset += line.length;
      from = newline + 1;
    }
    if (from < chunk.length) {
      const tail = chunk.subarray(from);
      pending.push(tail);
      pendingBytes += tail.length;
    }
  }
}
