// Keep each Wrangler --command below both D1's SQL limit and Windows' command-line limit.
export const SQL_CHUNK_BYTES = 8 * 1024;

export const sql = (value) => `CAST(X'${Buffer.from(String(value)).toString('hex')}' AS TEXT)`;

export function metadataMatches(stored, source, store, key) {
  const destination = JSON.parse(stored || 'null');
  if (store === 'spi-maint' && key === 'share-cleanup') {
    // Netlify returns {} for this housekeeping blob; Cloudflare's scheduler writes NULL.
    const empty = (value) => value == null ||
      (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
    if (empty(destination) && empty(source)) return true;
  }
  return JSON.stringify(destination) === JSON.stringify(source);
}

export function* utf8Chunks(text, maxBytes = SQL_CHUNK_BYTES) {
  let chunk = '';
  let size = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > maxBytes && chunk) {
      yield chunk;
      chunk = '';
      size = 0;
    }
    chunk += character;
    size += bytes;
  }
  if (chunk) yield chunk;
}
