import { useState, useEffect } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { Settings, ArrowUpRight, LockKeyhole } from "lucide-react";
import type {
  Profile,
  Page,
  StarNode,
  History,
  Signal,
  Statistics,
  Metrics,
  Distribution,
  Quests,
} from "../../shared/types";
import { STATUSES, JUDGMENTS } from "../../shared/types";
import { useApp } from "../App";
import { useResource } from "../api/hooks";
import { mutation, query } from "../api/client";
import {
  PageTitle,
  RequestState,
  Empty,
  Pager,
  Grade,
  Status,
  Field,
  ActionError,
  useAction,
  date,
  number,
  Modal,
  AI,
  DistributionView,
  Back,
} from "../components/ui";
import { RecordView } from "../components/RecordView";

export function StarRow({
  star: s,
  own = true,
}: {
  star: StarNode;
  own?: boolean;
}) {
  return (
    <article className="star-row">
      <div
        className={
          "list-star color-" +
          Math.min(4, s.planetCount) +
          (s.status === "complete" && !s.planetCount ? " apricot" : "")
        }
        aria-hidden="true"
      />
      <div className="star-row-main">
        <div className="inline-info">
          <h3>TIC {s.id}</h3>
          <Status star={s} />
          {s.reopenedAt && (
            <span className="badge">새 신호 · 다시 분석 가능</span>
          )}
        </div>
        <p className="muted">
          표시 행성 {s.planetCount}개 ·{" "}
          {s.curveStep ? "뺀 곡선 " + s.curveStep : "원본 곡선"}
          {s.hasFp ? " · 행성 아님 포함" : ""}
          {own && s.unpublishedCount
            ? " · 미게시 분석 " + s.unpublishedCount + "개"
            : ""}
        </p>
        <small>최근 활동 {date(s.lastActivity)}</small>
      </div>
      <Grade star={s} />
      <div className="actions vertical">
        {own && (
          <>
            <Link to={"/results/" + s.id}>결과 보기 ↗</Link>
            <Link to={"/analysis/" + s.id}>
              {s.reopenedAt
                ? "다시 분석"
                : s.status === "complete"
                  ? "재검토"
                  : "이어 하기"}{" "}
              ↗
            </Link>
          </>
        )}
        <Link to={"/community/stars/" + s.id}>별 게시판 ↗</Link>
      </div>
    </article>
  );
}

