// Interaction smoke test of the editor and overlay in the mock preview.
// npm run build && npx vite preview --port 4173 &  then  node scripts/ui-smoke.mjs
import { chromium } from 'playwright-core';

const base = process.env.BASE_URL || 'http://localhost:4173/';
const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
let failures = 0;
// CI runners are slow: wait for what the page reports instead of fixed pauses.
const commitCount = (page, n, timeout = 10000) =>
  page.waitForFunction((k) => (window.__commits ?? []).length >= k, n, { timeout }).catch(() => {});
/** Text of a locator once it equals `want` (or whatever it is after the timeout). */
async function textSettles(locator, want, timeout = 5000) {
  const end = Date.now() + timeout;
  let text = await locator.textContent();
  while (text !== want && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
    text = await locator.textContent();
  }
  return text;
}
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
  await commitCount(page, 1);
  let c = await commits();
  check(c.length === 1, 'Ctrl+C sends the rendered image');
  check(c[0]?.shapes === 7 + 5, `document has all shapes (got ${c[0]?.shapes}, want 12)`);
  check(c[0]?.width === 1920 && c[0]?.height === 1080, `export is full resolution (${c[0]?.width}×${c[0]?.height})`);

  // tool groups: the drop-down picks the marker, the group button shows it; keys still work
  await page.getByRole('button', { name: 'Карандаш или маркер' }).click();
  await page.getByRole('menuitemradio', { name: /Маркер/ }).click();
  check(await page.getByRole('button', { name: 'Маркер · M' }).isVisible(), 'pen / marker group shows the picked marker');
  await page.keyboard.press('p');
  check(await page.getByRole('button', { name: 'Карандаш · P' }).isVisible(), 'the P key switches the group to the pen');
  check(await page.getByRole('button', { name: 'Прямоугольник · R' }).isVisible(), 'rectangle is the default of its group');

  // watermark (default): the button repeats the text over the whole picture, under the drawings
  await page.getByRole('button', { name: 'Поставить водяной знак' }).click();
  await page.keyboard.press('Control+c');
  await commitCount(page, 2);
  c = await commits();
  let st = c[c.length - 1];
  check(st?.marks === 1 && st.mark?.type === 'watermark' && st.firstType === 'watermark', `watermark under the drawings (${JSON.stringify(st?.mark)})`);
  check(st?.mark?.w === 1920 && st.mark.h === 1080 && st.mark.opacity === 0.25, 'watermark covers the whole picture, faint');
  // the same drop-down makes it a copyright: once, in the chosen corner
  await page.getByRole('button', { name: 'Водяной знак или копирайт' }).click();
  await page.getByRole('radio', { name: 'Копирайт' }).click();
  await page.getByRole('textbox', { name: 'Текст водяного знака' }).fill('© Test');
  await page.getByRole('radio', { name: 'Слева вверху' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+c');
  await commitCount(page, 3);
  c = await commits();
  st = c[c.length - 1];
  check(st?.marks === 1 && st?.shapes === 13, `one mark in the document (marks ${st?.marks}, shapes ${st?.shapes})`);
  check(st?.mark?.type === 'stamp' && st.mark.text === '© Test' && st.mark.x < 100 && st.mark.y < 100, `copyright follows the drop-down (${JSON.stringify(st?.mark)})`);
  // typing is one undo step: two undos — back to the default text, bottom-right
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+c');
  await commitCount(page, 4);
  c = await commits();
  st = c[c.length - 1];
  check(st?.mark?.text === 'AShot' && st.mark.x > 1000 && st.mark.y > 900, `undo restores it step by step (${JSON.stringify(st?.mark)})`);
  await page.getByRole('button', { name: 'Убрать копирайт' }).click();
  await page.keyboard.press('Control+c');
  await commitCount(page, 5);
  c = await commits();
  check(c[c.length - 1]?.marks === 0, 'the button removes it');

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
  await commitCount(page, 6);
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
  for (let i = 0; i < 100 && !calls.some((c) => c.cmd === 'overlay_finish'); i++) await page.waitForTimeout(100);
  const fin = calls.find((c) => c.cmd === 'overlay_finish');
  const k = 1920 / 1440;
  check(!!fin, 'Ctrl+U finishes the capture');
  check(fin?.args.action === 'upload', 'action is upload');
  check(fin && Math.abs(fin.args.rect.x - Math.round(100 * k) - 1) <= 1 && Math.abs(fin.args.rect.width - Math.round(300 * k)) <= 1, `rect is in physical pixels ${JSON.stringify(fin?.args.rect)}`);
  check(errors.length === 0, `no page errors ${errors.join('; ')}`);
  await page.close();
}

// ---------------------------------------------------------------- window mode: whole windows only
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const calls = [];
  await page.exposeFunction('__record', (c) => calls.push(c));
  await page.goto(`${base}?mock&mode=windowPick#/overlay`);
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const { __TAURI_INTERNALS__: t } = window;
    const orig = t.invoke;
    t.invoke = (cmd, args, opts) => {
      if (cmd === 'overlay_finish') window.__record({ cmd, args });
      return orig(cmd, args, opts);
    };
  });
  // A drag makes no free region here: the release takes the window under the cursor.
  await page.mouse.move(150, 150);
  await page.mouse.down();
  await page.mouse.move(300, 300, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('Control+c');
  for (let i = 0; i < 100 && !calls.length; i++) await page.waitForTimeout(100);
  const rect = calls[0]?.args.rect;
  check(JSON.stringify(rect) === JSON.stringify({ x: 120, y: 80, width: 760, height: 520 }), `window mode selects the whole window (${JSON.stringify(rect)})`);
  check(errors.length === 0, `no page errors ${errors.join('; ')}`);
  await page.close();
}

