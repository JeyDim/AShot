// Interaction smoke test of the editor and overlay in the mock preview.
// npm run build && npx vite preview --port 4173 &  then  node scripts/ui-smoke.mjs
import { chromium } from 'playwright-core';

const base = process.env.BASE_URL || 'http://localhost:4173/';
const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};

// ---------------------------------------------------------------- editor
{
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?mock#/editor/a1`);
  await page.waitForTimeout(1500);
  const commits = () => page.evaluate(() => window.__commits ?? []);
  const canvas = page.locator('.konvajs-content');
  const box = await canvas.boundingBox();
  const at = (x, y) => [box.x + x, box.y + y];

  // rectangle
  await page.keyboard.press('r');
  await page.mouse.move(...at(300, 300));
  await page.mouse.down();
  await page.mouse.move(...at(450, 420), { steps: 6 });
  await page.mouse.up();
  // arrow
  await page.keyboard.press('a');
  await page.mouse.move(...at(500, 500));
  await page.mouse.down();
  await page.mouse.move(...at(620, 430), { steps: 6 });
  await page.mouse.up();
  // text (+ click elsewhere must not duplicate it)
  await page.keyboard.press('t');
  await page.mouse.click(...at(700, 600));
  await page.keyboard.type('Привет');
  await page.mouse.click(...at(900, 650));
  await page.keyboard.press('Escape');
  // step
  await page.keyboard.press('n');
  await page.mouse.click(...at(820, 300));
  // pixelate
  await page.keyboard.press('b');
  await page.mouse.move(...at(200, 200));
  await page.mouse.down();
  await page.mouse.move(...at(300, 260), { steps: 4 });
  await page.mouse.up();
  // undo + redo
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');

  await page.keyboard.press('Control+c');
  await page.waitForTimeout(800);
  let c = await commits();
  check(c.length === 1, 'Ctrl+C sends the rendered image');
  check(c[0]?.shapes === 7 + 5, `document has all shapes (got ${c[0]?.shapes}, want 12)`);
  check(c[0]?.width === 1920 && c[0]?.height === 1080, `export is full resolution (${c[0]?.width}×${c[0]?.height})`);

  // crop
  await page.keyboard.press('c');
  await page.waitForTimeout(100);
  await page.mouse.move(...at(150, 150));
  await page.mouse.down();
  await page.mouse.move(...at(650, 450), { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(800);
  c = await commits();
  const last = c[c.length - 1];
  check(!!last?.crop, 'crop stored in the document');
  check(last && Math.abs(last.width - last.crop.w) <= 1 && Math.abs(last.height - last.crop.h) <= 1 && last.width < 1920, `export follows the crop (${last?.width}×${last?.height})`);
  check(errors.length === 0, `no page errors ${errors.join('; ')}`);
  await page.screenshot({ path: process.env.OUT || '/tmp/editor-smoke.png' });
  await page.close();
}

// ---------------------------------------------------------------- overlay
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const calls = [];
  await page.exposeFunction('__record', (c) => calls.push(c));
  await page.goto(`${base}?mock#/overlay`);
  await page.waitForTimeout(900);
  // drag a region, then press Ctrl+U
  await page.mouse.move(100, 100);
  await page.mouse.down();
  await page.mouse.move(400, 300, { steps: 8 });
  await page.mouse.up();
  const bar = page.getByRole('button', { name: 'Ссылка' });
  check(await bar.isVisible(), 'action bar appears after selection');
  // nudge with arrows and check the finish payload
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => {
    const { __TAURI_INTERNALS__: t } = window;
    const orig = t.invoke;
    t.invoke = (cmd, args, opts) => {
      if (cmd === 'overlay_finish') window.__record({ cmd, args });
      return orig(cmd, args, opts);
    };
  });
  await page.keyboard.press('Control+u');
  await page.waitForTimeout(300);
  const fin = calls.find((c) => c.cmd === 'overlay_finish');
  const k = 1920 / 1440;
  check(!!fin, 'Ctrl+U finishes the capture');
  check(fin?.args.action === 'upload', 'action is upload');
  check(fin && Math.abs(fin.args.rect.x - Math.round(100 * k) - 1) <= 1 && Math.abs(fin.args.rect.width - Math.round(300 * k)) <= 1, `rect is in physical pixels ${JSON.stringify(fin?.args.rect)}`);
  check(errors.length === 0, `no page errors ${errors.join('; ')}`);
  await page.close();
}

