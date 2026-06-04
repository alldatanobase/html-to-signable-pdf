// A tiny, dependency-free PDF reader/writer — just enough to append an *incremental update*
// that adds blank AcroForm fields to an existing PDF (the one jsPDF produces). It is NOT a
// general-purpose PDF library: it parses the classic xref table + trailer, reads the few
// objects we need to re-emit (the catalog, the page tree, the affected pages), and serializes
// new objects as text. Everything is handled as a latin1 (one byte = one char code) string so
// byte offsets and character indices stay aligned — the same trick the renderer uses for
// `removeOpenAction`.

/** A parsed PDF value. Content streams aren't modeled here — we only read plain dicts/arrays. */
export type PdfValue =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "num"; v: number; raw?: string }
  | { t: "str"; v: string; hex: boolean }
  | { t: "name"; v: string }
  | { t: "array"; v: PdfValue[] }
  | { t: "dict"; v: Map<string, PdfValue> }
  | { t: "ref"; num: number; gen: number };

// ── Value constructors (used when building the new objects) ──────────────────────────────
export const pName = (v: string): PdfValue => ({ t: "name", v });
export const pRef = (num: number, gen = 0): PdfValue => ({ t: "ref", num, gen });
export const pNum = (v: number): PdfValue => ({ t: "num", v });
export const pBool = (v: boolean): PdfValue => ({ t: "bool", v });
export const pStr = (v: string): PdfValue => ({ t: "str", v, hex: false });
export const pArr = (v: PdfValue[]): PdfValue => ({ t: "array", v });
export const pDict = (entries: Record<string, PdfValue>): PdfValue => ({
  t: "dict",
  v: new Map(Object.entries(entries)),
});

// ── Serialization ────────────────────────────────────────────────────────────────────────
export function serialize(v: PdfValue): string {
  switch (v.t) {
    case "null":
      return "null";
    case "bool":
      return v.v ? "true" : "false";
    case "num":
      return v.raw ?? formatNumber(v.v);
    case "str":
      return v.hex ? `<${v.v}>` : `(${escapeLiteralString(v.v)})`;
    case "name":
      return `/${encodeName(v.v)}`;
    case "ref":
      return `${v.num} ${v.gen} R`;
    case "array":
      return `[${v.v.map(serialize).join(" ")}]`;
    case "dict": {
      const parts: string[] = [];
      for (const [k, val] of v.v) parts.push(`/${encodeName(k)} ${serialize(val)}`);
      return `<< ${parts.join(" ")} >>`;
    }
  }
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
}

function escapeLiteralString(s: string): string {
  return s.replace(/[\\()]/g, (c) => "\\" + c);
}

function encodeName(s: string): string {
  // Escape everything outside the "regular" name characters as #XX (PDF 1.2+ name encoding).
  return s.replace(/[^A-Za-z0-9._-]/g, (c) => "#" + c.charCodeAt(0).toString(16).padStart(2, "0"));
}

// ── latin1 <-> bytes ───────────────────────────────────────────────────────────────────────
export function latin1(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

export function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// ── Lexer / parser ───────────────────────────────────────────────────────────────────────
const DELIMS = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);

function isWsCode(c: number): boolean {
  return c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
}

function isRegular(ch: string | undefined): boolean {
  return ch !== undefined && !isWsCode(ch.charCodeAt(0)) && !DELIMS.has(ch);
}

function skipWs(s: string, i: number): number {
  for (;;) {
    while (i < s.length && isWsCode(s.charCodeAt(i))) i++;
    if (s[i] === "%") {
      while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i++; // skip comment to EOL
      continue;
    }
    return i;
  }
}

interface IntToken {
  n: number;
  raw: string;
  next: number;
}

function readIntToken(s: string, i: number): IntToken | null {
  const start = i;
  if (s[i] === "+" || s[i] === "-") i++;
  let any = false;
  while (i < s.length && s[i] >= "0" && s[i] <= "9") {
    i++;
    any = true;
  }
  if (!any) return null;
  const raw = s.slice(start, i);
  return { n: parseInt(raw, 10), raw, next: i };
}

interface Parsed {
  value: PdfValue;
  next: number;
}

export function parseValue(s: string, i0: number): Parsed {
  const i = skipWs(s, i0);
  const ch = s[i];
  if (ch === "/") return parseName(s, i);
  if (ch === "(") return parseLiteralString(s, i);
  if (ch === "<") return s[i + 1] === "<" ? parseDict(s, i) : parseHexString(s, i);
  if (ch === "[") return parseArray(s, i);
  if (ch === "t") return { value: { t: "bool", v: true }, next: parseKeyword(s, i, "true") };
  if (ch === "f") return { value: { t: "bool", v: false }, next: parseKeyword(s, i, "false") };
  if (ch === "n") return { value: { t: "null" }, next: parseKeyword(s, i, "null") };
  if (ch === "+" || ch === "-" || ch === "." || (ch >= "0" && ch <= "9")) {
    return parseNumberOrRef(s, i);
  }
  throw new Error(`PDF parse: unexpected character ${JSON.stringify(ch)} at ${i}`);
}

