import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../../api";
import { useSession } from "../../auth/SessionProvider";
import { ErrorState, LoadingState } from "../../components/RequestState";
import { useReadModel } from "../community/useReadModel";
import { usePostWrite, decodeWritten } from "../community/usePostWrite";
import { readWithdrawalPolicy, readWithdrawalStatus } from "./withdrawal";
import "./settings.css";
export function WithdrawalPage() {
  const navigate = useNavigate(),
    session = useSession();
  const load = useCallback(
    async (signal: AbortSignal) =>
      readWithdrawalPolicy(await api("/v1/me/withdrawal-policy", { signal })),
    [],
  );
  const state = useReadModel("withdrawal-policy", load),
    write = usePostWrite();
  const [accepted, setAccepted] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [requestId, setRequestId] = useState<string | null>(null);
  const policy = state.data;
  // POLICY_CHANGED는 실행 전 거절이다. 응답 유실/5xx와 달리 새 정책에
  // 다시 동의할 수 있지만, 재조회 버튼 자체가 새 POST를 보내지는 않는다.
  const policyRejected =
    write.error instanceof ApiError &&
    write.error.status === 409 &&
    write.error.code === "POLICY_CHANGED" &&
    !write.uncertain;
  function showReceipt(id: string, completed: boolean) {
    // 보호 화면에서 먼저 clear하면 라우트 전환보다 로그인 게이트가 앞설 수 있다.
    // 확인된 완료는 같은 회원·요청의 로컬 정리 신호만 넘기고 결과 화면에서 정리한다.
    navigate("/withdrawal/status/" + encodeURIComponent(id), {
      replace: true,
      state: completed
        ? {
            completedWithdrawal: {
              requestId: id,
              memberId: session.member?.memberId,
            },
          }
        : null,
    });
  }
  async function submit() {
    if (
      !policy?.available ||
      accepted !== policy.version ||
      confirmation !== "탈퇴" ||
      requestId
    )
      return;
    const prepared = await write.run(async (signal) =>
      decodeWritten(
        await api("/v1/me/withdrawal-requests", {
          method: "POST",
          json: { policyVersion: policy.version },
          signal,
        }),
        readWithdrawalStatus,
      ),
    );
    if (!prepared) return;
    const id = prepared.value.requestId;
    setRequestId(id);
    // 중복 준비 조회가 기존 요청의 현재 상태를 돌려주면 재확정하지 않는다.
    // 알 수 없는 상태/다른 형식은 위 파서에서 거절하고 영수증을 추측하지 않는다.
    if (prepared.value.status !== "READY") {
      showReceipt(id, prepared.value.status === "COMPLETED");
      return;
    }
    const result = await write.run(async (signal) =>
      decodeWritten(
        await api(
          "/v1/me/withdrawal-requests/" + encodeURIComponent(id) + "/confirm",
          {
            method: "POST",
            json: { policyVersion: policy.version, confirmation: "탈퇴" },
            signal,
          },
        ),
        (value) => readWithdrawalStatus(value, id),
      ),
    );
    if (result?.value.status === "COMPLETED") {
      showReceipt(id, true);
    }
  }
  return (
    <section className="explorer-settings">
      <Link to="/settings">← 설정으로</Link>
      <h1>계정 탈퇴</h1>
      {!policy ? (
        state.error ? (
          <ErrorState error={state.error} retry={state.reload} />
        ) : (
          <LoadingState />
        )
      ) : !policy.available ? (
        <p role="status">{policy.reason}</p>
      ) : (
        <>
          <p>아래의 데이터 처리 안내를 확인한 뒤 결정해 주세요.</p>
          {(
            [
              ["탈퇴 후 이용", policy.effects],
              ["기록 보관·처리", policy.retention],
              ["재가입", policy.rejoining],
            ] as const
          ).map(([title, items]) => (
            <section className="settings-row" key={title}>
              <h2>{title}</h2>
              <ul>
                {items.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </section>
          ))}
          <p>안내 버전: {policy.version}</p>
          <label>
            <input
              type="checkbox"
              checked={accepted === policy.version}
              disabled={write.pending || !!requestId}
              onChange={(e) =>
                setAccepted(e.target.checked ? policy.version : "")
              }
            />{" "}
            데이터 처리와 재가입 안내를 확인했습니다.
          </label>
          <p>
            <label>
              확인을 위해 ‘탈퇴’를 입력해 주세요
              <input
                value={confirmation}
                disabled={write.pending || !!requestId}
                onChange={(e) => setConfirmation(e.target.value)}
              />
            </label>
          </p>
          <button
            disabled={
              write.pending ||
              write.uncertain ||
              !!requestId ||
              accepted !== policy.version ||
              confirmation !== "탈퇴"
            }
            onClick={() => void submit()}
          >
            {write.pending ? "처리 확인 중…" : "탈퇴 신청"}
          </button>
        </>
      )}
      {write.error && (
        <p role="alert">
          {write.uncertain
            ? "처리 결과를 확인하지 못했습니다. 같은 신청을 반복하지 마세요."
            : write.error.message}
        </p>
      )}
      {requestId && (
        <p>
          <Link to={"/withdrawal/status/" + encodeURIComponent(requestId)}>
            탈퇴 처리 상태 확인
          </Link>
        </p>
      )}
      {write.error && (!requestId || policyRejected) && (
        <button
          disabled={write.pending}
          onClick={() => {
            setAccepted("");
            setConfirmation("");
            setRequestId(null);
            write.clearError();
            state.reload();
          }}
        >
          정책 다시 확인
        </button>
      )}
    </section>
  );
}
export function WithdrawalStatusPage() {
  const { requestId = "" } = useParams();
  const location = useLocation();
  const load = useCallback(
    async (signal: AbortSignal) =>
      readWithdrawalStatus(
        await api("/v1/withdrawal-requests/" + encodeURIComponent(requestId), {
          signal,
          sessionBound: false,
        }),
        requestId,
      ),
    [requestId],
  );
  const state = useReadModel("withdrawal:" + requestId, load),
    session = useSession();
  const completion = location.state?.completedWithdrawal;
  const completedByConfirmation =
    completion?.requestId === requestId &&
    !!session.member &&
    completion?.memberId === session.member.memberId;
  useEffect(() => {
    if (
      (completedByConfirmation || state.data?.status === "COMPLETED") &&
      session.status === "authenticated"
    )
      session.clear(null);
  }, [
    completedByConfirmation,
    state.data?.status,
    session.status,
    session.clear,
  ]);
  // 화면의 완료 표시와 영수증 권한은 계속 GET 응답에만 의존한다.
  // 로컬 정리 신호는 서버 권한/성공 표시를 대신하지 않으며, GET 실패에도 초안을 정리한다.
  // This page uses a server-issued HttpOnly receipt cookie, never a public ID alone.
  const labels = {
    READY: "아직 탈퇴가 확정되지 않았습니다",
    PROCESSING: "탈퇴 처리 결과를 확인하고 있습니다",
    COMPLETED: "탈퇴가 완료되었습니다",
    FAILED: "탈퇴가 완료되지 않았습니다",
  };
  return (
    <main className="page auth-message">
      <span className="brand">PLANETORY</span>
      <h1>{state.data ? labels[state.data.status] : "탈퇴 처리 확인"}</h1>
      {!state.data ? (
        state.error ? (
          <ErrorState error={state.error} retry={state.reload} />
        ) : (
          <LoadingState />
        )
      ) : (
        <p>{state.data.message}</p>
      )}
      <button
        onClick={() => {
          if (state.data?.status === "COMPLETED") session.clear(null);
          state.reload();
        }}
      >
        처리 상태 다시 확인
      </button>
      <p>
        <Link
          onClick={() => {
            if (state.data?.status === "COMPLETED") session.clear(null);
          }}
          to="/login"
        >
          로그인 화면으로
        </Link>
      </p>
      <p>결과가 확인되지 않을 때는 탈퇴 신청을 반복하지 마세요.</p>
    </main>
  );
}
