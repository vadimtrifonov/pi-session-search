// Read a descriptor-pinned byte range without retaining a whole image-heavy session.
// Only newline-terminated records are yielded; the live trailing record remains unpublished.
export async function* readLines(handle, start, end) {
  if (start >= end) return;
  let pending = Buffer.alloc(0), offset = start;
  const stream = handle.createReadStream({autoClose: false, start, end: end - 1, highWaterMark: 1 << 20});
  for await (const chunk of stream) {
    const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let from = 0, newline;
    while ((newline = bytes.indexOf(10, from)) !== -1) {
      const line = bytes.subarray(from, newline + 1);
      yield {line, offset};
      offset += line.length;
      from = newline + 1;
    }
    pending = bytes.subarray(from);
  }
}
