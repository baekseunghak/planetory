import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Non-deployable comparison build: production React, experimental UI enabled.
// Normal vite.config.ts and dist keep excluding the GPU experiment.
export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.DEV": "true",
    "import.meta.env.VITE_FIXTURE": JSON.stringify("false"),
    "import.meta.env.VITE_API_BASE": JSON.stringify("/api"),
  },
  build: {
    outDir: "test-results/gpu-app-build",
    target: ["chrome110", "edge110", "firefox115", "safari16.4"],
  },
  preview: { host: "127.0.0.1", port: 58266, strictPort: true },
});
