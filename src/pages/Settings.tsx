// Settings window: sections in the sidebar, every change is saved right away.
import clsx from 'clsx';
import {
  AlertTriangle,
  AppWindow,
  Check,
  ChevronRight,
  ChevronsDown,
  Cloud,
  Copy,
  Download,
  FileText,
  FolderOpen,
  Info,
  Keyboard,
  Minus,
  Monitor,
  Power,
  RefreshCw,
  Save,
  Scan,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Button, DevBadge, IconButton, Input, Logo, Range, Segmented, Select, Spinner, Switch } from '../components/ui';
import { acceleratorFromEvent, hotkeyLabel, plural } from '../lib/format';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTauriEvent } from '../lib/hooks';
import { api, errorText, type SettingsSection } from '../lib/ipc';
import type { AppInfo, AppSettings, BoxStatus, Hotkeys, S3Status, SettingsView, UpdateState, UploadProvider, UploadStatus } from '../lib/types';

type Section = Exclude<SettingsSection, 'links'>;

const SECTIONS: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'general', label: 'Снимок', icon: <SlidersHorizontal size={18} /> },
  { id: 'hotkeys', label: 'Горячие клавиши', icon: <Keyboard size={18} /> },
  { id: 'saving', label: 'Сохранение', icon: <Save size={18} /> },
  { id: 'box', label: 'Загрузка и ссылки', icon: <Cloud size={18} /> },
  { id: 'about', label: 'О программе', icon: <Info size={18} /> },
];

function toSection(s?: string | null): Section {
  if (s === 'links') return 'box';
  return SECTIONS.find((x) => x.id === s)?.id ?? 'general';
}

/** Recursive patch: nested settings objects (box, links, hotkeys) merge key by key. */
type Patch = { [K in keyof AppSettings]?: AppSettings[K] extends object ? Partial<AppSettings[K]> : AppSettings[K] };

function merge<T>(target: T, patch: object): T {
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' ? merge(cur, v) : v;
  }
  return out as T;
}

/** Local copy of the settings + debounced saving of the changed keys. */
function useAutosave() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const pending = useRef<Patch>({});
  const timer = useRef<number | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const inFlight = useRef(0);

  useEffect(() => {
    api.settingsGet().then((v) => {
      setView(v);
      setSettings(v.settings);
    });
  }, []);

  const idle = () => !Object.keys(pending.current).length && timer.current === undefined && inFlight.current === 0;

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const patch = pending.current;
    if (!Object.keys(patch).length) return queue.current;
    pending.current = {};
    inFlight.current += 1;
    setSaving(true);
    // One request at a time, so a later change never lands before an earlier one.
    queue.current = queue.current.then(async () => {
      try {
        const r = await api.settingsPatch(patch);
        setProblems(r.problems);
        inFlight.current -= 1;
        // Values may come back normalized (link template, folder name).
        if (idle()) setSettings(r.settings);
      } catch (e) {
        inFlight.current -= 1;
        setProblems([errorText(e)]);
      } finally {
        if (inFlight.current === 0) setSaving(false);
      }
    });
    return queue.current;
  }, []);

  /** `delay` – for typing: wait for a pause before saving. */
  const update = useCallback(
    (patch: Patch, delay = 0) => {
      setSettings((s) => (s ? merge(s, patch) : s));
      pending.current = merge(pending.current, patch);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, delay);
    },
    [flush],
  );

  // Changes made elsewhere (tray, editor, another settings window).
  useTauriEvent<AppSettings>('settings:changed', (e) => {
    if (idle()) setSettings(e.payload);
  });
  useEffect(() => {
    window.addEventListener('blur', flush);
    return () => window.removeEventListener('blur', flush);
  }, [flush]);

  return { view, settings, update, flush, saving, problems };
}

type Update = (patch: Patch, delay?: number) => void;

export default function Settings({ initial }: { initial?: string }) {
  const { view, settings, update, flush, saving, problems } = useAutosave();
  const [section, setSection] = useState<Section>(() => toSection(initial));
  useTauriEvent<string>('settings:section', (e) => setSection(toSection(e.payload)));

  if (!settings || !view) return <div className="h-full bg-bg" />;

  return (
    <div className="flex h-full bg-bg">
      <aside className="flex w-[210px] shrink-0 flex-col gap-0.5 px-2.5 py-4">
        {/* No native title bar: the header and the top of the page move the window. */}
        <div className="flex items-center gap-2.5 px-2.5 pt-1 pb-4" data-tauri-drag-region>
          <span className="pointer-events-none">
            <Logo size={26} radius={315} />
          </span>
          <span className="text-[14px] font-bold" data-tauri-drag-region>
            Настройки
          </span>
        </div>
        <nav className="flex flex-col gap-0.5">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              aria-current={section === s.id ? 'page' : undefined}
              className={clsx(
                'flex h-[38px] items-center gap-2.5 rounded-full px-3 text-[14px] transition-colors',
                section === s.id ? 'bg-lime font-medium text-on-lime' : 'text-text hover:bg-text/6',
              )}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </nav>
        <div className="flex-1" data-tauri-drag-region />
        <button
          onClick={() => api.quit()}
          className="mb-2 flex h-[38px] items-center gap-2.5 rounded-full px-3 text-[14px] text-muted transition-colors hover:bg-danger/10 hover:text-danger"
        >
          <Power size={18} />
          Выйти из AShot
        </button>
        <div className={clsx('flex items-center gap-1.5 px-3 text-[12px]', problems.length ? 'text-danger' : 'text-muted')}>
          {saving ? (
            <>
              <Spinner size={13} /> Сохраняю…
            </>
          ) : problems.length ? (
            <>
              <AlertTriangle size={14} /> Есть проблемы
            </>
          ) : (
            <>
              <Check size={15} className="text-success" /> Сохраняется сразу
            </>
          )}
        </div>
      </aside>

      <main className="my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-[14px] bg-surface">
        <div className="flex h-10 shrink-0 items-center justify-end gap-0.5 px-1.5" data-tauri-drag-region>
          <IconButton tip="Свернуть" tipPos="bottom" size={30} onClick={() => getCurrentWindow().minimize()}>
            <Minus size={17} />
          </IconButton>
          <IconButton tip="Закрыть" tipPos="left" size={30} tone="danger" onClick={() => getCurrentWindow().close()}>
            <X size={17} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-6">
          <div className="mx-auto flex max-w-[640px] flex-col gap-5">
            {problems.length > 0 && (
              <div className="flex gap-2.5 rounded-xl bg-danger/10 px-3.5 py-3 text-[12.5px] leading-relaxed text-danger">
                <AlertTriangle size={17} className="mt-px shrink-0" />
                <div className="whitespace-pre-line">{problems.join('\n')}</div>
              </div>
            )}
            {section === 'general' && <General s={settings} update={update} />}
            {section === 'hotkeys' && <HotkeysSection value={settings.hotkeys} scroll={settings.experimental.scrollCapture} onChange={(h) => update({ hotkeys: h })} />}
            {section === 'saving' && <Saving s={settings} update={update} view={view} />}
            {section === 'box' && <UploadSection s={settings} update={update} flush={flush} />}
            {section === 'about' && <About s={settings} update={update} />}
          </div>
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- building blocks

function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="font-display text-[19px] font-normal">{children}</h1>
      {sub && <p className="text-[13px] text-muted">{sub}</p>}
    </div>
  );
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5">
      {title && <div className="pb-1.5 text-[12px] text-muted">{title}</div>}
      {children}
    </section>
  );
}

