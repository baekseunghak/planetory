import { useState, useEffect, useRef } from "react";
import { api, ApiError } from "../../api";
import { useSession } from "../../auth/SessionProvider";
import { nicknameProblem, normalizedNickname } from "../../auth/flow";
import { ErrorState } from "../../components/RequestState";
import { usePostWrite, decodeWritten } from "../community/usePostWrite";
import { readNickname } from "./contracts";
export function NicknameEditor({
  memberId,
  nickname,
  active,
}: {
  memberId: string;
  nickname: string;
  active: boolean;
}) {
  const session = useSession(),
    write = usePostWrite(),
    read = usePostWrite();
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(""),
    [problem, setProblem] = useState(""),
    [current, setCurrent] = useState<string | null>(null),
    [verified, setVerified] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  async function save() {
    if (!active || write.pending || write.uncertain) return;
    const error = nicknameProblem(draft);
    setProblem(error ?? "");
    if (error) return;
    setVerified(false);
    setCurrent(null);
    const result = await write.run(async (signal) =>
      decodeWritten(
        await api("/v1/me/profile", {
          method: "PATCH",
          json: { nickname: normalizedNickname(draft) },
          signal,
        }),
        (raw) => readNickname(raw, memberId),
      ),
    );
    if (result) await session.refresh();
  }
  async function verify() {
    const result = await read.run(async (signal) =>
      readNickname(await api("/v1/me", { signal }), memberId),
    );
    if (result) {
      setCurrent(result.value.nickname);
      setVerified(true);
    }
  }
  if (!editing)
    return (
      <button
        type="button"
        disabled={!active}
        onClick={() => {
          setDraft(nickname);
          setEditing(true);
        }}
      >
        닉네임 변경
      </button>
    );
  const field =
    write.error instanceof ApiError
      ? write.error.fieldErrors.find((f) => f.field === "nickname")?.reason
      : undefined;
  return (
    <form
      className="nickname-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        새 닉네임
        <input
          ref={input}
          value={draft}
          autoComplete="off"
          disabled={!active || write.pending || write.uncertain}
          onChange={(e) => {
            setDraft(e.target.value);
            setProblem("");
            write.clearError();
          }}
          aria-describedby="nickname-help"
          aria-invalid={!!(problem || field)}
        />
      </label>
      <p id="nickname-help">
        한글·영문·숫자·밑줄, 2~20자 ({[...normalizedNickname(draft)].length}/20)
      </p>
      {problem && <p role="alert">{problem}</p>}
      {write.error && <ErrorState error={write.error} />}
      {write.uncertain ? (
        <>
          <p>저장 여부를 확인할 수 없습니다. 자동으로 다시 보내지 않습니다.</p>
          <button
            type="button"
            disabled={read.pending || !active}
            onClick={() => void verify()}
          >
            현재 닉네임 확인
          </button>
          {read.error && <ErrorState error={read.error} />}{" "}
          {verified && (
            <>
              <p role="status">현재 서버 닉네임: {current}</p>
              <button type="button" onClick={() => void session.refresh()}>
                현재 닉네임 사용
              </button>
              <button
                type="button"
                onClick={() => {
                  write.clearError();
                  setVerified(false);
                }}
              >
                입력 이어서 편집
              </button>
            </>
          )}
        </>
      ) : (
        <div className="profile-actions">
          <button
            type="button"
            disabled={write.pending}
            onClick={() => setEditing(false)}
          >
            취소
          </button>
          <button disabled={!active || write.pending}>
            {write.pending ? "저장 확인 중…" : "닉네임 저장"}
          </button>
        </div>
      )}
    </form>
  );
}
