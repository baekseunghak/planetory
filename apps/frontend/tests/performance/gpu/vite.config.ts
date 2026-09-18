import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  build: {
    outDir: "test-results/gpu-build",
    rollupOptions: {
      input: fileURLToPath(new URL("./index.html", import.meta.url)),
    },
  },
  preview: { host: "127.0.0.1", port: 58265, strictPort: true },
});
