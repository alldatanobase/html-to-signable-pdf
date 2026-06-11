import { Previewer } from "pagedjs";
import type { MarginsPt, PageSizePt } from "../types";
import { marginCss, pageSizeCss } from "./geometry";
import { cssEscape } from "./measurePlaceholder";

export interface PaginateResult {
  /** One `.pagedjs_pagebox` element per page, in order. These are exactly page-sized. */
  pageBoxes: HTMLElement[];
  /** Removes the off-screen render container from the DOM. */
  destroy: () => void;
}

export interface PaginateConfig {
  pagePt: PageSizePt;
  margins: MarginsPt;
  /** Placeholder classes whose elements must not be split across pages (signature, date, …). */
  placeholderClasses: string[];
  /** Class name that forces a page break before the element it's on. */
  pageBreakClass: string;
  debugOutline?: boolean;
}

/**
 * Paginate an HTML string with Paged.js into discrete, page-sized boxes rendered into an
 * off-screen container. `break-inside: avoid` is forced on every placeholder so none is ever
 * split across a page boundary (which would make a single rect meaningless).
 */
export async function paginate(html: string, config: PaginateConfig): Promise<PaginateResult> {
  const { pagePt, margins, placeholderClasses, pageBreakClass, debugOutline } = config;

  const container = document.createElement("div");
  // Hide the render container without moving it: clip it away at the origin. Two constraints
  // pull against each other here:
  //   1. dom-to-svg reads computed styles, so we must NOT use display:none / visibility:hidden
  //      / opacity:0 — they'd make it capture an invisible page.
  //   2. Paged.js's overflow/break math misbehaves when the container sits at a large negative
  //      offset (e.g. left:-100000px): it over-paginates, emitting duplicate copies of the
  //      first page. So we keep the container at left:0/top:0 and hide it with clip-path
  //      instead, which removes it visually while leaving layout coordinates well-behaved.
  container.style.cssText =
    "position:absolute; left:0; top:0; clip-path:inset(100%); overflow:hidden;";
  document.body.appendChild(container);

  const selectors = placeholderClasses.map((c) => `.${cssEscape(c)}`);
  const css = [
    `@page { size: ${pageSizeCss(pagePt)}; margin: ${marginCss(margins)}; }`,
    ...selectors.map((sel) => `${sel} { break-inside: avoid; box-sizing: border-box; }`),
    // Author-facing forced page break: any element with this class starts on a new page.
    // `page-break-before` is the legacy alias of `break-before`, kept for compatibility.
    `.${cssEscape(pageBreakClass)} { break-before: page; page-break-before: always; }`,
    debugOutline
      ? `${selectors.join(", ")} { background: rgba(255,0,0,0.12); border: 1px dashed #d00; }`
      : "",
  ].join("\n");

  // Paged.js's Polisher injects the processed stylesheet (including our debug-outline / break
  // rules) as <style> elements in document.head and never removes them — Previewer.preview()
  // has no teardown. Left in place, those global class rules (e.g. the debug outline) would
  // restyle the *next* generation's page boxes and accumulate on every run. We hold the
  // previewer so cleanup can call polisher.destroy(), which removes exactly the nodes this
  // run inserted (tracked per-Previewer, so concurrent runs don't clobber each other).
  const previewer = new Previewer();
  const cssUrl = URL.createObjectURL(new Blob([css], { type: "text/css" }));
  try {
    await previewer.preview(html, [cssUrl], container);
  } finally {
    URL.revokeObjectURL(cssUrl);
  }

  const cleanup = () => {
    container.remove();
    previewer.polisher.destroy();
  };

  const pageBoxes = Array.from(
    container.querySelectorAll<HTMLElement>(".pagedjs_pagebox"),
  );
  if (pageBoxes.length === 0) {
    cleanup();
    throw new Error("Paged.js produced no pages; check the input HTML.");
  }

  return { pageBoxes, destroy: cleanup };
}
