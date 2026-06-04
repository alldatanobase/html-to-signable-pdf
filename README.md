# html-to-signable-pdf

Turn an HTML string into a **vector PDF** (selectable text) in the browser and embed blank
AcroForm fields wherever placeholder elements render — **any number of each**:

- `<div class="pdfdigitalsignaturefield">` → a **blank digital‑signature field**.
- `<div class="pdfdatefield">` → a **blank, fillable date field** (Acrobat `AFDate` formatting).

Each placeholder may set `data-field-name="…"` to name its field; otherwise fields are auto-named
in document order (`Signature1`, `Signature2`, `Date1`, …).

The fields are written in **pure TypeScript** by appending a PDF *incremental update* — no
Python, no WebAssembly, no server, no CDN. The whole pipeline runs in the browser with three
small npm dependencies.

The fields are *empty*: no signing or filling happens here. The output is a PDF that is ready
for a real signature to be applied later (by a person in a PDF viewer) and for the date to be
typed in. Both placeholders are optional and their classes/field names are configurable.

## How it works

The coordinates are the whole problem: we must know which PDF page each placeholder lands on
and its exact rectangle in PDF points. We solve this by making **one DOM the single source
of truth** for both the rendered page and the field rectangles:

```
HTML string
  │  Paged.js paginates into page-sized boxes (break-inside:avoid on each placeholder,
  │  so it is never split across a page boundary)
  ▼
  ├─ dom-to-svg captures each page box as real SVG (<text>, so PDF text stays selectable)
  │  → svg2pdf draws it into a jsPDF page sized in points
  │
  └─ each placeholder is measured relative to its page box; the same viewBox→page scale
     converts it to a PDF box (x1,y1,x2,y2), origin bottom-left
  ▼
  a pure-TS PDF incremental update embeds the blank fields (signature, date) at {page, box}
  ▼
  Uint8Array (PDF bytes)
```

Because `dom-to-svg` sets the SVG `viewBox` to the page box's bounding rect and `svg2pdf`
scales that viewBox into the point-sized page, the rendered content and the computed field
boxes share one transform — they cannot drift apart.

### Why an incremental update?

Acrobat's signing engine doesn't just read a PDF — it *appends* the signature as its own
revision, and to compute the signed byte range it needs a `/Prev` pointer chain back through
the previous revision. A single-revision PDF has no `/Prev`, which surfaces as the
"could not find startxref address" signing error. So instead of rewriting the file, we leave
the jsPDF base revision byte-for-byte intact and append a second revision that:

- re-emits the **catalog** with `/AcroForm` added (and `/OpenAction` / `/AA` removed),
- re-emits each affected **page** with the field widget(s) appended to its `/Annots`, and
- adds the new field objects — for a signature, an `/FT /Sig` widget with `/F 132` and an
  empty `/AP /N` appearance XObject; for a date, an `/FT /Tx` widget with `AFDate` format and
  keystroke actions — plus the `/AcroForm` dictionary (`/SigFlags 1`, `/DR`).

The appended xref lists only the new/updated objects and its trailer's `/Prev` points back to
the base xref, forming the pointer chain Acrobat requires. jsPDF already writes a trailer
`/ID` and uses the xref entry format Acrobat expects, so both are carried straight through.

> **Note on embedded actions.** jsPDF always writes an `/OpenAction` (initial fit-width
> zoom) into the catalog, which makes recent Adobe Acrobat show a warning about "embedded
> actions". We don't need it, so the renderer blanks it out in place (offset-preserving, so
> the base xref stays valid) and the incremental update re-emits the catalog without
> `/OpenAction` / `/AA`. The output contains no document actions.

## Quick start

```bash
npm install
npm run dev               # open the demo, paste HTML, Generate
```

No runtime to vendor and no network access at generate time — everything is bundled.

## Usage

