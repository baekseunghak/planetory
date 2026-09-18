import { useCallback, useContext, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
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
import "./profile.css";
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
    slots = useContext(ProfileSlots),
    [section, setSection] = useState<"summary" | keyof ProfileSlotComponents>(
      "summary",
    );
  const path = own ? "/v1/me" : `/v1/members/${encodeURIComponent(memberId)}`;
  const load = useCallback(
    async (signal: AbortSignal) =>
      readProfile(await api(path, { signal }), memberId, own),
    [path, memberId, own],
  );
  const state = useReadModel(path, load),
    profile = state.data;
  return (
    <section className="profile-page">
      <header className="profile-heading">
        <p className="eyebrow">{own ? "MY OBSERVATORY" : "EXPLORER PROFILE"}</p>
        <h1>{profile?.nickname ?? (own ? "나의 탐사" : "탐사자 프로필")}</h1>
        <p>
          {own
            ? "차곡차곡 쌓인 발견과 관측의 기록"
            : "이 탐사자가 공개한 발견을 살펴보세요."}
        </p>
        {own && (
          <div className="profile-actions">
            <NicknameEditor
              memberId={memberId}
              nickname={profile?.nickname ?? member?.nickname ?? ""}
              active={!!profile}
            />
            <UsageGuide />
          </div>
        )}
      </header>
      {!profile ? (
        state.error ? (
          <ErrorState error={state.error} retry={state.reload} />
        ) : (
          <LoadingState />
        )
      ) : (
        <>
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
          {section === "summary" ? (
            <Summary profile={profile} own={own} />
          ) : (
            <ProfileSection
              section={section}
              memberId={memberId}
              isOwn={own}
              starListVisibility={profile.starListVisibility}
            />
          )}
        </>
      )}
    </section>
  );
}
function Summary({ profile, own }: { profile: Profile; own: boolean }) {
  const s = profile.achievementSummary;
  return (
    <>
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
              <dt>탐색 완료한 별</dt>
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
      <section className="profile-grades">
        <h2>성과를 쌓은 별</h2>
        <p>서버가 집계한 별의 등급별 수입니다.</p>
        <dl>
          {Object.entries(s.starCountByGrade).map(([grade, count]) => (
            <div key={grade}>
              <dt>{grade}</dt>
              <dd>{count.toLocaleString()}개</dd>
            </div>
          ))}
        </dl>
      </section>
      {own ? (
        <dl className="profile-meta">
          <dt>가입일 (한국 시간)</dt>
          <dd>
            <time dateTime={profile.joinedAt}>
              {formatJoinedDate(profile.joinedAt!)}
            </time>
          </dd>
        </dl>
      ) : (
        <p className="profile-meta">
          별 목록 {profile.starListVisibility === "PRIVATE" ? "비공개" : "공개"}{" "}
          · 성과 요약은 별 목록 공개 상태와 별도로 제공됩니다.
        </p>
      )}
    </>
  );
}
