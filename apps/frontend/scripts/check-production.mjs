import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
const sentinels = [
  "212 개발 검증용 반응",
  "211 개발 검증용 댓글",
  "210 개발 검증용 데이터",
  "community-fixture-209",
  "community-fixture-member-209",
  "209 개발 검증용 데이터",
  "data-camera",
  "군집 비교 실험",
  "comparison-snapshot-204",
  "/dev/galaxy-comparison",
  "galaxy-fixture-204",
  "dev-galaxy-204",
  "204 렌더 검증 도구",
  "sky-fixture-203",
  "sky-fixture-member-203",
  "dev-sky-203",
  "203 개발 검증 화면",
  "auth-fixture-202",
  "dev-auth-202",
  "FIXTURE_NICKNAME_REQUIRED_202",
  "foundation-fixture-member-201",
  "fixture-history-201",
  "연결 확인 계정",
  "FixturePages",
  "/api/session",
  "/accounts",
  "계정 초기화",
  "수동 성과",
];
const files = await readdir("dist", { recursive: true });
for (const file of files.filter((name) => /\.(js|html|json)$/.test(name))) {
  const text = await readFile(join("dist", file), "utf8");
  for (const sentinel of sentinels)
    if (text.includes(sentinel))
      throw new Error(
        `개발 전용 코드가 배포 파일에 포함됨: ${file}: ${sentinel}`,
      );
}
console.log(
  "Production bundle: development fixtures and account controls excluded.",
);
