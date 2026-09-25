// CI 전용 브라우저 테스트 실행기 [S15P21C206-91]. 스위트 목록은 package.json의 test:e2e를 그대로 쓴다.
//
// 505개를 worker 1개로 줄 세우면 약 40분이 걸린다. 두 단계로 나눠 병렬로 돌린다.
// 1. test:browser(253개)는 fixture 서버가 상태를 갖지 않아("Serve-only fixture") 스위트 안에서 병렬로 돈다.
// 2. 나머지는 서버 메모리 상태를 /reset으로 되돌리는 스위트가 있어 안에서는 순서대로 두고,
//    스위트끼리 동시에 돌린다. 스위트마다 포트·outputDir·fixture 서버가 따로라 서로 간섭하지 않는다.
//
// 동시 실행 수(E2E_LANES, 기본 2)는 빌드 노드 vCPU 4개를 다른 job과 나눠 쓰는 것을 기준으로 잡았다.
// 3에서는 CPU 경합으로 WebGL·드래그·스크린샷 테스트가 30초 제한과 값 비교에서 깨졌다(2026-09-25 실측).
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const lanes = Number(process.env.E2E_LANES ?? 2);
const { scripts } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const all = scripts["test:e2e"].split("&&").map((part) => {
  const [, name, extra = ""] = part.trim().match(/^npm run (\S+)(?:\s+--\s+(.*))?$/);
  return { name, args: extra.split(/\s+/).filter(Boolean) };
});

// 부분 실행: E2E_SUITES에 스위트 이름을 쉼표로 적으면 그것만 돈다(test: 접두어는 생략 가능).
// 실패한 스위트만 다시 돌리거나 CI 설정을 고치며 확인할 때 쓴다. 병합 판단의 근거가 아니다.
const wanted = (process.env.E2E_SUITES ?? "").split(",").map((name) => name.trim()).filter(Boolean)
  .map((name) => (name.startsWith("test:") ? name : `test:${name}`));
const unknown = wanted.filter((name) => !all.some((suite) => suite.name === name));
if (unknown.length) throw new Error(`E2E_SUITES에 없는 스위트: ${unknown.join(", ")}`);
const suites = wanted.length ? all.filter((suite) => wanted.includes(suite.name)) : all;
if (wanted.length) console.log(`부분 실행(병합 판단 근거 아님): ${wanted.join(", ")}`);

function run({ name, args }) {
  const started = Date.now();
  console.log(`시작: ${name}`);
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", name, ...(args.length ? ["--", ...args] : [])], {
      shell: process.platform === "win32",
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      const seconds = Math.round((Date.now() - started) / 1000);
      // 동시에 도는 스위트의 출력이 섞이지 않게 끝난 뒤 한 번에 찍는다.
      console.log(`\n===== ${name}: ${code === 0 ? "통과" : "실패"}, ${seconds}초 =====\n${output}`);
      resolve({ name, code, seconds, output });
    });
  });
}

// 병렬로 뜬 브라우저·서버의 나가는 연결이 Linux 임시 포트(32768~60999)에서 fixture 서버 포트를
// 먼저 잡을 수 있다. 테스트 실패가 아니라 서버 기동 실패이므로 그때만 한 번 다시 돌린다.
async function runSuite(suite) {
  const result = await run(suite);
  if (result.code === 0 || !result.output.includes("is already in use")) return result;
  console.log(`포트 충돌로 다시 시작: ${suite.name}`);
  return run(suite);
}

const results = [];
const browser = suites.find((suite) => suite.name === "test:browser");
if (browser) results.push(await runSuite({ ...browser, args: [...browser.args, `--workers=${lanes}`] }));

const queue = suites.filter((suite) => suite !== browser);
await Promise.all(
  Array.from({ length: lanes }, async () => {
    while (queue.length) results.push(await runSuite(queue.shift()));
  }),
);

console.log("\n===== 요약 =====");
for (const { name, code, seconds } of results) console.log(`${code === 0 ? "통과" : "실패"}  ${name}  ${seconds}초`);
process.exit(results.some(({ code }) => code !== 0) ? 1 : 0);
