import { jsPDF } from "jspdf";
import { elementToSVG } from "dom-to-svg";
import { svg2pdf } from "svg2pdf.js";
import type { PageSizePt } from "../types";
import { fixTextWrapping } from "./fixTextWrapping";

/**
 * Render each paginated page box to a vector PDF page: capture the live DOM as real SVG
 * (`dom-to-svg`, which emits `<text>` so the PDF text stays selectable), then draw that SVG
 * into a jsPDF page sized to `pagePt`. svg2pdf scales the px-based SVG viewBox to the
 * point-based page, which is the exact same scaling the signature-box geometry uses.
 */
export async function renderPagesToPdf(
  pageBoxes: HTMLElement[],
  pagePt: PageSizePt,
): Promise<Uint8Array> {
  const orientation = pagePt.widthPt > pagePt.heightPt ? "landscape" : "portrait";
  const pdf = new jsPDF({
    unit: "pt",
    format: [pagePt.widthPt, pagePt.heightPt],
    orientation,
  });

  // svg2pdf needs the SVG attached to a rendered document (getComputedStyle / getBBox).
  const host = document.createElement("div");
  host.style.cssText = "position:absolute; left:-100000px; top:0; width:0; height:0; overflow:hidden;";
  document.body.appendChild(host);

  try {
    for (let i = 0; i < pageBoxes.length; i++) {
      if (i > 0) pdf.addPage([pagePt.widthPt, pagePt.heightPt], orientation);

      const svgDoc = elementToSVG(pageBoxes[i]);
      // Repair any paragraphs dom-to-svg collapsed into a single unwrapped line. This must run
      // while the source page box is still laid out, since it re-measures the live text nodes.
      fixTextWrapping(svgDoc.documentElement as unknown as SVGSVGElement, pageBoxes[i]);
      const svgEl = document.importNode(svgDoc.documentElement, true) as unknown as SVGSVGElement;
      host.appendChild(svgEl);
      try {
        await svg2pdf(svgEl, pdf, {
          x: 0,
          y: 0,
          width: pagePt.widthPt,
          height: pagePt.heightPt,
        });
      } finally {
        host.removeChild(svgEl);
      }
    }
  } finally {
    host.remove();
  }

  return removeOpenAction(new Uint8Array(pdf.output("arraybuffer")));
}

/**
 * jsPDF always writes `/OpenAction [<page> 0 R /FitH null]` into the document catalog to set
 * the initial zoom — there is no option to disable it. Recent Adobe Acrobat warns about any
 * document containing embedded actions (OpenAction / Additional Actions). We don't need the
 * initial-zoom action, so blank it out.
 *
 * The replacement is the same byte length (spaces), so every cross-reference offset stays
 * valid and we avoid rewriting the xref table. Operates on the raw bytes; a single-byte
 * decoder keeps char indices aligned to byte indices, and we only overwrite the matched
 * ASCII region of the (uncompressed) catalog dict.
 */
function removeOpenAction(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder("latin1").decode(bytes);
  const match = /\/OpenAction\s*\[[^\]]*\]/.exec(text);
  if (!match) return bytes;
  for (let i = match.index; i < match.index + match[0].length; i++) {
    bytes[i] = 0x20; // ' '
  }
  return bytes;
}
