import type { FieldPlacement, FieldSpec } from "../types";
import {
  PdfDocument,
  asName,
  dictGet,
  latin1Bytes,
  pArr,
  pBool,
  pDict,
  pName,
  pNum,
  pRef,
  pStr,
  serialize,
  type PdfValue,
} from "./pdf";

// AcroForm field flags (/Ff). See PDF 32000 §12.7.4.
const FF_MULTILINE = 1 << 12; // 4096   (text)
const FF_RADIO = 1 << 15; // 32768   (button)
const FF_COMBO = 1 << 17; // 131072  (choice → dropdown)
const FF_EDIT = 1 << 18; // 262144  (choice → editable combo)
const FF_MULTISELECT = 1 << 21; // 2097152 (choice → list box)

/**
 * Embed a list of blank AcroForm fields (signature and/or date) into `pdfBytes` by appending a
 * single PDF *incremental update* — no Pyodide, no pyHanko, pure TypeScript. Returns the updated
 * PDF (or the input unchanged if `specs` is empty).
 *
 * Why an incremental update rather than rewriting the file: Acrobat's signing engine *appends*
 * the signature as its own incremental revision, and to compute the signed byte range it needs a
 * `/Prev` pointer chain back through the previous revision. A single-revision PDF has no `/Prev`,
 * which is exactly the "could not find startxref address" failure. So we leave the jsPDF base
 * revision byte-for-byte intact and append a second revision that re-emits the catalog (with
 * `/AcroForm`) and the affected pages (with `/Annots`), plus the new field objects.
 */
