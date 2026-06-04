/** Named page sizes the library knows about. */
export type PageSizeName = "A4" | "Letter";

/** An explicit page size in PDF points (1pt = 1/72 inch). */
export interface PageSizePt {
  widthPt: number;
  heightPt: number;
}

export type PageSize = PageSizeName | PageSizePt;

/** Page margins in PDF points. */
export interface MarginsPt {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Stages reported through {@link HtmlToPdfOptions.onProgress}. */
export type ProgressStage =
  | "paginating"
  | "measuring"
  | "rendering"
  | "embedding-field"
  | "done";

export interface HtmlToPdfOptions {
  /** Page size. Default: `"Letter"`. */
  pageSize?: PageSize;
  /** Page margins in points. Default: 54pt (0.75in) on every side. */
  marginsPt?: MarginsPt;
  /**
   * Class marking elements to replace with a signature field (any number per document).
   * Default: `"pdfdigitalsignaturefield"`. Each element may set `data-field-name` to name its
   * field explicitly; otherwise names are auto-assigned (see {@link signatureFieldPrefix}).
   */
  signatureClass?: string;
  /**
   * Prefix for auto-named signature fields when an element has no `data-field-name`. Fields are
   * numbered in document order: `Signature1`, `Signature2`, … Default: `"Signature"`.
   */
  signatureFieldPrefix?: string;
  /**
   * Class marking elements to replace with a date field (any number per document).
   * Default: `"pdfdatefield"`. Each element may set `data-field-name` to name its field
   * explicitly; otherwise names are auto-assigned (see {@link dateFieldPrefix}).
   */
  dateClass?: string;
  /**
   * Prefix for auto-named date fields when an element has no `data-field-name`. Fields are
   * numbered in document order: `Date1`, `Date2`, … Default: `"Date"`.
   */
  dateFieldPrefix?: string;
  /** Acrobat `AFDate` format string applied to every date field. Default: `"mm/dd/yyyy"`. */
  dateFormat?: string;
  /**
   * Class marking elements to replace with a single- or multi-line text field. Default:
   * `"pdftextfield"`. Supports `data-multiline`, `data-value`, `data-maxlen` on the element.
   */
  textClass?: string;
  /** Prefix for auto-named text fields (`Text1`, `Text2`, …). Default: `"Text"`. */
  textFieldPrefix?: string;
  /**
   * Class marking elements to replace with a checkbox. Default: `"pdfcheckboxfield"`. Supports
   * `data-checked` on the element; the checked on-state export value is `Yes`.
   */
  checkboxClass?: string;
  /** Prefix for auto-named checkbox fields (`Checkbox1`, …). Default: `"Checkbox"`. */
  checkboxFieldPrefix?: string;
  /**
   * Class marking elements to replace with a radio button. Default: `"pdfradiofield"`. Radios
   * sharing a `data-field-name` form one group; each carries a `data-export-value`. Radios with
   * no explicit name are each their own single-button group.
   */
  radioClass?: string;
  /** Prefix for auto-named radio groups (`Radio1`, …). Default: `"Radio"`. */
  radioFieldPrefix?: string;
  /**
   * Class marking elements to replace with a dropdown (combo box). Default: `"pdfdropdownfield"`.
   * Supports `data-options` (`|`-delimited), `data-default`, `data-editable`.
   */
  dropdownClass?: string;
  /** Prefix for auto-named dropdown fields (`Dropdown1`, …). Default: `"Dropdown"`. */
  dropdownFieldPrefix?: string;
  /**
   * Class marking elements to replace with a list box. Default: `"pdflistboxfield"`. Supports
   * `data-options` (`|`-delimited), `data-default`, `data-multiselect`.
   */
  listboxClass?: string;
  /** Prefix for auto-named list-box fields (`ListBox1`, …). Default: `"ListBox"`. */
  listboxFieldPrefix?: string;
  /**
   * Class name that forces a page break before the element it's on (use on any element, or on
   * an empty marker `<div>`). Default: `"pdfpagebreak"`.
   */
  pageBreakClass?: string;
  /**
   * Id of an element whose markup is lifted out of the body and repeated in the **top margin** of
   * every page. Default: `"pdfheader"`. The header lives in the page margin, so {@link marginsPt}
   * must leave room for it; content taller than the top margin is clipped.
   */
  headerId?: string;
  /**
   * Id of an element whose markup is lifted out of the body and repeated in the **bottom margin**
   * of every page. Default: `"pdffooter"`. The footer lives in the page margin, so
   * {@link marginsPt} must leave room for it; content taller than the bottom margin is clipped.
   */
  footerId?: string;
  /**
   * Token replaced with the 1-based current page number inside the header/footer markup.
   * Default: `"[[page]]"`.
   */
  pageNumberToken?: string;
  /**
   * Token replaced with the total page count inside the header/footer markup.
   * Default: `"[[pages]]"`.
   */
  pageCountToken?: string;
  /** Optional progress callback for UI feedback. */
  onProgress?: (stage: ProgressStage, detail?: string) => void;
  /**
   * Draw a visible box over each placeholder in the rendered PDF. Use this once to
   * eyeball that the field widgets line up with where the placeholders rendered.
   */
  debugOutlinePlaceholders?: boolean;
}

/** Where a form field should be placed, in final PDF coordinates. */
export interface FieldPlacement {
  /** 0-based PDF page index. */
  pageIndex: number;
  /** Bounding box `(x1, y1, x2, y2)` in PDF points, origin bottom-left, y axis up. */
  box: [number, number, number, number];
}

/** @deprecated Use {@link FieldPlacement}. Kept for backward compatibility. */
export type SignaturePlacement = FieldPlacement;

/** One widget (placement + export value) of a radio-button group. */
export interface RadioWidget {
  /** Value this button selects when chosen (the `/AP /N` on-state key). */
  exportValue: string;
  /** 0-based PDF page index. */
  pageIndex: number;
  /** Bounding box `(x1, y1, x2, y2)` in PDF points, origin bottom-left, y axis up. */
  box: [number, number, number, number];
}

/**
 * A single AcroForm field to embed. Discriminated by `kind`:
 * - `signature` — a blank digital-signature field (ready to be signed later).
 * - `date` — a blank, fillable date text field (Acrobat `AFDate` formatting).
 * - `text` — a single- or multi-line text field, optionally pre-filled.
 * - `checkbox` — an on/off checkbox (on-state key `Yes`).
 * - `radio` — a radio-button group: one field with N widgets, one export value each.
 * - `dropdown` — a combo box (optionally editable) backed by an options list.
 * - `listbox` — a list box (optionally multi-select) backed by an options list.
 */
export type FieldSpec =
  | ({ kind: "signature"; name: string } & FieldPlacement)
  | ({ kind: "date"; name: string; format: string } & FieldPlacement)
  | ({ kind: "text"; name: string; multiline?: boolean; value?: string; maxLen?: number } & FieldPlacement)
  | ({ kind: "checkbox"; name: string; checked?: boolean } & FieldPlacement)
  | ({ kind: "dropdown"; name: string; options: string[]; value?: string; editable?: boolean } & FieldPlacement)
  | ({ kind: "listbox"; name: string; options: string[]; value?: string; multiSelect?: boolean } & FieldPlacement)
  | { kind: "radio"; name: string; value?: string; widgets: RadioWidget[] };
