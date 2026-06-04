import type { FieldPlacement, FieldSpec, HtmlToPdfOptions, PageSizePt, RadioWidget } from "./types";
import { DEFAULT_MARGINS_PT, rectPxToPdfBox, resolvePageSize } from "./render/geometry";
import { paginate } from "./render/paginate";
import { measurePlaceholders, type MeasureResult } from "./render/measurePlaceholder";
import { renderPagesToPdf } from "./render/toPdf";
import { extractHeaderFooter, injectHeaderFooter } from "./render/headerFooter";
import { embedFields } from "./sign/embedFields";

export type {
  FieldPlacement,
  FieldSpec,
  HtmlToPdfOptions,
  MarginsPt,
  PageSize,
  PageSizeName,
  PageSizePt,
  ProgressStage,
  SignaturePlacement,
} from "./types";
export { embedFields, appendSignatureField } from "./sign/embedFields";

/**
 * Render an HTML string to a vector PDF (selectable text) and embed blank AcroForm fields
 * wherever the placeholder elements rendered (any number of each):
 * - `class="pdfdigitalsignaturefield"` → a blank digital-signature field (ready to be signed).
 * - `class="pdfdatefield"` → a blank, fillable date field (Acrobat `AFDate` formatting).
 *
 * Each placeholder may carry `data-field-name="…"` to name its field explicitly; otherwise
 * fields are auto-named in document order (`Signature1`, `Signature2`, `Date1`, …).
 *
 * Pipeline: Paged.js paginates the HTML → each page is captured to SVG and drawn into a
 * jsPDF page → each placeholder rect is measured and converted to PDF points → the fields are
 * embedded as a PDF incremental update (pure TypeScript — no Python/WASM runtime). Placeholders
 * are optional; if none are present, the PDF is returned unchanged. (Classes, name prefixes, and
 * date format are configurable via `options`.)
 *
 * Must run in a browser (it relies on the DOM and layout to render and measure).
 *
 * @returns the PDF as bytes (e.g. wrap in `new Blob([bytes], { type: "application/pdf" })`).
 */