export function embedFields(pdfBytes: Uint8Array, specs: FieldSpec[]): Uint8Array {
  if (specs.length === 0) return pdfBytes;

  const doc = new PdfDocument(pdfBytes);

  const rootRef = dictGet(doc.trailer, "Root");
  if (!rootRef || rootRef.t !== "ref") throw new Error("PDF: trailer has no /Root reference");
  const catalogNum = rootRef.num;
  const catalog = doc.getObject(catalogNum);
  if (catalog.t !== "dict") throw new Error("PDF: /Root is not a catalog dictionary");

  const pages = collectPages(doc, catalog);

  // ── Allocate object numbers for everything we add ────────────────────────────────────────
  let nextNum = doc.maxObjectNumber() + 1;
  const alloc = () => nextNum++;

  const updated = new Map<number, string>(); // object number -> serialized body (no obj/endobj)
  const annotRefsByPage = new Map<number, PdfValue[]>(); // page index -> widget refs for /Annots
  const allFieldRefs: PdfValue[] = []; // top-level fields for /AcroForm /Fields
  let hasSignature = false;
  let needsHelv = false; // any text/date/choice field → Helvetica in /DR
  let needsZapf = false; // any checkbox/radio → ZapfDingbats for the check/dot glyph
  let needsAppearances = false; // any text/choice carries a default value

  // Register a widget annotation on the page it lives on (for the page's /Annots array).
  const addAnnot = (pageIndex: number, ref: PdfValue): void => {
    const list = annotRefsByPage.get(pageIndex);
    if (list) list.push(ref);
    else annotRefsByPage.set(pageIndex, [ref]);
  };

  const requirePage = (pageIndex: number, name: string): PageEntry => {
    const page = pages[pageIndex];
    if (!page) {
      throw new Error(
        `PDF: field "${name}" targets page index ${pageIndex}, but the document has ` +
          `${pages.length} page(s).`,
      );
    }
    return page;
  };

  for (const spec of specs) {
    if (spec.kind === "radio") {
      // One parent field with N child widgets (one per option), spread across pages.
      const parentNum = alloc();
      const kidRefs: PdfValue[] = [];
      for (const w of spec.widgets) {
        const page = requirePage(w.pageIndex, spec.name);
        const kidNum = alloc();
        const onNum = alloc();
        const offNum = alloc();
        const selected = spec.value === w.exportValue;
        updated.set(kidNum, serialize(radioKid(w, page.num, parentNum, onNum, offNum, selected)));
        updated.set(onNum, glyphAppearance(w.box, "l")); // filled dot
        updated.set(offNum, glyphAppearance(w.box, "")); // empty
        const kidRef = pRef(kidNum);
        kidRefs.push(kidRef);
        addAnnot(w.pageIndex, kidRef);
      }
      updated.set(parentNum, serialize(radioParent(spec, kidRefs)));
      allFieldRefs.push(pRef(parentNum));
      needsZapf = true;
      continue;
    }

    const page = requirePage(spec.pageIndex, spec.name);
    const fieldNum = alloc();
    const fieldRef = pRef(fieldNum);

    switch (spec.kind) {
      case "signature": {
        hasSignature = true;
        const apNum = alloc();
        updated.set(fieldNum, serialize(signatureField(spec, page.num, apNum)));
        updated.set(apNum, appearanceXObject(spec.box));
        break;
      }
      case "date": {
        needsHelv = true;
        updated.set(fieldNum, serialize(dateField(spec, page.num)));
        break;
      }
      case "text": {
        needsHelv = true;
        if (spec.value) needsAppearances = true;
        updated.set(fieldNum, serialize(textField(spec, page.num)));
        break;
      }
      case "checkbox": {
        needsZapf = true;
        const onNum = alloc();
        const offNum = alloc();
        updated.set(fieldNum, serialize(checkboxField(spec, page.num, onNum, offNum)));
        updated.set(onNum, checkboxAppearance(spec.box, true));
        updated.set(offNum, checkboxAppearance(spec.box, false));
        break;
      }
      case "dropdown":
      case "listbox": {
        needsHelv = true;
        if (spec.value) needsAppearances = true;
        updated.set(fieldNum, serialize(choiceField(spec, page.num)));
        break;
      }
    }

    allFieldRefs.push(fieldRef);
    addAnnot(spec.pageIndex, fieldRef);
  }

  // ── Default-resource fonts (/DR). Text/date/choice fields build their appearance from /DA,
  //    which names a font that must exist in /DR; checkbox/radio appearance streams draw their
  //    glyph with ZapfDingbats. Only emit the fonts actually needed. ───────────────────────────
  let helvRef: PdfValue | undefined;
  let zapfRef: PdfValue | undefined;
  if (needsHelv) {
    const n = alloc();
    updated.set(n, serialize(fontDict("Helvetica", "WinAnsiEncoding")));
    helvRef = pRef(n);
  }
  if (needsZapf) {
    const n = alloc();
    updated.set(n, serialize(fontDict("ZapfDingbats")));
    zapfRef = pRef(n);
  }

  // ── AcroForm ─────────────────────────────────────────────────────────────────────────────
  const acroNum = alloc();
  updated.set(
    acroNum,
    serialize(acroForm(allFieldRefs, { hasSignature, needsAppearances, helvRef, zapfRef })),
  );

  // ── Re-emit the catalog: add /AcroForm, drop document-level actions (/OpenAction, /AA) so
  //    Acrobat doesn't warn about "embedded actions". ──────────────────────────────────────
  const newCatalog = cloneDict(catalog);
  newCatalog.delete("OpenAction");
  newCatalog.delete("AA");
  newCatalog.set("AcroForm", pRef(acroNum));
  updated.set(catalogNum, serialize({ t: "dict", v: newCatalog }));

  // ── Re-emit each affected page with the field widget(s) appended to its /Annots ──────────
  for (const [pageIndex, refs] of annotRefsByPage) {
    const page = pages[pageIndex];
    const newPage = cloneDict(page.dict);
    const existing = doc.resolve(newPage.get("Annots"));
    const annots = existing && existing.t === "array" ? [...existing.v] : [];
    newPage.set("Annots", pArr([...annots, ...refs]));
    updated.set(page.num, serialize({ t: "dict", v: newPage }));
  }

  return appendIncrementalUpdate(doc, updated, catalogNum);
}

