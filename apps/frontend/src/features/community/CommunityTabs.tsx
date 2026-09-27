import { Link } from "react-router-dom";
import { useLiveP1 } from "../p1";
export function CommunityTabs({
  active,
  officialHref = "/community/signal-threads",
  boardHref = (board) => (board ? "/community?board=" + board : "/community"),
}: {
  active: string;
  officialHref?: string;
  boardHref?: (board: string) => string;
}) {
  const p1Enabled = useLiveP1();
  const tabs = [
    ["", "전체", boardHref("")],
    ["FREE", "자유 게시판", boardHref("FREE")],
    ["STAR", "별 게시판", boardHref("STAR")],
    ["official", "공식 스레드", officialHref],
    ["hot", "핫 토픽", "/community/hot-topics"],
    ...(p1Enabled ? [["following", "팔로잉", "/community/following"]] : []),
  ];
  return (
    <nav
      className="community-tabs community-board-tabs"
      aria-label="게시판 종류"
    >
      {tabs.map(([key, label, href]) => (
        <Link
          key={key}
          to={href}
          state={null}
          aria-current={active === key ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