// ---------------------------------------------------------------- screen mode (several monitors): a click takes the screen
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const calls = [];
  await page.exposeFunction('__record', (c) => calls.push(c));
  await page.goto(`${base}?mock&mode=fullscreen#/overlay`);
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const { __TAURI_INTERNALS__: t } = window;
    const orig = t.invoke;
    t.invoke = (cmd, args, opts) => {
      if (cmd === 'overlay_finish') window.__record({ cmd, args });
      return orig(cmd, args, opts);
    };
  });
  // A drag over a window still takes the whole screen.
  await page.mouse.move(300, 300);
  await page.mouse.down();
  await page.mouse.move(500, 450, { steps: 6 });
  await page.mouse.up();
  for (let i = 0; i < 50 && !calls.length; i++) await page.waitForTimeout(100);
  const fin = calls[0]?.args;
  check(fin?.action === 'edit' && JSON.stringify(fin?.rect) === JSON.stringify({ x: 0, y: 0, width: 1920, height: 1080 }), `screen mode takes the whole monitor (${JSON.stringify(fin)})`);
  check(errors.length === 0, `no page errors ${errors.join('; ')}`);
  await page.close();
}

// ---------------------------------------------------------------- scroll mode: a click on the page starts it
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const calls = [];
  await page.exposeFunction('__record', (c) => calls.push(c));
  await page.goto(`${base}?mock&mode=scroll#/overlay`);
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const { __TAURI_INTERNALS__: t } = window;
    const orig = t.invoke;
    t.invoke = (cmd, args, opts) => {
      if (cmd === 'overlay_finish') window.__record({ cmd, args });
      return orig(cmd, args, opts);
    };
  });
  // The page area of the window is highlighted (not the whole window); a click takes it and
  // finishes right away — no drawing bar, the scrolling starts.
  await page.mouse.move(800, 400);
  await page.waitForTimeout(150);
  await page.mouse.move(805, 402);
  await page.waitForTimeout(250);
  await page.mouse.click(805, 402);
  for (let i = 0; i < 50 && !calls.length; i++) await page.waitForTimeout(100);
  const fin = calls[0]?.args;
  check(fin?.action === 'edit' && JSON.stringify(fin?.rect) === JSON.stringify({ x: 560, y: 190, width: 1100, height: 630 }), `scroll mode takes the page area at once (${JSON.stringify(fin)})`);
  check(!(await page.getByRole('toolbar', { name: 'Инструменты' }).isVisible().catch(() => false)), 'scroll mode shows no drawing bar');
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

