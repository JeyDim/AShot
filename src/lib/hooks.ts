import { listen, type EventCallback } from '@tauri-apps/api/event';
import { useEffect, useRef } from 'react';

/** Subscribes to a Tauri event for the lifetime of the component. */
export function useTauriEvent<T>(event: string, handler: EventCallback<T>) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<T>(event, (e) => ref.current(e))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [event]);
}

/** Global keydown handler. */
export function useKeyDown(handler: (e: KeyboardEvent) => void, deps: unknown[] = []) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const fn = (e: KeyboardEvent) => ref.current(e);
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
