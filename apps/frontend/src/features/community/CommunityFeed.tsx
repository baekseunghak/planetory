import { Link, useLocation } from "react-router-dom";
import { pagePath } from "../../app/paths";
import type { Author, FeedItem } from "./contracts";

export function DateTime({ value }: { value: string }) {
  return (
    <time dateTime={value}>
      {new Date(value).toLocaleString("ko-KR", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })}
    </time>
  );
}
export function AuthorLink({ author }: { author: Author }) {
  const location = useLocation();
  return (
    <Link
      to={pagePath(
        "member",
        { memberId: author.memberId },
        { returnTo: location.pathname + location.search },
      )}
    >
      {author.nickname}
    </Link>
  );
}
export function StarLink({ ticId }: { ticId: string }) {
  return (
    <Link className="community-tic" to={pagePath("starBoard", { ticId })}>
      TIC {ticId}
    </Link>
  );
}

export function CommunityFeed({
  items,
  hot = false,
}: {
  items: FeedItem[];
  hot?: boolean;
}) {
  const location = useLocation();
  const current = location.pathname + location.search;
  return (
    <ul className="community-feed">
      {items.map((item) => (
        <li key={`${item.type}:${item.id}`}>
          <div className="community-row-meta">
            <span
              className={
                item.type === "SIGNAL_THREAD" ? "community-official" : ""
              }
            >
              {item.type === "SIGNAL_THREAD"
                ? "공식 신호 스레드 · SYSTEM"
                : "일반 글"}
            </span>
            {item.ticId ? (
              <StarLink ticId={item.ticId} />
            ) : (
              <span>자유 게시판</span>
            )}
          </div>
          <h2>
            <Link
              state={{
                ...location.state,
                communityOrigin: { path: current, key: location.key },
                communityRestore: undefined,
              }}
              to={
                item.type === "POST"
                  ? pagePath("post", { postId: item.id }, { returnTo: current })
                  : pagePath(
                      "thread",
                      { threadId: item.id },
                      { returnTo: current },
                    )
              }
            >
              {item.title}
            </Link>
          </h2>
          <div className="community-row-meta">
            {"memberId" in item.author && <AuthorLink author={item.author} />}
            <DateTime value={item.createdAt} />
            <span>토론 {item.commentCount.toLocaleString()}개</span>
            {item.judgmentSummary && (
              <span>
                {item.judgmentSummary.participantCount
                  ? `공개 분석 참여자 ${item.judgmentSummary.participantCount.toLocaleString()}명`
                  : "아직 공개된 분석이 없습니다"}
              </span>
            )}
          </div>
          {hot && item.judgmentSummary && (
            <p className="hot-topic-judgments">
              행성 같음 {item.judgmentSummary.likelyPlanet.toLocaleString()}명
              {" · "}아닌 것 같음{" "}
              {item.judgmentSummary.unlikelyPlanet.toLocaleString()}명{" · "}
              모르겠음 {item.judgmentSummary.unsure.toLocaleString()}명
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