// ---------------------------------------------------------------- multi-monitor: foreign payloads
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  await page.goto(`${base}?mock#/overlay`);
  await page.waitForTimeout(900);
  // A payload for the overlay of another monitor (with a pre-selected area) must be ignored.
  await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
      event: 'overlay:prepare',
      payload: {
        label: 'overlay-1', sessionId: 99, image: 'session/99/1.bmp', windows: [], mode: 'region',
        monitor: { index: 1, name: 'DISPLAY2', bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 }, scale: 1, primary: false },
        preselect: { x: 2000, y: 100, width: 500, height: 300 }, autoAction: null, showMagnifier: true, uiElements: false, cursor: [2100, 200],
      },
    }),
  );
  await page.waitForTimeout(600);
  check(!(await page.getByRole('toolbar', { name: 'Инструменты' }).isVisible().catch(() => false)), 'overlay ignores the payload of another monitor');
  await page.close();
}

// ---------------------------------------------------------------- drawing on the overlay
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?mock#/overlay`);
  await page.waitForTimeout(900);
  await page.mouse.move(200, 150);
  await page.mouse.down();
  await page.mouse.move(700, 500, { steps: 8 });
  await page.mouse.up();
  check(await page.getByRole('toolbar', { name: 'Инструменты' }).isVisible(), 'drawing toolbar appears after selection');
  // arrow via hotkey, rectangle via toolbar button
  await page.keyboard.press('a');
  await page.mouse.move(300, 400);
  await page.mouse.down();
  await page.mouse.move(450, 260, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Прямоугольник · R' }).click();
  await page.mouse.move(480, 200);
  await page.mouse.down();
  await page.mouse.move(650, 300, { steps: 6 });
  await page.mouse.up();
  // a stroke outside the selection must not add a shape
  await page.mouse.move(900, 600);
  await page.mouse.down();
  await page.mouse.move(1000, 700, { steps: 4 });
  await page.mouse.up();
  // resize the selection with its bottom-right handle while a tool is active
  await page.mouse.move(700, 500);
  await page.mouse.down();
  await page.mouse.move(760, 540, { steps: 4 });
  await page.mouse.up();
  // steps numbered from 5 (picked in the drop-down); the button shows the next number
  await page.keyboard.press('n');
  const next = page.getByRole('button', { name: 'Следующий номер' });
  await next.click();
  await page.getByRole('option', { name: '5', exact: true }).click();
  await page.mouse.click(250, 200);
  await page.mouse.click(250, 260);
  check((await next.textContent()) === '7', `step numbering starts from the picked number (next: ${await next.textContent()})`);
  // any number in the field, applied as you type
  await next.click();
  await page.getByRole('textbox', { name: 'Свой номер' }).fill('42');
  await page.keyboard.press('Enter');
  check((await next.textContent()) === '42', `custom step number (next: ${await next.textContent()})`);
  await next.click();
  await page.getByRole('option', { name: '7', exact: true }).click();
  // "Save as…" cancelled (the mock dialog returns null): the capture stays open
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(300);
  check(await page.getByRole('toolbar', { name: 'Инструменты' }).isVisible(), 'cancelled "Save as…" keeps the overlay');
  check(!(await page.evaluate(() => window.__commits ?? [])).length, 'cancelled "Save as…" sends nothing');
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(800);
  const c = await page.evaluate(() => window.__commits ?? []);
  const k = 1920 / 1440;
  const last = c[c.length - 1];
  check(last?.cmd === 'overlay_finish_annotated', 'Ctrl+C sends the annotated image');
  check(last?.shapes === 4, `drawings inside the selection only (got ${last?.shapes}, want 4)`);
  check(last && Math.abs(last.width - Math.round(560 * k)) <= 2 && Math.abs(last.height - Math.round(390 * k)) <= 2, `image has the resized selection size (${last?.width}×${last?.height})`);
  check(errors.length === 0, `no page errors ${errors.join('; ')}`);
  await page.screenshot({ path: process.env.OUT_OVERLAY || '/tmp/overlay-smoke.png' });
  await page.close();
}

await browser.close();
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