export async function htmlToSignablePdf(
  html: string,
  options: HtmlToPdfOptions = {},
): Promise<Uint8Array> {
  const pagePt = resolvePageSize(options.pageSize);
  const margins = options.marginsPt ?? DEFAULT_MARGINS_PT;
  const sigClass = options.signatureClass ?? "pdfdigitalsignaturefield";
  const dateClass = options.dateClass ?? "pdfdatefield";
  const textClass = options.textClass ?? "pdftextfield";
  const checkboxClass = options.checkboxClass ?? "pdfcheckboxfield";
  const radioClass = options.radioClass ?? "pdfradiofield";
  const dropdownClass = options.dropdownClass ?? "pdfdropdownfield";
  const listboxClass = options.listboxClass ?? "pdflistboxfield";
  const sigPrefix = options.signatureFieldPrefix ?? "Signature";
  const datePrefix = options.dateFieldPrefix ?? "Date";
  const textPrefix = options.textFieldPrefix ?? "Text";
  const checkboxPrefix = options.checkboxFieldPrefix ?? "Checkbox";
  const radioPrefix = options.radioFieldPrefix ?? "Radio";
  const dropdownPrefix = options.dropdownFieldPrefix ?? "Dropdown";
  const listboxPrefix = options.listboxFieldPrefix ?? "ListBox";
  const dateFormat = options.dateFormat ?? "mm/dd/yyyy";
  const pageBreakClass = options.pageBreakClass ?? "pdfpagebreak";
  const headerId = options.headerId ?? "pdfheader";
  const footerId = options.footerId ?? "pdffooter";
  const pageNumberToken = options.pageNumberToken ?? "[[page]]";
  const pageCountToken = options.pageCountToken ?? "[[pages]]";
  const progress = options.onProgress ?? (() => {});

  // Lift the running header/footer out of the body before pagination so they don't flow inline.
  const { html: bodyHtml, headerHtml, footerHtml } = extractHeaderFooter(html, {
    headerId,
    footerId,
  });

  progress("paginating");
  const { pageBoxes, destroy } = await paginate(bodyHtml, {
    pagePt,
    margins,
    placeholderClasses: [
      sigClass,
      dateClass,
      textClass,
      checkboxClass,
      radioClass,
      dropdownClass,
      listboxClass,
    ],
    pageBreakClass,
    debugOutline: options.debugOutlinePlaceholders,
  });

  const specs: FieldSpec[] = [];
  let pdfBytes: Uint8Array;
  try {
    // Repeat the header/footer into every page's margin band, with page-number tokens filled in.
    injectHeaderFooter(pageBoxes, { headerHtml, footerHtml, pageNumberToken, pageCountToken });

    progress("measuring");
    const sigs = measurePlaceholders(pageBoxes, sigClass);
    const dates = measurePlaceholders(pageBoxes, dateClass);
    const texts = measurePlaceholders(pageBoxes, textClass);
    const checkboxes = measurePlaceholders(pageBoxes, checkboxClass);
    const radios = measurePlaceholders(pageBoxes, radioClass);
    const dropdowns = measurePlaceholders(pageBoxes, dropdownClass);
    const listboxes = measurePlaceholders(pageBoxes, listboxClass);

    // Group radio widgets into fields: those sharing an explicit data-field-name form one group;
    // each radio without an explicit name is its own single-button group. Build this before
    // reserving names, so each group contributes exactly one (possibly explicit) name.
    const radioGroups = groupRadios(radios, pagePt);

    const box = (m: MeasureResult) => rectPxToPdfBox(m.rectPx, m.pageElemPx, pagePt);

    // Names must be unique across the whole document. Reserve every explicit `data-field-name`
    // first (single-element fields + radio group names), then auto-number the rest per type.
    const taken = new Set<string>();
    reserveExplicitNames(sigs, taken);
    reserveExplicitNames(dates, taken);
    reserveExplicitNames(texts, taken);
    reserveExplicitNames(checkboxes, taken);
    reserveExplicitNames(dropdowns, taken);
    reserveExplicitNames(listboxes, taken);
    for (const g of radioGroups) {
      if (!g.explicitName) continue;
      if (taken.has(g.explicitName)) {
        throw new Error(
          `[html-to-signable-pdf] duplicate data-field-name "${g.explicitName}"; field names must be unique.`,
        );
      }
      taken.add(g.explicitName);
    }

    const assignName = makeNameAssigner(taken);
    for (const m of sigs) {
      specs.push({ kind: "signature", name: assignName(explicitName(m), sigPrefix), ...placement(m, box) });
    }
    for (const m of dates) {
      specs.push({ kind: "date", name: assignName(explicitName(m), datePrefix), format: dateFormat, ...placement(m, box) });
    }
    for (const m of texts) {
      specs.push({
        kind: "text",
        name: assignName(explicitName(m), textPrefix),
        multiline: boolAttr(m, "data-multiline"),
        value: strAttr(m, "data-value"),
        maxLen: intAttr(m, "data-maxlen"),
        ...placement(m, box),
      });
    }
    for (const m of checkboxes) {
      specs.push({
        kind: "checkbox",
        name: assignName(explicitName(m), checkboxPrefix),
        checked: boolAttr(m, "data-checked"),
        ...placement(m, box),
      });
    }
    for (const m of dropdowns) {
      specs.push({
        kind: "dropdown",
        name: assignName(explicitName(m), dropdownPrefix),
        options: optionsAttr(m),
        value: strAttr(m, "data-default"),
        editable: boolAttr(m, "data-editable"),
        ...placement(m, box),
      });
    }
    for (const m of listboxes) {
      specs.push({
        kind: "listbox",
        name: assignName(explicitName(m), listboxPrefix),
        options: optionsAttr(m),
        value: strAttr(m, "data-default"),
        multiSelect: boolAttr(m, "data-multiselect"),
        ...placement(m, box),
      });
    }
    for (const g of radioGroups) {
      specs.push({
        kind: "radio",
        name: g.explicitName ?? assignName(undefined, radioPrefix),
        value: g.value,
        widgets: g.widgets,
      });
    }

    progress("rendering");
    pdfBytes = await renderPagesToPdf(pageBoxes, pagePt);
  } finally {
    // The DOM is no longer needed once measured + rendered; free it.
    destroy();
  }

  if (specs.length === 0) {
    const classes = [sigClass, dateClass, textClass, checkboxClass, radioClass, dropdownClass, listboxClass]
      .map((c) => `.${c}`)
      .join(", ");
    console.warn(
      `[html-to-signable-pdf] no field placeholders (${classes}) found in the HTML; ` +
        "returning a PDF with no fields.",
    );
    progress("done");
    return pdfBytes;
  }

  progress("embedding-field");
  const out = embedFields(pdfBytes, specs);
  progress("done");
  return out;
}

