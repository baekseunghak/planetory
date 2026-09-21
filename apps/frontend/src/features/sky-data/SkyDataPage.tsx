import { useEffect, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { ErrorState, LoadingState } from "../../components/RequestState";
import { useSkyData } from "./useSkyData";
import type { SkyDataStore, SkySnapshot } from "./store";
import { QuestProvider } from "../quests/QuestProvider";
export type SkySceneProps = { data: SkySnapshot; store: SkyDataStore };
export function SkyDataPage({
  renderScene,
}: {
  renderScene?: (props: SkySceneProps) => ReactNode;
}) {
  const { data, store } = useSkyData(),
    location = useLocation();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    store?.select(params.get("star") || params.get("focus"));
  }, [store, location.search]);
  return (
    <section className="sky-page" aria-labelledby="sky-title">
      <header className="sky-heading">
        <p className="eyebrow">MY UNIVERSE</p>
        <h1 id="sky-title">별지도</h1>
        {data.meta && (
          <p>
            발견한 별{" "}
            <strong data-testid="sky-total">
              {data.meta.starCount.toLocaleString()}
            </strong>
            개
          </p>
        )}
      </header>
      <div className="sky-data-status">
        {(!store || !data.meta) && !data.error && <LoadingState />}
        {data.error && (
          <ErrorState error={data.error} retry={() => void store?.retry()} />
        )}
        {data.needsRefresh && data.meta && (
          <p role="status">
            최신 지도를 확인하고 있습니다. 현재 보이는 자료는 이전 버전입니다.
          </p>
        )}
        {data.failures.length > 0 && (
          <div role="alert">
            <p>
              {data.failures.length}개 영역을 불러오지 못했습니다. 불러온 영역은
              유지합니다.
            </p>
            <button onClick={() => void store?.retry()}>
              실패 영역 다시 불러오기
            </button>
          </div>
        )}
        <p
          role="status"
          aria-hidden={data.pending === 0}
          style={{
            minHeight: "1.5em",
            visibility: data.pending > 0 ? "visible" : "hidden",
          }}
        >
          {data.pending > 0 ? "주변 별을 불러오고 있습니다." : null}
        </p>
        {data.meta && data.phase === "ready" && data.meta.starCount === 0 && (
          <p>아직 열린 별이 없습니다.</p>
        )}
        {data.phase === "ready" &&
          data.meta &&
          data.meta.starCount > 0 &&
          data.view &&
          !data.stars.length && <p>현재 범위에는 표시할 별이 없습니다.</p>}
        {data.selectedTicId && data.selectionStatus === "not-loaded" && (
          <p role="status">
            선택한 TIC {data.selectedTicId}의 개별 자료가 현재 범위에 적재되지
            않았습니다. 선택은 유지합니다.
          </p>
        )}
      </div>
      {store &&
        data.meta &&
        (renderScene ? (
          <QuestProvider key={store.memberId} store={store} data={data}>
            {renderScene({ store, data })}
          </QuestProvider>
        ) : (
          <p className="sky-renderer-pending">
            지도 데이터를 준비했습니다. 지도 시각화 연결을 준비하고 있습니다.
          </p>
        ))}
    </section>
  );
}
