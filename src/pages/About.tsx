// "About" window with the version.
import { Check, Copy, ExternalLink, FileText, FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Logo } from '../components/ui';
import { useKeyDown } from '../lib/hooks';
import { api } from '../lib/ipc';
import type { AppInfo } from '../lib/types';
import { getCurrentWindow } from '@tauri-apps/api/window';

export default function About() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api.appInfo().then(setInfo).catch(() => {});
  }, []);
  useKeyDown((e) => {
    if (e.key === 'Escape') getCurrentWindow().close();
  });

  const versionLine = info ? `AdvantShoter ${info.version} (${info.commit}, ${info.buildDate}) · Tauri ${info.tauriVersion} · ${info.os}` : '';

  return (
    <div className="flex h-full flex-col items-center bg-bg px-8 pt-10 pb-6 text-center">
      <div className="relative">
        <div className="brand-gradient absolute inset-2 rounded-[28px] opacity-60 blur-2xl" />
        <Logo size={96} className="relative" />
      </div>
      <h1 className="font-display mt-5 text-[24px] font-semibold tracking-tight">AdvantShoter</h1>
      <div className="mt-1 text-[13px] text-muted">Скриншоты с редактором и ссылками advant.one</div>

      <div className="mt-6 w-full rounded-[14px] bg-surface p-4 text-left ring-1 ring-inset ring-border">
        <Row label="Версия" value={<span className="text-gradient text-[15px] font-semibold">{info?.version ?? '…'}</span>} />
        <Row label="Сборка" value={info ? `${info.commit} · ${info.buildDate}` : '…'} />
        <Row label="Платформа" value={info ? `${info.os} · Tauri ${info.tauriVersion}` : '…'} />
      </div>

      <div className="mt-4 flex w-full gap-2">
        <Button
          className="flex-1"
          icon={copied ? <Check size={16} /> : <Copy size={16} />}
          onClick={async () => {
            await api.copyText(versionLine);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Скопировано' : 'Скопировать версию'}
        </Button>
        <Button className="flex-1" icon={<ExternalLink size={16} />} onClick={() => api.openUrl('https://advant.one')}>
          advant.one
        </Button>
      </div>
      <div className="mt-2 flex w-full gap-2">
        <Button variant="ghost" size="sm" className="flex-1" icon={<FileText size={14} />} onClick={() => api.openFolder('logs')}>
          Журнал
        </Button>
        <Button variant="ghost" size="sm" className="flex-1" icon={<FolderOpen size={14} />} onClick={() => api.openFolder('history')}>
          Временные снимки
        </Button>
      </div>

      <div className="mt-auto pt-6 text-[11px] leading-relaxed text-subtle">
        Используются: Tauri, React, Konva, иконки Lucide (ISC),
        <br />
        snow-ui-selector из Snow Shot (Apache-2.0).
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-[13px]">
      <span className="text-subtle">{label}</span>
      <span className="text-text">{value}</span>
    </div>
  );
}
