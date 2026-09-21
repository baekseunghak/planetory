import { useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../../api";
import { pagePath } from "../../app/paths";
import { MySkyPreview } from "../sky-data/MySkyPreview";
import { readHotTopics } from "./contracts";
import { useReadModel } from "./useReadModel";

export function CommunityAside({ hot = true }: { hot?: boolean }) {
  return (
    <aside className="community-aside">
      {hot && <HotTopicPreview />}
      <MySkyPreview />
    </aside>
  );
}
function HotTopicPreview() {
  const location = useLocation();
  const load = useCallback(
    async (signal: AbortSignal) =>
      readHotTopics(
        await api("/v1/community/hot-topics?size=3", { signal }),
        null,
      ),
    [],
  );
  const state = useReadModel("hot-topic-preview", load);
  return (
    <section className="hot-topic-preview">
      <header className="aside-heading">
        <h2>핫 토픽</h2>
        <Link to={pagePath("hotTopics")}>전체 보기 ↗</Link>
      </header>
      {state.error ? (
        <p>
          핫 토픽을 불러오지 못했어요.{" "}
          <button onClick={state.reload}>다시 보기</button>
        </p>
      ) : !state.data ? (
        <p role="status">함께 살펴본 신호를 불러오고 있어요.</p>
      ) : !state.data.items.length ? (
        <p>아직 선정된 핫 토픽이 없습니다.</p>
      ) : (
        <ol>
          {state.data.items.slice(0, 3).map((item) => (
            <li key={item.id}>
              <Link
                className="hot-topic-preview-item"
                aria-label={`핫 토픽 미리보기: ${item.title}`}
                to={pagePath(
                  "thread",
                  { threadId: item.id },
                  { returnTo: location.pathname + location.search },
                )}
              >
                <small>
                  TIC {item.ticId} · 공개 분석 참여자{" "}
                  {item.judgmentSummary?.participantCount.toLocaleString()}명
                </small>
                <span>
                  {item.title} <span aria-hidden="true">↗</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
      <p>여러 탐사자가 함께 살펴보고 있는 신호</p>
    </section>
  );
}