/**
 * Convenience wrapper for the common single blank-signature case.
 * @deprecated Prefer {@link embedFields}.
 */
export function appendSignatureField(
  pdfBytes: Uint8Array,
  placement: FieldPlacement,
  fieldName: string,
): Uint8Array {
  return embedFields(pdfBytes, [{ kind: "signature", name: fieldName, ...placement }]);
}

// ── Object builders ──────────────────────────────────────────────────────────────────────

/**
 * A merged signature field + widget annotation (`/FT /Sig`). `/V` is intentionally absent — the
 * PDF reader writes it when the user actually signs. `/F 132` is Print (4) + Locked (128), which
 * matches what Acrobat itself writes for signature fields. The empty `/AP /N` appearance must
 * exist before Acrobat will prepare a signing context.
 */
function signatureField(
  spec: Extract<FieldSpec, { kind: "signature" }>,
  pageNum: number,
  apNum: number,
): PdfValue {
  return pDict({
    Type: pName("Annot"),
    Subtype: pName("Widget"),
    FT: pName("Sig"),
    T: pStr(spec.name),
    Rect: rectArray(spec.box),
    F: pNum(132),
    P: pRef(pageNum),
    AP: pDict({ N: pRef(apNum) }),
  });
}

/** An empty appearance Form XObject for the signature widget. */
function appearanceXObject(box: FieldPlacement["box"]): string {
  return formXObject(box, pDict({}), "");
}

/**
 * Serialize a Form XObject stream object: a `<< … >>` dict (with a correct `/Length`) followed by
 * its content stream. `content` is ASCII-only PDF operators, so its byte length equals its string
 * length. `extra` adds dict entries beyond the standard XObject keys (e.g. `/Resources`).
 */
function formXObject(box: FieldPlacement["box"], resources: PdfValue, content: string): string {
  const w = round(box[2] - box[0]);
  const h = round(box[3] - box[1]);
  const dict = serialize(
    pDict({
      Type: pName("XObject"),
      Subtype: pName("Form"),
      BBox: pArr([pNum(0), pNum(0), pNum(w), pNum(h)]),
      Resources: resources,
      Length: pNum(content.length),
    }),
  );
  return `${dict}\nstream\n${content}\nendstream`;
}

/** A standard 14 Type1 font dictionary for the AcroForm default resources. */
function fontDict(baseFont: string, encoding?: string): PdfValue {
  const entries: Record<string, PdfValue> = {
    Type: pName("Font"),
    Subtype: pName("Type1"),
    BaseFont: pName(baseFont),
  };
  if (encoding) entries.Encoding = pName(encoding);
  return pDict(entries);
}

/**
 * A merged text field + widget annotation (`/FT /Tx`) carrying Acrobat date format/keystroke
 * actions, left empty (no `/V`, no `/AP` — the viewer builds the appearance from `/DA` + `/DR`).
 */
function dateField(spec: Extract<FieldSpec, { kind: "date" }>, pageNum: number): PdfValue {
  return pDict({
    FT: pName("Tx"),
    T: pStr(spec.name),
    Type: pName("Annot"),
    Subtype: pName("Widget"),
    Rect: rectArray(spec.box),
    P: pRef(pageNum),
    F: pNum(4), // Print
    DA: pStr("/Helv 0 Tf 0 g"),
    Q: pNum(0),
    AA: pDict({
      F: jsAction(`AFDate_FormatEx("${spec.format}");`),
      K: jsAction(`AFDate_KeystrokeEx("${spec.format}");`),
    }),
  });
}

/**
 * A merged text field + widget annotation (`/FT /Tx`). Multi-line sets the Multiline flag; a
 * `value` pre-fills `/V` (the viewer regenerates the appearance via `/NeedAppearances`).
 */
