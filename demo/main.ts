import { htmlToSignablePdf, type ProgressStage } from "../src/index";
import contractHtml from "../sample/contract.html?raw";
import leaseHtml from "../sample/lease-multipage.html?raw";
import invoiceHtml from "../sample/invoice.html?raw";
import handbookHtml from "../sample/handbook-long.html?raw";
import imageHtml from "../sample/report-with-image.html?raw";
import forcedBreakHtml from "../sample/forced-break.html?raw";
import multiPartyHtml from "../sample/multi-party.html?raw";
import headerFooterHtml from "../sample/header-footer.html?raw";
import headerFooterSpacingHtml from "../sample/header-footer-spacing.html?raw";
import formFieldsHtml from "../sample/form-fields.html?raw";

const STAGE_LABEL: Record<ProgressStage, string> = {
  paginating: "Paginating HTML…",
  measuring: "Measuring signature placeholder…",
  rendering: "Rendering vector PDF…",
  "embedding-field": "Embedding signature field…",
  done: "Done.",
};

/** Starter templates offered in the dropdown. The first is loaded on page open. */
const EXAMPLES: Array<{ id: string; label: string; html: string }> = [
  { id: "contract", label: "Service agreement (signature + date)", html: contractHtml },
  { id: "lease", label: "Lease — multi-page (pagination test)", html: leaseHtml },
  { id: "invoice", label: "Invoice — table, date field only", html: invoiceHtml },
  { id: "handbook", label: "Handbook — 10 pages, signature on page 5", html: handbookHtml },
  { id: "image", label: "Inspection report — embedded images", html: imageHtml },
  { id: "forced-break", label: "Forced page breaks", html: forcedBreakHtml },
  { id: "multi-party", label: "Multi-party — multiple signatures + dates", html: multiPartyHtml },
  { id: "header-footer", label: "Running header & footer (page numbers)", html: headerFooterHtml },
  { id: "header-footer-spacing", label: "Header/footer spacing (margins + CSS)", html: headerFooterSpacingHtml },
  { id: "form-fields", label: "Form fields (text, checkbox, radio, dropdown, list)", html: formFieldsHtml },
];

/** Default page margins in points (matches the library default). */
const DEFAULT_MARGIN_PT = 54;

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <main style="font-family: system-ui, sans-serif; max-width: 1100px; margin: 0 auto; padding: 16px;">
    <h1 style="margin:0 0 4px;">html-to-signable-pdf</h1>
    <p style="margin:0 0 16px; color:#555;">
      HTML → vector PDF with blank AcroForm fields where
      <code>&lt;div class="pdfdigitalsignaturefield"&gt;</code> and
      <code>&lt;div class="pdfdatefield"&gt;</code> render (any number of each). Pick an
      example or paste your own.
    </p>
    <div style="display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap;">
      <div style="flex:1 1 420px; min-width:320px;">
        <div style="display:flex; justify-content:space-between; align-items:baseline; gap:12px;">
          <label style="font-weight:600;">HTML source</label>
          <label style="font-size:13px; color:#555;">Example
            <select id="example">
              ${EXAMPLES.map(
                (e, i) => `<option value="${e.id}"${i === 0 ? " selected" : ""}>${e.label}</option>`,
              ).join("")}
            </select>
          </label>
        </div>
        <textarea id="html" spellcheck="false"
          style="width:100%; height:420px; font-family:ui-monospace,monospace; font-size:12px;
                 box-sizing:border-box; margin-top:4px;"></textarea>
        <div style="display:flex; gap:12px; align-items:center; margin-top:10px; flex-wrap:wrap;">
          <label>Page size
            <select id="pagesize">
              <option value="Letter">Letter</option>
              <option value="A4">A4</option>
            </select>
          </label>
          <label><input type="checkbox" id="debug" /> Debug outline</label>
          <button id="generate" style="padding:8px 16px; font-weight:600;">Generate PDF</button>
          <a id="download" style="display:none;">Download PDF</a>
        </div>
        <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap; font-size:13px; color:#555;">
          <span>Margins (pt):</span>
          ${(["top", "right", "bottom", "left"] as const)
            .map(
              (side) =>
                `<label style="text-transform:capitalize;">${side}
                  <input type="number" id="margin-${side}" min="0" step="1" value="${DEFAULT_MARGIN_PT}"
                    style="width:56px;" />
                </label>`,
            )
            .join("")}
        </div>
        <div id="status" style="margin-top:10px; min-height:1.4em; color:#333;"></div>
      </div>
      <div style="flex:1 1 420px; min-width:320px;">
        <label style="font-weight:600;">PDF preview</label>
        <iframe id="preview" title="PDF preview"
          style="width:100%; height:520px; border:1px solid #ccc; margin-top:4px;"></iframe>
      </div>
    </div>
  </main>
