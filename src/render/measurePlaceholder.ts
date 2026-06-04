import type { RectPx } from "./geometry";

export interface MeasureResult {
  /** The matched placeholder element (so the caller can read e.g. `data-field-name`). */
  element: HTMLElement;
  /** 0-based index of the page (within `pageBoxes`) that contains the placeholder. */
  pageIndex: number;
  /** Placeholder rect in px, relative to the top-left of its page box. */
  rectPx: RectPx;
  /** Size of the page box (px) the placeholder lives in — the denominator for scaling. */
  pageElemPx: { width: number; height: number };
}

/**
 * Locate every element with `placeholderClass` among the paginated page boxes and measure each
 * relative to its page box. Results are returned in document order (page by page, then in DOM
 * order within a page), which lets the caller assign sequential field names deterministically.
 * Returns an empty array if no element has the class.
 *
 * Measuring against the page box (which is rendered in full, margins included) means a single
 * uniform scale maps each rect into PDF space — no separate content-origin math.
 */
export function measurePlaceholders(
  pageBoxes: HTMLElement[],
  placeholderClass: string,
): MeasureResult[] {
  const selector = `.${cssEscape(placeholderClass)}`;
  const out: MeasureResult[] = [];
  for (let i = 0; i < pageBoxes.length; i++) {
    const pageRect = pageBoxes[i].getBoundingClientRect();
    const matches = pageBoxes[i].querySelectorAll<HTMLElement>(selector);
    for (const el of matches) {
      const elRect = el.getBoundingClientRect();
      out.push({
        element: el,
        pageIndex: i,
        rectPx: {
          left: elRect.left - pageRect.left,
          top: elRect.top - pageRect.top,
          width: elRect.width,
          height: elRect.height,
        },
        pageElemPx: { width: pageRect.width, height: pageRect.height },
      });
    }
  }
  return out;
}

/** `CSS.escape` for a class/id token, with a conservative fallback for non-DOM environments. */
export function cssEscape(token: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(token);
  }
  return token.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
