import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./client";
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<Error | null>(null),
    [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    setData(null);
    setError(null);
    if (!path) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    api<T>(path, { signal: controller.signal })
      .then((d) => {
        if (id === seq.current) setData(d);
      })
      .catch((e) => {
        if (e.name !== "AbortError" && id === seq.current) setError(e);
      })
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
    return () => controller.abort();
  }, [path, version]);
  return { data, loading, error, reload };
}
