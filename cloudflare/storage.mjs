// Netlify Blobs 相容介面。索引與稽核放 D1，二進位原始檔與分享本文放私有 R2。
// D1 的 (store,key) 唯一鍵與 etag 比對提供條件寫入；R2 物件不對外公開。
const token = () => crypto.randomUUID();
const objectKey = (store, key) => `${store}/${key}`;
const value = (r) => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : null });

export function createStore(env, store) {
  if (!env.DB || !env.BLOBS) throw new Error('Cloudflare storage bindings missing');
  const db = env.DB;
  const row = (key) => db.prepare('SELECT kind, body, metadata, etag FROM objects WHERE store = ? AND key = ?').bind(store, key).first();
  const listPage = async (prefix, after) => {
    const out = await db.prepare('SELECT key FROM objects WHERE store = ? AND substr(key, 1, ?) = ? AND key > ? AND kind != ? ORDER BY key LIMIT 100')
      .bind(store, prefix.length, prefix, after, 'pending').all();
    return (out.results || []).map(({ key }) => ({ key }));
  };
  return {
    async getWithMetadata(key, { type } = {}) {
      const r = await row(key);
      if (!r || r.kind === 'pending') return null;
      const info = value(r);
      let data;
      if (r.kind === 'binary') {
        const hit = await env.BLOBS.get(objectKey(store, key));
        if (!hit) return null;
        data = await hit.arrayBuffer();
      } else if (type === 'json') {
        data = JSON.parse(r.body);
      } else {
        data = r.body;
      }
      return { data, metadata: info.metadata, etag: r.etag };
    },
    async get(key, opts) { return (await this.getWithMetadata(key, opts))?.data ?? null; },
    async getMetadata(key) {
      const r = await row(key);
      return r && r.kind !== 'pending' ? { metadata: value(r).metadata, etag: r.etag } : null;
    },
    async setJSON(key, data, opts = {}) {
      const body = JSON.stringify(data), etag = token();
      let result;
      if (opts.onlyIfMatch) {
        result = await db.prepare('UPDATE objects SET kind = ?, body = ?, metadata = NULL, etag = ? WHERE store = ? AND key = ? AND etag = ?')
          .bind('json', body, etag, store, key, opts.onlyIfMatch).run();
      } else if (opts.onlyIfNew) {
        result = await db.prepare('INSERT OR IGNORE INTO objects (store, key, kind, body, etag) VALUES (?, ?, ?, ?, ?)')
          .bind(store, key, 'json', body, etag).run();
      } else {
        result = await db.prepare('INSERT INTO objects (store, key, kind, body, etag) VALUES (?, ?, ?, ?, ?) ON CONFLICT(store,key) DO UPDATE SET kind=excluded.kind, body=excluded.body, metadata=NULL, etag=excluded.etag')
          .bind(store, key, 'json', body, etag).run();
      }
      return { modified: (result.meta?.changes || 0) > 0, etag };
    },
    async set(key, data, opts = {}) {
      const isBinary = data instanceof ArrayBuffer || ArrayBuffer.isView(data);
      if (!isBinary) {
        const etag = token();
        const result = opts.onlyIfNew
          ? await db.prepare('INSERT OR IGNORE INTO objects (store,key,kind,body,metadata,etag) VALUES (?,?,?,?,?,?)').bind(store,key,'text',String(data),JSON.stringify(opts.metadata || null),etag).run()
          : await db.prepare('INSERT INTO objects (store,key,kind,body,metadata,etag) VALUES (?,?,?,?,?,?) ON CONFLICT(store,key) DO UPDATE SET kind=excluded.kind,body=excluded.body,metadata=excluded.metadata,etag=excluded.etag').bind(store,key,'text',String(data),JSON.stringify(opts.metadata || null),etag).run();
        return { modified: (result.meta?.changes || 0) > 0, etag };
      }
      // 先保留唯一鍵；未完成的 R2 寫入不可被讀出。
      const etag = token();
      const reserve = await db.prepare('INSERT OR IGNORE INTO objects (store,key,kind,metadata,etag) VALUES (?,?,?,?,?)')
        .bind(store,key,'pending',JSON.stringify(opts.metadata || null),etag).run();
      if (!(reserve.meta?.changes > 0)) return { modified: false };
      try {
        await env.BLOBS.put(objectKey(store,key), data);
        const done = await db.prepare('UPDATE objects SET kind = ? WHERE store = ? AND key = ? AND etag = ? AND kind = ?')
          .bind('binary',store,key,etag,'pending').run();
        if (!(done.meta?.changes > 0)) throw new Error('Storage reservation lost');
      } catch (e) {
        await db.prepare('DELETE FROM objects WHERE store = ? AND key = ? AND etag = ? AND kind = ?').bind(store,key,etag,'pending').run();
        await env.BLOBS.delete(objectKey(store,key));
        throw e;
      }
      return { modified: true, etag };
    },
    async delete(key) {
      await db.prepare('DELETE FROM objects WHERE store = ? AND key = ?').bind(store,key).run();
      await env.BLOBS.delete(objectKey(store,key));
    },
    list(opts = {}) {
      const prefix = opts.prefix || '';
      if (opts.paginate) return {
        async *[Symbol.asyncIterator]() {
          let after = '';
          while (true) {
            const blobs = await listPage(prefix, after);
            if (!blobs.length) break;
            yield { blobs };
            after = blobs[blobs.length - 1].key;
            if (blobs.length < 100) break;
          }
        },
      };
      return (async () => {
        const blobs = [];
        let after = '';
        while (true) {
          const page = await listPage(prefix, after);
          if (!page.length) break;
          blobs.push(...page);
          after = page[page.length - 1].key;
          if (page.length < 100) break;
        }
        return { blobs };
      })();
    },
  };
}
