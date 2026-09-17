import { build } from "vite";
await build({
  mode: "renderer",
  define: {
    "import.meta.env.VITE_SKY_RENDERER_ENABLED": JSON.stringify("true"),
  },
});
