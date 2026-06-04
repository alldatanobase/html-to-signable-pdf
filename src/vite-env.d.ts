/// <reference types="vite/client" />

// Python source files imported as raw strings (Vite ?raw suffix).
declare module "*.py?raw" {
  const src: string;
  export default src;
}

// Paged.js ships no type declarations; declare the minimal surface we use.
declare module "pagedjs" {
  export class Previewer {
    constructor(options?: unknown);
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