// ---------------------------------------------------------------- multi-monitor: one selection per capture
// This overlay is the left monitor (`overlay-0`); `other` is what the overlay of the right one says.
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const calls = [];
  await page.exposeFunction('__record', (c) => calls.push(c));
  await page.goto(`${base}?mock&monitors=2#/overlay`);
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    window.__sent = [];
    const t = window.__TAURI_INTERNALS__;
    const orig = t.invoke;
    t.invoke = (cmd, args, opts) => {
      if (cmd === 'plugin:event|emit' && args?.event === 'overlay:selection') window.__sent.push(args.payload);
      if (cmd === 'overlay_finish') window.__record({ cmd, args });
      return orig(cmd, args, opts);
    };
  });
  const k = 1920 / 1440;
  let rev = 0;
  const other = async (patch) => {
    rev += 1000;
    const payload = { sessionId: 1, rev, from: 'overlay-1', owner: 'overlay-1', selection: null, chosen: true, drawn: false, ...patch };
    await page.evaluate((payload) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'overlay:selection', payload }), payload);
    await page.waitForTimeout(150);
  };
  const lastSent = () => page.evaluate(() => window.__sent.filter((p) => p.from === 'overlay-0').at(-1));
  const toolbar = page.getByRole('toolbar', { name: 'Инструменты' });
  const editorButton = page.locator('[data-tip^="Рисовать — в редакторе"]');
  const drag = async (x1, y1, x2, y2) => {
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(150);
  };
  // CSS pixels of this overlay for a virtual-screen point on this monitor.
  const css = (x, y) => [x / k, y / k];

  // Something is drawn on the other monitor's selection: no second one here (neither a drag nor F).
  await other({ selection: { x: 2100, y: 100, width: 300, height: 200 }, drawn: true });
  await drag(100, 100, 400, 300);
  await page.keyboard.press('f');
  await page.waitForTimeout(150);
  check(!(await toolbar.isVisible()), 'no second selection while the other monitor has drawings');

  // A bare selection there: a region here replaces it.
  await other({ selection: { x: 2100, y: 100, width: 300, height: 200 } });
  await drag(100, 100, 400, 300);
  check(await toolbar.isVisible(), 'a region replaces a bare selection on the other monitor');
  let sent = await lastSent();
  check(sent?.owner === 'overlay-0' && sent?.selection && sent.sessionId === 1, `the other monitors are told (${JSON.stringify(sent)})`);

  // A region started there drops the one here.
  await other({ selection: null, chosen: false });
  check(!(await toolbar.isVisible()), 'a region started on the other monitor drops the selection here');

  // A selection of the other monitor reaching this one: its part is grabbed here and moved so
  // that its middle is on this monitor — this overlay holds it from now on (the action bar, no
  // drawing tools: the editor draws on a selection over several monitors).
  await other({ selection: { x: 1700, y: 200, width: 600, height: 300 } });
  await drag(...css(1800, 350), ...css(1600, 350));
  sent = await lastSent();
  check(await toolbar.isVisible(), 'the part of a selection reaching this monitor can be grabbed');
  check(sent?.owner === 'overlay-0' && sent.selection?.x === 1500 && sent.selection?.width === 600, `…and moved from here (${JSON.stringify(sent?.selection)})`);
  check(await editorButton.isVisible(), 'a selection on several monitors offers the editor instead of drawing tools');

  // Right click on the part of the other monitor's selection resets it, as there.
  await other({ selection: { x: 1700, y: 200, width: 600, height: 300 } });
  check(!(await toolbar.isVisible()), 'taken back by the other monitor');
  await page.mouse.click(...css(1800, 350), { button: 'right' });
  await page.waitForTimeout(150);
  sent = await lastSent();
  check(sent?.owner === null && sent?.selection === null, `right click resets it (${JSON.stringify(sent)})`);

  // Moved past the edge of this monitor: the capture takes the virtual-screen rectangle.
  await drag(...css(1500, 300), ...css(1900, 600));
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.waitForTimeout(150);
  check(await editorButton.isVisible(), 'a region moved over the edge reaches the next monitor');
  await page.keyboard.press('Control+u');
  for (let i = 0; i < 50 && !calls.some((c) => c.cmd === 'overlay_finish'); i++) await page.waitForTimeout(100);
  const fin = calls.find((c) => c.cmd === 'overlay_finish');
  check(!!fin && fin.args.rect.x + fin.args.rect.width > 1920, `the capture spans both monitors ${JSON.stringify(fin?.args.rect)}`);
  check(errors.length === 0, `no page errors ${errors.join('; ')}`);
  await page.close();
}

