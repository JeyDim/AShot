// Settings window.
import clsx from 'clsx';
import { ChevronRight, Cloud, FolderOpen, Keyboard, Link2, LogIn, LogOut, MousePointerClick, Save, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Input, Kbd, Logo, Segmented, Select, Spinner, Switch } from '../components/ui';
import { acceleratorFromEvent } from '../lib/format';
import { useTauriEvent } from '../lib/hooks';
import { api, errorText } from '../lib/ipc';
import type { AppSettings, BoxStatus, Hotkeys, SettingsView } from '../lib/types';

type Section = 'general' | 'hotkeys' | 'saving' | 'box' | 'links';

const SECTIONS: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'general', label: 'Основные', icon: <SlidersHorizontal size={17} /> },
  { id: 'hotkeys', label: 'Горячие клавиши', icon: <Keyboard size={17} /> },
  { id: 'saving', label: 'Сохранение', icon: <Save size={17} /> },
  { id: 'box', label: 'Box.com', icon: <Cloud size={17} /> },
  { id: 'links', label: 'Ссылки', icon: <Link2 size={17} /> },
];

export default function Settings({ initial }: { initial?: string }) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [section, setSection] = useState<Section>(() => (SECTIONS.some((s) => s.id === initial) ? (initial as Section) : 'general'));
  useTauriEvent<string>('settings:section', (e) => {
    if (SECTIONS.some((s) => s.id === e.payload)) setSection(e.payload as Section);
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    api.settingsGet().then((v) => {
      setView(v);
      setDraft(v.settings);
    });
  }, []);

  const dirty = useMemo(() => !!view && !!draft && JSON.stringify(view.settings) !== JSON.stringify(draft), [view, draft]);

  if (!draft || !view) return <div className="h-full bg-bg" />;

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => setDraft({ ...draft, [key]: value });

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const problems = await api.settingsSet(draft);
      const fresh = await api.settingsGet();
      setView(fresh);
      setDraft(fresh.settings);
      setMessage(problems.length ? { kind: 'error', text: problems.join('\n') } : { kind: 'ok', text: 'Настройки сохранены' });
    } catch (e) {
      setMessage({ kind: 'error', text: errorText(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full bg-bg">
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-border bg-surface px-3 py-4">
        <div className="mb-4 flex items-center gap-2.5 px-2">
          <Logo size={26} />
          <span className="font-display text-[15px] font-semibold">Настройки</span>
        </div>
        <nav className="flex flex-col gap-0.5">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={clsx(
                'flex h-9 items-center gap-2.5 rounded-[10px] px-3 text-[13.5px] transition-colors',
                section === s.id ? 'bg-accent-soft text-text ring-1 ring-inset ring-accent/30' : 'text-muted hover:bg-white/5 hover:text-text',
              )}
            >
              <span className={section === s.id ? 'text-[#a9a9ff]' : ''}>{s.icon}</span>
              {s.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
          <div className="mx-auto max-w-[620px]">
            {section === 'general' && <General draft={draft} set={set} />}
            {section === 'hotkeys' && <HotkeysSection value={draft.hotkeys} onChange={(h) => set('hotkeys', h)} />}
            {section === 'saving' && <Saving draft={draft} set={set} view={view} />}
            {section === 'box' && <BoxSection draft={draft} set={set} />}
            {section === 'links' && <Links draft={draft} set={set} />}
          </div>
        </div>
        <footer className="flex items-center gap-3 border-t border-border bg-surface px-6 py-3">
          <div className={clsx('min-w-0 flex-1 text-[12.5px] whitespace-pre-line', message?.kind === 'error' ? 'text-danger' : 'text-success')}>{message?.text}</div>
          <Button variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(view.settings)}>
            Отменить
          </Button>
          <Button variant="primary" disabled={!dirty} loading={saving} onClick={save}>
            Сохранить
          </Button>
        </footer>
      </main>
    </div>
  );
}

type SetFn = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;

function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-5">
      <h2 className="font-display text-[20px] font-semibold tracking-tight">{children}</h2>
      {sub && <p className="mt-1 text-[13px] text-muted">{sub}</p>}
    </div>
  );
}

function Card({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <section className="mb-4">
      {title && <div className="mb-2 px-1 text-[12px] font-semibold tracking-wide text-subtle uppercase">{title}</div>}
      <div className="divide-y divide-border rounded-[14px] bg-surface ring-1 ring-inset ring-border">{children}</div>
    </section>
  );
}