/** An element's explicit `data-field-name`, trimmed, or `undefined` if absent/blank. */
function explicitName(m: MeasureResult): string | undefined {
  const raw = m.element.getAttribute("data-field-name");
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Reserve every explicit field name up front, erroring on duplicates (PDF names must be unique). */
function reserveExplicitNames(matches: MeasureResult[], taken: Set<string>): void {
  for (const m of matches) {
    const name = explicitName(m);
    if (!name) continue;
    if (taken.has(name)) {
      throw new Error(
        `[html-to-signable-pdf] duplicate data-field-name "${name}"; field names must be unique.`,
      );
    }
    taken.add(name);
  }
}

/**
 * Build a name assigner over a shared `taken` set: returns the explicit name if given, otherwise
 * the next free `${prefix}${n}` (n from 1), skipping names already taken (including explicit ones
 * reserved earlier). Per-prefix counters persist across calls so numbering doesn't restart.
 */
function makeNameAssigner(taken: Set<string>): (explicit: string | undefined, prefix: string) => string {
  const counters = new Map<string, number>();
  return (explicit, prefix) => {
    if (explicit) return explicit; // already reserved in `taken`
    let n = counters.get(prefix) ?? 1;
    let name = `${prefix}${n}`;
    while (taken.has(name)) name = `${prefix}${++n}`;
    counters.set(prefix, n + 1);
    taken.add(name);
    return name;
  };
}

// ── Placeholder attribute readers ──────────────────────────────────────────────────────────

/** `{ pageIndex, box }` for a measured placeholder — the common tail of every single-widget spec. */
function placement(m: MeasureResult, box: (m: MeasureResult) => FieldPlacement["box"]): FieldPlacement {
  return { pageIndex: m.pageIndex, box: box(m) };
}

/** A boolean `data-*` attribute: present and not `"false"`/`"0"` → true. */
function boolAttr(m: MeasureResult, attr: string): boolean {
  if (!m.element.hasAttribute(attr)) return false;
  const v = m.element.getAttribute(attr)?.trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

/** A trimmed string `data-*` attribute, or `undefined` if absent/blank. */
function strAttr(m: MeasureResult, attr: string): string | undefined {
  const v = m.element.getAttribute(attr)?.trim();
  return v ? v : undefined;
}

/** A non-negative integer `data-*` attribute, or `undefined` if absent/invalid. */
function intAttr(m: MeasureResult, attr: string): number | undefined {
  const v = strAttr(m, attr);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** The `data-options` list, split on `|`, trimmed, with blanks dropped. */
function optionsAttr(m: MeasureResult): string[] {
  const raw = m.element.getAttribute("data-options") ?? "";
  return raw.split("|").map((o) => o.trim()).filter((o) => o.length > 0);
}

interface RadioGroup {
  /** Explicit `data-field-name` shared by the group, or `undefined` (auto-named singleton). */
  explicitName?: string;
  /** Currently-selected export value, from the widget marked `data-checked`. */
  value?: string;
  widgets: RadioWidget[];
}

/**
 * Group radio placeholders into fields. Radios sharing an explicit `data-field-name` form one
 * group (document order preserved); each radio without an explicit name is its own singleton.
 * Each widget's export value comes from `data-export-value`, else an auto `Option{i}`; export
 * values must be unique within a group. The selected value is the (first) widget with `data-checked`.
 */
function groupRadios(matches: MeasureResult[], pagePt: PageSizePt): RadioGroup[] {
  const named = new Map<string, RadioGroup>();
  const groups: RadioGroup[] = [];

  for (const m of matches) {
    const explicit = explicitName(m);
    let group: RadioGroup;
    if (explicit) {
      const existing = named.get(explicit);
      if (existing) {
        group = existing;
      } else {
        group = { explicitName: explicit, widgets: [] };
        named.set(explicit, group);
        groups.push(group);
      }
    } else {
      group = { widgets: [] };
      groups.push(group);
    }

    const exportValue = strAttr(m, "data-export-value") ?? `Option${group.widgets.length + 1}`;
    if (group.widgets.some((w) => w.exportValue === exportValue)) {
      throw new Error(
        `[html-to-signable-pdf] duplicate radio data-export-value "${exportValue}"` +
          (explicit ? ` in group "${explicit}"` : "") +
          "; export values must be unique within a group.",
      );
    }
    group.widgets.push({
      exportValue,
      pageIndex: m.pageIndex,
      box: rectPxToPdfBox(m.rectPx, m.pageElemPx, pagePt),
    });
    if (boolAttr(m, "data-checked") && group.value === undefined) group.value = exportValue;
  }

  return groups;
}
