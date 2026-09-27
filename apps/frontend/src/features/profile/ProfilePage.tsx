import { useCallback, useContext } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import { useSession } from "../../auth/SessionProvider";
import { ErrorState, LoadingState } from "../../components/RequestState";
import { useReadModel } from "../community/useReadModel";
import { formatJoinedDate, readProfile, type Profile } from "./contracts";
import { NicknameEditor } from "./NicknameEditor";
import {
  ProfileSection,
  ProfileSlots,
  type ProfileSlotComponents,
} from "./ProfileSlots";
import { UsageGuide } from "./UsageGuide";
import { ProfileStarFilters } from "./ProfileStarFilters";
import "./profile.css";
import { MySkyPreview } from "../sky-data/MySkyPreview";
import { FollowButton, FollowSummary } from "../follow/Follow";
import { p1Enabled } from "../p1";
import { useCinemaWording } from "../../shared/cinema-wording";
export function MyProfilePage() {
  const { member } = useSession();
  return member ? (
    <ProfileScreen key={member.memberId} memberId={member.memberId} own />
  ) : null;
}
export function MemberProfilePage() {
  const { memberId = "" } = useParams(),
    { member } = useSession();
  return memberId === member?.memberId ? (
    <Navigate to="/me" replace />
  ) : (
    <ProfileScreen key={memberId} memberId={memberId} own={false} />
  );
}
function ProfileScreen({ memberId, own }: { memberId: string; own: boolean }) {
  const { member } = useSession(),
    slots = useContext(ProfileSlots);
  // 어느 칸을 보고 있었는지를 주소에 둔다(#196). 지역 상태로 두면 기록
  // 상세에 갔다 돌아왔을 때 늘 「탐사 요약」으로 되돌아간다.
  const [params, setParams] = useSearchParams();
  const requested = params.get("section") ?? "";
  const section = (
    ["stars", "history", "statistics"].includes(requested)
      ? requested
      : "summary"
  ) as "summary" | keyof ProfileSlotComponents;
  const setSection = (next: string) => {
    const copy = new URLSearchParams(params);
    if (next === "summary") copy.delete("section");
    else copy.set("section", next);
    // 칸을 바꾸는 것은 새 자리가 아니라 같은 화면의 다른 면이다. 뒤로 가기가
    // 칸 전환마다 걸리지 않게 현재 주소를 바꾼다.
    setParams(copy, { replace: true });
  };
  const path = own ? "/v1/me" : `/v1/members/${encodeURIComponent(memberId)}`;
  const load = useCallback(
    async (signal: AbortSignal) =>
      readProfile(await api(path, { signal }), memberId, own),
    [path, memberId, own],
  );
  const state = useReadModel(path, load),
    profile = state.data;
  // Cinema app: the tabs come first and "탐사 요약" is the body under its tab
  // (src/shared/cinema-wording); develop keeps the summary above the tabs.
  const cinema = useCinemaWording();
  return (
    <section className="profile-page">
      <header className="profile-heading">
        <p className="eyebrow">{own ? "MY OBSERVATORY" : "EXPLORER PROFILE"}</p>
        <h1>{own ? "마이페이지" : "탐사자 프로필"}</h1>
      </header>
      <div className="profile-identity">
        <span className="profile-avatar" aria-hidden="true">
          {(profile?.nickname ?? (own ? member?.nickname : null) ?? "P").slice(
            0,
            1,
          )}
        </span>
        <div>
          <h2>{profile?.nickname ?? (own ? "나의 탐사" : "탐사자")}</h2>
          <p>
            {own
              ? "차곡차곡 쌓인 발견과 관측의 기록"
              : "이 탐사자가 공개한 발견을 살펴보세요."}
          </p>
        </div>
        {own && (
          <div className="profile-actions">
            <Link to="/settings">설정</Link>
            <NicknameEditor
              memberId={memberId}
              nickname={profile?.nickname ?? member?.nickname ?? ""}
              active={!!profile}
            />
            <UsageGuide />
          </div>
        )}
      </div>
      {!profile ? (
        state.error ? (
          <ErrorState error={state.error} retry={state.reload} />
        ) : (
          <LoadingState />
        )
      ) : (
        <>
          {p1Enabled && (
            <>
              <FollowSummary memberId={memberId} own={own} />
              {!own && (
                <FollowButton
                  target={{
                    kind: "MEMBER",
                    id: memberId,
                    label: profile.nickname,
                  }}
                />
              )}
            </>
          )}
          {p1Enabled && !own && profile.starListVisibility === "PUBLIC" && (
            <Link
              className="primary-link"
              to={"/members/" + encodeURIComponent(memberId) + "/sky"}
            >
              은하 방문하기 →
            </Link>
          )}
          {section === "summary" && !cinema && (
            <Summary profile={profile} own={own} />
          )}
          <nav className="profile-tabs" aria-label="프로필 메뉴">
            {(
              [
                "summary",
                "stars",
                ...(own ? ["history"] : []),
                ...(own && slots.statistics ? ["statistics"] : []),
              ] as const
            ).map((key) => (
              <button
                key={key}
                aria-current={section === key ? "page" : undefined}
                onClick={() => setSection(key as typeof section)}
              >
                {
                  (
                    {
                      summary: "탐사 요약",
                      stars: own ? "내 별" : "공개한 별",
                      history: "내 분석 기록",
                      statistics: "통계",
                    } as Record<string, string>
                  )[key]
                }
              </button>
            ))}
          </nav>
          {section === "summary" && cinema && (
            <Summary profile={profile} own={own} />
          )}
          {section !== "summary" &&
            (own && section === "stars" && slots.stars ? (
              <ProfileStarFilters
                Page={slots.stars}
                memberId={memberId}
                isOwn
                starListVisibility={profile.starListVisibility}
              />
            ) : (
              <ProfileSection
                section={section}
                memberId={memberId}
                isOwn={own}
                starListVisibility={profile.starListVisibility}
              />
            ))}
        </>
      )}
    </section>
  );
}
function Summary({ profile, own }: { profile: Profile; own: boolean }) {
  const s = profile.achievementSummary;
  const cinema = useCinemaWording();
  return (
    <>
      <div
        className={
          own ? "profile-collection" : "profile-collection public-profile"
        }
      >
        {own && <MySkyPreview />}
        <section className="profile-grades">
          <p className="eyebrow">YOUR DISCOVERIES</p>
          <h2>성과를 쌓은 별</h2>
          <p>한 별에서 인정받은 성과가 쌓일수록 등급이 올라갑니다.</p>
          <dl>
            {Object.entries(s.starCountByGrade).map(([grade, count]) => (
              <div key={grade}>
                <dt>{grade}</dt>
                <dd>{count.toLocaleString()}개</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      <dl className="profile-summary">
        {own && (
          <>
            <div>
              <dt>발견한 별</dt>
              <dd>
                {s.discoveredStarCount!.toLocaleString()}
                <small>개</small>
              </dd>
            </div>
            <div>
              <dt>{cinema ? "탐사 완료한 별" : "탐색 완료한 별"}</dt>
              <dd>
                {s.completedStarCount!.toLocaleString()}
                <small>개</small>
              </dd>
            </div>
          </>
        )}
        <div>
          <dt>찾은 신호</dt>
          <dd>
            {s.signalCount.toLocaleString()}
            <small>개</small>
          </dd>
        </div>
      </dl>
      {own ? (
        <dl className="profile-meta">
          <dt>가입일 (한국 시간)</dt>
          <dd>
            <time dateTime={profile.joinedAt}>
              {formatJoinedDate(profile.joinedAt!)}
            </time>
          </dd>
        </dl>
      ) : cinema ? (
        <p className="profile-meta">
          {profile.starListVisibility === "PRIVATE"
            ? "이 탐사자는 별 목록을 공개하지 않았습니다."
            : "이 탐사자는 별 목록을 공개했습니다."}
        </p>
      ) : (
        <p className="profile-meta">
          별 목록 {profile.starListVisibility === "PRIVATE" ? "비공개" : "공개"}{" "}
          · 성과 요약은 별 목록 공개 상태와 별도로 제공됩니다.
        </p>
      )}
    </>
  );
}