function Row({ label, hint, children, stack }: { label: ReactNode; hint?: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <div className={clsx('flex gap-4 px-4 py-3.5', stack ? 'flex-col' : 'items-center')}>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px]">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-snug text-subtle">{hint}</div>}
      </div>
      <div className={stack ? '' : 'shrink-0'}>{children}</div>
    </div>
  );
}

function General({ draft, set }: { draft: AppSettings; set: SetFn }) {
  return (
    <>
      <Title sub="Поведение при снимке и запуск программы">Основные</Title>
      <Card title="Снимок">
        <Row label="Показывать курсор" hint="Рисовать указатель мыши на снимке">
          <Switch checked={draft.showCursor} onChange={(v) => set('showCursor', v)} />
        </Row>
        <Row label="Лупа при выделении" hint="Увеличение, координаты и цвет пикселя под курсором">
          <Switch checked={draft.showMagnifier} onChange={(v) => set('showMagnifier', v)} />
        </Row>
        <Row label="После выделения" hint="Панель действий позволяет выбрать: редактор, копирование, сохранение или ссылка">
          <Select value={draft.afterCapture} onChange={(e) => set('afterCapture', e.target.value as AppSettings['afterCapture'])} className="w-[230px]">
            <option value="ask">Показать панель действий</option>
            <option value="openEditor">Открыть редактор</option>
            <option value="copy">Скопировать в буфер</option>
            <option value="save">Сохранить в папку</option>
            <option value="upload">Загрузить и скопировать ссылку</option>
          </Select>
        </Row>
        <Row label="«Весь экран» снимает">
          <Segmented
            value={draft.fullscreenMode}
            onChange={(v) => set('fullscreenMode', v)}
            options={[
              { value: 'currentMonitor', label: 'Монитор с курсором' },
              { value: 'allMonitors', label: 'Все мониторы' },
            ]}
          />
        </Row>
      </Card>
      <Card title="История">
        <Row label="Хранить последних снимков" hint="Временное хранилище: снимки можно снова открыть из трея">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={50}
              value={draft.historyLimit}
              onChange={(e) => set('historyLimit', Number(e.target.value))}
              className="w-[160px] accent-[#6b6bff]"
            />
            <span className="w-7 text-right text-[13.5px] tabular-nums">{draft.historyLimit}</span>
          </div>
        </Row>
      </Card>
      <Card title="Система">
        <Row label="Запускать вместе с Windows">
          <Switch checked={draft.autostart} onChange={(v) => set('autostart', v)} />
        </Row>
      </Card>
    </>
  );
}

function HotkeysSection({ value, onChange }: { value: Hotkeys; onChange: (h: Hotkeys) => void }) {
  const rows: { key: keyof Hotkeys; label: string; hint: string }[] = [
    { key: 'region', label: 'Снимок области', hint: 'Выделение мышью, клик — окно или элемент' },
    { key: 'window', label: 'Снимок активного окна', hint: 'Окно в фокусе сразу выделено, его можно подправить' },
    { key: 'fullscreen', label: 'Весь экран', hint: 'Монитор под курсором или все мониторы' },
    { key: 'lastRegion', label: 'Повторить последнюю область', hint: 'Та же область, что и в прошлый раз' },
  ];
  return (
    <>
      <Title sub="Нажмите на поле и затем нужное сочетание. Backspace — очистить.">Горячие клавиши</Title>
      <Card>
        {rows.map((r) => (
          <Row key={r.key} label={r.label} hint={r.hint}>
            <HotkeyInput value={value[r.key]} onChange={(v) => onChange({ ...value, [r.key]: v })} />
          </Row>
        ))}
      </Card>
      <p className="px-1 text-[12px] leading-relaxed text-subtle">
        В Windows 11 клавишу PrtSc по умолчанию занимает «Ножницы». Отключите: Параметры → Специальные возможности → Клавиатура → «Использовать кнопку PrtSc для
        открытия функции захвата экрана».
      </p>
      <div className="mt-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ region: 'PrintScreen', window: 'Alt+PrintScreen', fullscreen: 'Control+PrintScreen', lastRegion: 'Shift+PrintScreen' })}
        >
          Вернуть по умолчанию
        </Button>
      </div>
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
        'flex h-9 min-w-[190px] items-center justify-center gap-1 rounded-[10px] px-3 text-[13px] ring-1 ring-inset transition-shadow',
        recording ? 'bg-accent-soft ring-2 ring-accent' : 'bg-surface-2 ring-border hover:ring-border-strong',
      )}
    >
      {recording ? <span className="text-[#c3c3ff]">Нажмите сочетание…</span> : value ? <Kbd keys={value} /> : <span className="text-subtle">Не назначено</span>}
    </button>
  );
}

