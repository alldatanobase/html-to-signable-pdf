import { defineConfig } from "vite";
import { resolve } from "node:path";

// Library build: emits an ES module from src/index.ts. Runtime deps are externalized
// so consumers dedupe them; types are emitted separately via `npm run build:types`.
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist/lib",
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: ["dom-to-svg", "jspdf", "svg2pdf.js", "pagedjs"],
    },
  },
});