function parseKeyword(s: string, i: number, kw: string): number {
  if (!s.startsWith(kw, i)) throw new Error(`PDF parse: expected ${kw} at ${i}`);
  return i + kw.length;
}

function parseName(s: string, i: number): Parsed {
  i++; // skip '/'
  let out = "";
  while (i < s.length && isRegular(s[i])) {
    if (s[i] === "#" && i + 2 < s.length) {
      out += String.fromCharCode(parseInt(s.substr(i + 1, 2), 16));
      i += 3;
    } else {
      out += s[i];
      i++;
    }
  }
  return { value: { t: "name", v: out }, next: i };
}

const ESC: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  "(": "(",
  ")": ")",
  "\\": "\\",
};

function parseLiteralString(s: string, i: number): Parsed {
  i++; // skip '('
  let out = "";
  let depth = 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      const n = s[i + 1];
      if (n in ESC) {
        out += ESC[n];
        i += 2;
      } else if (n >= "0" && n <= "7") {
        let oct = n;
        i += 2;
        for (let k = 0; k < 2 && s[i] >= "0" && s[i] <= "7"; k++) oct += s[i++];
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      } else if (n === "\n") {
        i += 2; // line continuation
      } else if (n === "\r") {
        i += s[i + 2] === "\n" ? 3 : 2;
      } else {
        out += n;
        i += 2;
      }
    } else if (ch === "(") {
      depth++;
      out += ch;
      i++;
    } else if (ch === ")") {
      depth--;
      i++;
      if (depth === 0) break;
      out += ch;
    } else {
      out += ch;
      i++;
    }
  }
  return { value: { t: "str", v: out, hex: false }, next: i };
}

function parseHexString(s: string, i: number): Parsed {
  i++; // skip '<'
  let hex = "";
  while (i < s.length && s[i] !== ">") {
    if (!isWsCode(s.charCodeAt(i))) hex += s[i];
    i++;
  }
  i++; // skip '>'
  return { value: { t: "str", v: hex.toUpperCase(), hex: true }, next: i };
}

function parseArray(s: string, i: number): Parsed {
  i++; // skip '['
  const arr: PdfValue[] = [];
  for (;;) {
    i = skipWs(s, i);
    if (s[i] === "]") {
      i++;
      break;
    }
    if (i >= s.length) throw new Error("PDF parse: unterminated array");
    const p = parseValue(s, i);
    arr.push(p.value);
    i = p.next;
  }
  return { value: { t: "array", v: arr }, next: i };
}

function parseDict(s: string, i: number): Parsed {
  i += 2; // skip '<<'
  const map = new Map<string, PdfValue>();
  for (;;) {
    i = skipWs(s, i);
    if (s[i] === ">" && s[i + 1] === ">") {
      i += 2;
      break;
    }
    if (i >= s.length) throw new Error("PDF parse: unterminated dict");
    if (s[i] !== "/") throw new Error(`PDF parse: expected a name key at ${i}`);
    const key = parseName(s, i);
    const val = parseValue(s, key.next);
    map.set((key.value as { v: string }).v, val.value);
    i = val.next;
  }
  return { value: { t: "dict", v: map }, next: i };
}

function parseNumberOrRef(s: string, i: number): Parsed {
  const start = i;
  if (s[i] === "+" || s[i] === "-") i++;
  let hasDot = false;
  while (i < s.length) {
    const ch = s[i];
    if (ch >= "0" && ch <= "9") i++;
    else if (ch === ".") {
      hasDot = true;
      i++;
    } else break;
  }
  const raw = s.slice(start, i);
  const num = parseFloat(raw);

  // A plain non-negative integer may actually begin an indirect reference "N G R".
  if (!hasDot && raw[0] !== "-" && raw[0] !== "+") {
    const g = readIntToken(s, skipWs(s, i));
    if (g && g.raw[0] !== "-" && g.raw[0] !== "+") {
      const k = skipWs(s, g.next);
      if (s[k] === "R" && !isRegular(s[k + 1])) {
        return { value: { t: "ref", num, gen: g.n }, next: k + 1 };
      }
    }
  }
  return { value: { t: "num", v: num, raw }, next: i };
}