function Row({ icon, label, hint, children }: { icon?: ReactNode; label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-2">
      {icon && <span className="shrink-0 text-muted">{icon}</span>}
      <div className="min-w-0 flex-1 text-[14px]">
        {label}
        {hint && <div className="mt-0.5 text-[12px] leading-snug text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-xl bg-surface-2 px-3.5 py-3 text-[12px] leading-relaxed text-muted">
      <Info size={18} className="shrink-0" />
      <div>{children}</div>
    </div>
  );
}

/** Text input that saves while typing (after a pause) but never jumps under the cursor. */
function TextField({
  value,
  onChange,
  className,
  ...rest
}: { value: string; onChange: (v: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  return (
    <Input
      value={focused ? text : value}
      onFocus={() => {
        setText(value);
        setFocused(true);
      }}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value);
      }}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      className={clsx('w-[250px] shrink-0', className)}
      {...rest}
    />
  );
}

const TYPING = 500;

// ---------------------------------------------------------------- Снимок

function General({ s, update }: { s: AppSettings; update: Update }) {
  return (
    <>
      <Title sub="Поведение при съёмке">Снимок</Title>
      <Group title="Захват">
        <Row label="Показывать курсор" hint="Указатель мыши попадёт на снимок">
          <Switch checked={s.showCursor} onChange={(v) => update({ showCursor: v })} label="Показывать курсор" />
        </Row>
        <Row label="Лупа при выделении" hint="Увеличение, координаты и цвет пикселя под курсором">
          <Switch checked={s.showMagnifier} onChange={(v) => update({ showMagnifier: v })} label="Лупа при выделении" />
        </Row>
        <Row label="«Весь экран» снимает">
          <Segmented
            accent
            value={s.fullscreenMode}
            onChange={(v) => update({ fullscreenMode: v })}
            options={[
              { value: 'currentMonitor', label: 'Монитор с курсором' },
              { value: 'allMonitors', label: 'Все мониторы' },
            ]}
          />
        </Row>
      </Group>
      <Group title="После выделения">
        <Row label="Что делать дальше" hint="Панель позволяет выбрать: редактор, копирование, файл или ссылка">
          <Select value={s.afterCapture} onChange={(e) => update({ afterCapture: e.target.value as AppSettings['afterCapture'] })} className="w-[250px] shrink-0">
            <option value="ask">Показать панель действий</option>
            <option value="openEditor">Открыть редактор</option>
            <option value="copy">Скопировать в буфер</option>
            <option value="save">Сохранить в папку</option>
            <option value="upload">Загрузить и скопировать ссылку</option>
          </Select>
        </Row>
      </Group>
      <Group title="Экспериментальное">
        <Row
          label={
            <span className="flex items-center gap-2">
              Снимок с прокруткой
              <span className="inline-flex h-[18px] items-center rounded-full bg-lime px-1.5 text-[10.5px] font-semibold text-on-lime">бета</span>
            </span>
          }
          hint="Страница целиком: AShot сам прокрутит область и склеит кадры. В панели и меню появится «Прокрутка». Ещё в работе — получается не на всех страницах"
        >
          <Switch checked={s.experimental.scrollCapture} onChange={(v) => update({ experimental: { scrollCapture: v } })} label="Снимок с прокруткой" />
        </Row>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------- Горячие клавиши

// Every capture has a hotkey by default (same as `Hotkeys::default` in Rust).
const DEFAULT_HOTKEYS: Hotkeys = { region: 'Control+PrintScreen', window: 'Alt+PrintScreen', fullscreen: 'Shift+PrintScreen', scroll: 'Control+Shift+PrintScreen' };

function HotkeysSection({ value, scroll, onChange }: { value: Hotkeys; scroll: boolean; onChange: (h: Hotkeys) => void }) {
  const all: { key: keyof Hotkeys; label: string; hint: string; icon: ReactNode }[] = [
    { key: 'region', label: 'Снимок области', hint: 'Выделение мышью, клик — окно или элемент', icon: <Scan size={20} /> },
    { key: 'window', label: 'Снимок окна', hint: 'Наведите на окно и кликните', icon: <AppWindow size={20} /> },
    { key: 'fullscreen', label: 'Весь экран', hint: 'Сразу в редактор; если экранов несколько — кликните по нужному', icon: <Monitor size={20} /> },
    { key: 'scroll', label: 'Снимок с прокруткой', hint: 'Страница целиком: AShot прокрутит область и склеит', icon: <ChevronsDown size={20} /> },
  ];
  // The scrolling capture is an experiment: its hotkey shows once it is turned on.
  const rows = all.filter((r) => scroll || r.key !== 'scroll');
  const isDefault = (Object.keys(DEFAULT_HOTKEYS) as (keyof Hotkeys)[]).every((k) => value[k] === DEFAULT_HOTKEYS[k]);
  return (
    <>
      <Title sub="Нажмите на поле, затем нужное сочетание. Backspace — очистить.">Горячие клавиши</Title>
      <Group title="Съёмка">
        {rows.map((r) => (
          <Row key={r.key} icon={r.icon} label={r.label} hint={r.hint}>
            <HotkeyInput value={value[r.key]} onChange={(v) => onChange({ ...value, [r.key]: v })} />
          </Row>
        ))}
      </Group>
      <Group>
        <Row label="Вернуть сочетания по умолчанию">
          <Button variant="outline" disabled={isDefault} onClick={() => onChange(DEFAULT_HOTKEYS)}>
            Сбросить
          </Button>
        </Row>
      </Group>
      <Note>
        Если назначаете просто PrtSc: в Windows 11 её по умолчанию занимают «Ножницы». Отключите: Параметры → Специальные возможности → Клавиатура → «Использовать кнопку PrtSc для открытия
        функции захвата экрана».
      </Note>
    </>
  );
}

function HotkeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false);
  const stop = () => {
    setRecording(false);
    api.hotkeysSuspend(false).catch(() => {});
  };
  const handle = (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return (e.currentTarget as HTMLElement).blur();
    if (e.key === 'Backspace' || e.key === 'Delete') {
      onChange('');
      return (e.currentTarget as HTMLElement).blur();
    }
    const acc = acceleratorFromEvent(e.nativeEvent);
    if (acc) {
      onChange(acc);
      (e.currentTarget as HTMLElement).blur();
    }
  };
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        onFocus={() => {
          setRecording(true);
          // Global hotkeys would swallow PrintScreen while recording.
          api.hotkeysSuspend(true).catch(() => {});
        }}
        onBlur={stop}
        onKeyDown={handle}
        // PrintScreen produces only keyup in browsers.
        onKeyUp={(e) => {
          if (e.key === 'PrintScreen' || e.code === 'PrintScreen') handle(e);
        }}
        className={clsx(
          'flex h-9 w-[190px] items-center justify-center rounded-[10px] bg-surface-2 px-3 font-mono text-[12px] ring-1 ring-inset transition-shadow outline-none',
          recording ? 'text-muted ring-2 ring-lime' : 'ring-transparent hover:ring-border-strong',
        )}
      >
        {recording ? 'Нажмите сочетание…' : value ? hotkeyLabel(value) : <span className="font-sans text-muted">Не назначено</span>}
      </button>
      <IconButton tip="Очистить" tipPos="left" size={28} disabled={!value} onClick={() => onChange('')}>
        <X size={18} />
      </IconButton>
    </div>
  );
}

