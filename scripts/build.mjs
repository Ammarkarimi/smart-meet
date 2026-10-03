// Validates the extension and packages it as a Chrome Web Store-ready zip.
//   node scripts/build.mjs           -> dist/smart-meet-<version>.zip
//   node scripts/build.mjs --check   -> validation only

import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = ['manifest.json', 'PRIVACY.md', 'src', 'assets/icons'];
const checkOnly = process.argv.includes('--check');

const errors = [];
const fail = (msg) => errors.push(msg);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const toPosix = (p) => p.split(sep).join('/');

// --- Validation ------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) fail(`invalid manifest version "${manifest.version}"`);
if (manifest.version !== pkg.version) fail(`manifest version ${manifest.version} != package.json version ${pkg.version}`);
if (manifest.name.length > 75) fail('name must be <= 75 characters');
if (manifest.description.length > 132) fail(`description is ${manifest.description.length} chars; the store limit is 132`);

const referenced = new Set([
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  manifest.side_panel?.default_path,
  manifest.options_ui?.page,
  manifest.background?.service_worker,
  ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
].filter(Boolean));
for (const f of referenced) if (!existsSync(join(ROOT, f))) fail(`manifest references missing file: ${f}`);

const files = INCLUDE.flatMap((p) => {
  const abs = join(ROOT, p);
  if (!existsSync(abs)) { fail(`missing ${p}`); return []; }
  return statSync(abs).isDirectory() ? walk(abs) : [abs];
});

// Every local import / src / href must resolve inside the package.
const included = new Set(files.map((f) => resolve(f)));
for (const file of files) {
  if (!/\.(js|mjs|html|css)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  const refs = [];
  if (file.endsWith('.html')) {
    for (const m of text.matchAll(/\b(?:src|href)="([^"]+)"/g)) refs.push(m[1]);
    if (/<script(?![^>]*\bsrc=)[^>]*>[^<]+<\/script>/i.test(text)) fail(`${toPosix(relative(ROOT, file))}: inline <script> is blocked by the extension CSP`);
  } else if (/\.m?js$/.test(file)) {
    for (const m of text.matchAll(/(?:^|\s)(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]/gm)) refs.push(m[1]);
    for (const m of text.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) refs.push(m[1]);
  }
  for (const ref of refs) {
    if (/^(https?:|data:|#|mailto:|chrome:)/.test(ref)) continue;
    const target = resolve(dirname(file), ref.split(/[?#]/)[0]);
    if (!included.has(target)) fail(`${toPosix(relative(ROOT, file))}: reference "${ref}" does not resolve to a packaged file`);
  }
}

if (errors.length) {
  console.error(`✗ ${errors.length} problem(s):\n  - ${errors.join('\n  - ')}`);
  process.exit(1);
}
console.log(`✓ manifest and ${files.length} files validated (v${manifest.version})`);
if (checkOnly) process.exit(0);

// --- Zip -------------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);            // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const entries = files
  .map((f) => ({ name: toPosix(relative(ROOT, f)), data: readFileSync(f) }))
  .sort((a, b) => a.name.localeCompare(b.name));
const out = join(ROOT, 'dist', `smart-meet-${manifest.version}.zip`);
mkdirSync(dirname(out), { recursive: true });
const buf = zip(entries);
writeFileSync(out, buf);
console.log(`✓ packaged ${entries.length} files → ${toPosix(relative(ROOT, out))} (${(buf.length / 1024).toFixed(1)} KB)`);
