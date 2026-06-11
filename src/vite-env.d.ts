/// <reference types="vite/client" />

// Python source files imported as raw strings (Vite ?raw suffix).
declare module "*.py?raw" {
  const src: string;
  export default src;
}

// Paged.js ships no type declarations; declare the minimal surface we use.
declare module "pagedjs" {
  /**
   * Processes stylesheets and injects them as `<style data-pagedjs-inserted-styles>` elements in
   * `document.head`. `destroy()` removes the elements this instance inserted; `preview()` does NOT
   * call it, so callers must, or the (global) injected rules leak across runs.
   */
  export class Polisher {
    destroy(): void;
  }

  export class Previewer {
    constructor(options?: unknown);
    /** The Polisher that owns this previewer's injected head styles (for teardown). */
    readonly polisher: Polisher;
    /**
     * Paginates `content` using `stylesheets`, appending `.pagedjs_page` elements into
     * `renderTo`. Resolves with a flow object describing the rendered pages.
     */
    preview(
      content: string | Node,
      stylesheets: Array<string | object>,
      renderTo: Element,
    ): Promise<{ total: number; pages: unknown[] }>;
  }
}
