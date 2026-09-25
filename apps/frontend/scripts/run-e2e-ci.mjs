// CI 전용 브라우저 테스트 실행기 [S15P21C206-91]. 스위트 목록은 package.json의 test:e2e를 그대로 쓴다.
//
// 505개를 worker 1개로 줄 세우면 약 40분이 걸린다. 두 단계로 나눠 병렬로 돌린다.
// 1. test:browser(253개)는 fixture 서버가 상태를 갖지 않아("Serve-only fixture") 스위트 안에서 병렬로 돈다.
// 2. 나머지는 서버 메모리 상태를 /reset으로 되돌리는 스위트가 있어 안에서는 순서대로 두고,
//    스위트끼리 동시에 돌린다. 스위트마다 포트·outputDir·fixture 서버가 따로라 서로 간섭하지 않는다.
//
// 동시 실행 수(E2E_LANES, 기본 3)는 빌드 노드 vCPU 4개를 다른 job과 나눠 쓰는 것을 기준으로 잡았다.
// 올리면 CPU 경합으로 WebGL·애니메이션 테스트가 30초 제한에 걸릴 수 있다.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const lanes = Number(process.env.E2E_LANES ?? 3);
const { scripts } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const suites = scripts["test:e2e"].split("&&").map((part) => {
  const [, name, extra = ""] = part.trim().match(/^npm run (\S+)(?:\s+--\s+(.*))?$/);
  return { name, args: extra.split(/\s+/).filter(Boolean) };
});

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
      resolve({ name, code, seconds });
    });
  });
}

const results = [];
const browser = suites.find((suite) => suite.name === "test:browser");
results.push(await run({ ...browser, args: [...browser.args, `--workers=${lanes}`] }));

const queue = suites.filter((suite) => suite !== browser);
await Promise.all(
  Array.from({ length: lanes }, async () => {
    while (queue.length) results.push(await run(queue.shift()));
  }),
);

console.log("\n===== 요약 =====");
for (const { name, code, seconds } of results) console.log(`${code === 0 ? "통과" : "실패"}  ${name}  ${seconds}초`);
process.exit(results.some(({ code }) => code !== 0) ? 1 : 0);
