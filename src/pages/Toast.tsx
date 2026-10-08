// Notification card shown in the bottom-right corner (link copied, saved, errors…).
import clsx from 'clsx';
import { AlertTriangle, Check, CheckCircle2, Copy, ExternalLink, FolderOpen, Info, Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconButton, Spinner } from '../components/ui';
import { useTauriEvent } from '../lib/hooks';
import { api } from '../lib/ipc';
import type { ToastPayload } from '../lib/types';

export default function Toast() {
  const [toast, setToast] = useState<ToastPayload | null>(null);
  const [key, setKey] = useState(0);
  const [hover, setHover] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useTauriEvent<ToastPayload>('toast:show', (e) => {
    setToast(e.payload);
    setCopied(false);
    setKey((k) => k + 1);
  });

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
    success: <CheckCircle2 size={20} className="text-success" />,
    error: <AlertTriangle size={20} className="text-danger" />,
    info: <Info size={20} className="text-[#9b9bff]" />,
    progress: <Spinner size={20} className="text-[#9b9bff]" />,
  }[toast.kind];

  const copyLink = async () => {
    if (!toast.link) return;
    await api.copyText(toast.link);
    setCopied(true);
  };

  return (
    <div className="flex h-full items-end p-2.5" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div key={key} className="card-pop animate-pop-in relative w-full overflow-hidden">
        <div className="flex gap-3 px-4 pt-3.5 pb-3">
          <div className="pt-0.5">{icon}</div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">{toast.title}</div>
            {toast.message && <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug whitespace-pre-line text-muted">{toast.message}</div>}
            {toast.link && (
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  onClick={copyLink}
                  className={clsx(
                    'inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 font-mono text-[12px] transition-colors',
                    copied ? 'bg-success/15 text-success' : 'bg-accent-soft text-[#c9c9ff] hover:bg-accent/25',
                  )}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} className="shrink-0" />}
                  <span className="truncate">{toast.link.replace(/^https?:\/\//, '')}</span>
                </button>
                <IconButton tip="Открыть в браузере" tipPos="top-left" size={30} onClick={() => api.openUrl(toast.link!)}>
                  <ExternalLink size={15} />
                </IconButton>
              </div>
            )}
            {(toast.path || (toast.historyId && !toast.link && toast.kind !== 'progress')) && (
              <div className="mt-2 flex gap-1.5">
                {toast.path && (
                  <ToastButton onClick={() => api.revealPath(toast.path!)} icon={<FolderOpen size={13} />}>
                    Показать в папке
                  </ToastButton>
                )}
                {toast.historyId && (
                  <ToastButton
                    onClick={() => {
                      api.historyOpen(toast.historyId!);
                      close();
                    }}
                    icon={<Pencil size={13} />}
                  >
                    Редактировать
                  </ToastButton>
                )}
              </div>
            )}
          </div>
          <IconButton tip="Закрыть" tipPos="left" size={26} onClick={close} className="-mt-1 -mr-1.5">
            <X size={14} />
          </IconButton>
        </div>
        {toast.timeoutMs > 0 && !hover && (
          <div className="absolute right-0 bottom-0 left-0 h-[2px] bg-white/5">
            <div key={key} className="brand-gradient h-full origin-left" style={{ animation: `shrink ${toast.timeoutMs}ms linear forwards` }} />
          </div>
        )}
      </div>
      <style>{`@keyframes shrink { from { transform: scaleX(1) } to { transform: scaleX(0) } }`}</style>
    </div>
  );
}

function ToastButton({ children, icon, onClick }: { children: React.ReactNode; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-surface-3 px-2.5 text-[12px] text-text transition-colors hover:bg-border-strong">
      {icon}
      {children}
    </button>
  );
}
