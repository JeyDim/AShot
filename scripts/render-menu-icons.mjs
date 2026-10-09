// Renders the tray menu icons to PNG with headless Chromium: src-tauri/icons/menu/<item>.png —
// 16 px (the menu draws its icons at 16 × 16), white on transparent; the app tints them to the
// menu's text color (light / dark menu). Line 2 on a 24 grid, from the design
// «AShot — вариации 09 → Иконки меню трея»; `scroll` — ChevronsDown, as on the tray panel's tile.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ICONS = {
  region: 'M4 8V4H8M16 4H20V8M20 16V20H16M8 20H4V16M11 4H13M20 11V13M13 20H11M4 13V11',
  window: 'M5 4H19A2 2 0 0 1 21 6V18A2 2 0 0 1 19 20H5A2 2 0 0 1 3 18V6A2 2 0 0 1 5 4ZM3 9H21',
  fullscreen: 'M4 4H20A1 1 0 0 1 21 5V16A1 1 0 0 1 20 17H4A1 1 0 0 1 3 16V5A1 1 0 0 1 4 4ZM8 21H16M12 17V21',
  scroll: 'M7 6L12 11L17 6M7 13L12 18L17 13',
  panel: 'M3 12A9 9 0 1 0 5.6 5.6M3 3V8H8M12 7V12L15 14',
  settings: 'M4 7H13M19 7H20M13 7A3 3 0 1 0 19 7A3 3 0 1 0 13 7M4 17H5M11 17H20M5 17A3 3 0 1 0 11 17A3 3 0 1 0 5 17',
  about: 'M12 3A9 9 0 1 1 12 21A9 9 0 1 1 12 3ZM12 11V16M12 8V8.01',
  quit: 'M14 4H18A2 2 0 0 1 20 6V18A2 2 0 0 1 18 20H14M10 8L6 12L10 16M6 12H15',
};
const SIZE = 16;

mkdirSync(resolve('src-tauri/icons/menu'), { recursive: true });
const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
for (const [id, d] of Object.entries(ICONS)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="${d}"/></svg>`;
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.locator('svg').screenshot({ path: resolve(`src-tauri/icons/menu/${id}.png`), omitBackground: true });
  console.log(`src-tauri/icons/menu/${id}.png written`);
}
await browser.close();
