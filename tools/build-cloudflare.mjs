import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
const allowed = new Set(['index.html', 'vendor', '_headers']);
await mkdir(out, { recursive: true });
const existing = await readdir(out);
const unexpected = existing.filter((entry) => !allowed.has(entry));
if (unexpected.length) throw new Error(`Unexpected deploy asset in dist: ${unexpected.join(', ')}`);
const html = await readFile(join(root, 'spi-spc.html'));
await writeFile(join(out, 'index.html'), html);
await cp(join(root, 'vendor'), join(out, 'vendor'), { recursive: true, force: true });
try {
  await cp(join(root, '_headers'), join(out, '_headers'), { force: true });
} catch {}
console.log(`Cloudflare assets: index.html, vendor/, _headers (${html.length} HTML bytes)`);
