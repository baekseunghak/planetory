import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../api";
import { checkedAnalysisReturn } from "./analysis-return";

export function AnalysisReturnLink({
  ticId,
  to,
  children,
}: {
  ticId: string;
  to: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => pending.current?.abort(), []);
  if (!to.startsWith("/posts/")) return <Link to={to}>{children}</Link>;
  return (
    <span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          pending.current?.abort();
          const controller = new AbortController();
          pending.current = controller;
          setBusy(true);
          setError("");
          try {
            navigate(
              await checkedAnalysisReturn(api, ticId, to, controller.signal),
            );
          } catch (cause) {
            if (!controller.signal.aborted)
              setError(
                `원래 글로 돌아가지 못했습니다. ${(cause as Error).message}`,
              );
          } finally {
            if (!controller.signal.aborted) setBusy(false);
          }
        }}
      >
        {busy ? "원래 글 확인 중…" : children}
      </button>
      {error && (
        <span role="alert">
          {error} <Link to="/sky">별지도로</Link>
        </span>
      )}
    </span>
  );
}