`;

const htmlInput = document.querySelector<HTMLTextAreaElement>("#html")!;
const exampleSelect = document.querySelector<HTMLSelectElement>("#example")!;
const pageSizeSelect = document.querySelector<HTMLSelectElement>("#pagesize")!;
const debugCheckbox = document.querySelector<HTMLInputElement>("#debug")!;
const marginInputs = {
  top: document.querySelector<HTMLInputElement>("#margin-top")!,
  right: document.querySelector<HTMLInputElement>("#margin-right")!,
  bottom: document.querySelector<HTMLInputElement>("#margin-bottom")!,
  left: document.querySelector<HTMLInputElement>("#margin-left")!,
};
const generateButton = document.querySelector<HTMLButtonElement>("#generate")!;
const downloadLink = document.querySelector<HTMLAnchorElement>("#download")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const preview = document.querySelector<HTMLIFrameElement>("#preview")!;

htmlInput.value = EXAMPLES[0].html;

// Load the chosen example into the editor. To avoid clobbering hand-edits, only replace the
// textarea when it still matches one of the bundled examples verbatim.
exampleSelect.addEventListener("change", () => {
  const next = EXAMPLES.find((e) => e.id === exampleSelect.value);
  if (!next) return;
  const isPristine = EXAMPLES.some((e) => e.html === htmlInput.value);
  if (isPristine || confirm("Replace your edits with this example?")) {
    htmlInput.value = next.html;
  }
});

let lastUrl: string | null = null;

generateButton.addEventListener("click", async () => {
  generateButton.disabled = true;
  downloadLink.style.display = "none";
  statusEl.style.color = "#333";
  try {
    const readMargin = (input: HTMLInputElement) => {
      const v = Number(input.value);
      return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MARGIN_PT;
    };
    const bytes = await htmlToSignablePdf(htmlInput.value, {
      pageSize: pageSizeSelect.value as "Letter" | "A4",
      marginsPt: {
        top: readMargin(marginInputs.top),
        right: readMargin(marginInputs.right),
        bottom: readMargin(marginInputs.bottom),
        left: readMargin(marginInputs.left),
      },
      debugOutlinePlaceholders: debugCheckbox.checked,
      onProgress: (stage) => {
        statusEl.textContent = STAGE_LABEL[stage];
      },
    });

    // Copy into a fresh ArrayBuffer so the Blob owns standalone bytes.
    const blob = new Blob([bytes.slice()], { type: "application/pdf" });
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);

    preview.src = lastUrl;
    downloadLink.href = lastUrl;
    downloadLink.download = "document.pdf";
    downloadLink.textContent = `Download PDF (${(blob.size / 1024).toFixed(0)} KB)`;
    downloadLink.style.display = "inline";
    statusEl.textContent = `Done — ${(blob.size / 1024).toFixed(0)} KB.`;
  } catch (err) {
    statusEl.style.color = "#c00";
    statusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(err);
  } finally {
    generateButton.disabled = false;
  }
});