// ---------------------------------------------------------------- Сохранение

function Saving({ s, update, view }: { s: AppSettings; update: Update; view: SettingsView }) {
  const folder = s.saveFolder || view.defaultSaveFolder;
  const [limit, setLimit] = useState(s.historyLimit);
  const [quality, setQuality] = useState(s.jpegQuality);
  const [confirmClear, setConfirmClear] = useState(false);
  // How many screenshots the last "Очистить" removed (shown for 5 s).
  const [cleared, setCleared] = useState<number | null>(null);
  const [clearError, setClearError] = useState('');
  useEffect(() => {
    if (cleared === null) return;
    const t = window.setTimeout(() => setCleared(null), 5000);
    return () => window.clearTimeout(t);
  }, [cleared]);
  useEffect(() => setLimit(s.historyLimit), [s.historyLimit]);
  useEffect(() => setQuality(s.jpegQuality), [s.jpegQuality]);
  useEffect(() => {
    if (!confirmClear) return;
    const t = window.setTimeout(() => setConfirmClear(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirmClear]);

  const example = useMemo(() => {
    const d = new Date();
    const p = (n: number, l = 2) => String(n).padStart(l, '0');
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const time = `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
    return (
      (s.fileNamePattern.trim() || 'Screenshot')
        .replaceAll('{date}', date)
        .replaceAll('{time}', time)
        .replaceAll('{n}', '1')
        .replaceAll('{yyyy}', String(d.getFullYear()))
        .replaceAll('{yy}', p(d.getFullYear() % 100))
        .replaceAll('{MM}', p(d.getMonth() + 1))
        .replaceAll('{dd}', p(d.getDate()))
        .replaceAll('{HH}', p(d.getHours()))
        .replaceAll('{mm}', p(d.getMinutes()))
        .replaceAll('{ss}', p(d.getSeconds()))
        .replaceAll('{fff}', p(d.getMilliseconds(), 3))
        .replaceAll('{w}', '1280')
        .replaceAll('{h}', '720')
        .replaceAll('{rand}', 'k3x9qa') + ({ png: '.png', jpeg: '.jpg', webp: '.webp' } as const)[s.imageFormat]
    );
  }, [s.fileNamePattern, s.imageFormat]);

  return (
    <>
      <Title sub="Куда и как сохраняются файлы и сколько снимков хранится в истории">Сохранение</Title>
      <Group title="Файлы">
        <Row
          label="Папка снимков"
          hint={
            s.saveFolder ? (
              <button className="underline-offset-2 hover:text-text hover:underline" onClick={() => update({ saveFolder: '' })}>
                Вернуть папку по умолчанию
              </button>
            ) : undefined
          }
        >
          <div className="flex shrink-0 gap-1.5">
            <button
              className="flex h-9 w-[200px] items-center rounded-[10px] bg-surface-2 px-3 text-left font-mono text-[12px] transition-colors hover:bg-surface-3"
              data-tip={`${folder}\nОткрыть папку`}
              data-tip-pos="top"
              onClick={() => api.openFolder('save')}
            >
              <span className="truncate" dir="rtl">
                {folder}
              </span>
            </button>
            <Button
              variant="outline"
              className="h-9"
              onClick={async () => {
                const picked = await api.pickFolder(folder);
                if (picked) update({ saveFolder: picked === view.defaultSaveFolder ? '' : picked });
              }}
            >
              Обзор
            </Button>
          </div>
        </Row>
        <Row
          label="Имя файла"
          hint={
            <>
              {'{date}'}, {'{time}'}, {'{n}'} — номер по порядку
              <div className="truncate text-subtle">→ {example}</div>
            </>
          }
        >
          <TextField className="font-mono" value={s.fileNamePattern} placeholder="Screenshot {date} {time}" onChange={(v) => update({ fileNamePattern: v }, TYPING)} />
        </Row>
        <Row label="Формат" hint="Используется и для загрузки в Box">
          <Segmented
            accent
            value={s.imageFormat}
            onChange={(v) => update({ imageFormat: v })}
            options={[
              { value: 'png', label: 'PNG' },
              { value: 'jpeg', label: 'JPG' },
              { value: 'webp', label: 'WebP' },
            ]}
          />
        </Row>
        {s.imageFormat === 'jpeg' && (
          <Row label="Качество JPG">
            <Range label="Качество JPG" value={quality} min={40} max={100} onChange={setQuality} onCommit={(v) => update({ jpegQuality: v })} />
          </Row>
        )}
      </Group>
      <Group title="История">
        <Row label="Хранить последних снимков" hint="Временное хранилище: снимки можно снова открыть из трея">
          <Range label="Хранить последних снимков" value={limit} min={1} max={50} onChange={setLimit} onCommit={(v) => update({ historyLimit: v })} />
        </Row>
        <Row label="Очистить историю" hint={clearError || 'Файлы в папке снимков не удаляются'}>
          {cleared !== null ? (
            <span className="flex h-9 items-center gap-1.5 text-[13.5px] font-medium text-success" role="status">
              <Check size={16} />
              {cleared ? `Удалено ${cleared} ${plural(cleared, 'снимок', 'снимка', 'снимков')}` : 'История уже пуста'}
            </span>
          ) : (
            <Button
              variant="danger"
              onClick={() => {
                if (!confirmClear) return setConfirmClear(true);
                setConfirmClear(false);
                setClearError('');
                api
                  .historyClear()
                  .then(setCleared)
                  .catch((e) => setClearError(errorText(e)));
              }}
            >
              {confirmClear ? 'Точно очистить?' : 'Очистить'}
            </Button>
          )}
        </Row>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------- Загрузка и ссылки

const SAMPLE_BOX_LINK = 'https://app.box.com/s/3rud4dfakga5r953wt77anhyzo27tm7r';

/** The section: the storage (S3 or Box), its settings, then the links — common to both. */
function UploadSection({ s, update, flush }: { s: AppSettings; update: Update; flush: () => Promise<void> }) {
  const [status, setStatus] = useState<UploadStatus | null>(null);
  const refresh = () => api.uploadStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);
  useTauriEvent('upload:changed', () => refresh());
  const provider = s.uploadProvider ?? status?.defaultProvider ?? 'box';
  const links = <LinkGroups s={s} update={update} provider={provider} defaultTemplate={status?.defaultLinkTemplate ?? ''} />;

  return (
    <>
      <Title sub={provider === 's3' ? 'Снимки загружаются в хранилище S3, ссылка сразу копируется' : 'Снимки загружаются в ваш Box, ссылка сразу копируется'}>
        Загрузка и ссылки
      </Title>
      <Row label="Хранилище" hint={status && provider === status.defaultProvider ? 'Как в этой сборке' : undefined}>
        <Segmented
          accent
          value={provider}
          onChange={(v) => update({ uploadProvider: v })}
          options={[
            { value: 's3', label: 'S3' },
            { value: 'box', label: 'Box' },
          ]}
        />
      </Row>
      {provider === 's3' ? (
        <S3Section s={s} update={update} flush={flush} status={status?.s3 ?? null}>
          {links}
        </S3Section>
      ) : (
        <BoxSection s={s} update={update} flush={flush}>
          {links}
        </BoxSection>
      )}
    </>
  );
}

/** Links and what happens after an upload; the same for every storage. */
function LinkGroups({ s, update, provider, defaultTemplate }: { s: AppSettings; update: Update; provider: UploadProvider; defaultTemplate: string }) {
  const [preview, setPreview] = useState('');
  const links = s.links;
  useEffect(() => {
    api.linkPreview(links.template).then(setPreview).catch(() => setPreview(''));
  }, [links.template, provider, defaultTemplate]);
  const strip = (u: string) => u.replace(/^https?:\/\//, '');
  const box = provider === 'box';

  return (
    <>
      <Group title="Ссылки">
        <Row
          label={box ? 'Заменять ссылку Box по шаблону' : 'Ссылка по шаблону'}
          hint={box ? 'Выключено — обычная ссылка app.box.com/s/…' : 'Выключено — прямая ссылка на файл в бакете (откроется, только если бакет открыт на чтение)'}
        >
          <Switch checked={links.rewrite} onChange={(v) => update({ links: { rewrite: v } })} label="Ссылка по шаблону" />
        </Row>
        {links.rewrite && (
          <Row label="Шаблон ссылки" hint={`Пусто — по умолчанию сборки. {id} — ${box ? 'код Box' : 'код снимка'}, {ext} — расширение, {name} — имя файла`}>
            <TextField className="font-mono" value={links.template} placeholder={defaultTemplate} onChange={(v) => update({ links: { template: v } }, TYPING)} />
          </Row>
        )}
      </Group>

      <Group title="После загрузки">
        <Row label="Копировать ссылку в буфер обмена">
          <Switch checked={links.copyAfterUpload} onChange={(v) => update({ links: { copyAfterUpload: v } })} label="Копировать ссылку в буфер обмена" />
        </Row>
        <Row label="Открывать ссылку в браузере">
          <Switch checked={links.openAfterUpload} onChange={(v) => update({ links: { openAfterUpload: v } })} label="Открывать ссылку в браузере" />
        </Row>
      </Group>

      {links.rewrite && (
        <div className="flex flex-col gap-0.5 overflow-hidden rounded-xl bg-surface-2 px-3.5 py-3 font-mono text-[12px] leading-[1.7]">
          {box ? (
            <>
              <div className="truncate">
                <span className="text-muted">было{'  '}</span>
                {strip(SAMPLE_BOX_LINK)}
              </div>
              <div className="truncate">
                <span className="text-muted">стало </span>
                {strip(preview || SAMPLE_BOX_LINK)}
              </div>
            </>
          ) : (
            <div className="truncate">
              <span className="text-muted">ссылка </span>
              {strip(preview)}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** S3 storage: the bucket and the folder; the address, the region and an own key — advanced. */
function S3Section({ s, update, flush, status, children }: { s: AppSettings; update: Update; flush: () => Promise<void>; status: S3Status | null; children: ReactNode }) {
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const s3 = s.s3;
  // Builds without a storage key need the own key in the advanced fields.
  useEffect(() => {
    if (status && !status.builtinKey) setAdvanced(true);
  }, [status?.builtinKey]);

  // Settings are saved as they change; the secret only when used.
  const persist = async () => {
    await flush();
    if (secret) {
      await api.s3SetSecret(secret);
      setSecret('');
    }
  };
  const test = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await persist();
      await api.s3Test();
      setMsg({ kind: 'ok', text: 'Запись в бакет работает' });
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const host = (u: string) => u.replace(/^https?:\/\//, '');
  const ownKey = !!s3.accessKeyId;

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 rounded-[14px] bg-surface-2 p-3.5">
          <div className={clsx('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', status?.ready ? 'bg-lime text-on-lime' : 'bg-surface-3 text-muted')}>
            <Cloud size={18} />
          </div>
          <div className="min-w-0 flex-1 text-[14px] font-medium">
            <div className="truncate">{status?.ready ? `Бакет ${status.bucket}` : 'Хранилище не настроено'}</div>
            <div className="truncate text-[12px] font-normal text-muted">
              {status?.ready
                ? [ownKey ? 'свой ключ' : 'ключ сборки', host(status.endpoint)].join(' · ')
                : status?.builtinKey || ownKey
                  ? 'Укажите бакет'
                  : 'В этой сборке нет ключа — укажите свой в «Дополнительно»'}
            </div>
          </div>
          <Button variant="outline" size="sm" className="h-8" loading={busy} onClick={test}>
            Проверить
          </Button>
        </div>
        {msg && <p className={clsx('px-1 text-[12px] whitespace-pre-line', msg.kind === 'error' ? 'text-danger' : 'text-success')}>{msg.text}</p>}
      </div>

      <Group title="Куда загружать">
        <Row label="Бакет" hint="Имя бакета в Object Storage">
          <TextField className="font-mono" value={s3.bucket} placeholder={status?.bucket || 'имя бакета'} onChange={(v) => update({ s3: { bucket: v.trim() } }, TYPING)} />
        </Row>
        <Row label="Папка в бакете" hint="Необязательно: например, shots/">
          <TextField className="font-mono" value={s3.prefix} placeholder={status?.prefix || 'корень бакета'} onChange={(v) => update({ s3: { prefix: v } }, TYPING)} />
        </Row>
      </Group>

      {children}

      <section className="flex flex-col gap-0.5">
        <button onClick={() => setAdvanced((a) => !a)} className="flex items-center gap-1 self-start pb-1.5 text-[12px] text-muted transition-colors hover:text-text">
          <ChevronRight size={14} className={clsx('transition-transform', advanced && 'rotate-90')} />
          Дополнительно
        </button>
        {advanced && (
          <>
            <Row label="Адрес хранилища" hint="Любое S3-совместимое: Yandex Object Storage, MinIO, Cloudflare R2…">
              <TextField className="font-mono" value={s3.endpoint} placeholder={status?.endpoint} onChange={(v) => update({ s3: { endpoint: v.trim() } }, TYPING)} />
            </Row>
            <Row label="Регион">
              <TextField className="font-mono" value={s3.region} placeholder={status?.region} onChange={(v) => update({ s3: { region: v.trim() } }, TYPING)} />
            </Row>
            <Row
              label="Свой ключ: идентификатор"
              hint={status?.builtinKey ? 'Необязательно: вместо ключа, встроенного в сборку' : 'Статический ключ доступа сервисного аккаунта (только запись в бакет)'}
            >
              <TextField className="font-mono" value={s3.accessKeyId} placeholder="YCAJE…" onChange={(v) => update({ s3: { accessKeyId: v.trim() } }, TYPING)} />
            </Row>
            <Row label="Секретный ключ" hint={status?.hasSecret ? 'Сохранён (зашифрован в Windows)' : 'Хранится зашифрованным в Windows'}>
              <Input
                type="password"
                className="w-[250px] shrink-0 font-mono"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                onBlur={() => secret && persist().catch(() => {})}
                placeholder={status?.hasSecret ? '••••••••' : 'Секретный ключ'}
              />
            </Row>
          </>
        )}
      </section>
    </>
  );
}

function BoxSection({ s, update, flush, children }: { s: AppSettings; update: Update; flush: () => Promise<void>; children: ReactNode }) {
  const [status, setStatus] = useState<BoxStatus | null>(null);
  const [secret, setSecret] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const box = s.box;

  const refresh = () => api.boxStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);
  useTauriEvent('upload:changed', () => refresh());
  // Builds without an embedded Box app need the advanced fields.
  useEffect(() => {
    if (status && (box.authMode !== 'oAuth' || (!status.builtinApp && !status.customApp))) setAdvanced(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.builtinApp, status?.customApp]);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(null);
      refresh();
    }
  };

  // Settings are saved as they change; secrets only when used.
  const persist = async () => {
    await flush();
    if (secret) {
      await api.boxSetSecret('clientSecret', secret);
      setSecret('');
    }
    if (token) {
      await api.boxSetSecret('developerToken', token);
      setToken('');
    }
  };

  const login = () =>
    run('login', async () => {
      await persist();
      await api.boxLogin();
    });
  const test = () =>
    run('test', async () => {
      await persist();
      const u = await api.boxTest();
      setMsg({ kind: 'ok', text: `Подключено: ${u.name || u.login}${u.login ? ` (${u.login})` : ''}` });
    });

  const oauth = box.authMode === 'oAuth';
  const noApp = oauth && status && !status.builtinApp && !status.customApp;
  const account = status?.account;

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 rounded-[14px] bg-surface-2 p-3.5">
          {oauth && status?.signedIn ? (
            <>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-lime text-[14px] font-medium text-on-lime">
                {(account?.name || account?.login || 'B').slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1 text-[14px] font-medium">
                <div className="truncate">{account?.name || 'Аккаунт Box'}</div>
                <div className="truncate text-[12px] font-normal text-muted">{[account?.login, 'Box подключён'].filter(Boolean).join(' · ')}</div>
              </div>
              <Button variant="outline" size="sm" className="h-8" loading={busy === 'logout'} onClick={() => run('logout', () => api.boxLogout())}>
                Выйти
              </Button>
            </>
          ) : oauth ? (
            <>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-3 text-muted">
                <Cloud size={18} />
              </div>
              <div className="min-w-0 flex-1 text-[14px] font-medium">
                Box не подключён
                <div className="text-[12px] font-normal text-muted">
                  {busy === 'login' ? 'Войдите на сайте Box и нажмите «Предоставить доступ»' : 'Войдите, чтобы получать ссылки — ключи вводить не нужно'}
                </div>
              </div>
              {busy === 'login' ? (
                <Button variant="outline" size="sm" className="h-8" icon={<Spinner size={13} />} onClick={() => api.boxLogout()}>
                  Отмена
                </Button>
              ) : (
                <Button variant="accent" size="sm" className="h-8" disabled={!!noApp} onClick={login}>
                  Войти через Box
                </Button>
              )}
            </>
          ) : (
            <>
              <ShieldCheck size={20} className={clsx('mx-2', status?.ready ? 'text-success' : 'text-muted')} />
              <div className="min-w-0 flex-1 text-[14px] font-medium">
                {box.authMode === 'clientCredentials' ? 'Сервисный аккаунт' : 'Developer token'}
                <div className="text-[12px] font-normal text-muted">{status?.ready ? 'Данные для входа указаны' : 'Заполните поля в «Дополнительно»'}</div>
              </div>
              <Button variant="outline" size="sm" className="h-8" loading={busy === 'test'} onClick={test}>
                Проверить
              </Button>
            </>
          )}
        </div>
        {noApp && <p className="px-1 text-[12px] text-warning">Эта сборка без встроенного приложения Box — укажите своё в «Дополнительно» ниже.</p>}
        {msg && <p className={clsx('px-1 text-[12px] whitespace-pre-line', msg.kind === 'error' ? 'text-danger' : 'text-success')}>{msg.text}</p>}
      </div>

      <Group title="Куда загружать">
        <Row label="Папка в Box" hint={box.folderId ? `Используется папка с ID ${box.folderId} (см. «Дополнительно»)` : 'Создаётся автоматически в «Все файлы»'}>
          <TextField value={box.folderName} disabled={!!box.folderId} onChange={(v) => update({ box: { folderName: v } }, TYPING)} />
        </Row>
        <Row label="Доступ по ссылке" hint="Откроется на телефоне без входа в Box">
          <Select
            value={box.sharedLinkAccess}
            onChange={(e) => update({ box: { sharedLinkAccess: e.target.value as AppSettings['box']['sharedLinkAccess'] } })}
            className="w-[250px] shrink-0"
          >
            <option value="open">Все, у кого есть ссылка</option>
            {/* Not offered any more; kept visible only for settings that already use it. */}
            {box.sharedLinkAccess === 'company' && <option value="company">Только сотрудники компании</option>}
            <option value="collaborators">Только участники папки</option>
          </Select>
        </Row>
      </Group>

      {children}

      <section className="flex flex-col gap-0.5">
        <button onClick={() => setAdvanced((a) => !a)} className="flex items-center gap-1 self-start pb-1.5 text-[12px] text-muted transition-colors hover:text-text">
          <ChevronRight size={14} className={clsx('transition-transform', advanced && 'rotate-90')} />
          Дополнительно
        </button>
        {advanced && (
          <>
            <Row label="Способ входа">
              <Segmented
                accent
                value={box.authMode}
                onChange={(v) => update({ box: { authMode: v } })}
                options={[
                  { value: 'oAuth', label: 'Вход через Box' },
                  { value: 'clientCredentials', label: 'Сервисный аккаунт' },
                  { value: 'developerToken', label: 'Токен' },
                ]}
              />
            </Row>
            {box.authMode !== 'developerToken' && (
              <>
                <Row
                  label={oauth ? 'Своё приложение Box' : 'Client ID'}
                  hint={oauth ? 'Необязательно: только если не подходит встроенное. User Authentication (OAuth 2.0)' : 'Server Authentication (Client Credentials Grant), одобренное администратором'}
                >
                  <TextField className="font-mono" value={box.clientId} placeholder="Client ID" onChange={(v) => update({ box: { clientId: v.trim() } }, TYPING)} />
                </Row>
                <Row label="Client Secret" hint={status?.hasClientSecret ? 'Сохранён (зашифрован в Windows)' : 'Хранится зашифрованным в Windows'}>
                  <Input
                    type="password"
                    className="w-[250px] shrink-0 font-mono"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    onBlur={() => secret && persist().then(refresh).catch(() => {})}
                    placeholder={status?.hasClientSecret ? '••••••••' : 'Client Secret'}
                  />
                </Row>
              </>
            )}
            {box.authMode === 'clientCredentials' && (
              <>
                <Row label="Enterprise ID">
                  <TextField className="font-mono" value={box.enterpriseId} onChange={(v) => update({ box: { enterpriseId: v.trim() } }, TYPING)} />
                </Row>
                <Row label="User ID" hint="Необязательно: действовать от имени пользователя">
                  <TextField className="font-mono" value={box.userId} onChange={(v) => update({ box: { userId: v.trim() } }, TYPING)} />
                </Row>
              </>
            )}
            {box.authMode === 'developerToken' && (
              <Row label="Developer token" hint="Временный токен из консоли разработчика Box (60 минут) — для проверки">
                <Input
                  type="password"
                  className="w-[250px] shrink-0 font-mono"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onBlur={() => token && persist().then(refresh).catch(() => {})}
                  placeholder={status?.hasDeveloperToken ? '•••••••• (сохранён)' : ''}
                />
              </Row>
            )}
            <Row label="ID папки" hint="Вместо имени: число из адреса app.box.com/folder/123456 (0 — корень)">
              <TextField className="font-mono" value={box.folderId} placeholder="авто" onChange={(v) => update({ box: { folderId: v.trim() } }, TYPING)} />
            </Row>
            {oauth && (
              <Row
                label="Redirect URI"
                hint="Необязательно: пусто — подбирается при входе. Если Box пишет redirect_uri_mismatch — адрес из настроек приложения Box (Configuration → OAuth 2.0 Redirect URI)"
              >
                <TextField
                  className="font-mono"
                  value={box.redirectUri}
                  placeholder={status?.redirectUri ? `авто (${status.redirectUri})` : 'авто'}
                  onChange={(v) => update({ box: { redirectUri: v.trim() } }, TYPING)}
                />
              </Row>
            )}
            <Row label="Проверить подключение">
              <Button variant="outline" icon={<ShieldCheck size={15} />} loading={busy === 'test'} onClick={test}>
                Проверить
              </Button>
            </Row>
          </>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------- О программе

const UI_SCALES = [80, 90, 100, 110, 125, 150];

function About({ s, update }: { s: AppSettings; update: Update }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api.appInfo().then(setInfo).catch(() => {});
  }, []);
  const name = info?.channel ? 'AShot Dev' : 'AShot';
  const versionLine = info
    ? `${name} ${info.version}${info.channel ? ` (${info.channel})` : ''} (${info.commit}, ${info.buildDate}) · Tauri ${info.tauriVersion} · ${info.os}`
    : '';
  const rows: [string, string][] = [
    ['Версия', info ? `${info.version}${info.channel ? ` · Dev, ${info.channel}` : ''}` : '…'],
    ['Сборка', info ? `${info.commit} · ${info.buildDate}` : '…'],
    ['Платформа', info ? `${info.os} · Tauri ${info.tauriVersion}` : '…'],
  ];

  const copyVersion = async () => {
    await api.copyText(versionLine);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mx-auto flex w-full max-w-[460px] flex-col gap-4">
      <div className="flex items-center gap-3.5">
        <Logo size={52} radius={284} />
        <div className="flex flex-col gap-0.5">
          <h1 className="flex items-center gap-2 font-display text-[22px] leading-tight font-normal">
            AShot
            {info?.channel && <DevBadge channel={info.channel} />}
          </h1>
          <div className="text-[13.5px] text-muted">Скриншоты с редактором и ссылками Box</div>
        </div>
      </div>
      <div className="rounded-[14px] bg-surface-2 px-4 py-1">
        {rows.map(([k, v], i) => (
          <div key={k} className="flex h-10 items-center justify-between gap-4 text-[14px]">
            <span className="text-muted">{k}</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono text-[13px]">{v}</span>
              {i === 0 && (
                <IconButton tip={copied ? 'Скопировано' : 'Скопировать версию и сборку'} tipPos="left" size={28} disabled={!info} onClick={copyVersion}>
                  {copied ? <Check size={15} className="text-success" /> : <Copy size={15} />}
                </IconButton>
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="rounded-[14px] bg-surface-2 px-4 py-1">
        <div className="flex items-center justify-between gap-4 py-2 text-[14px]">
          Тема
          <Segmented
            accent
            value={s.theme}
            onChange={(v) => update({ theme: v })}
            options={[
              { value: 'system', label: 'Системная' },
              { value: 'light', label: 'Светлая' },
              { value: 'dark', label: 'Тёмная' },
            ]}
          />
        </div>
        <div className="flex flex-col gap-2 border-t border-border py-2.5 text-[14px]">
          <span className="flex flex-col">
            Масштаб интерфейса
            <span className="text-[12px] text-muted">Панель в трее, уведомления и настройки</span>
          </span>
          <Segmented
            accent
            value={s.uiScale}
            onChange={(v) => update({ uiScale: v })}
            options={UI_SCALES.map((v) => ({ value: v, label: `${v}%` }))}
            className="self-start"
          />
        </div>
        <div className="flex flex-col gap-2 border-t border-border py-2.5 text-[14px]">
          <span className="flex flex-col">
            Масштаб кнопок в редакторах
            <span className="text-[12px] text-muted">Редактор и панели на экране выделения; сам снимок не меняется</span>
          </span>
          <Segmented
            accent
            value={s.editorScale}
            onChange={(v) => update({ editorScale: v })}
            options={UI_SCALES.map((v) => ({ value: v, label: `${v}%` }))}
            className="self-start"
          />
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-border py-2.5 text-[14px]">
          <span className="flex flex-col">
            Запускать вместе с Windows
            <span className="text-[12px] text-muted">AShot будет в трее сразу после входа в систему</span>
          </span>
          <Switch checked={s.autostart} onChange={(v) => update({ autostart: v })} label="Запускать вместе с Windows" />
        </div>
      </div>
      <Updates autoUpdate={s.autoUpdate} onAutoUpdate={(v) => update({ autoUpdate: v })} channel={info?.channel ?? ''} />
      <div className="flex flex-col gap-2 px-1">
        <div className="flex gap-5 text-[13px]">
          <button className="flex items-center gap-1.5 transition-colors hover:text-muted" onClick={() => api.openFolder('logs')}>
            <FileText size={16} className="text-muted" />
            Журнал
          </button>
          <button className="flex items-center gap-1.5 transition-colors hover:text-muted" onClick={() => api.openFolder('history')}>
            <FolderOpen size={16} className="text-muted" />
            Временные снимки
          </button>
        </div>
        <div className="text-[12px] leading-normal text-muted">
          Используются: Tauri, React, Konva, иконки Lucide (ISC), snow-ui-selector из Snow Shot (Apache-2.0), шрифты Roboto и Roboto Mono (OFL).
        </div>
      </div>
    </div>
  );
}

/** Update check / install from GitHub Releases. */
function Updates({ autoUpdate, onAutoUpdate, channel }: { autoUpdate: boolean; onAutoUpdate: (v: boolean) => void; channel: string }) {
  const [st, setSt] = useState<UpdateState>({ phase: 'idle' });
  useEffect(() => {
    api.updateState().then(setSt).catch(() => {});
  }, []);
  useTauriEvent<UpdateState>('update:state', (e) => setSt(e.payload));

  const check = () => api.updateCheck().then(setSt).catch((e) => setSt({ phase: 'error', message: errorText(e) }));
  // The app restarts on success; errors also arrive as `update:state`.
  const install = () => api.updateInstall().catch((e) => setSt({ phase: 'error', message: errorText(e) }));

  if (st.phase === 'disabled') {
    return (
      <div className="text-[12.5px] text-muted">
        {channel ? `Dev-сборка (${channel}) не обновляется сама — новая появляется в PR после каждого пуша` : 'Обновления недоступны в локальной сборке'}
      </div>
    );
  }

  let text: ReactNode;
  let action: ReactNode = null;
  switch (st.phase) {
    case 'idle':
      text = <span className="text-muted">Проверка новых версий</span>;
      action = (
        <Button variant="outline" icon={<RefreshCw size={15} />} onClick={check}>
          Проверить обновления
        </Button>
      );
      break;
    case 'checking':
      text = (
        <span className="flex items-center gap-2 text-muted">
          <Spinner size={15} /> Проверяю…
        </span>
      );
      action = (
        <Button variant="outline" icon={<RefreshCw size={15} />} disabled>
          Проверить обновления
        </Button>
      );
      break;
    case 'upToDate':
      text = (
        <span className="flex items-center gap-2">
          <Check size={16} className="text-success" /> Установлена последняя версия
        </span>
      );
      action = (
        <Button variant="outline" icon={<RefreshCw size={15} />} onClick={check}>
          Проверить снова
        </Button>
      );
      break;
    case 'available':
      text = (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">Доступна версия {st.version}</span>
          {st.url ? (
            <button className="self-start text-[12.5px] text-muted underline-offset-2 hover:text-text hover:underline" onClick={() => api.openUrl(st.url)}>
              Что нового
            </button>
          ) : (
            st.notes && <span className="line-clamp-2 text-[12.5px] whitespace-pre-line text-muted">{st.notes}</span>
          )}
        </span>
      );
      action = (
        <Button variant="accent" icon={<Download size={15} />} onClick={install}>
          Обновить
        </Button>
      );
      break;
    case 'downloading': {
      const pct = st.total ? Math.min(100, Math.round((st.downloaded / st.total) * 100)) : 0;
      text = (
        <span className="flex w-full flex-col gap-2">
          <span className="text-muted">
            Скачиваю {st.version} — {pct}%
          </span>
          <span className="h-1.5 overflow-hidden rounded-full bg-surface-3">
            <span className="block h-full rounded-full bg-lime transition-[width]" style={{ width: `${pct}%` }} />
          </span>
        </span>
      );
      break;
    }
    case 'installing':
      text = (
        <span className="flex items-center gap-2 text-muted">
          <Spinner size={15} /> Устанавливаю {st.version} — AShot перезапустится
        </span>
      );
      break;
    case 'error':
      text = <span className="text-danger">{st.message}</span>;
      action = (
        <Button variant="outline" icon={<RefreshCw size={15} />} onClick={check}>
          Повторить
        </Button>
      );
      break;
  }

  return (
    <div className="rounded-[14px] bg-surface-2 px-4 py-1">
      <div className="flex min-h-[52px] items-center justify-between gap-3 py-2 text-[14px]">
        <div className="flex min-w-0 flex-1">{text}</div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-border py-2.5 text-[14px]">
        <span className="flex flex-col">
          Обновлять автоматически
          <span className="text-[12px] text-muted">Когда ничего не открыто; AShot перезапустится сам</span>
        </span>
        <Switch checked={autoUpdate} onChange={onAutoUpdate} label="Обновлять автоматически" />
      </div>
    </div>
  );
}
