// Tray panel: the latest screenshot with its link, capture modes and earlier screenshots.
import clsx from 'clsx';
import {
  AppWindow,
  Check,
  CloudUpload,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  History,
  ImageOff,
  Link2,
  Monitor,
  MoreHorizontal,
  Pencil,
  Save,
  Scan,
  Settings as SettingsIcon,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, IconButton, Kbd, Logo, Spinner } from '../components/ui';
import { hotkeyParts, relativeTime, sizeLabel } from '../lib/format';
import { useKeyDown, useTauriEvent } from '../lib/hooks';
import { api, errorText, shotUrl } from '../lib/ipc';
import type { AppSettings, BoxStatus, CaptureMode, HistoryItem } from '../lib/types';

type Run = (id: string, label: string, fn: () => Promise<unknown>) => Promise<void>;
type MenuState = { item: HistoryItem; x: number; y: number };

export default function TrayPanel() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [box, setBox] = useState<BoxStatus | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [, setTick] = useState(0);
  const [animKey, setAnimKey] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [s, list, status] = await Promise.all([api.settingsGet(), api.historyList(), api.boxStatus()]);
      setSettings(s.settings);
      setItems(list);
      setBox(status);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(() => setTick((x) => x + 1), 30_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  useTauriEvent('history:changed', () => refresh());
  useTauriEvent('box:changed', () => refresh());
  useTauriEvent<AppSettings>('settings:changed', (e) => setSettings(e.payload));
  useTauriEvent('panel:shown', () => {
    refresh();
    setMenu(null);
    setShowAll(false);
    setAnimKey((k) => k + 1);
  });
  useKeyDown((e) => {
    if (e.key !== 'Escape') return;
    if (menu) setMenu(null);
    else api.panelHide();
  });

  const run: Run = async (id, label, fn) => {
    setBusy((b) => ({ ...b, [id]: label }));
    try {
      await fn();
    } catch (e) {
      console.error(errorText(e));
    } finally {
      setBusy((b) => {
        const { [id]: _, ...rest } = b;
        return rest;
      });
    }
  };

  const openMenu = (item: HistoryItem, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ item, x: e.clientX, y: e.clientY });
  };

  const hk = settings?.hotkeys;
  const [latest, ...earlier] = items;
  const grid = showAll ? items : earlier;

  return (
    <div className="h-full p-2.5" onMouseDown={() => setMenu(null)}>
      <div key={animKey} className="card-pop animate-pop-in relative flex h-full flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3" data-tauri-drag-region>
          <Logo size={28} radius={292} />
          <span className="font-display text-[15px] font-semibold" data-tauri-drag-region>
            AShot
          </span>
          <div className="flex-1" data-tauri-drag-region />
          <BoxPill box={box} refresh={refresh} />
          <IconButton tip="Настройки" tipPos="left" size={30} onClick={() => api.openSettings()}>
            <SettingsIcon size={19} />
          </IconButton>
        </div>

        {!showAll && (
          <>
            <Hero item={latest} busy={latest ? busy[latest.id] : undefined} run={run} onMenu={openMenu} hotkey={hk?.region ?? ''} />

            {/* Capture modes */}
            <div className="grid grid-cols-3 gap-2 p-4">
              <ModeTile icon={<Scan size={22} />} label="Область" keys={hk?.region} onClick={() => api.capture('region')} main />
              <ModeTile icon={<AppWindow size={22} />} label="Окно" keys={hk?.window} onClick={() => capture('windowPick')} tip="Кликните по окну" />
              <ModeTile
                icon={<Monitor size={22} />}
                label="Экран"
                keys={hk?.fullscreen}
                onClick={() => capture('fullscreen')}
                tip={settings?.fullscreenMode === 'allMonitors' ? 'Все мониторы — сразу в редактор' : 'Весь экран — сразу в редактор'}
                tipPos="top-left"
              />
            </div>
          </>
        )}

        {/* Earlier screenshots */}
        <div className={clsx('flex items-center justify-between px-4 text-[13px]', showAll && 'pt-1')}>
          <span className="font-medium">{showAll ? `Все снимки · ${items.length}` : 'Ранее'}</span>
          {(showAll || earlier.length > 4) && (
            <button className="text-muted transition-colors hover:text-text" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Свернуть' : 'Все снимки'}
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-2.5 pb-4">
          {grid.length === 0 ? (
            <div className="pt-6 text-center text-[12px] leading-relaxed text-muted">
              Здесь будут предыдущие снимки —
              <br />
              до {settings?.historyLimit ?? 10} последних
            </div>
          ) : (
            <div className="grid grid-cols-2 content-start gap-2">
              {grid.map((it) => (
                <ShotTile key={it.id} item={it} busy={busy[it.id]} run={run} onMenu={openMenu} />
              ))}
            </div>
          )}
        </div>

        {menu && <ContextMenu {...menu} run={run} close={() => setMenu(null)} />}
      </div>
    </div>
  );
}

function capture(mode: CaptureMode) {
  api.capture(mode);
}

function BoxPill({ box, refresh }: { box: BoxStatus | null; refresh: () => void }) {
  const [signingIn, setSigningIn] = useState(false);
  if (!box) return null;
  if (box.ready) {
    return (
      <button
        className="flex h-7 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-[12px] transition-colors hover:bg-surface-3"
        data-tip={box.account ? `${box.account.name}\n${box.account.login}` : 'Box подключён'}
        data-tip-pos="left"
        onClick={() => api.openSettings('box')}
      >
        <span className="h-[7px] w-[7px] rounded-full bg-success" />
        Box
      </button>
    );
  }
  return (
    <button
      className="flex h-7 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-[12px] transition-colors hover:bg-surface-3"
      data-tip="Откроется сайт Box — войдите и нажмите «Предоставить доступ»"
      data-tip-pos="left"
      onClick={async () => {
        if (box.mode !== 'oAuth') return api.openSettings('box');
        setSigningIn(true);
        try {
          await api.boxLogin();
        } catch {
          /* the error is shown in a toast */
        } finally {
          setSigningIn(false);
          refresh();
        }
      }}
    >
      {signingIn ? <Spinner size={11} /> : <span className="h-[7px] w-[7px] rounded-full bg-warning" />}
      {signingIn ? 'Вход…' : 'Войти в Box'}
    </button>
  );
}

const thumbPattern = 'repeating-linear-gradient(135deg, var(--color-surface-3) 0 8px, var(--color-surface-2) 8px 16px)';

function Hero({
  item,
  busy,
  run,
  onMenu,
  hotkey,
}: {
  item?: HistoryItem;
  busy?: string;
  run: Run;
  onMenu: (item: HistoryItem, e: React.MouseEvent) => void;
  hotkey: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [item?.id]);

  if (!item) {
    return (
      <div className="mx-4 flex h-[226px] flex-col items-center justify-center gap-3 rounded-2xl bg-surface-2 px-8 text-center">
        <ImageOff size={26} className="text-muted" />
        <div>
          <div className="text-[14px] font-medium">Пока нет снимков</div>
          <div className="mt-1 text-[12px] leading-relaxed text-muted">Последний снимок появится здесь — с правкой, ссылкой и копированием в один клик.</div>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-muted">
          {hotkey ? (
            <>
              Нажмите <Kbd keys={hotkey} />
            </>
          ) : (
            'Нажмите «Область» ниже'
          )}
        </div>
      </div>
    );
  }

  const copyLink = async () => {
    await run(item.id, 'link', () => api.historyCopyLink(item.id));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const uploading = busy === 'upload';

  return (
    <div className="mx-4 flex flex-col overflow-hidden rounded-2xl bg-surface-2" onContextMenu={(e) => onMenu(item, e)}>
      <div className="relative h-[170px]" style={{ background: thumbPattern }}>
        <button className="absolute inset-0 block h-full w-full" onClick={() => api.historyOpen(item.id)} aria-label="Открыть в редакторе">
          <img src={shotUrl(`history/${item.id}/current.png?r=${item.revision}`)} alt="" draggable={false} className="h-full w-full object-cover object-top" />
        </button>
        <div className="pointer-events-none absolute top-2.5 left-2.5 rounded-full bg-surface px-2 py-1 text-[12px]">
          {relativeTime(item.createdAt)} · {sizeLabel(item.width, item.height)}
        </div>
        <div className="absolute top-2.5 right-2.5 flex gap-1.5">
          <IconButton tone="solid" size={32} tip="Редактировать" onClick={() => api.historyOpen(item.id)}>
            <Pencil size={16} />
          </IconButton>
          <IconButton tone="solid" size={32} tip="Копировать изображение" onClick={() => run(item.id, 'copy', () => api.historyCopy(item.id))}>
            {busy === 'copy' ? <Spinner size={15} /> : <Copy size={16} />}
          </IconButton>
          <IconButton tone="solid" size={32} tip="Сохранить в папку снимков" tipPos="left" onClick={() => run(item.id, 'save', () => api.historySave(item.id))}>
            {busy === 'save' ? <Spinner size={15} /> : <Download size={16} />}
          </IconButton>
        </div>
      </div>
      <div className="flex items-center gap-2 p-2.5">
        {uploading ? (
          <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[10px] bg-surface px-3 text-[12px] text-muted">
            <Spinner size={14} /> Загрузка в Box…
          </div>
        ) : item.shortLink ? (
          <button
            onClick={copyLink}
            data-tip={item.linkOutdated ? 'Ссылка на версию до редактирования' : undefined}
            data-tip-pos="top"
            className="flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-[10px] bg-surface px-3 font-mono text-[12px]"
          >
            {item.linkOutdated ? <span className="mx-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-warning" /> : <Check size={16} className="shrink-0 text-success" />}
            <span className="truncate">{item.shortLink}</span>
          </button>
        ) : (
          <div className="flex h-9 min-w-0 flex-1 items-center rounded-[10px] bg-surface px-3 text-[12px] text-muted">
            <span className="truncate">{item.savedPath ? 'Сохранён в файл, ссылки ещё нет' : 'Ссылки ещё нет'}</span>
          </div>
        )}
        {item.shortLink ? (
          <Button variant="primary" className="h-9" icon={copied ? <Check size={16} /> : <Copy size={16} />} onClick={copyLink}>
            {copied ? 'Скопировано' : 'Копировать'}
          </Button>
        ) : (
          <Button
            variant="primary"
            className="h-9"
            icon={<Link2 size={16} />}
            disabled={uploading}
            tip="Загрузить в Box и скопировать ссылку"
            tipPos="top-left"
            onClick={() => run(item.id, 'upload', () => api.historyUpload(item.id))}
          >
            Получить ссылку
          </Button>
        )}
      </div>
    </div>
  );
}

function ModeTile({
  icon,
  label,
  keys,
  onClick,
  main,
  disabled,
  tip,
  tipPos,
}: {
  icon: ReactNode;
  label: string;
  keys?: string;
  onClick: () => void;
  main?: boolean;
  disabled?: boolean;
  tip?: string;
  tipPos?: 'top' | 'top-left';
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-tip={tip}
      data-tip-pos={tipPos ?? 'top'}
      className={clsx(
        'flex h-[68px] flex-col items-center justify-center gap-1 rounded-[14px] px-1.5 transition-[background,filter,opacity] duration-100 disabled:opacity-40',
        main ? 'bg-lime text-on-lime hover:brightness-105 active:brightness-95' : 'bg-surface-2 text-text hover:bg-surface-3',
      )}
    >
      {icon}
      <span className="text-[12px] leading-tight font-medium">{label}</span>
      <span className="font-mono text-[10px] leading-tight opacity-65">{keys ? hotkeyParts(keys).join('+') : '—'}</span>
    </button>
  );
}

function ShotTile({ item, busy, run, onMenu }: { item: HistoryItem; busy?: string; run: Run; onMenu: (item: HistoryItem, e: React.MouseEvent) => void }) {
  const [copied, setCopied] = useState(false);
  const copyLink = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await run(item.id, 'link', () => api.historyCopyLink(item.id));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  let badge: ReactNode;
  if (busy === 'upload') {
    badge = (
      <Badge icon={<Spinner size={11} className="text-muted" />} tip={undefined}>
        Загрузка
      </Badge>
    );
  } else if (item.shortLink) {
    badge = (
      <Badge
        icon={copied ? <Check size={13} className="text-success" /> : <Link2 size={13} className={item.linkOutdated ? 'text-warning' : 'text-success'} />}
        tip={item.linkOutdated ? 'Ссылка на версию до редактирования.\nНажмите, чтобы скопировать' : `${item.shortLink}\nНажмите, чтобы скопировать`}
        onClick={copyLink}
      >
        {copied ? 'Скопировано' : 'Ссылка'}
      </Badge>
    );
  } else if (item.savedPath) {
    badge = <Badge icon={<Save size={13} className="text-muted" />}>Файл</Badge>;
  } else {
    badge = <Badge icon={<History size={13} className="text-muted" />}>История</Badge>;
  }

  return (
    <div className="group flex min-w-0 flex-col gap-1.5" onContextMenu={(e) => onMenu(item, e)}>
      <div className="relative h-[76px] overflow-hidden rounded-xl" style={{ background: thumbPattern }}>
        <button
          className="absolute inset-0 block h-full w-full rounded-xl ring-inset ring-text/30 transition-shadow hover:ring-2"
          onClick={() => api.historyOpen(item.id)}
          aria-label="Открыть в редакторе"
        >
          <img src={shotUrl(`history/${item.id}/thumb.png?r=${item.revision}`)} alt="" draggable={false} className="h-full w-full rounded-xl object-cover object-top" />
        </button>
        <div className="absolute bottom-1.5 left-1.5">{badge}</div>
        <IconButton
          tone="solid"
          size={24}
          tip="Действия"
          tipPos="left"
          className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={(e) => onMenu(item, e)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <MoreHorizontal size={14} />
        </IconButton>
      </div>
      <div className="flex items-baseline justify-between gap-2 text-[12px] text-muted">
        <span className="truncate">{relativeTime(item.createdAt)}</span>
        {item.edited && <Pencil size={11} className="shrink-0 self-center" aria-label="Отредактирован" />}
      </div>
    </div>
  );
}

function Badge({ icon, children, tip, onClick }: { icon: ReactNode; children: ReactNode; tip?: string; onClick?: (e: React.MouseEvent) => void }) {
  const cls = 'flex items-center gap-1 rounded-full bg-surface px-[7px] py-[3px] text-[11px] leading-none text-text';
  return onClick ? (
    <button className={clsx(cls, 'transition-colors hover:bg-surface-2')} data-tip={tip} data-tip-pos="right" onClick={onClick}>
      {icon}
      {children}
    </button>
  ) : (
    <span className={cls}>
      {icon}
      {children}
    </span>
  );
}

function ContextMenu({ item, x, y, run, close }: MenuState & { run: Run; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // Keep the menu inside the panel.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 12)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 12)) });
  }, [x, y]);

  const entry = (icon: ReactNode, label: string, fn: () => unknown, danger?: boolean) => (
    <button
      onClick={() => {
        close();
        fn();
      }}
      className={clsx(
        'flex h-8 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[13px] transition-colors',
        danger ? 'text-danger hover:bg-danger/10' : 'text-text hover:bg-text/6',
      )}
    >
      <span className={danger ? '' : 'text-muted'}>{icon}</span>
      {label}
    </button>
  );

  return (
    <div
      ref={ref}
      className="animate-fade-in fixed z-40 w-[220px] rounded-[12px] bg-elevated p-1 shadow-(--shadow-pop) ring-1 ring-border"
      style={pos}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {entry(<Pencil size={15} />, 'Открыть в редакторе', () => api.historyOpen(item.id))}
      {entry(<Copy size={15} />, 'Копировать изображение', () => run(item.id, 'copy', () => api.historyCopy(item.id)))}
      {item.shortLink
        ? entry(<Link2 size={15} />, 'Копировать ссылку', () => run(item.id, 'link', () => api.historyCopyLink(item.id)))
        : entry(<CloudUpload size={15} />, 'Получить ссылку', () => run(item.id, 'upload', () => api.historyUpload(item.id)))}
      {item.shortLink && entry(<CloudUpload size={15} />, 'Загрузить заново', () => run(item.id, 'upload', () => api.historyUpload(item.id)))}
      {entry(<Download size={15} />, 'Сохранить в папку', () => run(item.id, 'save', () => api.historySave(item.id)))}
      {entry(<Save size={15} />, 'Сохранить как…', () => run(item.id, 'save', () => api.historySaveAs(item.id)))}
      {item.savedPath && entry(<FolderOpen size={15} />, 'Показать файл', () => api.revealPath(item.savedPath!))}
      {item.shareUrl && entry(<ExternalLink size={15} />, 'Открыть ссылку', () => api.openUrl(item.shareUrl!))}
      <div className="mx-1 my-1 h-px bg-border" />
      {entry(<Trash2 size={15} />, 'Удалить из истории', () => api.historyDelete(item.id), true)}
    </div>
  );
}
