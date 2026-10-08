import { describe, expect, it } from 'vitest';
import { acceleratorFromEvent, hotkeyLabel, plural, relativeTime } from './format';

describe('hotkeys', () => {
  it('formats accelerators', () => {
    expect(hotkeyLabel('PrintScreen')).toBe('PrtSc');
    expect(hotkeyLabel('Control+Shift+PrintScreen')).toBe('Ctrl + Shift + PrtSc');
    expect(hotkeyLabel('Alt+KeyS')).toBe('Alt + S');
    expect(hotkeyLabel('')).toBe('');
  });

  it('builds accelerators from keyboard events', () => {
    const base = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    expect(acceleratorFromEvent({ ...base, key: 'PrintScreen', code: 'PrintScreen' })).toBe('PrintScreen');
    expect(acceleratorFromEvent({ ...base, ctrlKey: true, shiftKey: true, key: 'S', code: 'KeyS' })).toBe('Control+Shift+KeyS');
    expect(acceleratorFromEvent({ ...base, ctrlKey: true, key: 'Control', code: 'ControlLeft' })).toBeNull();
  });
});

describe('time', () => {
  const now = new Date(2026, 9, 8, 15, 0, 0);
  it('relative labels', () => {
    expect(relativeTime(new Date(2026, 9, 8, 14, 59, 40).toISOString(), now)).toBe('только что');
    expect(relativeTime(new Date(2026, 9, 8, 14, 30).toISOString(), now)).toBe('30 мин назад');
    expect(relativeTime(new Date(2026, 9, 8, 9, 5).toISOString(), now)).toBe('сегодня, 09:05');
    expect(relativeTime(new Date(2026, 9, 7, 18, 1).toISOString(), now)).toBe('вчера, 18:01');
    expect(relativeTime(new Date(2026, 9, 3, 18, 1).toISOString(), now)).toBe('3 окт, 18:01');
  });

  it('plural forms', () => {
    expect(plural(1, 'снимок', 'снимка', 'снимков')).toBe('снимок');
    expect(plural(3, 'снимок', 'снимка', 'снимков')).toBe('снимка');
    expect(plural(11, 'снимок', 'снимка', 'снимков')).toBe('снимков');
    expect(plural(22, 'снимок', 'снимка', 'снимков')).toBe('снимка');
  });
});
