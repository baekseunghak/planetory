import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./index";

// Decode should be a stable function declared outside the component.
export function useResource<T>(
  path: string | null,
  decode: (value: unknown) => T,
) {
  const [value, setValue] = useState<{
    path: string | null;
    data: T | null;
    loading: boolean;
    error: Error | null;
  }>({ path, data: null, loading: !!path, error: null });
  const [version, setVersion] = useState(0);
  const seq = useRef(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    const id = ++seq.current;
    setValue({ path, data: null, error: null, loading: !!path });
    if (!path) return;
    const controller = new AbortController();
    api<unknown>(path, { signal: controller.signal })
      .then(decode)
      .then((data) => {
        if (id === seq.current && !controller.signal.aborted)
          setValue({ path, data, error: null, loading: false });
      })
      .catch((error) => {
        if (id === seq.current && !controller.signal.aborted)
          setValue({ path, data: null, error, loading: false });
      });
    return () => {
      ++seq.current;
      controller.abort();
    };
  }, [path, version, decode]);
  return {
    ...(value.path === path
      ? value
      : { data: null, error: null, loading: !!path }),
    reload,
  };
}