function textField(spec: Extract<FieldSpec, { kind: "text" }>, pageNum: number): PdfValue {
  const entries: Record<string, PdfValue> = {
    FT: pName("Tx"),
    T: pStr(spec.name),
    Type: pName("Annot"),
    Subtype: pName("Widget"),
    Rect: rectArray(spec.box),
    P: pRef(pageNum),
    F: pNum(4), // Print
    DA: pStr("/Helv 0 Tf 0 g"),
    Q: pNum(0),
  };
  if (spec.multiline) entries.Ff = pNum(FF_MULTILINE);
  if (spec.value) entries.V = pStr(spec.value);
  if (spec.maxLen !== undefined) entries.MaxLen = pNum(spec.maxLen);
  return pDict(entries);
}

/**
 * A merged checkbox field + widget annotation (`/FT /Btn`). The on-state export value is `Yes`.
 * `/AP /N` carries both states' appearance XObjects; `/AS` + `/V` select the current state.
 */
function checkboxField(
  spec: Extract<FieldSpec, { kind: "checkbox" }>,
  pageNum: number,
  onApNum: number,
  offApNum: number,
): PdfValue {
  const state = spec.checked ? "Yes" : "Off";
  return pDict({
    FT: pName("Btn"),
    T: pStr(spec.name),
    Type: pName("Annot"),
    Subtype: pName("Widget"),
    Rect: rectArray(spec.box),
    P: pRef(pageNum),
    F: pNum(4), // Print
    V: pName(state),
    AS: pName(state),
    DA: pStr("/ZaDb 0 Tf 0 g"),
    MK: pDict({ BC: pArr([pNum(0)]), CA: pStr("4") }), // border + check glyph (ZapfDingbats "4")
    BS: pDict({ W: pNum(1), S: pName("S") }),
    AP: pDict({ N: pDict({ Yes: pRef(onApNum), Off: pRef(offApNum) }) }),
  });
}

/** Checkbox appearance: ZapfDingbats check glyph "4" when on; empty when off. */
function checkboxAppearance(box: FieldPlacement["box"], on: boolean): string {
  return glyphAppearance(box, on ? "4" : "");
}

/** The parent of a radio-button group: `/FT /Btn` with the Radio flag, `/Kids`, and the selection. */
function radioParent(spec: Extract<FieldSpec, { kind: "radio" }>, kidRefs: PdfValue[]): PdfValue {
  return pDict({
    FT: pName("Btn"),
    Ff: pNum(FF_RADIO),
    T: pStr(spec.name),
    V: pName(spec.value ?? "Off"),
    Kids: pArr(kidRefs),
  });
}

/**
 * One radio widget (child of the group). Its `/AP /N` has two keys — the button's export value
 * (the filled dot) and `Off` (empty). `/AS` is set to the export value when this button is the
 * group's selected one, else `Off`.
 */
function radioKid(
  w: { exportValue: string; box: FieldPlacement["box"] },
  pageNum: number,
  parentNum: number,
  onApNum: number,
  offApNum: number,
  selected: boolean,
): PdfValue {
  return pDict({
    Type: pName("Annot"),
    Subtype: pName("Widget"),
    Parent: pRef(parentNum),
    Rect: rectArray(w.box),
    P: pRef(pageNum),
    F: pNum(4), // Print
    AS: pName(selected ? w.exportValue : "Off"),
    DA: pStr("/ZaDb 0 Tf 0 g"),
    MK: pDict({ BC: pArr([pNum(0)]), CA: pStr("l") }), // ZapfDingbats "l" = filled circle
    BS: pDict({ W: pNum(1), S: pName("S") }),
    AP: pDict({ N: pDict({ [w.exportValue]: pRef(onApNum), Off: pRef(offApNum) }) }),
  });
}

/**
 * Draw a single centered ZapfDingbats glyph (check or dot) sized to the box. An empty `glyph`
 * yields a blank (off-state) appearance. Uses `/ZaDb` from the appearance's own /Resources.
 */
