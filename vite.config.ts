import { defineConfig } from "vite";

// Demo app config. The library core lives in src/ and is exercised by demo/main.ts.
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist/demo",
  },
});
