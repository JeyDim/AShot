// Renders the app icon (1b «Лаймовая плашка») with headless Chromium, in two masters — a
// progressive scale: 16–20 px from the pixel master assets/logo-16.svg, 24 px and up from
// assets/logo.svg (AShot and AShot Dev).
//   assets/logo-1024.png      → `tauri icon` (bundle PNGs, icns, Square*Logo);
//   src-tauri/icons/icon.ico  → rewritten afterwards with each size from its own master (the exe
//                               icon: Explorer, Start, shortcuts, the editor's title bar);
//   src-tauri/icons/tray/N.png → the tray icon, one per taskbar scale (16 px at 100 % … 48 at 300 %).
import { chromium } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SMALL_MAX = 20;
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const TRAY_SIZES = [16, 20, 24, 28, 32, 36, 40, 48];

const masters = { large: readFileSync(resolve('assets/logo.svg'), 'utf8'), small: readFileSync(resolve('assets/logo-16.svg'), 'utf8') };
const sized = (svg, px) => svg.replace(/width="\d+" height="\d+"/, `width="${px}" height="${px}"`);

const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
async function render(px, path) {
  const svg = sized(px <= SMALL_MAX ? masters.small : masters.large, px);
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg style="display:block" ')}</body></html>`);
  return page.locator('svg').screenshot({ path, omitBackground: true });
}

await render(1024, resolve('assets/logo-1024.png'));
console.log('assets/logo-1024.png written');
mkdirSync(resolve('src-tauri/icons/tray'), { recursive: true });
for (const px of TRAY_SIZES) await render(px, resolve(`src-tauri/icons/tray/${px}.png`));
console.log(`src-tauri/icons/tray/{${TRAY_SIZES.join(',')}}.png written`);
const ico = [];
for (const px of ICO_SIZES) ico.push({ px, png: await render(px) });
await browser.close();

const tauri = spawnSync('npx tauri icon assets/logo-1024.png', { stdio: 'inherit', shell: true });
if (tauri.status !== 0) process.exit(tauri.status ?? 1);

// ICO: a directory of PNG entries (Windows Vista and up), each size drawn from its own master.
const dir = Buffer.alloc(6 + 16 * ico.length);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(ico.length, 4);
let offset = dir.length;
ico.forEach(({ px, png }, i) => {
  const at = 6 + 16 * i;
  dir.writeUInt8(px % 256, at); // 0 = 256
  dir.writeUInt8(px % 256, at + 1);
  dir.writeUInt16LE(1, at + 4); // planes
  dir.writeUInt16LE(32, at + 6); // bits per pixel
  dir.writeUInt32LE(png.length, at + 8);
  dir.writeUInt32LE(offset, at + 12);
  offset += png.length;
});
writeFileSync(resolve('src-tauri/icons/icon.ico'), Buffer.concat([dir, ...ico.map((e) => e.png)]));
console.log(`src-tauri/icons/icon.ico written (${ICO_SIZES.join(', ')} px)`);