function Saving({ draft, set, view }: { draft: AppSettings; set: SetFn; view: SettingsView }) {
  const preview = useMemo(() => {
    const d = new Date();
    const p = (n: number, l = 2) => String(n).padStart(l, '0');
    return (
      (draft.fileNamePattern || 'Screenshot')
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
        .replaceAll('{rand}', 'k3x9qa') + (draft.imageFormat === 'png' ? '.png' : '.jpg')
    );
  }, [draft.fileNamePattern, draft.imageFormat]);

  return (
    <>
      <Title sub="Куда и как сохраняются файлы по кнопке «Сохранить»">Сохранение</Title>
      <Card>
        <Row label="Папка" hint={draft.saveFolder ? undefined : `По умолчанию: ${view.defaultSaveFolder}`} stack>
          <div className="flex gap-2">
            <Input value={draft.saveFolder} placeholder={view.defaultSaveFolder} onChange={(e) => set('saveFolder', e.target.value)} />
            <Button icon={<FolderOpen size={16} />} onClick={() => api.openFolder('save')}>
              Открыть
            </Button>
          </div>
        </Row>
        <Row label="Имя файла" hint={<>Пример: <span className="text-muted">{preview}</span></>} stack>
          <Input value={draft.fileNamePattern} onChange={(e) => set('fileNamePattern', e.target.value)} />
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11.5px] text-subtle">
            {['{yyyy}', '{MM}', '{dd}', '{HH}', '{mm}', '{ss}', '{w}', '{h}', '{rand}'].map((t) => (
              <button key={t} className="kbd hover:text-text" onClick={() => set('fileNamePattern', draft.fileNamePattern + t)}>
                {t}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Формат" hint="Используется и для загрузки в Box">
          <Segmented
            value={draft.imageFormat}
            onChange={(v) => set('imageFormat', v)}
            options={[
              { value: 'png', label: 'PNG' },
              { value: 'jpeg', label: 'JPEG' },
            ]}
          />
        </Row>
        {draft.imageFormat === 'jpeg' && (
          <Row label="Качество JPEG">
            <div className="flex items-center gap-3">
              <input type="range" min={40} max={100} value={draft.jpegQuality} onChange={(e) => set('jpegQuality', Number(e.target.value))} className="w-[160px] accent-[#6b6bff]" />
              <span className="w-8 text-right tabular-nums">{draft.jpegQuality}</span>
            </div>
          </Row>
        )}
      </Card>
      <p className="px-1 text-[12px] text-subtle">Временные снимки (история): {view.historyFolder}</p>
    </>
  );
}

function BoxSection({ draft, set }: { draft: AppSettings; set: SetFn }) {
  const [status, setStatus] = useState<BoxStatus | null>(null);
  const [secret, setSecret] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const box = draft.box;
  const setBox = (patch: Partial<AppSettings['box']>) => set('box', { ...box, ...patch });

  const refresh = () => api.boxStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);
  useTauriEvent('box:changed', () => refresh());
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

  // Persist the Box part of the settings before talking to Box.
  const persist = async () => {
    const current = await api.settingsGet();
    await api.settingsSet({ ...current.settings, box });
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
      <Title sub="Снимки загружаются в ваш Box, ссылка advant.one сразу копируется">Box.com</Title>

      {/* Account */}
      <section className="mb-4 rounded-[16px] bg-surface p-5 ring-1 ring-inset ring-border">
        {oauth && status?.signedIn ? (
          <div className="flex items-center gap-4">
            <div className="brand-gradient flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[18px] font-semibold text-white">
              {(account?.name || account?.login || 'B').slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[15px] font-semibold">{account?.name || 'Аккаунт Box'}</span>
                <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">подключено</span>
              </div>
              <div className="truncate text-[12.5px] text-muted">{account?.login}</div>
            </div>
            <Button icon={<LogOut size={16} />} onClick={() => run('logout', () => api.boxLogout())}>
              Выйти
            </Button>
          </div>
        ) : oauth ? (
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-[#b4b4ff]">
              <Cloud size={28} />
            </div>
            <div>
              <div className="text-[15px] font-semibold">Войдите в Box, чтобы получать ссылки</div>
              <div className="mt-1 text-[12.5px] leading-relaxed text-muted">
                Откроется сайт Box — войдите и нажмите «Предоставить доступ». Ключи и ID вводить не нужно.
              </div>
            </div>
            {busy === 'login' ? (
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-2 text-[13px] text-muted">
                  <Spinner size={16} /> Ждём вход в браузере…
                </span>
                <Button size="sm" variant="ghost" onClick={() => api.boxLogout()}>
                  Отмена
                </Button>
              </div>
            ) : (
              <Button variant="primary" size="lg" icon={<LogIn size={18} />} disabled={!!noApp} onClick={login}>
                Войти через Box
              </Button>
            )}
            {noApp && (
              <p className="text-[12px] text-warning">
                Эта сборка без встроенного приложения Box — укажите своё в «Дополнительно» ниже.
              </p>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3 text-[13px]">
            <ShieldCheck size={18} className={status?.ready ? 'text-success' : 'text-subtle'} />
            <span className="flex-1">{box.authMode === 'clientCredentials' ? 'Сервисный аккаунт' : 'Developer token'}</span>
            <Button size="sm" icon={<ShieldCheck size={15} />} loading={busy === 'test'} onClick={test}>
              Проверить
            </Button>
          </div>
        )}
        {msg && <p className={clsx('mt-3 text-center text-[12.5px] whitespace-pre-line', msg.kind === 'error' ? 'text-danger' : 'text-success')}>{msg.text}</p>}
      </section>

      <Card title="Куда загружать">
        <Row label="Папка в Box" hint={box.folderId ? `Используется папка с ID ${box.folderId} (см. «Дополнительно»)` : 'Создаётся автоматически в «Все файлы»'}>
          <Input className="w-[230px]" value={box.folderName} disabled={!!box.folderId} onChange={(e) => setBox({ folderName: e.target.value })} />
        </Row>
        <Row label="Доступ по ссылке" hint="«Все, у кого есть ссылка» — откроется на телефоне без входа в Box">
          <Select value={box.sharedLinkAccess} onChange={(e) => setBox({ sharedLinkAccess: e.target.value as AppSettings['box']['sharedLinkAccess'] })} className="w-[230px]">
            <option value="open">Все, у кого есть ссылка</option>
            <option value="company">Только сотрудники компании</option>
            <option value="collaborators">Только участники папки</option>
          </Select>
        </Row>
      </Card>

      <section className="mb-4">
        <button
          onClick={() => setAdvanced((a) => !a)}
          className="mb-2 flex items-center gap-1.5 px-1 text-[12px] font-semibold tracking-wide text-subtle uppercase hover:text-muted"
        >
          <ChevronRight size={14} className={clsx('transition-transform', advanced && 'rotate-90')} />
          Дополнительно
        </button>
        {advanced && (
          <div className="divide-y divide-border rounded-[14px] bg-surface ring-1 ring-inset ring-border">
            <div className="p-3">
              <Segmented
                value={box.authMode}
                onChange={(v) => setBox({ authMode: v })}
                options={[
                  { value: 'oAuth', label: 'Вход через Box' },
                  { value: 'clientCredentials', label: 'Сервисный аккаунт' },
                  { value: 'developerToken', label: 'Developer token' },
                ]}
              />
            </div>
            {box.authMode !== 'developerToken' && (
              <>
                <Row
                  label={oauth ? 'Своё приложение Box (необязательно)' : 'Client ID'}
                  hint={
                    oauth
                      ? 'Только если не подходит встроенное. Тип: User Authentication (OAuth 2.0)'
                      : 'Приложение «Server Authentication (Client Credentials Grant)», одобренное администратором'
                  }
                  stack
                >
                  <div className="grid grid-cols-2 gap-2">
                    <Input value={box.clientId} onChange={(e) => setBox({ clientId: e.target.value.trim() })} placeholder="Client ID" />
                    <Input
                      type="password"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      placeholder={status?.hasClientSecret ? 'Client Secret (сохранён)' : 'Client Secret'}
                    />
                  </div>
                </Row>
              </>
            )}
            {box.authMode === 'clientCredentials' && (
              <div className="grid grid-cols-2 divide-x divide-border">
                <Row label="Enterprise ID" stack>
                  <Input value={box.enterpriseId} onChange={(e) => setBox({ enterpriseId: e.target.value.trim() })} />
                </Row>
                <Row label="User ID (необязательно)" stack>
                  <Input value={box.userId} onChange={(e) => setBox({ userId: e.target.value.trim() })} />
                </Row>
              </div>
            )}
            {box.authMode === 'developerToken' && (
              <Row label="Developer token" hint="Временный токен из консоли разработчика Box (60 минут) — для проверки" stack>
                <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={status?.hasDeveloperToken ? '•••••••• (сохранён)' : ''} />
              </Row>
            )}
            <Row label="ID папки" hint="Вместо имени папки: число из адреса app.box.com/folder/123456 (0 — корень)">
              <Input className="w-[160px]" value={box.folderId} placeholder="авто" onChange={(e) => setBox({ folderId: e.target.value.trim() })} />
            </Row>
            {oauth && (
              <Row
                label="Redirect URI (необязательно)"
                hint="Пусто — подбирается при входе автоматически. Если Box пишет redirect_uri_mismatch — впишите адрес из настроек приложения Box (Configuration → OAuth 2.0 Redirect URI)"
                stack
              >
                <Input
                  className="font-mono"
                  value={box.redirectUri}
                  placeholder={status?.redirectUri ? `авто (сейчас ${status.redirectUri})` : 'авто'}
                  onChange={(e) => setBox({ redirectUri: e.target.value.trim() })}
                />
              </Row>
            )}
            <div className="flex justify-end p-3">
              <Button size="sm" icon={<ShieldCheck size={15} />} loading={busy === 'test'} onClick={test}>
                Сохранить и проверить
              </Button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function Links({ draft, set }: { draft: AppSettings; set: SetFn }) {
  const [preview, setPreview] = useState('');
  const links = draft.links;
  const setLinks = (patch: Partial<AppSettings['links']>) => set('links', { ...links, ...patch });
  useEffect(() => {
    api.linkPreview(links.template).then(setPreview).catch(() => setPreview(''));
  }, [links.template]);
  return (
    <>
      <Title sub="Ссылка Box заменяется на ваш домен-прокси">Ссылки</Title>
      <Card>
        <Row label="Заменять ссылку Box на свой домен">
          <Switch checked={links.rewrite} onChange={(v) => setLinks({ rewrite: v })} />
        </Row>
        <Row label="Шаблон ссылки" hint={<>Подстановки: <span className="font-mono">{'{id}'}</span> — код ссылки Box, <span className="font-mono">{'{ext}'}</span> — расширение файла, <span className="font-mono">{'{name}'}</span> — имя файла</>} stack>
          <Input value={links.template} onChange={(e) => setLinks({ template: e.target.value })} className="font-mono" disabled={!links.rewrite} />
        </Row>
        <div className={clsx('px-4 py-3.5', !links.rewrite && 'opacity-50')}>
          <div className="mb-2 text-[12px] text-subtle">Пример</div>
          <div className="space-y-1.5 font-mono text-[12px]">
            <div className="flex items-center gap-2 text-subtle">
              <span className="w-12 shrink-0 font-sans">Было</span>
              <span className="truncate line-through decoration-white/20">https://app.box.com/s/3rud4dfakga5r953wt77anhyzo27tm7r</span>
            </div>
            <div className="flex items-center gap-2 text-[#c3c3ff]">
              <span className="w-12 shrink-0 font-sans text-subtle">Стало</span>
              <span className="truncate">{links.rewrite ? preview : 'https://app.box.com/s/3rud4dfakga5r953wt77anhyzo27tm7r'}</span>
            </div>
          </div>
        </div>
      </Card>
      <Card title="После загрузки">
        <Row label="Копировать ссылку в буфер обмена">
          <Switch checked={links.copyAfterUpload} onChange={(v) => setLinks({ copyAfterUpload: v })} />
        </Row>
        <Row label="Открывать ссылку в браузере">
          <Switch checked={links.openAfterUpload} onChange={(v) => setLinks({ openAfterUpload: v })} />
        </Row>
      </Card>
      <p className="flex items-start gap-2 px-1 text-[12px] leading-relaxed text-subtle">
        <MousePointerClick size={14} className="mt-0.5 shrink-0" />
        Чтобы ссылка открывалась на телефоне сразу как картинка, домен-прокси должен отдавать файл по коду ссылки. Пример прокси на Cloudflare Workers — в папке
        proxy/ репозитория.
      </p>
    </>
  );
}