```ts
import { htmlToSignablePdf } from "html-to-signable-pdf";

const bytes = await htmlToSignablePdf(htmlString, {
  pageSize: "Letter",                            // "Letter" | "A4" | { widthPt, heightPt }
  marginsPt: { top: 54, right: 54, bottom: 54, left: 54 },
  signatureClass: "pdfdigitalsignaturefield",    // default
  signatureFieldPrefix: "Signature",             // default → Signature1, Signature2, …
  dateClass: "pdfdatefield",                     // default
  dateFieldPrefix: "Date",                       // default → Date1, Date2, …
  dateFormat: "mm/dd/yyyy",                      // default (Acrobat AFDate format)
  onProgress: (stage) => console.log(stage),
});

const blob = new Blob([bytes.slice()], { type: "application/pdf" });
// download / preview the blob
```

### The placeholder contract

- Mark fields by **class** (you can have **any number** of each). The signature and date fields are
  the headline pair; the full set of controls is in [Form field controls](#form-field-controls)
  below:
  - `class="pdfdigitalsignaturefield"` → blank digital-signature field.
  - `class="pdfdatefield"` → blank, fillable date field.
- **Name a field** by adding `data-field-name="…"` to the element. Names must be unique across
  the document (a duplicate throws). Placeholders without it are auto-named in document order
  (`Signature1`, `Signature2`, `Date1`, …), skipping any name already taken by an explicit one.
- **Give each a definite size** (e.g. `height: 56pt; width: 100%`). The element reserves the
  space the widget occupies; an empty, zero-height div produces a zero-height box.
- The placeholders' visible content does not matter — the widgets are drawn blank.
- Each placeholder is optional. If none are present you get the PDF with **no** fields (and
  a console warning).

```html
<!-- explicitly named -->
<div class="pdfdigitalsignaturefield" data-field-name="BuyerSignature"></div>
<div class="pdfdatefield" data-field-name="BuyerDate"></div>
<!-- auto-named Signature1 / Date1 -->
<div class="pdfdigitalsignaturefield"></div>
<div class="pdfdatefield"></div>
```

### Form field controls

Beyond signature and date, the library embeds the standard AcroForm controls. Mark each with a
class, size it with CSS, and optionally name it with `data-field-name`. Auto-names use the prefix
shown (`Text1`, `Checkbox1`, …).

| Control | Class | `data-*` attributes | Auto-name prefix |
| --- | --- | --- | --- |
| Text (single/multi-line) | `pdftextfield` | `data-multiline`, `data-value`, `data-maxlen` | `Text` |
| Checkbox | `pdfcheckboxfield` | `data-checked` | `Checkbox` |
| Radio button | `pdfradiofield` | `data-export-value`, `data-checked` | `Radio` |
| Dropdown (combo) | `pdfdropdownfield` | `data-options`, `data-default`, `data-editable` | `Dropdown` |
| List box | `pdflistboxfield` | `data-options`, `data-default`, `data-multiselect` | `ListBox` |

```html
<div class="pdftextfield" data-field-name="FullName" data-maxlen="60"></div>
<div class="pdftextfield" data-multiline="true"></div>
<div class="pdfcheckboxfield" data-field-name="AgreeTOS" data-checked="true"></div>
<div class="pdfdropdownfield" data-options="Email|Phone|Mail" data-default="Email"></div>
<div class="pdflistboxfield" data-options="A|B|C" data-multiselect="true"></div>
```

**Radio groups.** Radios that share a `data-field-name` form one mutually-exclusive group; each
carries a `data-export-value` (the value selected when that button is chosen), and the one marked
`data-checked` is selected. Export values must be unique within a group. A radio with no explicit
name is its own single-button group.

```html
<div class="pdfradiofield" data-field-name="Plan" data-export-value="basic"></div>
<div class="pdfradiofield" data-field-name="Plan" data-export-value="pro" data-checked="true"></div>
```

**Options** for dropdowns/list boxes are a `|`-delimited `data-options` list; `data-default`
pre-selects one. **Checkbox and radio appearances** (the check mark / dot) are drawn by the library
so they show in every viewer. For **text/choice default values** the library sets the AcroForm
`/NeedAppearances` flag, so the viewer regenerates the field's appearance on open. Every class is
configurable via options (`textClass`, `checkboxClass`, `radioClass`, `dropdownClass`,
`listboxClass`, and the matching `…FieldPrefix`).

### Forcing a page break

Add `class="pdfpagebreak"` to any element to force it to start on a new page, or drop in an
empty `<div class="pdfpagebreak"></div>` as a standalone break marker:

```html
<div class="pdfpagebreak"></div>   <!-- everything after this starts a new page -->
<h2 class="pdfpagebreak">Appendix A</h2>   <!-- this heading starts a new page -->
```

The class name is configurable via the `pageBreakClass` option (default `"pdfpagebreak"`).
Avoid putting a bare marker as the very first element — a break before the first element can
produce a blank first page.

### Running header & footer

Mark **one** running header and/or footer with `id="pdfheader"` / `id="pdffooter"`. They are
lifted out of the body before pagination and repeated in the **top / bottom margin** of every
page. Two tokens are substituted per page:

- `[[page]]` → the 1-based current page number
- `[[pages]]` → the total page count

```html
<div id="pdfheader"><span>Field Operations Manual</span></div>
<div id="pdffooter">Page [[page]] of [[pages]]</div>
```

Because the header/footer live in the page **margins**, set `marginsPt` large enough to hold
them (content taller than the margin band is clipped). They can hold rich markup and are styled
by your document's `<style>` (id, class, or inline) like any other element. The ids and tokens
are configurable via `headerId` / `footerId` / `pageNumberToken` / `pageCountToken`.

### Supported HTML/CSS

This targets **simple documents**: headings, paragraphs, lists, basic tables, flexbox,
borders/backgrounds, and the standard PDF font families (Helvetica/Arial, Times, Courier).
Out of scope: JavaScript-driven content (Paged.js renders static HTML), embedded custom
fonts (text falls back to a standard family), and exotic CSS. If something renders wrong,
simplify the markup/CSS to fit. Use the demo's **Debug outline** toggle to confirm each field
box lines up with where its placeholder rendered.

## API

| Export | Description |
| --- | --- |
| `htmlToSignablePdf(html, options?)` | End-to-end: HTML → PDF bytes with the blank field(s). |
| `embedFields(pdfBytes, specs)` | Lower-level: embed a list of `FieldSpec` (signature/date) at known `{ pageIndex, box }` into an existing PDF. Synchronous. |
| `appendSignatureField(pdfBytes, placement, fieldName)` | Deprecated thin wrapper over `embedFields` for a single signature. |

See `src/types.ts` for `HtmlToPdfOptions`, `FieldSpec`, `FieldPlacement`, etc.

## Verifying the fields

The output PDF contains real, blank AcroForm fields. To confirm:

- **Adobe Acrobat Reader** shows a clickable “sign here” field at the signature placeholder
  and a date field (which formats input to the configured pattern) at the date placeholder.
- **pdf-lib**: `(await PDFDocument.load(bytes)).getForm().getFields()` lists both fields; check
  each widget `/Rect` against the expected box.

## Deploying

`npm run build` outputs the demo to `dist/demo/`. Serve it from any static host — there are no
extra runtime assets to vendor and no special `Content-Type` requirements.

The **library** build (`npm run build:lib` + `npm run build:types`) emits `dist/lib/index.js`
and `dist/types/`. Runtime deps (`dom-to-svg`, `jspdf`, `svg2pdf.js`, `pagedjs`) are
externalized for the consumer to dedupe. The **standalone** build
(`npm run build:standalone`) emits a single self-contained IIFE at
`dist/standalone/html-to-signable-pdf.standalone.js` exposing `window.PdfFromTemplate`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` / `build` / `preview` | Demo app (Vite). |
| `npm run build:lib` / `build:types` | Library ESM + `.d.ts`. |
| `npm run build:standalone` | Single self-contained IIFE bundle (`window.PdfFromTemplate`). |
| `npm run typecheck` | `tsc --noEmit`. |

## Limitations

- Browser only (needs the DOM and layout to render and measure; `embedFields` itself is
  environment-agnostic and also runs in Node).
- Keep HTML/CSS simple (see above).
- The PDF reader/writer handles the classic xref-table PDFs jsPDF produces; it does not parse
  cross-reference streams.
