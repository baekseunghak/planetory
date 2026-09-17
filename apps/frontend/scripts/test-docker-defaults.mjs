import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

// Reuse the production browser checks with the actual Docker build-stage ARGs.
// envDir:false matches .dockerignore: local .env files cannot fix a bad default.
const dockerfile = await readFile(
  new URL("../Dockerfile", import.meta.url),
  "utf8",
);
const stage = dockerfile.match(
  /^FROM .+ AS build\s*$([\s\S]*?)(?=^FROM |$(?![\s\S]))/im,
)?.[1];
if (!stage) throw new Error("Docker build stage not found");
for (const key of Object.keys(process.env))
  if (key.startsWith("VITE_")) delete process.env[key];
let count = 0;
for (const line of stage.split(/\r?\n/)) {
  if (!/^ARG VITE_/.test(line)) continue;
  const arg = line.match(
    /^ARG (VITE_[A-Z0-9_]+)=(?:"([^"$]*)"|'([^'$]*)'|([^\s$]+))$/,
  );
  if (!arg)
    throw new Error("Unsupported Docker ARG: use a literal build default");
  process.env[arg[1]] = arg[2] ?? arg[3] ?? arg[4];
  count++;
}
if (!count) throw new Error("No VITE Docker defaults found");
process.env.API_PROXY_TARGET = "";
console.log(
  `Building with ${count} Dockerfile defaults; local VITE overrides excluded.`,
);
const { build } = await import("vite");
await build({ envDir: false, build: { outDir: "dist/docker-defaults" } });

const child = spawn(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config=playwright.production.config.ts",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", env: { ...process.env, FRONTEND_DOCKER_DEFAULTS: "1" } },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
