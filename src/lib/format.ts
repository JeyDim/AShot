// Formatting helpers (Russian UI).

const KEY_LABELS: Record<string, string> = {
  PrintScreen: 'PrtSc',
  Control: 'Ctrl',
  CommandOrControl: 'Ctrl',
  Super: 'Win',
  Meta: 'Win',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Пробел',
  Backspace: 'Backspace',
  Delete: 'Del',
};

/** "Control+Shift+PrintScreen" → ["Ctrl", "Shift", "PrtSc"] */
export function hotkeyParts(accelerator: string): string[] {
  if (!accelerator.trim()) return [];
  return accelerator.split('+').map((p) => {
    const key = p.trim();
    if (KEY_LABELS[key]) return KEY_LABELS[key];
    if (/^Key[A-Z]$/.test(key)) return key.slice(3);
    if (/^Digit[0-9]$/.test(key)) return key.slice(5);
    return key;
  });
}

export function hotkeyLabel(accelerator: string): string {
  return hotkeyParts(accelerator).join(' + ');
}

/**
 * Builds a global-shortcut accelerator from a keyboard event, e.g. "Control+Shift+KeyS".
 * Returns null while only modifiers are held.
 */
export function acceleratorFromEvent(e: { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  const modifierCodes = ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'];
  if (modifierCodes.includes(e.code) || ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  const code = e.code || e.key;
  if (!code) return null;
  parts.push(code);
  return parts.join('+');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "сегодня, 14:32" / "вчера, 09:15" / "3 окт, 18:01" */
export function relativeTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) {
    const mins = Math.floor((now.getTime() - d.getTime()) / 60_000);
    if (mins < 1) return 'только что';
    if (mins < 60) return `${mins} мин назад`;
    return `сегодня, ${time}`;
  }
  if (days === 1) return `вчера, ${time}`;
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${d.getDate()} ${months[d.getMonth()]}, ${time}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export function sizeLabel(w: number, h: number): string {
  return `${w} × ${h}`;
}
