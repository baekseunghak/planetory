import { useCallback, useEffect, useRef, useState } from "react";

// Private pages have no persistent cache. Returning from another page/tab
// requires fresh parent access checks before displaying any child content.
export function useReadModel<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
) {
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    error: Error | null;
    loading: boolean;
  }>({ key, data: null, error: null, loading: true });
  const [version, setVersion] = useState(0);
  const sequence = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const clear = useCallback(() => {
    ++sequence.current;
    pending.current?.abort();
    setState({ key, data: null, error: null, loading: true });
  }, [key]);
  const reload = useCallback(() => {
    clear();
    setVersion((v) => v + 1);
  }, [clear]);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden) clear();
      else reload();
    };
    const focus = () => {
      if (!document.hidden) reload();
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) reload();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    window.addEventListener("pagehide", clear);
    window.addEventListener("pageshow", restore);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("pageshow", restore);
    };
  }, [clear, reload]);
  useEffect(() => {
    clear();
    if (document.hidden) return;
    const id = ++sequence.current;
    const controller = new AbortController();
    pending.current = controller;
    load(controller.signal)
      .then((data) => {
        if (id === sequence.current && !controller.signal.aborted)
          setState({ key, data, error: null, loading: false });
      })
      .catch((error: Error) => {
        if (id === sequence.current && !controller.signal.aborted) {
          controller.abort();
          setState({ key, data: null, error, loading: false });
        }
      });
    return () => {
      ++sequence.current;
      controller.abort();
    };
  }, [key, load, version, clear]);
  return {
    ...(state.key === key ? state : { data: null, error: null, loading: true }),
    reload,
  };
}
