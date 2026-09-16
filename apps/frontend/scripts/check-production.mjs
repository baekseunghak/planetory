import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
const sentinels = [
  "prototype-observation-10m-mean-v1",
  "프로토타입 관측 데이터입니다",
  "sourceSha256",
  "rm-fixture-182",
  "개발용 합성 응답입니다",
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
