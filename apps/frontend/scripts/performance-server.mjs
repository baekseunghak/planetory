import { build } from "vite";
import react from "@vitejs/plugin-react";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { galaxyFixturePlugin } from "../dev/galaxy-fixture-plugin.ts";

// A separate, production-compiled benchmark. No fixture is bundled into product dist.
await build({
  configFile: false,
  plugins: [react()],
  define: {
    "import.meta.env.VITE_API_BASE": JSON.stringify("/api"),
    "import.meta.env.VITE_SKY_RENDERER_ENABLED": JSON.stringify("true"),
  },
  build: {
    outDir: "benchmark-dist",
    rollupOptions: { input: "dev/performance.html" },
  },
});
let api;
galaxyFixturePlugin(true).configureServer({
  middlewares: {
    use(prefix, handler) {
      if (prefix === "/api") api = handler;
    },
  },
});
const root = path.resolve("benchmark-dist");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname.startsWith("/api/")) {
    req.url = req.url.slice(4);
    return api(req, res);
  }
  const file = path.resolve(
    root,
    "." + (!path.extname(pathname) ? "/dev/performance.html" : pathname),
  );
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const content = await readFile(file);
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(58360, "127.0.0.1", async () => {
  const response = await fetch(
    "http://127.0.0.1:58360/api/dev-galaxy-204/reset?count=100000",
    { method: "POST" },
  );
  if (!response.ok) throw new Error("Benchmark fixture preparation failed");
  console.log(
    "Benchmark http://127.0.0.1:58360/sky · 100,000 stars / 5,000 planets",
  );
});
