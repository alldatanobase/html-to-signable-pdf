import type { MarginsPt, PageSize, PageSizeName, PageSizePt } from "../types";

export const PT_PER_IN = 72;
export const CSS_PX_PER_IN = 96;
/** CSS pixels are 1/96in, PDF points are 1/72in. */
export const PX_TO_PT = PT_PER_IN / CSS_PX_PER_IN; // 0.75

export const PAGE_SIZES_PT: Record<PageSizeName, PageSizePt> = {
  Letter: { widthPt: 612, heightPt: 792 },
  A4: { widthPt: 595.28, heightPt: 841.89 },
};

export const DEFAULT_MARGINS_PT: MarginsPt = {
  top: 54,
  right: 54,
  bottom: 54,
  left: 54,
};

export function resolvePageSize(size: PageSize = "Letter"): PageSizePt {
  return typeof size === "string" ? PAGE_SIZES_PT[size] : size;
}

/** `@page { size: ... }` value, expressed in inches. */
export function pageSizeCss(p: PageSizePt): string {
  return `${p.widthPt / PT_PER_IN}in ${p.heightPt / PT_PER_IN}in`;
}

/** `@page { margin: ... }` value (top right bottom left), in inches. */
export function marginCss(m: MarginsPt): string {
  return [m.top, m.right, m.bottom, m.left].map((v) => `${v / PT_PER_IN}in`).join(" ");
}

/** A rectangle measured in CSS pixels, relative to the top-left of its page element. */
export interface RectPx {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Convert a placeholder rect (px, measured relative to the page element's top-left and
 * within a page element of `pageElemPx` size) into a PDF box `(x1, y1, x2, y2)` with the
 * PDF origin at the bottom-left and the y axis pointing up.
 *
 * The scale is derived per-axis from the *measured* page element size and the target page
 * size in points, so it stays correct even if the rendered page element isn't exactly
 * `pagePt / PX_TO_PT` pixels — the same viewBox→page scaling svg2pdf applies.
 */
export function rectPxToPdfBox(
  rect: RectPx,
  pageElemPx: { width: number; height: number },
  pagePt: PageSizePt,
): [number, number, number, number] {
  const sx = pagePt.widthPt / pageElemPx.width;
  const sy = pagePt.heightPt / pageElemPx.height;
  const x1 = rect.left * sx;
  const x2 = (rect.left + rect.width) * sx;
  // rect.top is distance from the page top; flip to a bottom-left origin.
  const y2 = pagePt.heightPt - rect.top * sy; // upper edge
  const y1 = pagePt.heightPt - (rect.top + rect.height) * sy; // lower edge
  return [x1, y1, x2, y2];
}
