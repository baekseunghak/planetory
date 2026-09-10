import { defineConfig,loadEnv } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({mode})=>({
  plugins: [react()],
  server: {
    proxy: { "/api": process.env.API_PROXY_TARGET || loadEnv(mode,process.cwd(),'').API_PROXY_TARGET || "http://127.0.0.1:58242" },
  },
  build: { target: ["chrome110", "edge110", "firefox115", "safari16.4"] },
}));
