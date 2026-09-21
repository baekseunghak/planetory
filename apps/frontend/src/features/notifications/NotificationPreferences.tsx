import { useCallback } from "react";
import { api } from "../../api";
import { ErrorState, LoadingState } from "../../components/RequestState";
import { useReadModel } from "../community/useReadModel";
import { usePostWrite, decodeWritten } from "../community/usePostWrite";
import {
  noticeKinds,
  noticeLabels,
  readNotificationPreferences,
  type NoticeKind,
} from "./contracts";
import { ApiError } from "../../api/client";
export function NotificationPreferences() {
  const path = "/v1/me/notification-settings";
  const load = useCallback(
    async (signal: AbortSignal) =>
      readNotificationPreferences(await api(path, { signal })),
    [],
  );
  const state = useReadModel(path, load),
    write = usePostWrite();
  async function toggle(kind: NoticeKind) {
    if (!state.data) return;
    const desired = !state.data[kind];
    const result = await write.run(async (signal) =>
      decodeWritten(
        await api(path, {
          method: "PATCH",
          json: { preferences: { [kind]: desired } },
          signal,
        }),
        (v) => {
          const saved = readNotificationPreferences(v);
          if (saved[kind] !== desired)
            throw new ApiError(
              0,
              "INVALID_RESPONSE",
              "설정 저장 결과가 다릅니다.",
            );
          return saved;
        },
      ),
    );
    if (result) state.reload();
  }
  return (
    <section className="settings-row" id="notifications">
      <h2>알림 수신</h2>
      <div>
        <p>
          앞으로 받을 소식의 종류를 선택하세요. 이미 도착한 알림은 남습니다.
        </p>
        {!state.data ? (
          state.error ? (
            <ErrorState error={state.error} retry={state.reload} />
          ) : (
            <LoadingState />
          )
        ) : (
          noticeKinds.map((kind) => (
            <div className="settings-switchline" key={kind}>
              <span>{noticeLabels[kind]}</span>
              <button
                type="button"
                role="switch"
                className="settings-switch"
                aria-label={noticeLabels[kind] + " 알림"}
                aria-checked={state.data![kind]}
                disabled={write.pending || write.uncertain}
                onClick={() => void toggle(kind)}
              >
                <span />
              </button>
            </div>
          ))
        )}
        {write.error && (
          <div role="alert">
            {write.uncertain
              ? "저장 여부를 확인할 수 없습니다. 현재 설정을 다시 읽어 주세요."
              : write.error.message}
            <button
              onClick={() => {
                write.clearError();
                state.reload();
              }}
            >
              수신 설정 다시 확인
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