// ---------------------------------------------------------------- multi-monitor: hand over
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?mock&monitors=2#/overlay`);
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    window.__sent = [];
    const t = window.__TAURI_INTERNALS__;
    const orig = t.invoke;
    t.invoke = (cmd, args, opts) => {
      if (cmd === 'plugin:event|emit' && args?.event === 'overlay:selection') window.__sent.push(args.payload);
      return orig(cmd, args, opts);
    };
  });
  // A wide region moved mostly onto the right monitor: that monitor takes it (and the action bar).
  await page.keyboard.press('v');
  await page.mouse.move(5, 100);
  await page.mouse.down();
  await page.mouse.move(600, 400, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  await page.mouse.move(20, 200);
  await page.mouse.down();
  await page.mouse.move(1435, 200, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const sent = await page.evaluate(() => window.__sent.filter((p) => p.from === 'overlay-0').at(-1));
  check(sent?.owner === 'overlay-1' && sent.selection && sent.selection.x + sent.selection.width / 2 > 1920, `handed over to the monitor under its middle (${JSON.stringify(sent)})`);
  check(!(await page.getByRole('toolbar', { name: 'Инструменты' }).isVisible()), 'the action bar goes with it');
  check(errors.length === 0, `no page errors ${errors.join('; ')}`);
  await page.close();
}

// ---------------------------------------------------------------- drawing on the overlay
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // finish() reports its failures with console.error — print them if a check fails here.
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('Failed to load resource') && consoleErrors.push(m.text()));
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
  // the watermark of the editor is here too; it follows the selection when that is resized
  await page.getByRole('button', { name: 'Поставить водяной знак' }).click();
  check(await page.getByRole('button', { name: 'Убрать водяной знак' }).isVisible(), 'overlay: a watermark over the selection');
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
  const afterTwo = await textSettles(next, '7');
  check(afterTwo === '7', `step numbering starts from the picked number (next: ${afterTwo})`);
  // any number in the field, applied as you type
  await next.click();
  await page.getByRole('textbox', { name: 'Свой номер' }).fill('42');
  await page.keyboard.press('Enter');
  const custom = await textSettles(next, '42');
  check(custom === '42', `custom step number (next: ${custom})`);
  await next.click();
  await page.getByRole('option', { name: '7', exact: true }).click();
  // text tool dragged: an arrow to the press point + the text at its tail (one step each)
  await page.keyboard.press('t');
  await page.mouse.move(600, 250);
  await page.mouse.down();
  await page.mouse.move(450, 330, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.type('Выноска');
  await page.keyboard.press('Enter');
  // "downscale to": the check box on the toolbar, the output size in the drop-down
  await page.getByRole('checkbox', { name: 'Уменьшать картинку' }).click();
  await page.getByRole('button', { name: /Уменьшать до/ }).click();
  const preview = await page.getByText(/→ \d+ × \d+/).textContent().catch(() => '');
  check(/→ 740 × \d+/.test(preview ?? ''), `downscaling preview (${preview})`);
  await page.keyboard.press('Escape');
  check(await page.getByRole('toolbar', { name: 'Инструменты' }).isVisible(), 'Esc closes the drop-down, not the capture');
  // "Save as…" cancelled (the mock dialog returns null): the capture stays open
  await page.keyboard.press('Control+s');
  // the (mock) dialog was shown and cancelled
  await page.waitForFunction(() => window.__saveDialogs >= 1, null, { timeout: 10000 }).catch(() => {});
  check((await page.evaluate(() => window.__saveDialogs)) === 1, '"Save as…" asks for the file before closing the capture');
  await page.waitForTimeout(200);
  check(await page.getByRole('toolbar', { name: 'Инструменты' }).isVisible(), 'cancelled "Save as…" keeps the overlay');
  check(!(await page.evaluate(() => window.__commits ?? [])).length, 'cancelled "Save as…" sends nothing');
  await page.keyboard.press('Control+c');
  await commitCount(page, 1);
  const c = await page.evaluate(() => window.__commits ?? []);
  const k = 1920 / 1440;
  const last = c[c.length - 1];
  check(last?.cmd === 'overlay_finish_annotated', 'Ctrl+C sends the annotated image');
  if (!last) {
    const state = await page.evaluate(() => ({
      active: `${document.activeElement?.tagName} ${document.activeElement?.getAttribute('aria-label') ?? ''}`,
      textareas: document.querySelectorAll('textarea').length,
      hasFocus: document.hasFocus(),
      saveDialogs: window.__saveDialogs,
    }));
    console.log('  overlay state:', JSON.stringify(state), 'console errors:', JSON.stringify(consoleErrors));
  }
  check(last?.shapes === 7, `drawings inside the selection only, callout = arrow + text, watermark (got ${last?.shapes}, want 7)`);
  const wm = last?.mark;
  check(
    last?.marks === 1 && last.firstType === 'watermark' && Math.abs(wm.x) <= 1 && Math.abs(wm.y) <= 1 && Math.abs(wm.w - last.width) <= 2 && Math.abs(wm.h - last.height) <= 2,
    `the watermark under the drawings covers the resized selection (${JSON.stringify(wm && { x: wm.x, y: wm.y, w: wm.w, h: wm.h })})`,
  );
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
