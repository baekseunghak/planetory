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
  const recoveryUsed = useRef(false);
  const changeObserved = useRef(false);
  const claimBundleRecovery = useCallback(() => {
    if (recoveryUsed.current) return false;
    recoveryUsed.current = true;
    return true;
  }, []);
  const retry = useCallback(() => {
    recoveryUsed.current = false;
    changeObserved.current = false;
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
  const recoverBundle = useCallback(() => {
    const canRecover = claimBundleRecovery();
    changeObserved.current = true;
    ++sequence.current;
    pending.current?.abort();
    if (!canRecover) {
      setState({
        ticId,
        data: null,
        loading: false,
        error: new Error(
          "데이터 판이 계속 바뀌어 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.",
        ),
        bundleChanged: true,
      });
      return false;
    }
    setState({
      ticId,
      data: null,
      loading: true,
      error: null,
      bundleChanged: true,
    });
    setVersion((value) => value + 1);
    return true;
  }, [ticId, claimBundleRecovery]);

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
      bundleChanged: changeObserved.current,
    });
    loadAnalysis(
      api,
      ticId,
      controller.signal,
      () => {
        if (!active()) return;
        changeObserved.current = true;
        setState((value) => ({ ...value, bundleChanged: true }));
      },
      previous.current?.ticId === ticId ? previous.current.bundleId : undefined,
      claimBundleRecovery,
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
          bundleChanged: changeObserved.current || data.bundleChanged,
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
  }, [ticId, version, claimBundleRecovery]);

  const current = state.ticId === ticId ? state : null;
  return {
    context: current?.data?.context ?? null,
    curve: current?.data?.curve ?? null,
    loading: current?.loading ?? true,
    error: current?.error ?? null,
    bundleChanged: current?.bundleChanged ?? false,
    retry,
    recoverBundle,
  };
}
