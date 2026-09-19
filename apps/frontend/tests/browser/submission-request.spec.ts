import { expect, test } from "@playwright/test";
import { PERIODOGRAM_FIXTURE_TICS } from "../../dev/periodogram-fixtures.ts";

// 보존한 요청 ID는 초안과 같은 접두사를 써서 로그아웃 정리에 함께 지워진다.
// 공용 파일(auth/session-draft-storage.ts)을 고치지 않기 위한 전제이므로,
// 그 파일이 접두사를 바꾸면 여기서 드러나야 한다. 단위 검사는 접두사가 같다는
// 것만 보고 실제로 지워지는지는 보지 못한다.
test("a kept request id is cleared by the shared draft cleanup, and nothing else is", async ({
  page,
}) => {
  await page.goto(`/analysis/${PERIODOGRAM_FIXTURE_TICS.normal}`);
  const result = await page.evaluate(async () => {
    const paths = [
      "/src/features/analysis/submission-request.ts",
      "/src/auth/session-draft-storage.ts",
    ];
    const [request, auth] = await Promise.all(
      paths.map((path) => import(/* @vite-ignore */ path)),
    );
    const key = request.submissionStorageKey("u-209", "259377024");
    const reserved = request.reserveRequestId(
      key,
      request.submissionFingerprint({ memo: "확인" }),
    );
    const unrelated = "unrelated:key";
    sessionStorage.setItem(unrelated, "keep me");
    const stored = sessionStorage.getItem(key);
    auth.clearSessionDrafts();
    const survivor = sessionStorage.getItem(unrelated);
    sessionStorage.removeItem(unrelated);
    return {
      requestId: reserved.requestId,
      volatile: reserved.volatile,
      storedBefore: stored !== null,
      storedAfter: sessionStorage.getItem(key) !== null,
      unrelatedSurvived: survivor === "keep me",
    };
  });
  expect(result.requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  // 실제 브라우저 저장소에서는 휘발이 아니다.
  expect(result.volatile).toBe(false);
  expect(result.storedBefore).toBe(true);
  expect(result.storedAfter).toBe(false);
  expect(result.unrelatedSurvived).toBe(true);
});
