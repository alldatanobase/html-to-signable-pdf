// Builds a single, minified, self-contained IIFE bundle of the library (and its npm deps:
// dom-to-svg, jspdf, svg2pdf.js, pagedjs). No external runtime, no /pyodide/ directory — the
// signature/date fields are embedded in pure TypeScript. Exposes
// `window.PdfFromTemplate.{htmlToSignablePdf, embedFields, appendSignatureField}`.
//
// Run: npm run build:standalone
import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STANDALONE = join(ROOT, "standalone");
const OUT = join(ROOT, "dist", "standalone", "html-to-signable-pdf.standalone.js");

mkdirSync(join(ROOT, "dist", "standalone"), { recursive: true });
await build({
  entryPoints: [join(STANDALONE, "entry.ts")],
  bundle: true,
  format: "iife",
  globalName: "PdfFromTemplate",
  minify: true,
  platform: "browser",
  target: "es2022",
  legalComments: "none",
  outfile: OUT,
});

const sizeMB = (statSync(OUT).size / 1e6).toFixed(2);
console.log(`[build-standalone] wrote ${OUT.replace(ROOT, "")} (${sizeMB} MB)`);
