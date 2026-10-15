// Packages dist/ into a versioned, load-unpacked-ready release zip.
//
//   npm run release   →  test + build + this script
//
// Output: release/codesync-extension-v{version}.zip (+ .sha256 sidecar).
// The zip stores files at its root (what the Chrome Web Store expects);
// end users just extract it into a folder and pick "Load unpacked".
// Written with Node built-ins only (store-method zip, UTF-8 names).
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const releaseDir = path.join(root, 'release');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
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

function collectFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...collectFiles(full, rel));
    else out.push({ name: rel.split(path.sep).join('/'), data: readFileSync(full) });
  }
  return out;
}

function buildZipBuffer(files) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const size = file.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + size;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

const manifest = JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
const files = collectFiles(dist);
if (!files.length) throw new Error('dist/ is empty — run `npm run build` first');
if (!files.some((f) => f.name === 'manifest.json')) throw new Error('dist/manifest.json missing');

mkdirSync(releaseDir, { recursive: true });
const zipName = `codesync-extension-v${manifest.version}.zip`;
const zipPath = path.join(releaseDir, zipName);
const zip = buildZipBuffer(files);
writeFileSync(zipPath, zip);

const sha = createHash('sha256').update(zip).digest('hex');
writeFileSync(`${zipPath}.sha256`, `${sha}  ${zipName}\n`);

console.log(`release: release/${zipName}`);
console.log(`  version: ${manifest.version}`);
console.log(`  files:   ${files.length}`);
console.log(`  size:    ${(zip.length / 1024).toFixed(1)} KiB`);
console.log(`  sha256:  ${sha}`);
console.log('');
console.log('New users: extract the zip into a folder, open chrome://extensions,');
console.log('enable "Developer mode", click "Load unpacked" and select that folder.');