function glyphAppearance(box: FieldPlacement["box"], glyph: string): string {
  const w = round(box[2] - box[0]);
  const h = round(box[3] - box[1]);
  const resources = pDict({ Font: pDict({ ZaDb: fontDict("ZapfDingbats") }) });
  if (!glyph) return formXObject(box, resources, "");
  // Size the glyph to ~80% of the smaller dimension and roughly center it.
  const size = round(Math.min(w, h) * 0.8);
  const tx = round(w / 2 - size * 0.3);
  const ty = round(h / 2 - size * 0.35);
  const content =
    `q BT /ZaDb ${size} Tf 0 g ${tx} ${ty} Td (${glyph}) Tj ET Q`;
  return formXObject(box, resources, content);
}

/**
 * A merged choice field + widget annotation (`/FT /Ch`): dropdown (combo) or list box. `/Opt`
 * holds the option strings; `/V` (+ `/I` for list box) pre-selects a default.
 */
function choiceField(
  spec: Extract<FieldSpec, { kind: "dropdown" | "listbox" }>,
  pageNum: number,
): PdfValue {
  let ff = 0;
  if (spec.kind === "dropdown") {
    ff |= FF_COMBO;
    if (spec.editable) ff |= FF_EDIT;
  } else if (spec.multiSelect) {
    ff |= FF_MULTISELECT;
  }
  const entries: Record<string, PdfValue> = {
    FT: pName("Ch"),
    T: pStr(spec.name),
    Type: pName("Annot"),
    Subtype: pName("Widget"),
    Rect: rectArray(spec.box),
    P: pRef(pageNum),
    F: pNum(4), // Print
    DA: pStr("/Helv 0 Tf 0 g"),
    Q: pNum(0),
    Opt: pArr(spec.options.map((o) => pStr(o))),
  };
  if (ff) entries.Ff = pNum(ff);
  if (spec.value) {
    entries.V = pStr(spec.value);
    const idx = spec.options.indexOf(spec.value);
    if (idx >= 0) entries.I = pArr([pNum(idx)]); // selection index (list box highlights it)
  }
  return pDict(entries);
}

function jsAction(js: string): PdfValue {
  return pDict({ S: pName("JavaScript"), JS: pStr(js) });
}

interface AcroFormFlags {
  hasSignature: boolean;
  needsAppearances: boolean;
  helvRef: PdfValue | undefined;
  zapfRef: PdfValue | undefined;
}

/**
 * The AcroForm dictionary. `/SigFlags 1` signals signature fields; `/DA` + `/DR` supply the
 * default appearance/resources variable-text and choice fields need; `/NeedAppearances true` asks
 * the viewer to (re)generate appearances for fields we pre-filled with a value.
 */
function acroForm(fieldRefs: PdfValue[], flags: AcroFormFlags): PdfValue {
  const fonts: Record<string, PdfValue> = {};
  if (flags.helvRef) fonts.Helv = flags.helvRef;
  if (flags.zapfRef) fonts.ZaDb = flags.zapfRef;

  const entries: Record<string, PdfValue> = {
    Fields: pArr(fieldRefs),
    DR: Object.keys(fonts).length ? pDict({ Font: pDict(fonts) }) : pDict({}),
  };
  if (flags.helvRef) entries.DA = pStr("/Helv 0 Tf 0 g");
  if (flags.hasSignature) entries.SigFlags = pNum(1);
  if (flags.needsAppearances) entries.NeedAppearances = pBool(true);
  return pDict(entries);
}

function rectArray(box: FieldPlacement["box"]): PdfValue {
  return pArr(box.map((v) => pNum(round(v))));
}

function round(n: number): number {
  return Number(n.toFixed(4));
}

// ── Page-tree walk ─────────────────────────────────────────────────────────────────────────
interface PageEntry {
  num: number;
  dict: PdfValue;
}

