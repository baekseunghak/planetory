import { Builder, By, until } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { createServer, request } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

// A local fault proxy keeps browser cookies and request bodies intact. This
// avoids BiDi interception limitations without changing the app under test.
const upstream = process.env.AUTH_FIXTURE_URL || "http://127.0.0.1:58302";
const port = Number(process.env.FIREFOX_PROXY_PORT || 58303),
  base = `http://127.0.0.1:${port}`;
let mode = "normal",
  writes = 0,
  accepted = false,
  cookieSeen = false;
const proxy = createServer((req, res) => {
  const patch = req.method === "PATCH" && req.url === "/api/v1/me/profile";
  if (patch) writes++;
  if (
    req.url === "/api/v1/me" &&
    req.headers.cookie?.includes("auth-fixture-202-session=")
  )
    cookieSeen = true;
  if (mode === "lookup-failure" && accepted && req.url === "/api/v1/me") {
    res.writeHead(503, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({ code: "UNAVAILABLE", message: "확인 지연" }),
    );
  }
  const out = request(
    new URL(req.url, upstream),
    { method: req.method, headers: req.headers },
    (incoming) => {
      if (patch && incoming.statusCode === 200) accepted = true;
      if (patch && mode === "lost-reply" && incoming.statusCode === 200) {
        incoming.resume();
        incoming.on("end", () => {
          // Deliver headers first: a pre-header disconnect can be retried by the
          // browser transport itself, which is separate from app retry policy.
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Length": "999",
          });
          res.write('{"nickname":');
          setTimeout(() => res.destroy(), 50);
        });
        return;
      }
      res.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(res);
    },
  );
  out.on("error", () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(out);
});
await new Promise((resolve) => proxy.listen(port, "127.0.0.1", resolve));
const results = [],
  folder = "test-results/stock-firefox-native";
await mkdir(folder, { recursive: true });
let driver, version;
const xpath = (tag, text) => By.xpath(`//${tag}[normalize-space(.)='${text}']`);
const element = (by) => driver.wait(until.elementLocated(by), 10000);
const click = async (text) =>
  (
    await element(By.xpath(`//button[contains(normalize-space(.),'${text}')]`))
  ).click();
const visible = async (tag, text) =>
  driver.wait(
    async () => {
      for (const e of await driver.findElements(xpath(tag, text)))
        if (await e.isDisplayed()) return true;
      return false;
    },
    10000,
    `${tag}: ${text}`,
  );
const alert = async (text) =>
  driver.wait(
    async () => {
      const es = await driver.findElements(By.css('[role="alert"]'));
      return (await Promise.all(es.map((e) => e.getText()))).some((t) =>
        t.includes(text),
      );
    },
    10000,
    text,
  );
async function type(text) {
  const e = await element(By.css("input"));
  await e.clear();
  await e.sendKeys(text);
  assert.equal(await e.getAttribute("value"), text);
}
async function scenario(name, fn) {
  mode = "normal";
  writes = 0;
  accepted = false;
  cookieSeen = false;
  driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(
      new firefox.Options()
        .setBinary(
          process.env.FIREFOX_EXECUTABLE ||
            "C:/Program Files/Mozilla Firefox/firefox.exe",
        )
        .addArguments("-headless"),
    )
    .build();
  version = (await driver.getCapabilities()).get("browserVersion");
  try {
    await driver.manage().window().setRect({ width: 1440, height: 1000 });
    await fn();
    results.push({ name, passed: true });
    console.log("PASS", name);
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
    await writeFile(
      `${folder}/${results.length}-failure.png`,
      await driver.takeScreenshot(),
      "base64",
    );
    console.error("FAIL", name, String(error));
  } finally {
    await driver.quit();
  }
}
try {
  await scenario("201-real-cookie-and-route-return", async () => {
    await driver.get(base + "/analysis/259377017?historyId=000123");
    await click("Google 계정으로 로그인");
    await visible("a", "구글탐사자");
    cookieSeen = false;
    await driver.navigate().refresh();
    await driver.wait(
      async () =>
        (await driver.findElement(By.css("body")).getText()).includes(
          "분석 기록 000123",
        ),
      10000,
    );
    assert.equal(cookieSeen, true);
    assert.ok(
      (await driver.getCurrentUrl()).endsWith(
        "/analysis/259377017?historyId=000123",
      ),
    );
  });
  await scenario("202-korean-nickname-validation", async () => {
    await driver.get(base + "/api/dev-auth-202/google?scenario=first");
    await type("Admin");
    await click("이 이름으로 시작하기");
    await alert("사용할 수 없는 닉네임");
    assert.equal(writes, 0);
    await type("이미사용중");
    await click("이 이름으로 시작하기");
    await alert("이미 사용 중인 닉네임");
    assert.equal(
      await (await element(By.css("input"))).getAttribute("value"),
      "이미사용중",
    );
    await type("  새탐사자  ");
    await click("이 이름으로 시작하기");
    await visible("a", "새탐사자");
    assert.equal(writes, 2);
  });
  await scenario("202-accepted-write-lost-reply", async () => {
    await driver.get(base + "/api/dev-auth-202/ssafy?scenario=first");
    mode = "lost-reply";
    await type("응답확인탐사자");
    await click("이 이름으로 시작하기");
    await visible("button", "저장 여부 확인");
    assert.equal(accepted, true);
    assert.equal(writes, 1);
    assert.equal(
      await (await element(By.css("input"))).getAttribute("value"),
      "응답확인탐사자",
    );
    await click("저장 여부 확인");
    await visible("a", "응답확인탐사자");
    assert.equal(writes, 1);
  });
  await scenario("202-write-success-lookup-failure", async () => {
    await driver.get(base + "/login?returnTo=%2Fcommunity%3Fq%3Dfirst");
    await driver.executeScript(
      "sessionStorage.setItem('planetory.oauth.returnTo','/community?q=first')",
    );
    await driver.get(base + "/api/dev-auth-202/google?scenario=first");
    mode = "lookup-failure";
    await type("저장검증");
    await click("이 이름으로 시작하기");
    await visible("h2", "회원 정보를 확인하지 못했습니다");
    assert.equal(
      (await driver.findElements(xpath("button", "메뉴"))).length,
      0,
    );
    mode = "normal";
    // Retry appears only in the member-lookup error state.
    await click("다시 시도");
    await driver.wait(
      async () => (await driver.getCurrentUrl()).endsWith("/community?q=first"),
      10000,
    );
    assert.equal(writes, 1);
  });
} finally {
  await writeFile(
    `${folder}/results.json`,
    JSON.stringify({ browser: version, results }, null, 2),
  );
  await new Promise((resolve) => proxy.close(resolve));
}
if (results.some((r) => !r.passed)) process.exitCode = 1;
