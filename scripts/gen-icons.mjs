// Renders the extension icon (rounded gradient tile with a speech bubble) to
// PNG at every size the manifest needs. Zero dependencies: rasterizes signed
// distance fields with 4x4 supersampling and encodes PNG with node:zlib.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icons');
const STORE_OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'store');
const SIZES = [16, 32, 48, 128];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

// Triangle (bubble tail) via barycentric inside test → hard edge, smoothed by supersampling.
function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const s = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / d;
  const t = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) / d;
  return s >= 0 && t >= 0 && s + t <= 1;
}

/** Color at unit coordinates (0..1). Returns [r,g,b,a] 0..255 or null for transparent. */
function shade(x, y) {
  // Tile
  if (sdRoundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) return null;
  const t = clamp01((x + y) / 2);
  let r = lerp(0x5b, 0x8b, t);
  let g = lerp(0x5b, 0x5c, t);
  let b = lerp(0xf7, 0xf6, t);

  // Speech bubble
  const inBubble = sdRoundRect(x, y, 0.5, 0.46, 0.29, 0.21, 0.12) <= 0
    || inTriangle(x, y, [0.32, 0.6], [0.47, 0.64], [0.27, 0.8]);
  if (inBubble) {
    [r, g, b] = [255, 255, 255];
    // Three dots
    for (const cx of [0.37, 0.5, 0.63]) {
      if (sdCircle(x, y, cx, 0.46, 0.045) <= 0) [r, g, b] = [lerp(0x5b, 0x8b, t), lerp(0x5b, 0x5c, t), lerp(0xf7, 0xf6, t)];
    }
  }
  return [r, g, b, 255];
}

function render(size) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const i = (y * size + x) * 4;
      const n = ss * ss;
      px[i] = a ? Math.round(r / a) : 0;
      px[i + 1] = a ? Math.round(g / a) : 0;
      px[i + 2] = a ? Math.round(b / a) : 0;
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT, `icon${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log('wrote', file);
}

// 300×300 logo for the Edge Add-ons listing (not packaged in the extension).
mkdirSync(STORE_OUT, { recursive: true });
const logo = join(STORE_OUT, 'logo-300.png');
writeFileSync(logo, encodePng(300, render(300)));
console.log('wrote', logo);
