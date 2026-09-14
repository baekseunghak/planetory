import { Link } from "react-router-dom";
import type { PageSlots } from "../src/app/App";
import { pagePath } from "../src/app/paths";
import { usePageContext } from "../src/app/usePageContext";
import { useSession } from "../src/auth/SessionProvider";
import { useResource } from "../src/api/useResource";
import { ErrorState, LoadingState } from "../src/components/RequestState";

function Note() {
  return (
    <p className="fixture-note">
      공통 연결 확인 · 개발 전용 테스트 응답입니다. 실제 계정과 탐사 기록은
      사용하지 않습니다.
    </p>
  );
}
function Sky() {
  const { currentPath } = usePageContext();
  return (
    <>
      <Note />
      <p className="eyebrow">SHARED FRONTEND</p>
      <h1>화면 연결을 확인합니다</h1>
      <p>
        메뉴와 로그인 정보, 화면 이동을 확인하는 공간입니다.
        <br />
        은하 지도는 기존 시제품에 보존되어 있습니다.
      </p>
      <div className="fixture-links">
        <Link
          to={pagePath(
            "analysis",
            { ticId: "259377017" },
            { returnTo: currentPath },
          )}
        >
          TIC 259377017 분석으로 이동
        </Link>
        <Link
          to={pagePath(
            "member",
            { memberId: "fixture-probe" },
            { returnTo: currentPath },
          )}
        >
          회원 정보 요청 확인
        </Link>
      </div>
    </>
  );
}
function Analysis() {
  const context = usePageContext();
  return (
    <>
      <Note />
      <h1>분석 화면 연결 자리</h1>
      <p>TIC {context.ticId}</p>
      <p>
        분석 기능은 백지웅님이 연결합니다. 이 화면에서는 실제 분석이나 제출을
        수행하지 않습니다.
      </p>
      <div className="fixture-links">
        <Link
          to={pagePath(
            "historyDetail",
            { historyId: "fixture-history-201" },
            { ticId: context.ticId, returnTo: context.currentPath },
          )}
        >
          분석 기록 연결 확인
        </Link>
        <Link to={context.returnTo}>별지도로 돌아가기</Link>
      </div>
    </>
  );
}
function History() {
  const context = usePageContext();
  return (
    <>
      <Note />
      <h1>분석 기록 연결 자리</h1>
      <p>TIC {context.ticId}</p>
      <p>분석 기록 {context.historyId}</p>
      <Link to={context.returnTo}>분석으로 돌아가기</Link>
    </>
  );
}
function Profile() {
  const session = useSession();
  return (
    <>
      <Note />
      <h1>마이페이지 연결 자리</h1>
      <p>{session.member?.nickname}</p>
      <p>별지도와 같은 로그인 정보를 사용하고 있습니다.</p>
      <Link to="/sky">별지도로 돌아가기</Link>
    </>
  );
}
function readProbe(value: unknown): { nickname: string } {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { nickname?: unknown }).nickname !== "string"
  )
    throw new Error("프로필 응답 형식을 확인해 주세요.");
  return { nickname: (value as { nickname: string }).nickname };
}
function MemberProbe() {
  const context = usePageContext();
  const state = useResource(
    `/v1/members/${encodeURIComponent(context.memberId!)}`,
    readProbe,
  );
  return (
    <>
      <Note />
      <h1>회원 정보 요청 확인</h1>
      {state.loading ? (
        <LoadingState />
      ) : state.error ? (
        <ErrorState error={state.error} retry={state.reload} />
      ) : (
        <p data-testid="probe-result">{state.data?.nickname}</p>
      )}
      <Link to={pagePath("member", { memberId: "fixture-next" })}>
        다음 회원 확인
      </Link>
      <p>
        <Link to={context.returnTo}>이전 화면으로</Link>
      </p>
    </>
  );
}
export const fixturePages: PageSlots = {
  sky: Sky,
  analysis: Analysis,
  historyDetail: History,
  profile: Profile,
  member: MemberProbe,
};
