import { PublicSourcePicker } from "./PublicSourcePicker";
import { useCallback, useState } from "react";
import { api } from "../../api";
import { ErrorState, LoadingState } from "../../components/RequestState";
import { endpoint, readPage, judgmentLabels } from "./contracts";
import {
  emptyMaterials,
  materialError,
  materialObject,
  materialText,
  readSource,
  type Materials,
  type Source,
} from "./materialContracts";
import { useReadModel } from "./useReadModel";
import { usePostWrite } from "./usePostWrite";
import "./materials.css";

export function MaterialPicker({
  ticId,
  value,
  onChange,
  disabled = false,
}: {
  ticId: string | null;
  value: Materials;
  onChange: (next: Materials) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = { ...emptyMaterials(), ...value };
  return (
    <fieldset
      className="material-picker"
      disabled={disabled}
      aria-label="자료 첨부"
    >
      <legend>자료 첨부</legend>
      <p>
        같은 별의 내 분석 기록과 공개 출처를 각각 3개까지 연결할 수 있습니다.
        본문 주소는 자동 첨부되지 않습니다.
      </p>
      {!!selected.unavailableSources.length && (
        <p>
          볼 수 없는 출처가 있습니다. 본문·기록 수정 시 유지됩니다. 출처를
          바꾸려면 먼저 모두 제거해 주세요.
          <button
            type="button"
            onClick={() =>
              onChange({ ...selected, sourceLinks: [], unavailableSources: [] })
            }
          >
            공개 출처 모두 제거
          </button>
        </p>
      )}
      <ul>
        {selected.historyIds.map((id) => (
          <li key={id}>
            내 분석 기록 {id}{" "}
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...selected,
                  historyIds: selected.historyIds.filter((v) => v !== id),
                })
              }
            >
              기록 {id} 제거
            </button>
          </li>
        ))}
        {selected.sourceLinks.map((s) => (
          <li key={s.type + s.id}>
            {s.type === "PUBLIC_ANALYSIS" ? "공개 분석" : "공식 스레드"} {s.id}{" "}
            <button
              type="button"
              disabled={selected.unavailableSources.length > 0}
              onClick={() =>
                onChange({
                  ...selected,
                  sourceLinks: selected.sourceLinks.filter(
                    (v) => v.type !== s.type || v.id !== s.id,
                  ),
                })
              }
            >
              출처 {s.id} 제거
            </button>
          </li>
        ))}
      </ul>
      {ticId && /^[1-9]\d*$/.test(ticId) ? (
        <>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
          >
            {open ? "자료 선택 접기" : "자료 선택 열기"}
          </button>
          {open && (
            <Choices
              key={ticId}
              ticId={ticId}
              selected={selected}
              onChange={onChange}
            />
          )}
        </>
      ) : (
        <p>별 게시판과 TIC 번호를 먼저 선택해 주세요.</p>
      )}
    </fieldset>
  );
}
function Choices({
  ticId,
  selected,
  onChange,
}: {
  ticId: string;
  selected: Required<Materials>;
  onChange: (value: Materials) => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null),
    [kind, setKind] = useState<Source["type"]>("PUBLIC_ANALYSIS"),
    [id, setId] = useState(""),
    [message, setMessage] = useState("");
  const path = endpoint("/v1/me/histories", { ticId, size: "20", cursor });
  const load = useCallback(
    async (signal: AbortSignal) =>
      readPage(
        await api(path, { signal }),
        (raw) => {
          const r = materialObject(raw);
          if (r.ticId !== ticId)
            throw new Error("다른 별의 기록이 반환되어 선택을 중단했습니다.");
          return {
            historyId: materialText(r.historyId),
            submittedAt: materialText(r.submittedAt),
            submissionKind: materialText(r.submissionKind),
            userJudgment:
              r.userJudgment === null ? null : materialText(r.userJudgment),
          };
        },
        (v) => v.historyId,
        cursor,
      ),
    [path, ticId, cursor],
  );
  const histories = useReadModel(path, load),
    preview = usePostWrite();
  const add = (next: Materials) => {
    const error = materialError(next, ticId);
    setMessage(error);
    if (!error) onChange(next);
  };
  async function source(chosen?: Source) {
    const target: Source = chosen ?? { type: kind, id: id.trim() };
    if (!target.id) {
      setMessage("출처 ID를 입력해 주세요.");
      return;
    }
    const result = await preview.run(async (signal) =>
      readSource(
        await api(endpoint("/v1/source-cards", { ...target, ticId }), {
          signal,
        }),
        target,
        ticId,
      ),
    );
    if (result) {
      add({ ...selected, sourceLinks: [...selected.sourceLinks, target] });
      setId("");
    }
  }
  return (
    <div className="material-choices">
      <section aria-label="내 기록 선택">
        <h3>내 분석 기록</h3>
        {!histories.data ? (
          histories.error ? (
            <ErrorState error={histories.error} retry={histories.reload} />
          ) : (
            <LoadingState />
          )
        ) : (
          <>
            <ul>
              {histories.data.items.map((h) => (
                <li key={h.historyId}>
                  <span>
                    {h.historyId} ·{" "}
                    {h.userJudgment === null
                      ? h.submissionKind === "no_candidate"
                        ? "신호 없음으로 제출"
                        : h.submissionKind === "skipped"
                          ? "건너뛴 기록"
                          : "판단 없음"
                      : (judgmentLabels[
                          h.userJudgment as keyof typeof judgmentLabels
                        ] ?? h.userJudgment)}{" "}
                    · {new Date(h.submittedAt).toLocaleString("ko-KR")}
                  </span>
                  <button
                    type="button"
                    disabled={
                      selected.historyIds.includes(h.historyId) ||
                      selected.historyIds.length >= 3
                    }
                    onClick={() =>
                      add({
                        ...selected,
                        historyIds: [...selected.historyIds, h.historyId],
                      })
                    }
                  >
                    {h.historyId} 첨부
                  </button>
                </li>
              ))}
            </ul>
            {!histories.data.items.length && (
              <p>이 별에서 제출한 기록이 없습니다.</p>
            )}
            <nav>
              {cursor && (
                <button type="button" onClick={() => setCursor(null)}>
                  기록 첫 페이지
                </button>
              )}
              {histories.data.hasNext && (
                <button
                  type="button"
                  onClick={() => setCursor(histories.data!.nextCursor)}
                >
                  기록 다음 페이지
                </button>
              )}
            </nav>
          </>
        )}
      </section>
      <section aria-label="공개 출처 선택">
        <h3>공개 출처</h3>
        <PublicSourcePicker ticId={ticId} selected={selected.sourceLinks} disabled={preview.pending || selected.sourceLinks.length >= 3 || selected.unavailableSources.length > 0} onSelect={(target) => void source(target)} />
        <details><summary>출처 ID 직접 입력</summary>
        <p>
          공개 분석 또는 공식 스레드의 ID를 입력하면 현재 공개 여부와 같은
          별인지 확인합니다.
        </p>
        <label>
          출처 종류
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Source["type"])}
          >
            <option value="PUBLIC_ANALYSIS">공개 분석</option>
            <option value="SIGNAL_THREAD">공식 스레드</option>
          </select>
        </label>
        <label>
          출처 ID
          <input value={id} onChange={(e) => setId(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={
            preview.pending ||
            selected.sourceLinks.length >= 3 ||
            selected.unavailableSources.length > 0
          }
          onClick={() => void source()}
        >
          {preview.pending ? "확인 중…" : "출처 확인 후 첨부"}
        </button>
        </details>
        {preview.error && <ErrorState error={preview.error} />}
      </section>
      {message && <p role="alert">{message}</p>}
    </div>
  );
}
