// Notification card shown in the bottom-right corner (link copied, upload progress, errors…).
import clsx from 'clsx';
import { Check, ChevronsDown, CircleAlert, CircleCheck, CloudUpload, ExternalLink, FolderOpen, Info, Pencil, Square, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton } from '../components/ui';
import { useTauriEvent } from '../lib/hooks';
import { api } from '../lib/ipc';
import type { ToastPayload } from '../lib/types';

export default function Toast() {
  const [toast, setToast] = useState<ToastPayload | null>(null);
  const [key, setKey] = useState(0);
  const [hover, setHover] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const show = (t: ToastPayload) => {
    setToast(t);
    setCopied(false);
    setKey((k) => k + 1);
  };
  useTauriEvent<ToastPayload>('toast:show', (e) => show(e.payload));

  // The window may have been shown before this page finished loading.
  useEffect(() => {
    api
      .toastCurrent()
      .then((t) => (t ? show(t) : api.toastHide()))
      .catch(() => {});
  }, []);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!toast || hover || !toast.timeoutMs) return;
    timer.current = window.setTimeout(() => {
      setToast(null);
      api.toastHide();
    }, toast.timeoutMs);
    return () => window.clearTimeout(timer.current);
  }, [toast, hover, key]);

  const close = () => {
    setToast(null);
    api.toastHide();
  };

  if (!toast) return null;
  const icon = {
    success: <CircleCheck size={22} className="text-success" />,
    error: <CircleAlert size={22} className="text-danger" />,
    info: <Info size={22} className="text-muted" />,
    progress: toast.stopScroll ? <ChevronsDown size={22} className="text-muted" /> : <CloudUpload size={22} className="text-muted" />,
  }[toast.kind];

  const copyLink = async () => {
    if (!toast.link) return;
    await api.copyText(toast.link);
    setCopied(true);
  };
  const id = toast.historyId;
  const retry = toast.retryUpload && !!id;
  const showEdit = !!id && !toast.link && !retry && toast.kind !== 'progress';

  return (
    <div className="flex h-full items-end p-2.5" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div key={key} className="card-pop animate-pop-in flex w-full items-start gap-3 py-3.5 pr-3.5 pl-4">
        <div className="shrink-0">{icon}</div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="text-[14px] leading-[22px] font-medium">{toast.title}</div>
          {toast.message && <div className="line-clamp-2 text-[13px] leading-[1.45] whitespace-pre-line text-muted">{toast.message}</div>}
          {toast.link && (
            <div className="flex gap-1.5">
              <button
                onClick={copyLink}
                data-tip={copied ? undefined : 'Скопировать ещё раз'}
                data-tip-pos="top"
                className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[8px] bg-surface-2 px-2.5 font-mono text-[12px] transition-colors hover:bg-surface-3"
              >
                {copied && <Check size={14} className="shrink-0 text-success" />}
                <span className="truncate">{copied ? 'Скопировано' : toast.link.replace(/^https?:\/\//, '')}</span>
              </button>
              <button
                data-tip="Открыть в браузере"
                data-tip-pos="top-left"
                aria-label="Открыть в браузере"
                onClick={() => api.openUrl(toast.link!)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-surface-2 transition-colors hover:bg-surface-3"
              >
                <ExternalLink size={16} />
              </button>
            </div>
          )}
          {toast.kind === 'progress' && (
            <div className="h-1 overflow-hidden rounded-full bg-surface-2">
              <div className="animate-indeterminate h-full w-2/5 rounded-full bg-text" />
            </div>
          )}
          {toast.stopScroll && (
            <div className="flex flex-wrap gap-2">
              <ToastButton primary icon={<Square size={12} fill="currentColor" />} onClick={() => api.scrollStop().catch(() => {})}>
                Остановить
              </ToastButton>
            </div>
          )}
          {(retry || toast.path || showEdit) && (
            <div className="flex flex-wrap gap-2">
              {retry && (
                <ToastButton
                  primary
                  onClick={() => {
                    close();
                    api.historyUpload(id!).catch(() => {});
                  }}
                >
                  Повторить
                </ToastButton>
              )}
              {retry && (
                <ToastButton
                  onClick={() => {
                    close();
                    api.historySave(id!).catch(() => {});
                  }}
                >
                  Сохранить в файл
                </ToastButton>
              )}
              {toast.path && (
                <ToastButton onClick={() => api.revealPath(toast.path!)} icon={<FolderOpen size={14} />}>
                  Показать в папке
                </ToastButton>
              )}
              {showEdit && (
                <ToastButton
                  onClick={() => {
                    api.historyOpen(id!);
                    close();
                  }}
                  icon={<Pencil size={14} />}
                >
                  Редактировать
                </ToastButton>
              )}
            </div>
          )}
        </div>
        <IconButton tip="Закрыть" tipPos="left" size={24} onClick={close} className="shrink-0">
          <X size={18} />
        </IconButton>
      </div>
    </div>
  );
}

function ToastButton({ children, icon, onClick, primary }: { children: ReactNode; icon?: ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'inline-flex h-[30px] items-center gap-1.5 rounded-full px-3.5 text-[13px] transition-[background,opacity]',
        primary ? 'bg-primary font-medium text-on-primary hover:opacity-90' : 'bg-surface-2 text-text hover:bg-surface-3',
      )}
    >
      {icon}
      {children}
    </button>
  );
}
