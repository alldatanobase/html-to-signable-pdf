// Works around a dom-to-svg line-detection bug.
//
// dom-to-svg turns each DOM text node into an SVG <text> with one <tspan> per visual line. It
// finds line breaks by extending a Range one character at a time and watching for the moment
// getClientRects() reports a rectangle on a new line — but it compares only the first two
// rectangles of the range (`rects[0].top !== rects[1].top`). When a browser splits a *single*
// visual line into two client rectangles that share the same top (which Chromium/Edge do for
// some lines after a Paged.js page-break reflow), that check never fires for the first line, the
// per-line walk desyncs, and the whole paragraph collapses into one <tspan>. In the PDF that
// tspan renders as one long line that overflows the page instead of wrapping.
//
// We re-derive the correct lines ourselves with the same Range technique, but decide a line
// break by comparing the FIRST and LAST rectangle of the range (so multiple same-line fragments
// are treated as one line), then rebuild the affected <text>'s tspans. dom-to-svg emits its
// <text> elements in the same document order as the text nodes it visited, so we can pair them
// up by walking the DOM in that order. Only <text> elements whose line count actually changed
// are touched; everything dom-to-svg already got right is left alone.

const SVG_NS = "http://www.w3.org/2000/svg";

interface Line {
  text: string;
  /** x of the line's left edge (raw viewport-relative px, matching dom-to-svg's tspans). */
  x: number;
  /** y of the line's bottom edge (dom-to-svg uses dominant-baseline:text-after-edge). */
  y: number;
  /** total advance width of the line (sum of its same-line fragment widths). */
  width: number;
}

/**
 * Repair any paragraphs that dom-to-svg collapsed into a single unwrapped line. `svg` is the
 * `<svg>` dom-to-svg produced for `sourceRoot`; both are mutated/read in place. Coordinates are
 * taken relative to `sourceRoot`'s bounding box, matching the viewBox dom-to-svg emits.
 */
export function fixTextWrapping(svg: SVGSVGElement, sourceRoot: HTMLElement): void {
  const textEls = Array.from(svg.querySelectorAll("text"));
  if (textEls.length === 0) return;

  const textNodes = collectRenderedTextNodes(sourceRoot);
  // dom-to-svg visits text nodes in document order and appends one <text> each, so the two
  // lists line up by index. If they ever don't (defensive), skip rather than corrupt the SVG.
  if (textNodes.length !== textEls.length) return;

  for (let i = 0; i < textEls.length; i++) {
    const textEl = textEls[i];
    const tspanCount = textEl.querySelectorAll("tspan").length;
    const lines = measureLines(textNodes[i]);
    // Only rebuild when our line count disagrees with dom-to-svg's — i.e. it collapsed (or
    // otherwise miscounted) the wrapping. Matching counts mean it already did the right thing.
    if (lines.length > 0 && lines.length !== tspanCount) {
      rebuildTspans(textEl, lines);
    }
  }
}

/** Visible text nodes under `root`, in document order — the order dom-to-svg processes them. */
function collectRenderedTextNodes(root: HTMLElement): Text[] {
  const win = root.ownerDocument.defaultView!;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    if (!node.textContent || !node.textContent.trim()) continue; // dom-to-svg skips empty nodes
    const parent = node.parentElement;
    if (!parent) continue;
    const styles = win.getComputedStyle(parent);
    if (styles.display === "none" || styles.visibility === "hidden") continue;
    out.push(node);
  }
  return out;
}

/**
 * Split a text node into visual lines using its client rectangles. A line break is detected when
 * extending the range by one more character puts the range's LAST rectangle on a different row
 * than its FIRST — which correctly ignores multiple fragments that share a row.
 *
 * Coordinates are the raw viewport-relative `getClientRects()` values, exactly as dom-to-svg
 * writes them onto its tspans (it sets `x`/`y` straight from the line rectangle, with the page
 * box's document offset already baked into the SVG `viewBox`). Subtracting any other origin here
 * would push the rebuilt lines out of the viewBox — which renders them off the page.
 */
function measureLines(textNode: Text): Line[] {
  const text = textNode.textContent ?? "";
  const len = text.length;
  if (len === 0) return [];
  const doc = textNode.ownerDocument;
  const range = doc.createRange();
  const lines: Line[] = [];

  let start = 0;
  for (let end = 1; end <= len; end++) {
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    const rects = range.getClientRects();
    if (rects.length === 0) continue;
    const crossed = rects[rects.length - 1].top !== rects[0].top;
    if (crossed) {
      // Characters [start, end-1) belong to the line we were building.
      lines.push(makeLine(range, textNode, start, end - 1));
      start = end - 1;
      end--; // reconsider this character as the first of the next line
    }
  }
  lines.push(makeLine(range, textNode, start, len));
  return lines;
}

function makeLine(range: Range, textNode: Text, start: number, end: number): Line {
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const rects = Array.from(range.getClientRects());
  const first = rects[0];
  // Sum the widths of fragments on the same row as the first rect (the line's advance width).
  let width = 0;
  for (const r of rects) {
    if (Math.abs(r.top - first.top) < 1) width += r.width;
  }
  return {
    text: range.toString(),
    x: first.left,
    y: first.bottom, // bottom: dom-to-svg sets dominant-baseline:text-after-edge
    width,
  };
}

/** Replace a <text>'s children with one <tspan> per measured line. */
function rebuildTspans(textEl: SVGTextElement, lines: Line[]): void {
  const doc = textEl.ownerDocument;
  while (textEl.firstChild) textEl.removeChild(textEl.firstChild);
  for (const line of lines) {
    const tspan = doc.createElementNS(SVG_NS, "tspan");
    tspan.setAttribute("xml:space", "preserve");
    tspan.setAttribute("x", String(line.x));
    tspan.setAttribute("y", String(line.y));
    tspan.setAttribute("textLength", String(line.width));
    tspan.setAttribute("lengthAdjust", "spacingAndGlyphs");
    tspan.textContent = line.text;
    textEl.appendChild(tspan);
  }
}