export function ProfilePage() {
  const { memberId } = useParams(),
    { member, refresh } = useApp(),
    target = memberId || member.id,
    r = useResource<Profile>(memberId ? "/members/" + memberId : "/me");
  const [page, setPage] = useState(1),
    [filter, setFilter] = useState(""),
    [status, setStatus] = useState("all"),
    [editing, setEditing] = useState(false),
    [nick, setNick] = useState(member.nickname),
    a = useAction();
  useEffect(() => {
    setPage(1);
  }, [target, filter, status]);
  const canSee = r.data && (r.data.own || r.data.publicStars),
    stars = useResource<Page<StarNode>>(
      canSee
        ? query("/members/" + target + "/stars", {
            page,
            query: filter,
            status,
          })
        : null,
    );
  return (
    <main className="page">
      <PageTitle
        eyebrow="MY OBSERVATORY"
        title={
          r.data?.own
            ? "마이페이지"
            : (r.data?.member.nickname || "탐사자") + "의 기록"
        }
        description="작은 발견부터, 다시 살펴볼 신호까지."
        actions={
          r.data?.own && (
            <>
              <Link className="button" to="/history">
                전체 제출 기록
              </Link>
              <Link className="icon-button" aria-label="설정" to="/settings">
                <Settings size={20} />
              </Link>
            </>
          )
        }
      />
      <RequestState state={r} />
      <ActionError message={a.error} />
      {r.data && (
        <>
          <section className="profile-hero panel">
            <div className="avatar" aria-hidden="true">
              {r.data.member.nickname.slice(0, 1)}
            </div>
            <div>
              <p className="eyebrow">EXPLORER</p>
              {editing ? (
                <form
                  className="inline-info"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void a.run(async () => {
                      await mutation("/me/profile", { nickname: nick });
                      await refresh();
                      r.reload();
                      setEditing(false);
                    });
                  }}
                >
                  <label className="sr-only" htmlFor="nickname">
                    새 닉네임
                  </label>
                  <input
                    id="nickname"
                    value={nick}
                    minLength={2}
                    maxLength={20}
                    onChange={(e) => setNick(e.target.value)}
                    required
                  />
                  <button className="primary" disabled={a.pending}>
                    저장
                  </button>
                  <button type="button" onClick={() => setEditing(false)}>
                    취소
                  </button>
                </form>
              ) : (
                <div className="inline-info">
                  <h2>{r.data.member.nickname}</h2>
                  {r.data.own && (
                    <button
                      className="text-button"
                      onClick={() => {
                        setNick(member.nickname);
                        setEditing(true);
                      }}
                    >
                      닉네임 수정
                    </button>
                  )}
                </div>
              )}
              <p className="muted">
                가입 {date(r.data.member.joinedAt)} · 팔로워 {r.data.followers}{" "}
                · 팔로잉 {r.data.followingCount}
              </p>
            </div>
            {!r.data.own && (
              <button
                className={r.data.following ? "" : "primary"}
                disabled={a.pending}
                onClick={() =>
                  a.run(async () => {
                    await mutation("/follows", {
                      kind: "member",
                      id: target,
                      active: !r.data!.following,
                    });
                    r.reload();
                  })
                }
              >
                {r.data.following ? "팔로우 취소" : "팔로우"}
              </button>
            )}
            <div className="profile-counts">
              {[
                ["찾은 별", r.data.found],
                ["탐색 완료", r.data.completed],
                ["찾은 신호", r.data.signals],
              ].map(([label, value]) => (
                <div key={label}>
                  <strong>{number(Number(value))}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </section>
          <div className="grade-strip">
            {Object.entries(r.data.grades).map(([g, n]) => (
              <span key={g}>
                <b className={"grade g" + g}>{g}</b> {n}개
              </span>
            ))}
            <small>별 전체 성과 수에 따른 단일 등급</small>
          </div>
          <section>
            <div className="section-title">
              <h2>제출한 별의 활동 기록</h2>
              <span className="muted">최근 활동 순</span>
            </div>
            {!canSee ? (
              <Empty title="별 목록이 비공개입니다">
                <LockKeyhole size={22} />
                <p>이 탐사자는 자신의 별 목록을 공개하지 않았습니다.</p>
              </Empty>
            ) : (
              <>
                <div className="filter-bar">
                  <Field label="TIC 검색">
                    <input
                      value={filter}
                      placeholder="TIC 번호"
                      onChange={(e) => setFilter(e.target.value)}
                    />
                  </Field>
                  <Field label="진행 상태">
                    <select
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                    >
                      <option value="all">전체</option>
                      {Object.entries(STATUSES).map(([k, v]) => (
                        <option value={k} key={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <RequestState state={stars} />
                {stars.data && (
                  <>
                    {!stars.data.items.length ? (
                      <Empty title="아직 제출한 별이 없습니다">
                        <Link to="/sky">
                          밤하늘에서 첫 별을 선택해 보세요 →
                        </Link>
                      </Empty>
                    ) : (
                      stars.data.items.map((s) => (
                        <StarRow key={s.id} star={s} own={r.data!.own} />
                      ))
                    )}
                    <Pager data={stars.data} onPage={setPage} />
                  </>
                )}
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}

export function HistoryPage() {
  const [page, setPage] = useState(1),
    [tic, setTic] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [outcome, setOutcome] = useState("all");
  useEffect(() => setPage(1), [tic, from, to, outcome]);
  const r = useResource<Page<History>>(
    query("/history", { page, starId: tic, from, to, outcome }),
  );
  return (
    <main className="page">
      <Back to="/me" label="마이페이지" />
      <PageTitle
        eyebrow="ANALYSIS LOG"
        title="제출 기록"
        description="제출한 판단과 근거, 당시의 곡선을 다시 확인합니다."
      />
      <div className="filter-bar">
        <Field label="TIC 번호">
          <input
            value={tic}
            onChange={(e) => setTic(e.target.value)}
            placeholder="전체 별"
          />
        </Field>
        <Field label="시작일">
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="종료일">
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <Field label="탐색 결과">
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {Object.entries({
              all: "전체",
              matched: "신호 찾음",
              matched_harmonic: "배수 주기 보정",
              duplicate: "기존 성과",
              not_matched: "신호 미일치",
              ambiguous_match: "여러 신호와 겹침",
              none_wrong: "신호 없음 판단 오류",
              skipped: "건너뛰기",
            }).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <RequestState state={r} />
      {r.data && (
        <>
          {!r.data.items.length ? (
            <Empty title="조건에 맞는 기록이 없습니다" />
          ) : (
            <div className="history-list">
              {r.data.items.map((h) => (
                <article key={h.id}>
                  <div>
                    <small>{date(h.submittedAt)}</small>
                    <h3>
                      <Link to={"/history/" + h.id}>
                        TIC {h.starId} <ArrowUpRight size={14} />
                      </Link>
                    </h3>
                    <p className="muted">
                      {h.curveStep ? "뺀 곡선 " + h.curveStep : "원본 곡선"} ·{" "}
                      {h.period === null ? "주기 없음" : h.period + "일"} ·{" "}
                      {h.outcome === "skipped"
                        ? "건너뛰기"
                        : h.signalId
                          ? "신호 찾음"
                          : "신호 미일치"}
                    </p>
                  </div>
                  <div className="history-flags">
                    {h.achievementResult === "recognized" && (
                      <span className="badge">최초 성과 인정</span>
                    )}
                    {h.publication?.hidden ? (
                      <span>숨겨짐</span>
                    ) : h.publication?.active ? (
                      <span className="badge">공개됨</span>
                    ) : (
                      <span className="muted">
                        {h.type === "unconfirmed" ? "새 미게시 분석" : "미게시"}
                      </span>
                    )}
                    <Link className="button" to={"/history/" + h.id}>
                      기록 상세
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          )}
          <Pager data={r.data} onPage={setPage} />
        </>
      )}
    </main>
  );
}

export function HistoryDetailPage() {
  const { historyId } = useParams(),
    r = useResource<History>("/history/" + historyId),
    d = useResource<Distribution | null>(
      "/history/" + historyId + "/distribution",
    ),
    [hint, setHint] = useState<{ signal: Signal; canSkip: boolean } | null>(
      null,
    ),
    [cancel, setCancel] = useState(false),
    a = useAction(),
    navigate = useNavigate();
  return (
    <main className="page narrow">
      <Back to="/history" label="제출 기록" />
      <PageTitle eyebrow="RECORD DETAIL" title="내 분석 기록" />
      <RequestState state={r} />
      <ActionError message={a.error} />
      {r.data && (
        <>
          <section className="panel">
            <RecordView key={r.data.id} history={r.data} />
            <RequestState state={d} />
            <DistributionView data={d.data || null} />
            <div className="actions">
              {r.data.hintAvailable && (
                <button
                  disabled={a.pending}
                  onClick={() =>
                    a.run(async () => {
                      setHint(
                        await mutation("/history/" + historyId + "/reveal", {}),
                      );
                    })
                  }
                >
                  상세 보기
                </button>
              )}
              {r.data.publication?.active && !r.data.publication.hidden && (
                <button onClick={() => setCancel(true)}>분석 공개 취소</button>
              )}
              {!r.data.signalId && r.data.outcome !== "skipped" && (
                <Link
                  className="button"
                  to={
                    "/community/new?star=" +
                    r.data.starId +
                    "&history=" +
                    r.data.id
                  }
                >
                  별 게시판에 의견 남기기
                </Link>
              )}
            </div>
          </section>
          {hint && (
            <Modal title="기록과 비교하기" onClose={() => setHint(null)}>
              <p>비교 대상: {hint.signal.id}</p>
              <dl className="facts">
                <div>
                  <dt>반복 주기</dt>
                  <dd>{hint.signal.period}일</dd>
                </div>
                <div>
                  <dt>가려진 시간</dt>
                  <dd>{number(hint.signal.duration * 24, "시간")}</dd>
                </div>
                <div>
                  <dt>기록된 분류</dt>
                  <dd>
                    {hint.signal.type === "fp"
                      ? "행성 아님"
                      : hint.signal.type === "confirmed"
                        ? "확인된 행성"
                        : "아직 확인 안 된 신호"}
                  </dd>
                </div>
              </dl>
              <AI signal={hint.signal} />
              <p className="muted">
                해설을 본 사실이 기록됩니다. 판단이나 성과는 바뀌지 않습니다.
              </p>
              {hint.canSkip && (
                <button
                  className="primary"
                  disabled={a.pending}
                  onClick={() =>
                    a.run(async () => {
                      await mutation("/stars/" + r.data!.starId + "/skip", {});
                      setHint(null);
                      navigate("/sky");
                    })
                  }
                >
                  다음 튜토리얼로
                </button>
              )}
              <ActionError message={a.error} />
            </Modal>
          )}
          {cancel && (
            <Modal
              title="분석 공개를 취소할까요?"
              onClose={() => setCancel(false)}
            >
              <p>
                공개 분석과 판단 집계에서 제외됩니다. 개인 기록과 이미 인정된
                성과, 새로 찾은 별은 유지됩니다.
              </p>
              <button
                disabled={a.pending}
                onClick={() =>
                  a.run(async () => {
                    await mutation("/publications", {
                      historyId,
                      active: false,
                    });
                    setCancel(false);
                    r.reload();
                    d.reload();
                  })
                }
              >
                공개 취소
              </button>
            </Modal>
          )}
        </>
      )}
    </main>
  );
}

export function SettingsPage() {
  const { member, refresh, startGuide } = useApp(),
    quests = useResource<Quests>("/quests"),
    [settings, setSettings] = useState(structuredClone(member.settings)),
    [saved, setSaved] = useState(false),
    [withdraw, setWithdraw] = useState(false),
    a = useAction(),
    navigate = useNavigate();
  const labels: Record<string, string> = {
    challenge: "이번 주 챌린지",
    candidate: "후보 상태 변경",
    expert: "전문가 검토 상태",
    grade: "성과 인정·등급 변경",
    community: "내 글의 댓글",
    follow: "팔로우한 회원·별의 새 활동",
    reopened: "새로 찾을 수 있는 신호",
  };
  return (
    <main className="page narrow">
      <Back to="/me" label="마이페이지" />
      <PageTitle eyebrow="PREFERENCES" title="설정" />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            await mutation("/me/settings", { settings });
            await refresh();
            setSaved(true);
          });
        }}
      >
        <section className="panel">
          <h2>공개 범위</h2>
          <label className="switch-row">
            <span>
              <strong>다른 사람에게 내 별 목록 공개</strong>
              <small>
                게시글과 직접 공개한 분석의 공개 상태는 각각 유지됩니다.
              </small>
            </span>
            <input
              type="checkbox"
              checked={settings.publicStars}
              onChange={(e) => {
                setSaved(false);
                setSettings({ ...settings, publicStars: e.target.checked });
              }}
            />
          </label>
        </section>
        <section className="panel">
          <h2>알림</h2>
          {Object.entries(settings.notifications)
            .filter(([key]) => key !== "expert" && key in labels)
            .map(([key, value]) => (
              <label className="switch-row" key={key}>
                <span>{labels[key] || key}</span>
                <input
                  type="checkbox"
                  checked={value}
                  onChange={(e) => {
                    setSaved(false);
                    setSettings({
                      ...settings,
                      notifications: {
                        ...settings.notifications,
                        [key]: e.target.checked,
                      },
                    });
                  }}
                />
              </label>
            ))}
        </section>
        <ActionError message={a.error} />
        <div className="actions">
          <button className="primary" disabled={a.pending}>
            설정 저장
          </button>
          {saved && <span role="status">저장했습니다.</span>}
        </div>
      </form>
      <section className="panel">
        <h2>사용 안내</h2>
        <RequestState state={quests} />
        <p className="muted">
          첫 번째 별 선택부터 분석 제출까지 다시 안내합니다.
        </p>
        <button
          disabled={!quests.data?.tutorials.some((t) => t.number === 1)}
          onClick={() => {
            const first = quests.data!.tutorials.find((t) => t.number === 1)!;
            startGuide(first.id);
            navigate("/sky?star=" + encodeURIComponent(first.id));
          }}
        >
          첫 사용 안내 다시 보기
        </button>
      </section>
      <section className="panel">
        <h2>계정</h2>
        <p>연결된 로그인: {member.provider === "ssafy" ? "SSAFY" : "Google"}</p>
        <p>가입일: {date(member.joinedAt)}</p>
        <button className="danger-text" onClick={() => setWithdraw(true)}>
          회원 탈퇴
        </button>
      </section>
      {withdraw && (
        <Modal title="회원 탈퇴 안내" onClose={() => setWithdraw(false)}>
          <p>
            명세의 탈퇴 후 기록 처리 정책(DEC-11)이 아직 확정되지 않았습니다.
            현재 검증 환경에서는 계정을 삭제하지 않습니다.
          </p>
          <button onClick={() => setWithdraw(false)}>확인</button>
        </Modal>
      )}
    </main>
  );
}

const metricLabels: [keyof Metrics, string, string][] = [
  ["found", "찾은 별", "개"],
  ["started", "시작한 별", "개"],
  ["completed", "탐색 완료", "개"],
  ["achievements", "인정된 성과", "건"],
  ["agreement", "기록과 일치", "%"],
  ["likelyAgreement", "행성 같음 · 기록과 일치", "%"],
  ["unlikelyAgreement", "아닌 것 같음 · 기록과 일치", "%"],
  ["firstAgreement", "첫 제출 기록과 일치", "%"],
  ["recovered", "재도전으로 인정", "건"],
  ["attemptsPerStar", "별당 평균 시도", "회"],
  ["harmonicRatio", "배수 주기 보정 비율", "%"],
  ["evidenceAverage", "평균 선택 근거", "개"],
  ["posts", "작성한 글", "개"],
  ["comments", "작성한 댓글", "개"],
  ["unpublished", "미게시 분석", "개"],
  ["activeDays", "활동한 날", "일"],
];
function MetricsView({ data: m }: { data: Metrics }) {
  const max = Math.max(1, ...m.weekly.map((w) => w.count));
  return (
    <>
      <div className="metric-grid">
        {metricLabels.map(([key, label, unit]) => (
          <div className="metric-card" key={key}>
            <span>{label}</span>
            <strong>{number(m[key] as number | null, unit)}</strong>
          </div>
        ))}
      </div>
      <section className="panel">
        <h2>제출한 판단</h2>
        <div className="inline-info">
          {Object.entries(m.judgments).map(([j, n]) => (
            <span key={j}>
              {JUDGMENTS[j as keyof typeof JUDGMENTS]} · {n}회
            </span>
          ))}
        </div>
        <small>
          판단이 있는 모든 제출의 횟수입니다. 신호별 공개 분석 통계와
          별도입니다.
        </small>
      </section>
      <div className="two-columns">
        <section className="panel">
          <h2>최근 8주 활동</h2>
          <div
            className="weekly-chart"
            role="img"
            aria-label={m.weekly
              .map((w) => w.week + " " + w.count + "회")
              .join(", ")}
          >
            {m.weekly.map((w) => (
              <div key={w.week}>
                <span>{w.count}</span>
                <i
                  style={{ height: Math.max(2, (w.count / max) * 110) + "px" }}
                />
                <small>{w.week.slice(5)}</small>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <h2>성과 유형과 등급</h2>
          <dl className="facts">
            <div>
              <dt>확인된 행성</dt>
              <dd>{m.types.confirmed}건</dd>
            </div>
            <div>
              <dt>아직 확인 안 된 신호</dt>
              <dd>{m.types.unconfirmed}건</dd>
            </div>
            <div>
              <dt>행성 아님</dt>
              <dd>{m.types.fp}건</dd>
            </div>
            {Object.entries(m.grades).map(([g, n]) => (
              <div key={g}>
                <dt>{g} 등급의 별</dt>
                <dd>{n}개</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      <section className="panel">
        <h2>선택한 근거</h2>
        <table>
          <thead>
            <tr>
              <th>근거</th>
              <th>선택 횟수</th>
              <th>판단 일치율</th>
            </tr>
          </thead>
          <tbody>
            {m.evidence.map((e) => (
              <tr key={e.name}>
                <td>{e.name}</td>
                <td>{e.count}회</td>
                <td>{number(e.agreement, "%")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
export function StatisticsPage() {
  const r = useResource<Statistics>("/statistics"),
    [tab, setTab] = useState("mine");
  const comparisons = [
    "agreement",
    "firstAgreement",
    "attemptsPerStar",
    "harmonicRatio",
    "evidenceAverage",
  ] as const;
  return (
    <main className="page">
      <PageTitle
        eyebrow="EXPLORATION INSIGHTS"
        title="탐사 통계"
        description="얼마나 찾았는지, 어떤 근거로 판단했는지 살펴보세요."
      />
      <div className="tabs">
        {[
          ["mine", "나의 통계"],
          ["global", "전체 통계"],
          ["compare", "내 기록과 기준선"],
        ].map(([k, v]) => (
          <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {v}
          </button>
        ))}
      </div>
      <RequestState state={r} />
      {r.data && (
        <>
          {tab === "mine" ? (
            <>
              <p className="notice">다음 목표 · {r.data.mine.nextGoal}</p>
              <MetricsView data={r.data.mine} />
            </>
          ) : tab === "global" ? (
            <>
              <p className="muted">
                {date(r.data.asOf)} 집계 · {r.data.refreshMinutes}분 갱신
              </p>
              <MetricsView data={r.data.global} />
              <div className="two-columns">
                <section className="panel">
                  <DistributionView data={r.data.publicJudgments} />
                </section>
                <section className="panel">
                  <h2>토론이 많은 별</h2>
                  {r.data.discussedStars.map((s) => (
                    <p key={s.id}>
                      <Link to={"/community/stars/" + s.id}>TIC {s.id}</Link> ·{" "}
                      {s.count}개 글
                    </p>
                  ))}
                </section>
              </div>
              <section className="panel">
                <h2>AI 참고 구간별 사용자 판단</h2>
                <table>
                  <thead>
                    <tr>
                      <th>AI 참고 구간</th>
                      <th>행성 같음</th>
                      <th>아닌 것 같음</th>
                      <th>모르겠음</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.data.aiBands.map((b) => (
                      <tr key={b.name}>
                        <td>
                          {{
                            approved: "승인",
                            review: "검토",
                            below: "기준 미만",
                            not_evaluated: "미평가",
                          }[b.name] || b.name}
                        </td>
                        {Object.values(b.counts).map((n, i) => (
                          <td key={i}>{n}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <small>AI 점수는 성과 인정 기준이 아닙니다.</small>
              </section>
              <div className="two-columns">
                <section className="panel">
                  <h2>섹터별 탐색 현황</h2>
                  {r.data.sectors.map((s) => (
                    <div className="distribution-row" key={s.sector}>
                      <span>Sector {s.sector}</span>
                      <div className="meter">
                        <i
                          style={{
                            width:
                              (s.total ? (s.completed / s.total) * 100 : 0) +
                              "%",
                          }}
                        />
                      </div>
                      <span>
                        {s.completed} / {s.total}
                      </span>
                    </div>
                  ))}
                </section>
                <section className="panel">
                  <h2>이번 주 챌린지 · {r.data.challenge.participants}명</h2>
                  <DistributionView data={r.data.challenge.distribution} />
                </section>
              </div>
            </>
          ) : (
            <>
              <p className="muted">
                {r.data.baseline.population} · {date(r.data.baseline.asOf)} 기준
              </p>
              <p>
                파란 막대는 나, 회색 막대는 최근 활동 회원의 중앙값입니다.
                일치율이 낮다면 기록 상세의 근거를 비교하고, 시도 횟수가 많다면
                구간 선택을 다시 살펴보세요.
              </p>
              <section className="panel comparison">
                <div className="inline-info">
                  <span className="mine-key">나</span>
                  <span className="baseline-key">기준선 중앙값</span>
                </div>
                {comparisons.map((k) => {
                  const def = metricLabels.find((x) => x[0] === k)!,
                    mine = r.data!.mine[k],
                    base = r.data!.baseline[k],
                    max = Math.max(1, mine || 0, base || 0);
                  return (
                    <div key={k} className="compare-row">
                      <h3>{def[1]}</h3>
                      <div>
                        <span>나</span>
                        <i style={{ width: ((mine || 0) / max) * 70 + "%" }} />
                        <b>{number(mine, def[2])}</b>
                      </div>
                      <div>
                        <span>기준선</span>
                        <i
                          className="baseline"
                          style={{ width: ((base || 0) / max) * 70 + "%" }}
                        />
                        <b>{number(base, def[2])}</b>
                      </div>
                    </div>
                  );
                })}
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}
