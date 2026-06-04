// Standalone IIFE entry. esbuild bundles this (plus dom-to-svg / jspdf / svg2pdf / pagedjs)
// into a single self-contained file exposing `window.PdfFromTemplate`.
export { htmlToSignablePdf, embedFields, appendSignatureField } from "../src/index";
