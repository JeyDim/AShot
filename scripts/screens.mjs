// Renders UI screenshots from the mock preview (`?mock`) with headless Chromium.
// Usage: npm run build && npx vite preview --port 4173 &  then  node scripts/screens.mjs
import { chromium } from 'playwright-core';

const base = process.env.BASE_URL || 'http://localhost:4173/';
const out = process.env.OUT_DIR || 'docs/screenshots';
const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});

// Desk behind transparent windows (tray panel, toasts) – as in the design mock-ups.
const desk = { light: '#CFCFD3', dark: '#0A0A0B' };

async function shot(name, route, { w, h, dpr = 1, query = '', setup, wall = false, wait = 600, theme = 'light' } = {}) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  page.on('pageerror', (e) => console.error(`[${name}]`, e.message));
  page.on('console', (m) => m.type() === 'error' && console.error(`[${name}] console:`, m.text()));
  await page.goto(`${base}?mock&theme=${theme}${query}#/${route}`);
  await page.waitForTimeout(wait);
  if (wall) await page.evaluate((bg) => (document.body.style.background = bg), desk[theme]);
  if (setup) await setup(page);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/${name}.png` });
  await page.close();
  console.log('✓', name);
}

const nav = (label) => (p) => p.getByRole('button', { name: label }).click();

await shot('tray-panel', 'panel', { w: 400, h: 660, wall: true, dpr: 2 });
await shot('tray-panel-dark', 'panel', { w: 400, h: 660, wall: true, dpr: 2, theme: 'dark' });
await shot('tray-panel-empty', 'panel', { w: 400, h: 660, wall: true, query: '&empty&signedout' });
await shot('settings-general', 'settings', { w: 840, h: 760 });
await shot('settings-general-dark', 'settings', { w: 840, h: 760, theme: 'dark' });
await shot('settings-hotkeys', 'settings', { w: 840, h: 640, setup: nav('Горячие клавиши') });
await shot('settings-saving', 'settings', { w: 840, h: 640, setup: nav('Сохранение') });
await shot('settings-box', 'settings/box', { w: 840, h: 760 });
await shot('settings-box-signin', 'settings/box', { w: 840, h: 640, query: '&signedout', theme: 'dark' });
await shot('settings-about', 'settings/about', { w: 840, h: 640 });
await shot('toast-link', 'toast', { w: 400, h: 176, wall: true, wait: 1800 });
await shot('toast-progress', 'toast', { w: 400, h: 176, wall: true, wait: 1800, query: '&kind=progress', theme: 'dark' });
await shot('toast-error', 'toast', { w: 400, h: 176, wall: true, wait: 1800, query: '&kind=error' });
await shot('toast-info', 'toast', { w: 400, h: 176, wall: true, wait: 1800, query: '&kind=info', theme: 'dark' });
await shot('overlay-hover', 'overlay', {
  w: 1440, h: 810, wait: 900,
  setup: async (p) => { await p.mouse.move(700, 330); await p.waitForTimeout(100); await p.mouse.move(705, 334); },
});
await shot('overlay-selected', 'overlay', { w: 1440, h: 810, query: '&selected', wait: 900 });
await shot('overlay-scroll', 'overlay', {
  w: 1440, h: 810, wait: 900, query: '&mode=scroll',
  setup: async (p) => { await p.mouse.move(800, 400); await p.waitForTimeout(100); await p.mouse.move(805, 402); },
});
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
await shot('editor-dark', 'editor/a1', { w: 1500, h: 900, wait: 1500, theme: 'dark' });
await shot('editor-compact', 'editor/a1', { w: 1024, h: 700, wait: 1500 });
await shot('editor-watermark', 'editor/a1', {
  w: 1500, h: 900, wait: 1500,
  setup: async (p) => {
    await p.getByRole('button', { name: 'Поставить водяной знак' }).click();
    await p.getByRole('button', { name: 'Водяной знак или копирайт' }).click();
  },
});
await browser.close();
