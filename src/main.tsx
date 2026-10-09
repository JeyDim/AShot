import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { api } from './lib/ipc';
import { initTheme } from './lib/theme';

// Every window loads index.html with its own route in the hash: #/panel, #/overlay,
// #/editor/<id>, #/settings[/<section>], #/toast.
const TrayPanel = lazy(() => import('./pages/TrayPanel'));
const Overlay = lazy(() => import('./pages/Overlay'));
const Editor = lazy(() => import('./pages/editor/Editor'));
const Settings = lazy(() => import('./pages/Settings'));
const Toast = lazy(() => import('./pages/Toast'));

function route() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [page, ...rest] = hash.split('/');
  return { page, param: decodeURIComponent(rest.join('/')) };
}

function App() {
  const { page, param } = route();
  switch (page) {
    case 'panel':
      return <TrayPanel />;
    case 'overlay':
      return <Overlay />;
    case 'editor':
      return <Editor id={param} />;
    case 'settings':
      return <Settings initial={param} />;
    case 'about':
      return <Settings initial="about" />;
    case 'toast':
      return <Toast />;
    default:
      return <TrayPanel />;
  }
}

async function start() {
  // Browser preview without Tauri (UI development / screenshots): `?mock`
  if (new URLSearchParams(window.location.search).has('mock')) {
    const { installMocks } = await import('./mock/mock');
    await installMocks();
  }
  const { page } = route();
  // Every window follows the theme setting, the capture overlay's toolbars too.
  initTheme();
  if (page === 'panel' || page === 'toast') document.body.classList.add('transparent');
  if (page === 'overlay') document.body.style.background = '#000';
  // UI scale (the window's zoom) before the first render, so nothing jumps; never wait long.
  await Promise.race([api.uiZoom().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Suspense fallback={null}>
        <App />
      </Suspense>
    </StrictMode>,
  );
}

start();
