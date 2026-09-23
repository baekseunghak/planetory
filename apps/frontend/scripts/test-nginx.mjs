import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";

// Actual Dockerfile + nginx.conf, isolated synthetic backend, Chrome only.
// No existing containers, volumes, accounts or deployed services are used.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = fileURLToPath(
  new URL("../tests/nginx/backend.mjs", import.meta.url),
);
const output = new URL("../test-results/nginx/", import.meta.url);
const id = `planetory-239-${process.pid}-${Date.now()}`;
const frontend = `${id}-frontend`;
const backend = `${id}-backend`;
const image = `${id}:test`;
const created = [];
const results = [];
const startedAt = new Date().toISOString();
let networkCreated = false;
let browser;
await mkdir(output, { recursive: true });
// A failed rerun must not leave the previous run's success as current evidence.
await writeFile(
  new URL("results.json", output),
  JSON.stringify({ startedAt, status: "running", passed: 0 }, null, 2),
);
function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 120000,
  }).trim();
}
async function check(name, run) {
  await run();
  results.push(name);
  console.log(`PASS ${name}`);
}
async function until(check, timeout = 25000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try {
      return await check();
    } catch (error) {
      last = error;
    }
    await delay(250);
  } while (Date.now() < deadline);
  throw last;
}
try {
  docker("info", "--format", "{{.ServerVersion}}");
  execFileSync(
    "docker",
    [
      "build",
      "-f",
      "apps/frontend/Dockerfile",
      "--target",
      "runtime",
      "-t",
      image,
      ".",
    ],
    {
      cwd: root,
      stdio: "inherit",
      timeout: 600000,
    },
  );
  // A dedicated bridge permits the host Chrome test to reach the loopback port.
  docker("network", "create", id);
  networkCreated = true;
  docker(
    "run",
    "-d",
    "--name",
    frontend,
    "--network",
    id,
    "-p",
    "127.0.0.1::8080",
    image,
  );
  created.push(frontend);
  const port = docker("port", frontend, "8080/tcp").split(":").at(-1);
  const base = `http://127.0.0.1:${port}`;
  // Native HTTP preserves a test Host header; Node fetch may replace it.
  const request = (path, options = {}) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        `${base}${path}`,
        {
          method: options.method ?? "GET",
          headers: options.headers,
          signal: AbortSignal.timeout(35000),
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (value !== undefined)
                headers.set(
                  name,
                  Array.isArray(value) ? value.join(", ") : value,
                );
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode,
                headers,
              }),
            );
          });
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  await check("nginx syntax and SPA startup without backend DNS", async () => {
    docker("exec", frontend, "nginx", "-t");
    await until(async () =>
      assert.equal((await request("/login")).status, 200),
    );
    assert.equal((await request("/sky")).status, 200);
  });
  await check(
    "missing backend remains API 502 and OAuth service_unavailable",
    async () => {
      assert.equal((await request("/api/v1/me")).status, 502);
      for (const path of [
        "/oauth2/authorization/google",
        "/login/oauth2/code/google",
      ]) {
        const response = await request(path);
        assert.equal(response.status, 302);
        assert.equal(
          response.headers.get("location"),
          "/oauth/callback?error=service_unavailable",
        );
      }
    },
  );
  docker(
    "run",
    "-d",
    "--name",
    backend,
    "--network",
    id,
    "--network-alias",
    "backend",
    "--mount",
    `type=bind,source=${fixture},target=/fixture.mjs,readonly`,
    "node:22-alpine",
    "node",
    "/fixture.mjs",
  );
  created.push(backend);
  await check(
    "backend arriving after frontend startup resolves without nginx restart",
    async () => {
      await until(async () =>
        assert.equal((await request("/api/v1/me?status=200")).status, 200),
      );
    },
  );
  await check(
    "HTTPS forwarded headers, local fallback, exact URI and write body survive",
    async () => {
      for (const path of [
        "/api/echo?q=a%2Fb&next=x%20y",
        "/oauth2/echo?q=a%2Fb",
        "/login/oauth2/code/google?status=200&code=synthetic%2Fcode",
      ]) {
        const response = await request(path, {
          headers: { Host: "app.planetory.test", "X-Forwarded-Proto": "https" },
        });
        const body = await response.json();
        assert.equal(body.uri, path);
        assert.equal(body.proto, "https");
        assert.equal(body.host, "app.planetory.test");
        assert.equal(body.forwardedHost, "app.planetory.test");
      }
      const local = await (await request("/api/echo")).json();
      assert.equal(local.proto, "http");
      const write = await (
        await request("/api/echo", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-TOKEN": "synthetic",
          },
          body: '{"onboardingDone":true}',
        })
      ).json();
      assert.equal(write.method, "PATCH");
      assert.equal(write.body, '{"onboardingDone":true}');
      assert.equal(write.csrf, "synthetic");
    },
  );
  await check(
    "nginx-generated redirects never expose its internal host or port",
    async () => {
      const response = await request("/assets", {
        headers: { Host: "app.planetory.test", "X-Forwarded-Proto": "https" },
      });
      assert.equal(response.status, 301);
      assert.equal(response.headers.get("location"), "/assets/");
    },
  );
  await check(
    "callback 401/403, cancellation, 502/503/504 and success stay distinct",
    async () => {
      for (const status of [401, 403, 502, 503, 504]) {
        const response = await request(
          `/login/oauth2/code/google?status=${status}`,
        );
        assert.equal(response.status, 302);
        assert.equal(
          response.headers.get("location"),
          `/oauth/callback?error=${status < 500 ? "authentication_failed" : "service_unavailable"}`,
        );
        assert.equal(response.headers.get("cache-control"), "no-store");
      }
      const denied = await request(
        "/login/oauth2/code/google?status=401&error=access_denied",
      );
      assert.equal(
        denied.headers.get("location"),
        "/oauth/callback?error=access_denied",
      );
      const success = await request("/login/oauth2/code/google?status=302");
      assert.equal(success.headers.get("location"), "/oauth/callback");
      assert.match(success.headers.get("set-cookie"), /test-session=synthetic/);
    },
  );
  await check(
    "login entry 502/503/504 is unavailable while authentication errors stay intact",
    async () => {
      for (const status of [401, 403, 502, 503, 504]) {
        const response = await request(`/oauth2/echo?status=${status}`);
        assert.equal(response.status, status < 500 ? status : 302);
        if (status >= 500) {
          assert.equal(
            response.headers.get("location"),
            "/oauth/callback?error=service_unavailable",
          );
          assert.equal(response.headers.get("cache-control"), "no-store");
        }
      }
    },
  );
  await check(
    "API errors including /me keep status and JSON, never become a session 401 or SPA",
    async () => {
      for (const path of ["/api/v1/me", "/api/echo"]) {
        for (const status of [401, 403, 404, 500, 502, 503, 504]) {
          const response = await request(`${path}?status=${status}`);
          assert.equal(response.status, status);
          assert.match(
            response.headers.get("content-type"),
            /application\/json/,
          );
          assert.equal((await response.json()).uri, `${path}?status=${status}`);
        }
      }
    },
  );
  await check(
    "Chrome real nginx displays outage, cancellation and auth failure without provider retry",
    async () => {
      browser = await chromium.launch({ channel: "chrome", headless: true });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      let starts = 0;
      page.on("request", (req) => {
        if (req.url().includes("/oauth2/authorization/")) starts++;
      });
      await page.goto(`${base}/login?returnTo=%2Fme`);
      await page
        .getByRole("button", { name: "Google 계정으로 로그인", exact: true })
        .click();
      await page
        .getByRole("heading", {
          name: "로그인 서비스를 잠시 이용할 수 없습니다",
        })
        .waitFor();
      assert.match(
        await page.getByRole("alert").innerText(),
        /서버에 일시적인 문제/,
      );
      await until(async () => {
        const url = new URL(page.url());
        assert.equal(url.searchParams.has("error"), false);
        assert.equal(url.searchParams.get("returnTo"), "/me");
      });
      assert.equal(starts, 1);
      await page.screenshot({
        path: fileURLToPath(new URL("outage.png", output)),
      });
      for (const [query, title] of [
        ["status=401", "로그인을 완료하지 못했습니다"],
        ["status=403&error=access_denied", "로그인이 취소되었습니다"],
      ]) {
        await page.goto(`${base}/login/oauth2/code/google?${query}`);
        await page.getByRole("heading", { name: title }).waitFor();
      }
      await page.close();
    },
  );
  await writeFile(
    new URL("results.json", output),
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "passed",
        passed: results.length,
        checks: results,
        browser: "Chrome",
        productionOAuthTested: false,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    new URL("results.json", output),
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "failed",
        passed: results.length,
        checks: results,
      },
      null,
      2,
    ),
  );
  for (const container of created) {
    try {
      await writeFile(
        new URL(`${container}.log`, output),
        docker("logs", container),
      );
    } catch {
      /* preserve the original test failure */
    }
  }
  throw error;
} finally {
  await browser?.close();
  for (const container of created.reverse()) docker("rm", "-f", container);
  if (networkCreated) docker("network", "rm", id);
}
