// Folder-driven photo pipeline for the wedding countdown.
//
//   npm run photos
//
// For every image in /photos (couple photos) and /photos/pequenos (childhood photos):
//   - decodes it (HEIC via heic-convert, others natively)
//   - auto-rotates from EXIF, resizes to fit MAX px, encodes to WebP
//   - writes the optimized file into /photos/web (mirrors the source layout)
// Then it injects the photo list (filenames + dimensions) into countdown.html
// between the <!-- PHOTOS:START --> / <!-- PHOTOS:END --> markers.
//
// Re-runs are cheap: an image is reconverted only when its source is newer
// than the existing output. Drop new photos in, run again, git push.

import { readdir, mkdir, stat, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import heicConvert from 'heic-convert';

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'photos');
const PEQ_DIR = path.join(SRC_DIR, 'pequenos');
const OUT_DIR = path.join(SRC_DIR, 'web');
const OUT_PEQ_DIR = path.join(OUT_DIR, 'pequenos');
const HTML = path.join(ROOT, 'countdown.html');

const MAX = 1600;      // longest edge, px
const QUALITY = 80;    // webp quality
const IMG_RE = /\.(heic|heif|jpe?g|png)$/i;

async function listImages(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter(e => e.isFile() && IMG_RE.test(e.name)).map(e => e.name);
}

// Detect real HEIC/HEIF by the ISO-BMFF `ftyp` brand — not the extension,
// since some files are mislabeled (e.g. a JPEG saved as .heic).
function isHeic(buf) {
  if (buf.length < 12 || buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('ascii', 8, 12);
  return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand);
}

async function decodeToSharp(file) {
  const buf = await readFile(file);
  if (isHeic(buf)) {
    const jpg = await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.92 });
    return sharp(Buffer.from(jpg));
  }
  return sharp(buf); // sharp reads jpeg/png/webp regardless of the file's extension
}

const webName = name => name.replace(IMG_RE, '.webp');

async function convertOne(srcPath, outPath) {
  if (existsSync(outPath)) {
    const [s, o] = await Promise.all([stat(srcPath), stat(outPath)]);
    if (o.mtimeMs >= s.mtimeMs) {
      const meta = await sharp(outPath).metadata();
      return { width: meta.width, height: meta.height, skipped: true };
    }
  }
  const img = (await decodeToSharp(srcPath))
    .rotate()
    .resize({ width: MAX, height: MAX, fit: 'inside', withoutEnlargement: true });
  const out = await img.webp({ quality: QUALITY }).toBuffer({ resolveWithObject: true });
  await writeFile(outPath, out.data);
  return { width: out.info.width, height: out.info.height, skipped: false };
}

// Date-named files (YYYY-MM-DD…) sort chronologically first; everything else after, by name.
function sortKey(name) {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `0_${m[1]}${m[2]}${m[3]}_${name}` : `1_${name.toLowerCase()}`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(OUT_PEQ_DIR, { recursive: true });

  // ---- Gallery: all top-level /photos images, chronological ----
  const galleryNames = (await listImages(SRC_DIR)).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const gallery = [];
  const failures = [];
  for (const name of galleryNames) {
    try {
      const info = await convertOne(path.join(SRC_DIR, name), path.join(OUT_DIR, webName(name)));
      gallery.push({ src: `photos/web/${webName(name)}`, w: info.width, h: info.height });
      console.log(`${info.skipped ? 'skip' : 'conv'}  ${name}  ${info.width}x${info.height}`);
    } catch (err) {
      failures.push(name);
      console.warn(`FAIL  ${name}  (${err.message}) — skipped`);
    }
  }

  // ---- Hero: /photos/pequenos childhood photos ----
  const peqNames = (await listImages(PEQ_DIR)).sort();
  const hero = [];
  const kids = {};
  for (const name of peqNames) {
    try {
      const info = await convertOne(path.join(PEQ_DIR, name), path.join(OUT_PEQ_DIR, webName(name)));
      const src = `photos/web/pequenos/${webName(name)}`;
      hero.push(src);
      if (/adam/i.test(name)) kids.adam = src;   // name a file adam*.* to set Adam's circle
      if (/reme/i.test(name)) kids.reme = src;   // name a file reme*.* to set Reme's circle
      console.log(`${info.skipped ? 'skip' : 'conv'}  pequenos/${name}`);
    } catch (err) {
      failures.push(`pequenos/${name}`);
      console.warn(`FAIL  pequenos/${name}  (${err.message}) — skipped`);
    }
  }

  // ---- Inject the manifest into countdown.html ----
  const json = JSON.stringify({ hero, kids, gallery });
  const START = '<!-- PHOTOS:START -->';
  const END = '<!-- PHOTOS:END -->';
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${esc(START)}[\\s\\S]*?${esc(END)}`);

  let html = await readFile(HTML, 'utf8');
  if (!re.test(html)) throw new Error('PHOTOS markers not found in countdown.html');
  const block = `${START}\n<script>window.__PHOTOS__ = ${json};</` + `script>\n${END}`;
  await writeFile(HTML, html.replace(re, block));

  console.log(`\nDone. gallery: ${gallery.length}, hero(pequenos): ${hero.length}, kids: ${Object.keys(kids).join(', ') || '(none)'}`);
  if (failures.length) console.warn(`Skipped ${failures.length} unreadable file(s): ${failures.join(', ')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
