// Generates the extension's PNG icons at build time (no image dependencies).
//
// Design: rounded blue tile with a white code glyph "</>" — legible down to
// 16px (the toolbar size). Renders with a signed-distance-field rasterizer at
// 4x supersampling, then downsamples with premultiplied-alpha averaging for
// clean anti-aliased edges. Output: icon-16/32/48/128.png.
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ICON_SIZES = [16, 32, 48, 128];
export const ACTION_ICON_SIZES = [16, 32, 48];

const SUPERSAMPLE = 4;
const BG = [37, 99, 235]; // blue-600
const GLYPH = [255, 255, 255];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // scanline filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function sdRoundRect(px, py, halfWidth, halfHeight, radius) {
  const qx = Math.abs(px - 0.5) - (halfWidth - radius);
  const qy = Math.abs(py - 0.5) - (halfHeight - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

function sdSegment(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const t = Math.min(1, Math.max(0, ((px - x1) * vx + (py - y1) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy));
}

// The "</>" glyph as line segments in unit coordinates. Endpoints are spaced
// so every stroke keeps a visible gap even at 16px.
const GLYPH_SEGMENTS = [
  [0.32, 0.31, 0.15, 0.5], // < upper
  [0.15, 0.5, 0.32, 0.69], // < lower
  [0.68, 0.31, 0.85, 0.5], // > upper
  [0.85, 0.5, 0.68, 0.69], // > lower
  [0.57, 0.26, 0.43, 0.74], // slash
];
const GLYPH_WIDTH = 0.085;

function renderIcon(size) {
  const grid = size * SUPERSAMPLE;
  const samples = new Float32Array(grid * grid * 4); // premultiplied RGBA
  for (let y = 0; y < grid; y += 1) {
    for (let x = 0; x < grid; x += 1) {
      const u = (x + 0.5) / grid;
      const v = (y + 0.5) / grid;
      if (sdRoundRect(u, v, 0.5, 0.5, 0.22) > 0) continue; // outside the tile
      let color = BG;
      for (const [x1, y1, x2, y2] of GLYPH_SEGMENTS) {
        if (sdSegment(u, v, x1, y1, x2, y2) <= GLYPH_WIDTH / 2) {
          color = GLYPH;
          break;
        }
      }
      const i = (y * grid + x) * 4;
      samples[i] = color[0];
      samples[i + 1] = color[1];
      samples[i + 2] = color[2];
      samples[i + 3] = 1;
    }
  }
  const out = Buffer.alloc(size * size * 4);
  const area = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const i = ((y * SUPERSAMPLE + sy) * grid + (x * SUPERSAMPLE + sx)) * 4;
          r += samples[i];
          g += samples[i + 1];
          b += samples[i + 2];
          a += samples[i + 3];
        }
      }
      const o = (y * size + x) * 4;
      out[o] = a ? Math.round(r / a) : 0; // un-premultiply
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / area) * 255);
    }
  }
  return encodePng(size, size, out);
}

export async function generateIcons(outDir) {
  await mkdir(outDir, { recursive: true });
  const written = [];
  for (const size of ICON_SIZES) {
    const file = path.join(outDir, `icon-${size}.png`);
    await writeFile(file, renderIcon(size));
    written.push(file);
  }
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const target = process.argv[2] || path.join(process.cwd(), 'dist', 'icons');
  const files = await generateIcons(target);
  for (const file of files) console.log('wrote', file);
}
