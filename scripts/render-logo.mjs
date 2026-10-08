// Renders assets/logo.svg to assets/logo-1024.png with headless Chromium
// (source for `tauri icon`, which generates all app/tray icon sizes).
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const svg = readFileSync(resolve('assets/logo.svg'), 'utf8');
const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.locator('svg').screenshot({ path: resolve('assets/logo-1024.png'), omitBackground: true });
await browser.close();
console.log('assets/logo-1024.png written');
