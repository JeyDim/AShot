// Procedurally drawn "desktop" screenshots for the mock preview (no binary assets).

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

function windowFrame(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, title: string, dark: boolean) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 12;
  rr(ctx, x, y, w, h, 10, dark ? '#202124' : '#ffffff');
  ctx.restore();
  rr(ctx, x, y, w, 40, 10, dark ? '#2b2c30' : '#f3f4f6');
  ctx.fillStyle = dark ? '#2b2c30' : '#f3f4f6';
  ctx.fillRect(x, y + 20, w, 20);
  ctx.fillStyle = dark ? '#e8eaed' : '#111827';
  ctx.font = '14px "Segoe UI", sans-serif';
  ctx.fillText(title, x + 16, y + 25);
  ['#9ca3af', '#9ca3af', '#ef4444'].forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(x + w - 110 + i * 36, y + 19, 12, 2);
  });
}

function lines(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, rows: number, color: string, gap = 22) {
  for (let i = 0; i < rows; i++) {
    const lw = w * (0.55 + ((i * 37) % 40) / 100);
    rr(ctx, x, y + i * gap, lw, 9, 4, color);
  }
}

export async function fakeDesktop(W: number, H: number): Promise<string> {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1e3a8a');
  g.addColorStop(0.5, '#6d28d9');
  g.addColorStop(1, '#db2777');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.arc(200 + i * 330, 300 + (i % 2) * 400, 260, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${0.04 + (i % 3) * 0.02})`;
    ctx.fill();
  }

  // Explorer-like window
  windowFrame(ctx, 120, 80, 760, 520, 'Проводник — Документы', false);
  rr(ctx, 120, 120, 190, 480, 0, '#f9fafb');
  lines(ctx, 140, 150, 140, 12, '#d1d5db', 30);
  for (let i = 0; i < 6; i++) {
    rr(ctx, 340 + (i % 3) * 170, 160 + Math.floor(i / 3) * 170, 140, 110, 8, ['#dbeafe', '#fde68a', '#dcfce7', '#fce7f3', '#e0e7ff', '#ffedd5'][i]);
    rr(ctx, 350 + (i % 3) * 170, 285 + Math.floor(i / 3) * 170, 110, 9, 4, '#9ca3af');
  }

  // Browser window with a web app
  windowFrame(ctx, 560, 120, 1100, 700, 'Box — Отчёт за квартал', true);
  rr(ctx, 580, 170, 1060, 34, 17, '#35363a');
  ctx.fillStyle = '#9aa0a6';
  ctx.font = '14px "Segoe UI", sans-serif';
  ctx.fillText('app.box.com/folder/254711938204', 604, 192);
  rr(ctx, 560, 220, 220, 600, 0, '#18191c');
  lines(ctx, 584, 250, 150, 10, '#3c4043', 34);
  rr(ctx, 810, 250, 400, 28, 6, '#3c4043');
  lines(ctx, 810, 300, 780, 6, '#4b4f55', 26);
  // chart card
  rr(ctx, 810, 470, 380, 230, 12, '#26272b');
  const bars = [80, 130, 95, 170, 140, 190, 120];
  bars.forEach((b, i) => rr(ctx, 840 + i * 48, 680 - b, 28, b, 6, i === 5 ? '#8ab4f8' : '#5f6368'));
  rr(ctx, 1210, 470, 400, 230, 12, '#26272b');
  lines(ctx, 1234, 500, 340, 7, '#4b4f55', 26);
  rr(ctx, 1470, 250, 140, 36, 8, '#8ab4f8');
  ctx.fillStyle = '#202124';
  ctx.font = '600 14px "Segoe UI", sans-serif';
  ctx.fillText('Экспорт', 1508, 273);

  // Taskbar
  ctx.fillStyle = 'rgba(22, 24, 30, 0.92)';
  ctx.fillRect(0, H - 48, W, 48);
  for (let i = 0; i < 7; i++) rr(ctx, W / 2 - 160 + i * 46, H - 40, 32, 32, 7, i === 3 ? '#6b6bff' : 'rgba(255,255,255,0.14)');
  ctx.fillStyle = '#e5e7eb';
  ctx.font = '13px "Segoe UI", sans-serif';
  ctx.fillText('14:32', W - 70, H - 20);
  return c.toDataURL('image/png');
}

export async function fakeThumb(i: number): Promise<string> {
  const c = document.createElement('canvas');
  c.width = 360;
  c.height = 220;
  const ctx = c.getContext('2d')!;
  const palettes = [
    ['#111827', '#6b6bff'],
    ['#f3f4f6', '#0ea5e9'],
    ['#1f2937', '#f59e0b'],
    ['#ffffff', '#ef4444'],
    ['#0f172a', '#22c55e'],
    ['#fafafa', '#a855f7'],
  ];
  const [bg, accent] = palettes[i % palettes.length];
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 360, 220);
  const light = bg.startsWith('#f') || bg === '#ffffff';
  rr(ctx, 0, 0, 360, 30, 0, light ? '#e5e7eb' : '#374151');
  lines(ctx, 20, 52, 200, 5, light ? '#d1d5db' : '#4b5563', 20);
  rr(ctx, 230, 50, 110, 80, 8, accent);
  rr(ctx, 20, 160, 140, 34, 8, accent);
  if (i % 2 === 0) {
    ctx.strokeStyle = '#FF3B30';
    ctx.lineWidth = 4;
    ctx.strokeRect(222, 42, 126, 96);
  }
  return c.toDataURL('image/png');
}
