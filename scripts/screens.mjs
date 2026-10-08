// Renders UI screenshots from the mock preview (`?mock`) with headless Chromium.
// Usage: npm run build && npx vite preview --port 4173 &  then  node scripts/screens.mjs
import { chromium } from 'playwright-core';

const base = process.env.BASE_URL || 'http://localhost:4173/';
const out = process.env.OUT_DIR || 'docs/screenshots';
const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});

const wallpaper = 'linear-gradient(135deg,#1e3a8a 0%,#6d28d9 55%,#db2777 100%)';

async function shot(name, route, { w, h, dpr = 1, query = '', setup, wall = false, wait = 600 } = {}) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  page.on('pageerror', (e) => console.error(`[${name}]`, e.message));
  page.on('console', (m) => m.type() === 'error' && console.error(`[${name}] console:`, m.text()));
  await page.goto(`${base}?mock${query}#/${route}`);
  await page.waitForTimeout(wait);
  if (wall) await page.evaluate((bg) => (document.body.style.background = bg), wallpaper);
  if (setup) await setup(page);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/${name}.png` });
  await page.close();
  console.log('✓', name);
}

await shot('tray-panel', 'panel', { w: 440, h: 660, wall: true, dpr: 2 });
await shot('tray-panel-empty', 'panel', { w: 440, h: 660, wall: true, query: '&empty' });
await shot('overlay-hover', 'overlay', {
  w: 1440, h: 810, wait: 900,
  setup: async (p) => { await p.mouse.move(700, 330); await p.waitForTimeout(100); await p.mouse.move(705, 334); },
});
await shot('overlay-selected', 'overlay', { w: 1440, h: 810, query: '&selected', wait: 900 });
await shot('overlay-drawing', 'overlay', {
  w: 1440, h: 810, wait: 900,
  setup: async (p) => { await p.mouse.move(300, 200); await p.mouse.down(); await p.mouse.move(520, 330, { steps: 5 }); await p.mouse.move(640, 420, { steps: 5 }); },
});
await shot('overlay-annotate', 'overlay', {
  w: 1440, h: 810, wait: 900,
  setup: async (p) => {
    await p.evaluate(() => localStorage.removeItem('overlay.tool'));
    await p.mouse.move(420, 90); await p.mouse.down(); await p.mouse.move(1246, 615, { steps: 8 }); await p.mouse.up();
    await p.keyboard.press('r');
    await p.mouse.move(1095, 180); await p.mouse.down(); await p.mouse.move(1215, 222, { steps: 5 }); await p.mouse.up();
    await p.keyboard.press('a');
    await p.mouse.move(980, 330); await p.mouse.down(); await p.mouse.move(1090, 235, { steps: 5 }); await p.mouse.up();
    await p.keyboard.press('n');
    await p.mouse.click(1100, 180);
    await p.keyboard.press('t');
    await p.mouse.click(860, 345);
    await p.keyboard.type('Новая кнопка');
    await p.keyboard.press('Enter');
    await p.keyboard.press('b');
    await p.mouse.move(605, 185); await p.mouse.down(); await p.mouse.move(910, 212, { steps: 4 }); await p.mouse.up();
    await p.keyboard.press('v');
    await p.mouse.move(1000, 700);
  },
});
await shot('editor', 'editor/a1', { w: 1500, h: 900, wait: 1500 });
await shot('settings-general', 'settings', { w: 900, h: 680 });
await shot('settings-box', 'settings/box', { w: 900, h: 680 });
await shot('settings-box-signin', 'settings/box', { w: 900, h: 680, query: '&signedout' });
await shot('tray-panel-signin', 'panel', { w: 440, h: 660, wall: true, query: '&signedout&empty' });
await shot('settings-links', 'settings', { w: 900, h: 680, setup: (p) => p.getByRole('button', { name: 'Ссылки' }).click() });
await shot('settings-hotkeys', 'settings', { w: 900, h: 680, setup: (p) => p.getByRole('button', { name: 'Горячие клавиши' }).click() });
await shot('about', 'about', { w: 460, h: 520 });
await shot('toast-link', 'toast', { w: 420, h: 170, wall: true, wait: 1800 });
await shot('toast-info', 'toast', { w: 420, h: 170, wall: true, wait: 1800, query: '&kind=info' });
await shot('editor-compact', 'editor/a1', { w: 1024, h: 700, wait: 1500 });
await browser.close();
