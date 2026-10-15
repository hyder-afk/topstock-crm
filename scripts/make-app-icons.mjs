#!/usr/bin/env node
// Home-screen icons for the PWA basics (Day 7c, Haider's answer to plan question 8: home-screen icon, full-screen app
// look and safe areas only; no service worker, no offline mode, no install prompt). Made from the logo mark already in
// the repo (src/app/icon.svg, the Brand Pack's submark tile): the block-T path is read from that file, so the icons can
// never drift from it. Colours are DESIGN.md's: Signal Red #F2203E tile, Chalk White #F5F3EF mark.
//
//   node scripts/make-app-icons.mjs     writes public/icons/{icon-192,icon-512,maskable-192,maskable-512}.png and
//                                       src/app/apple-icon.png (committed)
//
// - icon-*.png (purpose "any"): the tile as in icon.svg, rounded corners on transparency.
// - maskable-*.png (purpose "maskable"): full-bleed red square, the mark scaled to 56% of the height so its farthest
//   corner stays inside the central safe circle (radius 40% of the size) that Android and others keep after masking.
// - apple-icon.png (180 x 180): full-bleed red square (iOS rounds the corners itself), the mark as in icon.svg.
// Uses sharp, which Next.js already installs (node_modules/sharp, via next); nothing is added to package.json.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(ROOT, "src/app/icon.svg"), "utf8");
const mark = /<path d="([^"]+)"/.exec(source)?.[1];
if (!mark) throw new Error("no path in src/app/icon.svg");
const RED = "#F2203E";
const CHALK = "#F5F3EF";
// The mark is 100 x 130 units. `height` is its height as a share of the 100-unit square; it is centred.
function svg({ height, rounded }) {
  const scale = height / 130;
  const x = (100 - 100 * scale) / 2;
  const y = (100 - height) / 2;
  const tile = rounded ? `<rect width="100" height="100" rx="22" fill="${RED}"/>` : `<rect width="100" height="100" fill="${RED}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${tile}<g transform="translate(${x.toFixed(3)} ${y.toFixed(3)}) scale(${scale.toFixed(5)})"><path d="${mark}" fill="${CHALK}"/></g></svg>`;
}
const outputs = [
  ["public/icons/icon-192.png", 192, { height: 64, rounded: true }],
  ["public/icons/icon-512.png", 512, { height: 64, rounded: true }],
  ["public/icons/maskable-192.png", 192, { height: 56, rounded: false }],
  ["public/icons/maskable-512.png", 512, { height: 56, rounded: false }],
  ["src/app/apple-icon.png", 180, { height: 64, rounded: false }],
];
for (const [file, size, opts] of outputs) {
  const png = await sharp(Buffer.from(svg(opts)), { density: (72 * size) / 100 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(path.join(ROOT, file), png);
  console.log(`${file}: ${size} x ${size}, ${png.length} bytes`);
}