/** Depth-first walk of the page tree from the catalog `/Pages`, returning leaf pages in order. */
function collectPages(doc: PdfDocument, catalog: PdfValue): PageEntry[] {
  const pagesRef = dictGet(catalog, "Pages");
  if (!pagesRef || pagesRef.t !== "ref") throw new Error("PDF: catalog has no /Pages reference");

  const out: PageEntry[] = [];
  const seen = new Set<number>();
  const visit = (ref: PdfValue): void => {
    if (ref.t !== "ref" || seen.has(ref.num)) return;
    seen.add(ref.num);
    const node = doc.getObject(ref.num);
    if (node.t !== "dict") return;
    if (asName(node.v.get("Type")) === "Pages") {
      const kids = doc.resolve(node.v.get("Kids"));
      if (kids && kids.t === "array") for (const kid of kids.v) visit(kid);
    } else {
      out.push({ num: ref.num, dict: node });
    }
  };
  visit(pagesRef);
  return out;
}

// ── Incremental-update assembly ──────────────────────────────────────────────────────────
function cloneDict(v: PdfValue): Map<string, PdfValue> {
  if (v.t !== "dict") throw new Error("PDF: expected a dictionary to clone");
  return new Map(v.v);
}

/**
 * Append the updated/new objects as an incremental update: the objects, a classic xref table
 * listing only them, and a trailer whose `/Prev` points back to the base revision's xref. Object
 * offsets are computed against the final byte stream, so the base bytes stay untouched.
 */
function appendIncrementalUpdate(
  doc: PdfDocument,
  updated: Map<number, string>,
  catalogNum: number,
): Uint8Array {
  const baseLen = doc.bytes.length;
  const offsets = new Map<number, number>();
  const nums = [...updated.keys()].sort((a, b) => a - b);

  // A newline separates the base %%EOF from the appended revision.
  let body = "\n";
  for (const num of nums) {
    offsets.set(num, baseLen + body.length);
    body += `${num} 0 obj\n${updated.get(num)}\nendobj\n`;
  }

  const xrefOffset = baseLen + body.length;
  body += "xref\n";
  for (const [start, run] of consecutiveRuns(nums)) {
    body += `${start} ${run.length}\n`;
    for (const num of run) {
      body += `${offsets.get(num)!.toString().padStart(10, "0")} 00000 n \n`;
    }
  }

  const size = Math.max(...nums) + 1;
  const trailer = pDict({
    Size: pNum(size),
    Root: pRef(catalogNum),
    Prev: pNum(doc.startxref),
    ID: trailerId(doc),
  });
  body += `trailer\n${serialize(trailer)}\nstartxref\n${xrefOffset}\n%%EOF\n`;

  const tail = latin1Bytes(body);
  const out = new Uint8Array(baseLen + tail.length);
  out.set(doc.bytes, 0);
  out.set(tail, baseLen);
  return out;
}

/** Group a sorted list of object numbers into runs of consecutive numbers (xref subsections). */
function consecutiveRuns(sorted: number[]): Array<[number, number[]]> {
  const runs: Array<[number, number[]]> = [];
  for (const num of sorted) {
    const last = runs[runs.length - 1];
    if (last && num === last[0] + last[1].length) last[1].push(num);
    else runs.push([num, [num]]);
  }
  return runs;
}

/**
 * Reuse the base document's `/ID` (Acrobat's signing engine relies on it to identify the
 * document). jsPDF always writes one; if it's somehow missing, synthesize a random pair.
 */
function trailerId(doc: PdfDocument): PdfValue {
  const id = dictGet(doc.trailer, "ID");
  if (id && id.t === "array" && id.v.length === 2) return id;
  const hex = randomHex(16);
  return pArr([{ t: "str", v: hex, hex: true }, { t: "str", v: hex, hex: true }]);
}

function randomHex(nBytes: number): string {
  const bytes = new Uint8Array(nBytes);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