function readIndirectObjectAt(s: string, offset: number): PdfValue {
  let i = skipWs(s, offset);
  const objNum = readIntToken(s, i);
  if (!objNum) throw new Error(`PDF: bad object header at ${offset}`);
  const gen = readIntToken(s, skipWs(s, objNum.next));
  if (!gen) throw new Error(`PDF: bad object generation at ${offset}`);
  i = skipWs(s, gen.next);
  if (!s.startsWith("obj", i)) throw new Error(`PDF: expected 'obj' at ${i}`);
  return parseValue(s, i + 3).value;
}

// ── Accessors ──────────────────────────────────────────────────────────────────────────────
export function dictGet(v: PdfValue | undefined, key: string): PdfValue | undefined {
  return v && v.t === "dict" ? v.v.get(key) : undefined;
}

export function asName(v: PdfValue | undefined): string | undefined {
  return v && v.t === "name" ? v.v : undefined;
}

/**
 * A minimally-parsed PDF: the classic xref table(s) are read into an object-number → byte-offset
 * map (newest revision wins), the newest trailer is captured, and individual objects can be read
 * on demand. Only the classic (table) xref form is supported — which is what jsPDF emits.
 */
export class PdfDocument {
  readonly bytes: Uint8Array;
  readonly s: string;
  readonly xref = new Map<number, number>();
  /** Byte offset of the file's last xref section (becomes our incremental update's /Prev). */
  startxref = 0;
  trailer: PdfValue = { t: "dict", v: new Map() };

  private readonly cache = new Map<number, PdfValue>();

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.s = latin1(bytes);
    this.parseXrefChain();
  }

  getObject(num: number): PdfValue {
    const hit = this.cache.get(num);
    if (hit) return hit;
    const off = this.xref.get(num);
    if (off === undefined) throw new Error(`PDF: object ${num} is not in the xref table`);
    const v = readIndirectObjectAt(this.s, off);
    this.cache.set(num, v);
    return v;
  }

  /** Follow an indirect reference to its object; pass-through for any other value. */
  resolve(v: PdfValue | undefined): PdfValue | undefined {
    return v && v.t === "ref" ? this.getObject(v.num) : v;
  }

  /** Highest object number referenced anywhere, so new objects can be numbered after it. */
  maxObjectNumber(): number {
    let max = 0;
    for (const n of this.xref.keys()) if (n > max) max = n;
    const size = dictGet(this.trailer, "Size");
    if (size && size.t === "num") max = Math.max(max, size.v - 1);
    return max;
  }

  private parseXrefChain(): void {
    const idx = this.s.lastIndexOf("startxref");
    if (idx < 0) throw new Error("PDF: no startxref found");
    const tok = readIntToken(this.s, skipWs(this.s, idx + "startxref".length));
    if (!tok) throw new Error("PDF: malformed startxref");
    this.startxref = tok.n;

    let offset: number | null = tok.n;
    let first = true;
    const seen = new Set<number>();
    while (offset !== null && !seen.has(offset)) {
      seen.add(offset);
      const trailer = this.parseXrefSection(offset);
      if (first) {
        this.trailer = trailer;
        first = false;
      }
      const prev = dictGet(trailer, "Prev");
      offset = prev && prev.t === "num" ? prev.v : null;
    }
  }

  /** Parse one classic xref section at `offset`; record offsets (newest wins) and return its trailer. */
  private parseXrefSection(offset: number): PdfValue {
    let i = skipWs(this.s, offset);
    if (!this.s.startsWith("xref", i)) {
      throw new Error(
        "PDF: cross-reference streams are not supported; expected a classic xref table",
      );
    }
    i += 4;
    for (;;) {
      i = skipWs(this.s, i);
      if (this.s.startsWith("trailer", i)) {
        i += "trailer".length;
        break;
      }
      const startTok = readIntToken(this.s, i);
      if (!startTok) throw new Error("PDF: bad xref subsection start");
      const countTok = readIntToken(this.s, skipWs(this.s, startTok.next));
      if (!countTok) throw new Error("PDF: bad xref subsection count");
      i = countTok.next;
      for (let k = 0; k < countTok.n; k++) {
        const offTok = readIntToken(this.s, skipWs(this.s, i));
        if (!offTok) throw new Error("PDF: bad xref entry offset");
        const genTok = readIntToken(this.s, skipWs(this.s, offTok.next));
        if (!genTok) throw new Error("PDF: bad xref entry generation");
        i = skipWs(this.s, genTok.next);
        const type = this.s[i];
        i++;
        const objNum = startTok.n + k;
        if (type === "n" && !this.xref.has(objNum)) this.xref.set(objNum, offTok.n);
      }
    }
    const trailer = parseValue(this.s, i).value;
    if (trailer.t !== "dict") throw new Error("PDF: trailer is not a dictionary");
    return trailer;
  }
}
