// Renders the app icon to PNG with headless Chromium (the source for `tauri icon`, which
// generates all app/tray icon sizes): assets/logo.svg → logo-1024.png (AShot and AShot Dev).
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
for (const name of ['logo']) {
  const svg = readFileSync(resolve(`assets/${name}.svg`), 'utf8');
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.locator('svg').screenshot({ path: resolve(`assets/${name}-1024.png`), omitBackground: true });
  console.log(`assets/${name}-1024.png written`);
}
await browser.close();
