import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { loadAnalysis } from "./load-analysis";

type Snapshot = Awaited<ReturnType<typeof loadAnalysis>>;
type State = {
  ticId: string;
  data: Snapshot | null;
  loading: boolean;
  error: Error | null;
  bundleChanged: boolean;
};

export function useAnalysisData(ticId: string) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<State>({
    ticId,
    data: null,
    loading: true,
    error: null,
    bundleChanged: false,
  });
  const sequence = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const previous = useRef<{ ticId: string; bundleId: string } | null>(null);
  const retry = useCallback(() => {
    ++sequence.current;
    pending.current?.abort();
    setState({
      ticId,
      data: null,
      loading: true,
      error: null,
      bundleChanged: false,
    });
    setVersion((value) => value + 1);
  }, [ticId]);

  useEffect(() => {
    const id = ++sequence.current;
    const controller = new AbortController();
    pending.current = controller;
    const active = () => id === sequence.current && !controller.signal.aborted;
    setState({
      ticId,
      data: null,
      loading: true,
      error: null,
      bundleChanged: false,
    });
    loadAnalysis(
      api,
      ticId,
      controller.signal,
      () => {
        if (active()) setState((value) => ({ ...value, bundleChanged: true }));
      },
      previous.current?.ticId === ticId ? previous.current.bundleId : undefined,
    )
      .then((data) => {
        if (!active()) return;
        previous.current = {
          ticId,
          bundleId: data.context.curveContext.bundleId,
        };
        setState({
          ticId,
          data,
          loading: false,
          error: null,
          bundleChanged: data.bundleChanged,
        });
      })
      .catch((error: Error) => {
        if (active())
          setState((value) => ({
            ...value,
            data: null,
            loading: false,
            error,
          }));
      });
    return () => {
      ++sequence.current;
      controller.abort();
    };
  }, [ticId, version]);

  const current = state.ticId === ticId ? state : null;
  return {
    context: current?.data?.context ?? null,
    curve: current?.data?.curve ?? null,
    loading: current?.loading ?? true,
    error: current?.error ?? null,
    bundleChanged: current?.bundleChanged ?? false,
    retry,
  };
}
