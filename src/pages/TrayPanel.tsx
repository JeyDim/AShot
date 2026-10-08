// Tray panel: big capture buttons in one row, quick toggles and the recent screenshots.
import clsx from 'clsx';
import {
  AppWindow,
  Check,
  Copy,
  Download,
  FolderOpen,
  ImageOff,
  Info,
  Link2,
  Monitor,
  MoreHorizontal,
  Pencil,
  Power,
  RotateCcw,
  Settings as SettingsIcon,
  SquareDashed,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton, Kbd, Logo, Spinner, Switch } from '../components/ui';
import { relativeTime, sizeLabel } from '../lib/format';
import { useKeyDown, useTauriEvent } from '../lib/hooks';
import { api, errorText, shotUrl } from '../lib/ipc';
import type { AppSettings, BoxStatus, CaptureMode, HistoryItem } from '../lib/types';

export default function TrayPanel() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [version, setVersion] = useState('');
  const [box, setBox] = useState<BoxStatus | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [busy, setBusy] = useState<Record<string, string>>({});
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
    api.appInfo().then((i) => setVersion(i.version)).catch(() => {});
    const t = window.setInterval(() => setTick((x) => x + 1), 30_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  useTauriEvent('history:changed', () => refresh());
  useTauriEvent('box:changed', () => refresh());
  useTauriEvent<AppSettings>('settings:changed', (e) => setSettings(e.payload));
  useTauriEvent('panel:shown', () => {
    refresh();
    setAnimKey((k) => k + 1);
  });
  useKeyDown((e) => {
    if (e.key === 'Escape') api.panelHide();
  });

  const capture = (mode: CaptureMode) => api.capture(mode);

  const run = async (id: string, label: string, fn: () => Promise<unknown>) => {
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

  const toggleCursor = async (value: boolean) => {
    setSettings((s) => (s ? { ...s, showCursor: value } : s));
    try {
      setSettings(await api.settingsPatch({ showCursor: value }));
    } catch (e) {
      console.error(e);
    }
  };

  const hk = settings?.hotkeys;
  const limit = settings?.historyLimit ?? 10;

  return (
    <div className="h-full p-2.5">
      <div key={animKey} className="card-pop animate-pop-in flex h-full flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2" data-tauri-drag-region>
          <Logo size={26} />
          <div className="flex min-w-0 flex-1 items-baseline gap-2" data-tauri-drag-region>
            <span className="font-display text-[15px] font-semibold tracking-tight">AdvantShoter</span>
            {version && <span className="text-[11px] text-subtle">v{version}</span>}
          </div>
          <IconButton tip="О программе" onClick={() => api.openAbout()} size={32}>
            <Info size={17} />
          </IconButton>
          <IconButton tip="Настройки" tipPos="left" onClick={() => api.openSettings()} size={32}>
            <SettingsIcon size={17} />
          </IconButton>
        </div>

        {/* Capture buttons — big icons in one row */}
        <div className="grid grid-cols-4 gap-2 px-3 pt-1 pb-3">
          <CaptureTile icon={<SquareDashed size={26} strokeWidth={1.8} />} label="Область" keys={hk?.region} onClick={() => capture('region')} primary />
          <CaptureTile icon={<AppWindow size={26} strokeWidth={1.8} />} label="Окно" keys={hk?.window} onClick={() => capture('windowPick')} />
          <CaptureTile icon={<Monitor size={26} strokeWidth={1.8} />} label="Весь экран" keys={hk?.fullscreen} onClick={() => capture('fullscreen')} />
          <CaptureTile
            icon={<RotateCcw size={24} strokeWidth={1.8} />}
            label="Повторить"
            keys={hk?.lastRegion}
            onClick={() => capture('lastRegion')}
            disabled={!settings?.lastRegion}
            tip={settings?.lastRegion ? 'Снять ту же область ещё раз' : 'Сначала сделайте снимок области'}
          />
        </div>

        {/* Quick toggles */}
        <div className="mx-3 mb-3 flex items-center gap-3 rounded-[12px] bg-surface-2 px-3.5 py-2.5 ring-1 ring-inset ring-border">
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px]">Показывать курсор</div>
            <div className="text-[11.5px] text-subtle">Указатель мыши попадёт на снимок</div>
          </div>
          <Switch checked={settings?.showCursor ?? false} onChange={toggleCursor} label="Показывать курсор" />
        </div>

        {/* Recent */}
        <div className="flex items-center px-4 pb-1.5">
          <div className="flex-1 text-[12px] font-semibold tracking-wide text-subtle uppercase">
            Последние снимки
            <span className="ml-2 font-normal tracking-normal normal-case">
              {items.length} / {limit}
            </span>
          </div>
          {items.length > 0 && (
            <button className="text-[12px] text-subtle transition-colors hover:text-danger" onClick={() => api.historyClear()}>
              Очистить
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {items.length === 0 ? (
            <EmptyState keys={hk?.region ?? 'PrintScreen'} />
          ) : (
            <ul className="flex flex-col gap-0.5">
              {items.map((it) => (
                <HistoryRow key={it.id} item={it} busy={busy[it.id]} run={run} />
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-1 border-t border-border px-2.5 py-2">
          <FooterButton icon={<FolderOpen size={15} />} onClick={() => api.openFolder('save')}>
            Папка снимков
          </FooterButton>
          {box?.ready ? (
            <FooterButton
              icon={<span className="h-2 w-2 rounded-full bg-success" />}
              tip={box.account ? `${box.account.name}\n${box.account.login}` : 'Box подключён'}
              onClick={() => api.openSettings('box')}
            >
              <span className="max-w-[150px] truncate">{box.account?.name || 'Box подключён'}</span>
            </FooterButton>
          ) : (
            <FooterButton
              icon={signingIn ? <Spinner size={13} /> : <span className="h-2 w-2 rounded-full bg-warning" />}
              tip="Откроется сайт Box — войдите и нажмите «Предоставить доступ»"
              onClick={async () => {
                if (box && box.mode !== 'oAuth') return api.openSettings('box');
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
              {signingIn ? 'Вход в Box…' : 'Войти в Box'}
            </FooterButton>
          )}
          <div className="flex-1" />
          <IconButton tip="Выйти из AdvantShoter" tipPos="top-left" size={30} tone="danger" onClick={() => api.quit()}>
            <Power size={15} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function CaptureTile({
  icon,
  label,
  keys,
  onClick,
  primary,
  disabled,
  tip,
}: {
  icon: ReactNode;
  label: string;
  keys?: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  tip?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-tip={tip}
      className={clsx(
        'group flex flex-col items-center gap-1.5 rounded-[14px] px-1 pt-3 pb-2.5 transition-all duration-150 disabled:opacity-40',
        'bg-surface-2 ring-1 ring-inset ring-border hover:-translate-y-px hover:bg-surface-3 hover:ring-accent/45 active:translate-y-0',
      )}
    >
      <span
        className={clsx(
          'flex h-12 w-12 items-center justify-center rounded-[13px] transition-transform duration-150 group-hover:scale-105',
          primary ? 'brand-gradient text-white shadow-[0_8px_20px_-8px_rgb(107_107_255/0.9)]' : 'bg-accent-soft text-[#b4b4ff]',
        )}
      >
        {icon}
      </span>
      <span className="text-[12.5px] leading-tight font-medium">{label}</span>
      <span className="h-[18px]">{keys ? <Kbd keys={keys} /> : <span className="text-[11px] text-subtle">—</span>}</span>
    </button>
  );
}

function FooterButton({ icon, children, onClick, tip }: { icon: ReactNode; children: ReactNode; onClick: () => void; tip?: string }) {
  return (
    <button
      onClick={onClick}
      data-tip={tip}
      data-tip-pos="top"
      className="inline-flex h-[30px] items-center gap-2 rounded-[8px] px-2.5 text-[12.5px] text-muted transition-colors hover:bg-white/6 hover:text-text"
    >
      {icon}
      {children}
    </button>
  );
}

function EmptyState({ keys }: { keys: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 py-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-subtle ring-1 ring-inset ring-border">
        <ImageOff size={24} />
      </div>
      <div>
        <div className="text-[14px] font-medium">Пока нет снимков</div>
        <div className="mt-1 text-[12.5px] leading-relaxed text-subtle">
          Здесь будут последние снимки — их можно снова скопировать, отредактировать или получить ссылку.
        </div>
      </div>
      <div className="flex items-center gap-2 text-[12px] text-muted">
        Нажмите <Kbd keys={keys} />
      </div>
    </div>
  );
}

function HistoryRow({
  item,
  busy,
  run,
}: {
  item: HistoryItem;
  busy?: string;
  run: (id: string, label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const copyLink = async () => {
    await run(item.id, 'link', () => api.historyCopyLink(item.id));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <li
      className="group relative flex items-center gap-3 rounded-[12px] p-1.5 pr-2 transition-colors hover:bg-white/4"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(true);
      }}
    >
      <button
        className="relative h-[54px] w-[86px] shrink-0 overflow-hidden rounded-[9px] bg-surface-3 ring-1 ring-white/8 transition-shadow hover:ring-2 hover:ring-accent/70"
        onClick={() => api.historyOpen(item.id)}
        data-tip="Открыть в редакторе"
        data-tip-pos="right"
      >
        <img
          src={shotUrl(`history/${item.id}/thumb.png?r=${item.revision}`)}
          alt=""
          draggable={false}
          className="h-full w-full object-cover object-top"
        />
        {item.edited && (
          <span className="absolute right-1 bottom-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white">
            <Pencil size={9} />
          </span>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-medium">{relativeTime(item.createdAt)}</span>
          <span className="shrink-0 text-[11.5px] text-subtle">{sizeLabel(item.width, item.height)}</span>
        </div>
        <div className="mt-1 h-[22px]">
          {busy === 'upload' ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
              <Spinner size={13} /> Загрузка…
            </span>
          ) : item.shortLink ? (
            <button
              onClick={copyLink}
              data-tip={item.linkOutdated ? 'Ссылка на версию до редактирования.\nНажмите, чтобы скопировать' : 'Скопировать ссылку'}
              className={clsx(
                'inline-flex max-w-full items-center gap-1.5 rounded-[7px] px-2 py-[3px] font-mono text-[11.5px] transition-colors',
                copied ? 'bg-success/15 text-success' : 'bg-accent-soft text-[#c3c3ff] hover:bg-accent/25',
              )}
            >
              {copied ? <Check size={12} /> : <Link2 size={12} className="shrink-0" />}
              <span className="truncate">{copied ? 'Скопировано' : item.shortLink}</span>
              {item.linkOutdated && !copied && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />}
            </button>
          ) : (
            <span className="text-[12px] text-subtle">{item.savedPath ? 'Сохранён в файл' : 'Только в истории'}</span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
        <IconButton tip="Копировать изображение" size={30} onClick={() => run(item.id, 'copy', () => api.historyCopy(item.id))}>
          {busy === 'copy' ? <Spinner size={14} /> : <Copy size={15} />}
        </IconButton>
        <IconButton
          tip={item.shareUrl && !item.linkOutdated ? 'Загрузить заново' : 'Загрузить в Box и скопировать ссылку'}
          tipPos="left"
          size={30}
          tone="accent"
          onClick={() => run(item.id, 'upload', () => api.historyUpload(item.id))}
        >
          <UploadCloud size={15} />
        </IconButton>
        <IconButton tip="Ещё" tipPos="left" size={30} onClick={() => setMenu((m) => !m)}>
          <MoreHorizontal size={15} />
        </IconButton>
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="animate-pop-in absolute top-[calc(100%-6px)] right-2 z-30 w-[210px] rounded-[12px] bg-elevated p-1 shadow-(--shadow-pop)"
        >
          <MenuItem icon={<Pencil size={15} />} onClick={() => api.historyOpen(item.id)}>
            Открыть в редакторе
          </MenuItem>
          <MenuItem icon={<Download size={15} />} onClick={() => run(item.id, 'save', () => api.historySave(item.id))}>
            Сохранить в папку
          </MenuItem>
          <MenuItem icon={<Download size={15} />} onClick={() => run(item.id, 'save', () => api.historySaveAs(item.id))}>
            Сохранить как…
          </MenuItem>
          {item.savedPath && (
            <MenuItem icon={<FolderOpen size={15} />} onClick={() => api.revealPath(item.savedPath!)}>
              Показать файл
            </MenuItem>
          )}
          {item.shareUrl && (
            <MenuItem icon={<Link2 size={15} />} onClick={() => api.openUrl(item.shareUrl!)}>
              Открыть ссылку
            </MenuItem>
          )}
          <div className="my-1 h-px bg-border" />
          <MenuItem icon={<Trash2 size={15} />} danger onClick={() => api.historyDelete(item.id)}>
            Удалить из истории
          </MenuItem>
        </div>
      )}
    </li>
  );

  function MenuItem({ icon, children, onClick, danger }: { icon: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
    return (
      <button
        onClick={() => {
          setMenu(false);
          onClick();
        }}
        className={clsx(
          'flex h-8 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[13px] transition-colors',
          danger ? 'text-danger hover:bg-danger/12' : 'text-text hover:bg-white/7',
        )}
      >
        <span className={danger ? '' : 'text-muted'}>{icon}</span>
        {children}
      </button>
    );
  }
}

