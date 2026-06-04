// Running header/footer support. Authors mark one `#pdfheader` and/or one `#pdffooter` element in
// their HTML; we lift those elements out of the body *before* pagination (so they don't flow
// inline), then re-inject a per-page copy into every paginated page's top/bottom margin band
// *after* pagination — substituting page-number tokens per page. Because renderPagesToPdf captures
// the whole page box (margins included) to SVG, the injected overlays become real vector content.

export interface ExtractOptions {
  headerId: string;
  footerId: string;
}

export interface ExtractResult {
  /** The input HTML with the header/footer elements removed (styles/head preserved). */
  html: string;
  /** `outerHTML` of the header element, or `null` if absent. */
  headerHtml: string | null;
  /** `outerHTML` of the footer element, or `null` if absent. */
  footerHtml: string | null;
}

/**
 * Parse `html`, lift out the `#headerId` / `#footerId` elements (capturing their `outerHTML`), and
 * return the remaining document serialized back to a string. `<head>`/`<style>` are preserved so
 * document CSS still reaches both Paged.js and the injected copies.
 */
export function extractHeaderFooter(html: string, options: ExtractOptions): ExtractResult {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const take = (id: string): string | null => {
    const el = doc.getElementById(id);
    if (!el) return null;
    const outer = el.outerHTML;
    el.remove();
    return outer;
  };

  const headerHtml = take(options.headerId);
  const footerHtml = take(options.footerId);

  // If neither was present, return the input untouched (avoids a needless re-serialize).
  if (headerHtml === null && footerHtml === null) {
    return { html, headerHtml: null, footerHtml: null };
  }

  return { html: doc.documentElement.outerHTML, headerHtml, footerHtml };
}

export interface InjectOptions {
  headerHtml: string | null;
  footerHtml: string | null;
  pageNumberToken: string;
  pageCountToken: string;
}

/**
 * Inject a per-page copy of the header/footer into every page box's margin band, with
 * `pageNumberToken` → 1-based page number and `pageCountToken` → total page count substituted.
 * The overlays are absolutely positioned within the (position:relative) page box and aligned to
 * the content area's horizontal extent, so they don't reflow body content.
 */
export function injectHeaderFooter(pageBoxes: HTMLElement[], options: InjectOptions): void {
  const { headerHtml, footerHtml, pageNumberToken, pageCountToken } = options;
  if (headerHtml === null && footerHtml === null) return;

  const total = pageBoxes.length;
  for (let i = 0; i < pageBoxes.length; i++) {
    const pageBox = pageBoxes[i];
    const content = contentArea(pageBox);
    const pageRect = pageBox.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();

    // Geometry relative to the page box's top-left.
    const left = contentRect.left - pageRect.left;
    const width = contentRect.width;
    const topBand = contentRect.top - pageRect.top; // top margin height
    const contentBottom = contentRect.bottom - pageRect.top;
    const bottomBand = pageRect.bottom - contentRect.bottom; // bottom margin height

    const subst = (markup: string): string =>
      markup.replaceAll(pageNumberToken, String(i + 1)).replaceAll(pageCountToken, String(total));

    if (headerHtml !== null) {
      pageBox.appendChild(
        overlay(pageBox, subst(headerHtml), { left, width, top: 0, height: topBand }),
      );
    }
    if (footerHtml !== null) {
      pageBox.appendChild(
        overlay(pageBox, subst(footerHtml), {
          left,
          width,
          top: contentBottom,
          height: bottomBand,
        }),
      );
    }
  }
}

/** The Paged.js flow area inside a page box (where body content lives), inset by the page margins. */
function contentArea(pageBox: HTMLElement): HTMLElement {
  return (
    pageBox.querySelector<HTMLElement>(".pagedjs_page_content") ??
    pageBox.querySelector<HTMLElement>(".pagedjs_area") ??
    pageBox
  );
}

interface Band {
  left: number;
  width: number;
  top: number;
  height: number;
}

/** An absolutely-positioned wrapper holding the substituted header/footer markup. */
function overlay(pageBox: HTMLElement, markup: string, band: Band): HTMLElement {
  const el = pageBox.ownerDocument.createElement("div");
  el.style.cssText =
    `position:absolute; left:${band.left}px; width:${band.width}px; ` +
    `top:${band.top}px; height:${band.height}px; overflow:hidden;`;
  el.innerHTML = markup;
  return el;
}
